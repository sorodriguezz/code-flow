//! What keeps an approved memory from going stale unseen — the parts of it that read the code.
//!
//! **Anchors.** A memory that names files or symbols ("la config vive en `jest.config.js`", "los
//! montos pasan por `toCents`") is anchored to them: the names are read out of its title, body and
//! evidence ([`candidates`]) and kept only when the repository has them ([`resolve`]) — a word that
//! merely looks like a path is not an anchor. A later pass ([`check`]) looks for each again; one
//! gone sends the memory to the user's review queue with what is missing and, for a file, where a
//! file of the same name lives now. Every anchor found is a confirmation: the code still says what
//! the memory was written against.
//!
//! Paths are checked on disk (a `package.json` or a `.env.example` is not in the code map); symbols
//! against the code map ([`crate::codemap`]), which the reviewer and the agents already keep warm.
//! The pass runs when the Memory pane opens ([`run`]), reading the database briefly at either end and
//! never holding it while a map is built.
//!
//! **Clashes.** A new memory that shares most of its distinctive words with an approved one of the
//! same place, and does not say the same thing, probably replaces it — or contradicts it. Which one
//! is the user's call ([`clash`] only finds the pair; `ai_memory::settle_clash` settles it).

use std::path::Path;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::{normalized, now, revise, Memory};

/// One thing in the code a memory is about: a file (relative to its repository, `/`-separated) or a
/// declared symbol, in the project it was found in.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    pub project_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
}

/// Why an approved memory waits for the user, besides its age (which is read, not stored).
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Reason {
    /// An anchor is gone from the code.
    CodeChanged,
    /// A model said the code contradicts it (`flag_memory`).
    Contradicted,
}

/// An anchor the last pass did not find, and — for a file — one of the same name elsewhere.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Missing {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub moved_to: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Review {
    pub reason: Reason,
    /// The model's words, for a contradiction; empty for a change in the code (see `missing`).
    #[serde(default)]
    pub detail: String,
    /// Where the model saw it (`path:line`, a command's output) — redacted like any evidence.
    #[serde(default)]
    pub evidence: Vec<String>,
    #[serde(default)]
    pub missing: Vec<Missing>,
    /// `system` for a pass, the engine or `agent` for a flag.
    pub by: String,
    pub at: i64,
}

/// Anchors kept per memory: the first few names say what it is about; a list of thirty is a pasted
/// file, not a rule.
const MAX_ANCHORS: usize = 8;

/// The file paths and symbol names a memory's text seems to mention — before the repository says
/// which of them are real. A path has a `/` or a file extension after a name (`jest.config.js`,
/// `src/money.ts:12` — the line is dropped); a symbol is written in backticks or looks like code
/// (`toCents`, `parse_amount`, `Checkout()`). URLs, versions and plain words are neither.
pub fn candidates(text: &str) -> (Vec<String>, Vec<String>) {
    let mut paths: Vec<String> = Vec::new();
    let mut symbols: Vec<String> = Vec::new();
    let push = |list: &mut Vec<String>, value: String| {
        if !value.is_empty() && !list.contains(&value) {
            list.push(value);
        }
    };
    // Backticked spans first: whatever the user quoted as code is the strongest hint.
    let mut quoted: Vec<&str> = Vec::new();
    for (i, part) in text.split('`').enumerate() {
        if i % 2 == 1 && !part.contains('\n') {
            quoted.push(part.trim());
        }
    }
    let words = text.split(|c: char| c.is_whitespace() || matches!(c, '`' | '"' | '«' | '»' | '(' | ')' | '[' | ']' | '{' | '}' | ',' | ';' | '\''));
    for (word, is_quoted) in quoted.iter().map(|w| (*w, true)).chain(words.map(|w| (w, false))) {
        let word = word.trim_matches(|c: char| matches!(c, '.' | ':' | '!' | '?' | '¿' | '¡' | '*'));
        if word.is_empty() || word.contains("://") || word.starts_with("www.") {
            continue;
        }
        // `path:line` / `path:line:col` → the path.
        let word = match word.split_once(':') {
            Some((head, tail)) if tail.split(':').all(|n| n.chars().all(|c| c.is_ascii_digit())) => head,
            Some(_) => continue,
            None => word,
        };
        if looks_like_path(word) {
            push(&mut paths, word.trim_start_matches("./").to_string());
        } else if let Some(symbol) = looks_like_symbol(word, is_quoted) {
            push(&mut symbols, symbol);
        }
    }
    (paths, symbols)
}

fn looks_like_path(word: &str) -> bool {
    if word.chars().any(|c| !(c.is_alphanumeric() || matches!(c, '/' | '.' | '_' | '-' | '@'))) {
        return false;
    }
    let name = word.rsplit('/').next().unwrap_or(word);
    if word.contains('/') {
        // `src/money.ts`, `src/money` — a file or a folder, but not `y/o`. Only a candidate: a word
        // like `and/or` is dropped when the repository has no such path.
        return word.len() >= 4 && (name.contains('.') || word.split('/').filter(|s| !s.is_empty()).count() >= 2);
    }
    // `name.ext`: letters before the dot, a short extension with a letter in it — not `1.2.3`.
    match name.rsplit_once('.') {
        Some((stem, ext)) => {
            !stem.is_empty()
                && stem.chars().any(char::is_alphabetic)
                && (1..=6).contains(&ext.len())
                && ext.chars().all(char::is_alphanumeric)
                && ext.chars().any(char::is_alphabetic)
        }
        None => false,
    }
}

fn looks_like_symbol(word: &str, quoted: bool) -> Option<String> {
    let word = word.trim_end_matches("()");
    if word.chars().count() < 3 || !word.chars().all(|c| c.is_alphanumeric() || c == '_') || word.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        return None;
    }
    let camel = word.chars().skip(1).any(char::is_uppercase) && word.chars().any(char::is_lowercase);
    let snake = word.contains('_') && word.chars().any(char::is_alphabetic);
    (quoted || camel || snake).then(|| word.to_string())
}

/// The candidates that exist in one repository, as anchors: a path that is a file or folder under
/// `root` (or, failing that, the one code file whose path ends with it), a symbol the map declares.
pub fn resolve(project_id: &str, root: &Path, map: Option<&crate::codemap::Snapshot>, paths: &[String], symbols: &[String]) -> Vec<Anchor> {
    let mut out: Vec<Anchor> = Vec::new();
    for path in paths {
        let found = if root.join(path).exists() {
            Some(path.clone())
        } else {
            map.and_then(|map| {
                let suffix = format!("/{path}");
                let mut hits = map.files.iter().filter(|f| f.path.ends_with(&suffix));
                match (hits.next(), hits.next()) {
                    (Some(only), None) => Some(only.path.clone()),
                    _ => None,
                }
            })
        };
        if let Some(path) = found {
            out.push(Anchor { project_id: project_id.to_string(), path: Some(path), symbol: None });
        }
    }
    if let Some(map) = map {
        for symbol in symbols {
            if map.declares(symbol) {
                out.push(Anchor { project_id: project_id.to_string(), path: None, symbol: Some(symbol.clone()) });
            }
        }
    }
    out.truncate(MAX_ANCHORS);
    out
}

/// The anchors of one repository that are gone. A path is looked for on disk; one that is gone is
/// matched by its file name against the map, so a move reads as «¿ahora en …?». A symbol is gone
/// when the map has it declared nowhere. Without a map, symbols are not judged.
pub fn check(root: &Path, map: Option<&crate::codemap::Snapshot>, anchors: &[&Anchor]) -> Vec<Missing> {
    let mut out = Vec::new();
    for anchor in anchors {
        if let Some(path) = &anchor.path {
            if root.join(path).exists() {
                continue;
            }
            let name = path.rsplit('/').next().unwrap_or(path);
            let moved_to = map.and_then(|map| {
                let suffix = format!("/{name}");
                let mut hits = map.files.iter().filter(|f| f.path == name || f.path.ends_with(&suffix));
                match (hits.next(), hits.next()) {
                    (Some(only), None) => Some(only.path.clone()),
                    _ => None,
                }
            });
            out.push(Missing { path: Some(path.clone()), symbol: None, moved_to });
        } else if let (Some(symbol), Some(map)) = (&anchor.symbol, map) {
            if !map.declares(symbol) {
                out.push(Missing { path: None, symbol: Some(symbol.clone()), moved_to: None });
            }
        }
    }
    out
}

/// The words that say what a memory is about — its title's and body's, function words out.
fn topic(memory: &Memory) -> Vec<String> {
    crate::knowledge::index::query_terms(&format!("{} {}", memory.title, memory.body)).into_iter().map(|t| t.word).collect()
}

/// The approved memory of `live` that `memory` most seems to clash with: most of the smaller one's
/// topic words shared (two at least), and not the same text. `None` when nothing comes close.
pub fn clash(memory: &Memory, live: &[Memory]) -> Option<String> {
    let mine = topic(memory);
    if mine.len() < 2 {
        return None;
    }
    let body = normalized(&memory.body);
    let mut best: Option<(f32, &Memory)> = None;
    for other in live.iter().filter(|m| m.id != memory.id && m.status == "approved") {
        if !body.is_empty() && normalized(&other.body) == body {
            continue;
        }
        let theirs = topic(other);
        let smaller = mine.len().min(theirs.len());
        if smaller < 2 {
            continue;
        }
        let shared = mine.iter().filter(|w| theirs.contains(w)).count();
        let needed = 2.max((smaller * 2).div_ceil(3));
        if shared < needed {
            continue;
        }
        let score = shared as f32 / smaller as f32;
        if best.is_none_or(|(s, _)| score > s) {
            best = Some((score, other));
        }
    }
    best.map(|(_, m)| m.id.clone())
}

/// One approved memory a pass looks at: its text, where it applies, and what it was anchored to.
struct Job {
    id: String,
    scope: String,
    project_id: Option<String>,
    text: String,
    anchors: Vec<Anchor>,
    anchored: bool,
    review: Option<Review>,
}

/// What a pass found for one memory.
enum Outcome {
    /// Anchored for the first time (possibly to nothing: the memory names nothing in the code).
    Anchored(Vec<Anchor>, Option<String>),
    /// Every anchor where it was.
    Present,
    /// These anchors are gone.
    Missing(Vec<Missing>),
}

/// The approved memories of `workspace_id` worth a look — never anchored, or anchored to something
/// — and the workspace's repositories by id.
fn jobs(conn: &Connection, workspace_id: &str) -> rusqlite::Result<(Vec<Job>, Vec<(String, String)>)> {
    let mut stmt = conn.prepare("SELECT id, local_path FROM projects WHERE workspace_id = ?1")?;
    let projects: Vec<(String, String)> = stmt.query_map(params![workspace_id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
    let mut stmt = conn.prepare(
        "SELECT id, scope, project_id, title, body, evidence, anchors, anchored_at, review FROM ai_memories
         WHERE status = 'approved' AND (anchored_at IS NULL OR anchors != '[]')
           AND ((scope = 'workspace' AND workspace_id = ?1)
                OR (scope IN ('project', 'task') AND project_id IN (SELECT id FROM projects WHERE workspace_id = ?1)))",
    )?;
    let jobs = stmt
        .query_map(params![workspace_id], |r| {
            let evidence: String = r.get(5)?;
            let evidence: Vec<String> = serde_json::from_str(&evidence).unwrap_or_default();
            let anchors: String = r.get(6)?;
            let review: Option<String> = r.get(8)?;
            Ok(Job {
                id: r.get(0)?,
                scope: r.get(1)?,
                project_id: r.get(2)?,
                text: format!("{}\n{}\n{}", r.get::<_, String>(3)?, r.get::<_, String>(4)?, evidence.join("\n")),
                anchors: serde_json::from_str(&anchors).unwrap_or_default(),
                anchored: r.get::<_, Option<i64>>(7)?.is_some(),
                review: review.and_then(|text| serde_json::from_str(&text).ok()),
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok((jobs, projects))
}

/// The short commit `root` is at, for "anclada en abc1234".
fn head(root: &str) -> Option<String> {
    let mut command = crate::proc::std_command("git");
    command.args(["-C", root, "rev-parse", "--short", "HEAD"]);
    let output = command.output().ok()?;
    output.status.success().then(|| String::from_utf8_lossy(&output.stdout).trim().to_string()).filter(|s| !s.is_empty())
}

/// One pass over `workspace_id`'s approved memories: anchors the new ones, checks the anchored ones,
/// sends the ones whose code changed to review and counts every anchor found as a confirmation.
/// Returns how many memories changed state. Blocking — maps are built here — so call it from
/// `spawn_blocking`.
pub fn run(workspace_id: &str) -> Result<usize, String> {
    let Some(loaded) = crate::ai_usage::with_conn(|conn| jobs(conn, workspace_id)) else {
        return Err("the app's database is not available yet".to_string());
    };
    let (jobs, projects) = loaded.map_err(|e| e.to_string())?;
    if jobs.is_empty() {
        return Ok(0);
    }
    // A repository's map is built only if some memory of it needs one, and once.
    let mut maps: std::collections::HashMap<String, Option<std::sync::Arc<crate::codemap::Snapshot>>> = std::collections::HashMap::new();
    let mut map_of = |project: &str, root: &str| -> Option<std::sync::Arc<crate::codemap::Snapshot>> {
        maps.entry(project.to_string()).or_insert_with(|| crate::codemap::snapshot(root).ok().map(|(map, _)| map)).clone()
    };
    let root_of = |project: &str| projects.iter().find(|(id, _)| id == project).map(|(_, root)| root.clone()).filter(|root| Path::new(root).is_dir());

    let mut outcomes: Vec<(String, Outcome, Option<Review>)> = Vec::new();
    for job in jobs {
        if !job.anchored {
            // A workspace memory may be about any of its repositories: each one is asked.
            let places: Vec<String> = match (&job.scope[..], &job.project_id) {
                ("workspace", _) => projects.iter().map(|(id, _)| id.clone()).collect(),
                (_, Some(project)) => vec![project.clone()],
                _ => Vec::new(),
            };
            let (paths, symbols) = candidates(&job.text);
            let mut anchors = Vec::new();
            let mut at_head = None;
            if !paths.is_empty() || !symbols.is_empty() {
                for project in &places {
                    let Some(root) = root_of(project) else { continue };
                    let map = if symbols.is_empty() && paths.iter().all(|p| Path::new(&root).join(p).exists()) { None } else { map_of(project, &root) };
                    let found = resolve(project, Path::new(&root), map.as_deref(), &paths, &symbols);
                    if !found.is_empty() && at_head.is_none() {
                        at_head = head(&root);
                    }
                    anchors.extend(found);
                }
            }
            anchors.truncate(MAX_ANCHORS);
            outcomes.push((job.id, Outcome::Anchored(anchors, at_head), job.review));
            continue;
        }
        let mut missing = Vec::new();
        let mut judged = false;
        let mut projects_of: Vec<&str> = job.anchors.iter().map(|a| a.project_id.as_str()).collect();
        projects_of.sort_unstable();
        projects_of.dedup();
        for project in projects_of {
            // A repository no longer on disk says nothing about the code: not judged.
            let Some(root) = root_of(project) else { continue };
            judged = true;
            let mine: Vec<&Anchor> = job.anchors.iter().filter(|a| a.project_id == project).collect();
            let map = if mine.iter().all(|a| a.symbol.is_none()) && mine.iter().all(|a| a.path.as_deref().is_some_and(|p| Path::new(&root).join(p).exists())) {
                None
            } else {
                map_of(project, &root)
            };
            missing.extend(check(Path::new(&root), map.as_deref(), &mine));
        }
        if !judged {
            continue;
        }
        outcomes.push((job.id, if missing.is_empty() { Outcome::Present } else { Outcome::Missing(missing) }, job.review));
    }

    crate::ai_usage::with_conn(|conn| apply(conn, outcomes)).unwrap_or_else(|| Err("the app's database is not available yet".to_string()))
}

/// Writes what a pass found. A contradiction a model reported stays as it is: the user has not seen
/// it yet, and a file being present does not answer it.
fn apply(conn: &Connection, outcomes: Vec<(String, Outcome, Option<Review>)>) -> Result<usize, String> {
    let at = now();
    let mut changed = 0;
    for (id, outcome, review) in outcomes {
        match outcome {
            Outcome::Anchored(anchors, at_head) => {
                conn.execute(
                    "UPDATE ai_memories SET anchors = ?1, anchored_at = ?2, anchor_head = ?3 WHERE id = ?4",
                    params![serde_json::to_string(&anchors).unwrap_or_else(|_| "[]".into()), at, at_head, id],
                )
                .map_err(|e| e.to_string())?;
            }
            Outcome::Present => match review.map(|r| r.reason) {
                // A model's doubt is not answered by a file being there.
                Some(Reason::Contradicted) => {}
                // What was missing is back (a branch switched back, a file restored): settled.
                Some(Reason::CodeChanged) => {
                    conn.execute("UPDATE ai_memories SET review = NULL, confirmed_at = ?1 WHERE id = ?2", params![at, id]).map_err(|e| e.to_string())?;
                    revise(conn, &id, "code_restored", "", "", "system").map_err(|e| e.to_string())?;
                    changed += 1;
                }
                None => {
                    conn.execute("UPDATE ai_memories SET confirmed_at = ?1 WHERE id = ?2", params![at, id]).map_err(|e| e.to_string())?;
                }
            },
            Outcome::Missing(missing) => {
                if review.as_ref().is_some_and(|r| r.reason == Reason::Contradicted || r.missing == missing) {
                    continue;
                }
                let flagged = Review { reason: Reason::CodeChanged, detail: String::new(), evidence: Vec::new(), missing, by: "system".into(), at };
                conn.execute("UPDATE ai_memories SET review = ?1 WHERE id = ?2", params![serde_json::to_string(&flagged).map_err(|e| e.to_string())?, id])
                    .map_err(|e| e.to_string())?;
                let what = flagged.missing.iter().filter_map(|m| m.path.clone().or_else(|| m.symbol.clone())).collect::<Vec<_>>().join(", ");
                revise(conn, &id, "code_changed", "", &what, "system").map_err(|e| e.to_string())?;
                changed += 1;
            }
        }
    }
    Ok(changed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn candidates_read_paths_and_code_names_but_not_urls_versions_or_words() {
        let (paths, symbols) = candidates(
            "Los tests usan Jest: la config vive en `jest.config.js` y src/money.ts:12 define `toCents`. \
             Ver https://example.com/docs, versión 1.2.3, y parse_amount() también. Nada de y/o.",
        );
        assert_eq!(paths, vec!["jest.config.js", "src/money.ts"]);
        assert!(symbols.contains(&"toCents".to_string()) && symbols.contains(&"parse_amount".to_string()), "{symbols:?}");
        assert!(!symbols.iter().any(|s| s == "Jest" || s == "tests"), "{symbols:?}");
        assert!(!paths.iter().any(|p| p.contains("example") || p == "1.2.3" || p == "y/o"), "{paths:?}");
    }

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE workspaces (id TEXT PRIMARY KEY); CREATE TABLE projects (id TEXT PRIMARY KEY); INSERT INTO workspaces VALUES ('w1'); INSERT INTO projects VALUES ('p1');").unwrap();
        crate::db::migrations::add_ai_platform_tables(&conn).unwrap();
        conn
    }

    fn approved(conn: &Connection, title: &str) -> Memory {
        let input = crate::ai_memory::NewMemory {
            scope: Some(crate::ai_memory::Scope::Project),
            workspace_id: Some("w1".into()),
            project_id: Some("p1".into()),
            kind: Some(crate::ai_memory::Kind::Convention),
            title: title.into(),
            approved: true,
            ..Default::default()
        };
        crate::ai_memory::create(conn, input).unwrap()
    }

    #[test]
    fn a_pass_sends_a_memory_whose_code_is_gone_to_review_and_settles_it_when_it_is_back() {
        let conn = db();
        let memory = approved(&conn, "La config de tests vive en jest.config.js");
        let get = |id: &str| crate::ai_memory::get(&conn, id).unwrap().unwrap();
        let anchor = Anchor { project_id: "p1".into(), path: Some("jest.config.js".into()), symbol: None };
        apply(&conn, vec![(memory.id.clone(), Outcome::Anchored(vec![anchor.clone()], Some("abc1234".into())), None)]).unwrap();
        let anchored = get(&memory.id);
        assert_eq!((anchored.anchors, anchored.anchor_head.as_deref()), (vec![anchor], Some("abc1234")));
        let gone = vec![Missing { path: Some("jest.config.js".into()), symbol: None, moved_to: None }];
        assert_eq!(apply(&conn, vec![(memory.id.clone(), Outcome::Missing(gone.clone()), None)]).unwrap(), 1);
        let flagged = get(&memory.id);
        assert!(flagged.needs_review);
        assert_eq!(flagged.review.as_ref().map(|r| (r.reason, r.missing.clone())), Some((Reason::CodeChanged, gone.clone())));
        // The same finding again changes nothing.
        assert_eq!(apply(&conn, vec![(memory.id.clone(), Outcome::Missing(gone), flagged.review.clone())]).unwrap(), 0);
        // Back (a branch switched back): settled, and counted as a confirmation.
        apply(&conn, vec![(memory.id.clone(), Outcome::Present, flagged.review.clone())]).unwrap();
        let back = get(&memory.id);
        assert!(back.review.is_none() && back.confirmed_at.is_some());
    }

    #[test]
    fn a_pass_leaves_a_models_contradiction_for_the_user() {
        let conn = db();
        let memory = approved(&conn, "Los montos pasan por toCents");
        let flagged = crate::ai_memory::flag(&conn, Some("w1"), Some("p1"), "Los montos pasan por toCents", "ya no existe", &[], "agent").unwrap();
        let gone = vec![Missing { path: None, symbol: Some("toCents".into()), moved_to: None }];
        apply(&conn, vec![(memory.id.clone(), Outcome::Missing(gone), flagged.review.clone())]).unwrap();
        apply(&conn, vec![(memory.id.clone(), Outcome::Present, flagged.review.clone())]).unwrap();
        let after = crate::ai_memory::get(&conn, &memory.id).unwrap().unwrap();
        assert_eq!(after.review.map(|r| r.reason), Some(Reason::Contradicted));
    }

    #[test]
    fn evidence_ids_are_not_paths() {
        let (paths, _) = candidates("experience:3f2a1 note:abc");
        assert!(paths.is_empty(), "{paths:?}");
    }

    #[test]
    fn a_path_is_an_anchor_only_when_the_repository_has_it_and_a_gone_one_is_reported() {
        let dir = std::env::temp_dir().join(format!("cf-anchor-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("jest.config.js"), "module.exports = {}").unwrap();
        std::fs::write(dir.join("src/money.ts"), "export const x = 1").unwrap();
        let paths = vec!["jest.config.js".to_string(), "src/money.ts".to_string(), "nope.ts".to_string()];
        let anchors = resolve("p1", &dir, None, &paths, &[]);
        assert_eq!(anchors.iter().filter_map(|a| a.path.as_deref()).collect::<Vec<_>>(), vec!["jest.config.js", "src/money.ts"]);
        std::fs::remove_file(dir.join("jest.config.js")).unwrap();
        let missing = check(&dir, None, &anchors.iter().collect::<Vec<_>>());
        assert_eq!(missing, vec![Missing { path: Some("jest.config.js".into()), symbol: None, moved_to: None }]);
        std::fs::remove_dir_all(&dir).ok();
    }
}
