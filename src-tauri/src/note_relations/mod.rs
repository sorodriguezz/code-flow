//! «Relacionadas»: which notes and meetings are about the same thing, which one picks up where
//! another left off, and what was settled between them.
//!
//! A meeting is rarely the first word on its subject. The decision taken on Monday is acted on in
//! Thursday's call, and the note written from each stood alone: nothing in Thursday's said what it
//! followed, and nothing in Monday's said whether what it left open was ever closed. A model asked
//! about either read one note and knew nothing of the other.
//!
//! **A pair, kept once.** `note_relations` holds one row per two notes, by which came later and
//! which earlier — the meeting's date when the note holds one, else when it was written. `related`
//! says they are about the same thing; `continues` that the later one follows the earlier, with
//! what the earlier left open and the later settled (`resolved`) or did not (`pending`).
//!
//! **Three ways a pair is made.** By their words alone ([`similar`], `origin = auto`) every time a
//! note is looked at after something changed — no model, nothing leaves the computer. By a model
//! that reads the note and its look-alikes and says which continue it and which only share words
//! ([`judge`], `origin = ai`). And by hand (`manual`), which no scan undoes. A pair the user
//! removed, or the model called a coincidence, stays as `dismissed` so the words do not bring it
//! back.
//!
//! **Preparing a meeting** reads the other way: from a subject typed before the meeting, the
//! earlier notes that speak of it ([`similar::search`]) and what they left open — [`prep_brief`],
//! which [`prep`] turns into what to know, ask and decide.
//!
//! **Models read them.** [`for_model`] is what `knowledge::read_note` puts under a note, so an
//! engine that reads one meeting learns which earlier one it continues and what is still open —
//! and can read that one too. A note in a local-only book is never named to a cloud engine.

pub mod judge;
pub mod prep;
pub mod similar;

use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// How many look-alikes a scan keeps for one note.
const MAX_ALIKE: usize = 6;
/// How many of a note's pairs one model call is asked about.
pub const MAX_JUDGED: usize = 6;

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS note_relations (
            id          TEXT PRIMARY KEY,
            -- The pair, once: which note came later and which earlier. See the module.
            later_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            earlier_id  TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
            -- 'related' · 'continues' (the later one follows the earlier).
            kind        TEXT NOT NULL DEFAULT 'related',
            reason      TEXT NOT NULL DEFAULT '',
            -- JSON arrays of strings: the words that made them alike; what the earlier note left
            -- open and the later settled; what it left open and is still open.
            shared      TEXT NOT NULL DEFAULT '[]',
            resolved    TEXT NOT NULL DEFAULT '[]',
            pending     TEXT NOT NULL DEFAULT '[]',
            -- 'auto' (their words) · 'ai' · 'manual'.
            origin      TEXT NOT NULL DEFAULT 'auto',
            -- 'linked' · 'dismissed' (removed by hand, or a coincidence: never offered again).
            status      TEXT NOT NULL DEFAULT 'linked',
            score       REAL NOT NULL DEFAULT 0,
            created_at  TEXT NOT NULL,
            updated_at  TEXT NOT NULL,
            UNIQUE (later_id, earlier_id)
        );
        CREATE INDEX IF NOT EXISTS idx_note_relations_earlier ON note_relations (earlier_id);
        -- When a note was last compared with the rest, and last read by a model.
        CREATE TABLE IF NOT EXISTS note_relation_scans (
            note_id     TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
            scanned_at  TEXT NOT NULL DEFAULT '',
            judged_at   TEXT NOT NULL DEFAULT ''
        );
        "#,
    )
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// A note related to the one being looked at.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationView {
    /// The other note.
    pub id: String,
    pub title: String,
    pub book_id: String,
    /// Its date: the meeting's when it holds one, else when it was written.
    pub when: String,
    /// Whether that note holds a meeting.
    pub meeting: bool,
    /// `earlier` — it came before this one — or `later`.
    pub direction: &'static str,
    /// `related` · `continues`.
    pub kind: String,
    pub reason: String,
    pub shared: Vec<String>,
    pub resolved: Vec<String>,
    pub pending: Vec<String>,
    /// `auto` · `ai` · `manual`.
    pub origin: String,
}

fn list_of(json: &str) -> Vec<String> {
    serde_json::from_str(json).unwrap_or_default()
}

/// What decides which of two notes came later: the latest meeting it holds, else its creation.
const WHEN: &str = "COALESCE((SELECT MAX(m.started_at) FROM meetings m WHERE m.note_id = n.id), n.created_at)";

/// The notes `note_id` is related to, the ones it continues or that continue it first, the newest
/// first within each. `workspace_id`: only notes on that workspace's shelf (its own and the global
/// ones) — `None` for whatever the note itself can see.
pub fn list_for(conn: &Connection, note_id: &str, workspace_id: Option<&str>) -> rusqlite::Result<Vec<RelationView>> {
    let mut statement = conn.prepare(&format!(
        "SELECT r.later_id, r.kind, r.reason, r.shared, r.resolved, r.pending, r.origin,
                n.id, n.title, COALESCE(n.book_id, ''), {WHEN},
                EXISTS (SELECT 1 FROM meetings m WHERE m.note_id = n.id)
         FROM note_relations r
         JOIN notes n ON n.id = CASE WHEN r.later_id = ?1 THEN r.earlier_id ELSE r.later_id END
         WHERE (r.later_id = ?1 OR r.earlier_id = ?1) AND r.status = 'linked' AND n.deleted_at = ''
           AND (?2 IS NULL OR n.scope = 'global' OR n.workspace_id = ?2)
         ORDER BY CASE r.kind WHEN 'continues' THEN 0 ELSE 1 END, 11 DESC, r.score DESC"
    ))?;
    let rows = statement
        .query_map(params![note_id, workspace_id], |row| {
            let later: String = row.get(0)?;
            Ok(RelationView {
                direction: if later == note_id { "earlier" } else { "later" },
                kind: row.get(1)?,
                reason: row.get(2)?,
                shared: list_of(&row.get::<_, String>(3)?),
                resolved: list_of(&row.get::<_, String>(4)?),
                pending: list_of(&row.get::<_, String>(5)?),
                origin: row.get(6)?,
                id: row.get(7)?,
                title: row.get(8)?,
                book_id: row.get(9)?,
                when: row.get(10)?,
                meeting: row.get(11)?,
            })
        })?
        .collect();
    rows
}

/// Every pair of live, related notes a workspace sees, as `(later, earlier, kind)` — the graph's
/// second kind of edge.
pub fn edges(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<(String, String, String)>> {
    let mut statement = conn.prepare(
        "SELECT r.later_id, r.earlier_id, r.kind FROM note_relations r
         JOIN notes a ON a.id = r.later_id JOIN notes b ON b.id = r.earlier_id
         WHERE r.status = 'linked' AND a.deleted_at = '' AND b.deleted_at = ''
           AND (a.scope = 'global' OR a.workspace_id = ?1) AND (b.scope = 'global' OR b.workspace_id = ?1)",
    )?;
    let rows = statement.query_map(params![workspace_id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?.collect();
    rows
}

/// A note as the scan reads it.
struct Loaded {
    id: String,
    title: String,
    tags: Vec<String>,
    body: String,
    /// What was said in its meetings, in order.
    said: String,
    when: String,
}

impl Loaded {
    /// Everything it says, for comparing.
    fn text(&self) -> String {
        if self.said.is_empty() { self.body.clone() } else { format!("{}\n{}", self.body, self.said) }
    }
}

/// How much of a note's meetings is read for comparing it.
const MAX_SAID: usize = 30_000;

/// The live notes `note_id` can be compared with — its workspace's and the global ones, itself
/// included — or nothing when it is gone.
fn corpus(conn: &Connection, note_id: &str) -> rusqlite::Result<Vec<Loaded>> {
    let home: Option<String> = conn.query_row("SELECT workspace_id FROM notes WHERE id = ?1 AND deleted_at = ''", params![note_id], |row| row.get(0)).optional()?;
    let Some(home) = home else { return Ok(Vec::new()) };
    let mut statement = conn.prepare(&format!(
        "SELECT n.id, n.title, n.tags, n.content, {WHEN} FROM notes n
         WHERE (n.workspace_id = ?1 OR n.scope = 'global' OR n.id = ?2) AND n.deleted_at = ''"
    ))?;
    let mut notes: Vec<Loaded> = statement
        .query_map(params![home, note_id], |row| {
            Ok(Loaded { id: row.get(0)?, title: row.get(1)?, tags: list_of(&row.get::<_, String>(2)?), body: row.get(3)?, said: String::new(), when: row.get(4)? })
        })?
        .collect::<rusqlite::Result<_>>()?;
    let at: HashMap<String, usize> = notes.iter().enumerate().map(|(index, note)| (note.id.clone(), index)).collect();
    let mut statement = conn.prepare(
        "SELECT m.note_id, l.text FROM meeting_lines l JOIN meetings m ON m.id = l.meeting_id ORDER BY m.started_at, l.start_ms, l.seq",
    )?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        let Some(&index) = at.get(&row.get::<_, String>(0)?) else { continue };
        let said = &mut notes[index].said;
        if said.len() < MAX_SAID {
            said.push_str(&row.get::<_, String>(1)?);
            said.push('\n');
        }
    }
    Ok(notes)
}

/// `(later, earlier)` of two notes.
fn ordered<'a>(a: (&'a str, &'a str), b: (&'a str, &'a str)) -> (&'a str, &'a str) {
    // By date, and by id when two share one, so a pair is always stored the same way round.
    if (a.1, a.0) >= (b.1, b.0) { (a.0, b.0) } else { (b.0, a.0) }
}

struct Pair {
    other: String,
    origin: String,
    status: String,
}

/// Every row `note_id` is in, whatever its status.
fn pairs(conn: &Connection, note_id: &str) -> rusqlite::Result<Vec<Pair>> {
    let mut statement = conn.prepare(
        "SELECT CASE WHEN later_id = ?1 THEN earlier_id ELSE later_id END, origin, status FROM note_relations WHERE later_id = ?1 OR earlier_id = ?1",
    )?;
    let rows = statement.query_map(params![note_id], |row| Ok(Pair { other: row.get(0)?, origin: row.get(1)?, status: row.get(2)? }))?.collect();
    rows
}

/// Whether anything was written since `note_id` was last compared — a note or a meeting, anywhere:
/// a look-alike may have appeared, or stopped being one.
pub fn stale(conn: &Connection, note_id: &str) -> rusqlite::Result<bool> {
    let scanned: String = conn.query_row("SELECT scanned_at FROM note_relation_scans WHERE note_id = ?1", params![note_id], |row| row.get(0)).optional()?.unwrap_or_default();
    if scanned.is_empty() {
        return Ok(true);
    }
    let changed: String = conn.query_row(
        "SELECT MAX(at) FROM (SELECT COALESCE(MAX(updated_at), '') AS at FROM notes UNION ALL SELECT COALESCE(MAX(updated_at), '') FROM meetings)",
        [],
        |row| row.get(0),
    )?;
    Ok(changed > scanned)
}

/// Compares `note_id` with every note it can see and keeps the pairs their words make: new
/// look-alikes are linked, the ones made by words alone that no longer look alike are dropped, and
/// what a model or the user decided is left as it is. Returns how many look-alikes it found.
pub fn scan(conn: &Connection, note_id: &str) -> Result<usize, String> {
    let db = |e: rusqlite::Error| e.to_string();
    let notes = corpus(conn, note_id).map_err(db)?;
    let Some(own) = notes.iter().find(|note| note.id == note_id) else { return Err("The note no longer exists".into()) };
    let texts: Vec<String> = notes.iter().map(Loaded::text).collect();
    let doc = |index: usize| similar::Doc { id: &notes[index].id, title: &notes[index].title, tags: &notes[index].tags, text: &texts[index] };
    let own_index = notes.iter().position(|note| note.id == note_id).unwrap_or(0);
    let others: Vec<similar::Doc<'_>> = (0..notes.len()).filter(|index| *index != own_index).map(doc).collect();
    let matches = similar::rank(&doc(own_index), &others, MAX_ALIKE);

    let existing = pairs(conn, note_id).map_err(db)?;
    let known: HashMap<&str, &Pair> = existing.iter().map(|pair| (pair.other.as_str(), pair)).collect();
    let alike: HashSet<&str> = matches.iter().map(|m| m.id.as_str()).collect();
    let stamp = now();
    for found in &matches {
        let Some(other) = notes.iter().find(|note| note.id == found.id) else { continue };
        let (later, earlier) = ordered((&own.id, &own.when), (&other.id, &other.when));
        let shared = serde_json::to_string(&found.shared).unwrap_or_else(|_| "[]".into());
        match known.get(found.id.as_str()) {
            None => {
                conn.execute(
                    "INSERT INTO note_relations (id, later_id, earlier_id, kind, shared, origin, status, score, created_at, updated_at)
                     VALUES (?1, ?2, ?3, 'related', ?4, 'auto', 'linked', ?5, ?6, ?6)",
                    params![uuid::Uuid::new_v4().to_string(), later, earlier, shared, found.score as f64, stamp],
                )
                .map_err(db)?;
            }
            // What they share is kept current on every pair; who made it and what it says is not touched.
            Some(_) => {
                conn.execute(
                    "UPDATE note_relations SET shared = ?1, score = ?2 WHERE (later_id = ?3 AND earlier_id = ?4) OR (later_id = ?4 AND earlier_id = ?3)",
                    params![shared, found.score as f64, own.id, other.id],
                )
                .map_err(db)?;
            }
        }
    }
    for pair in existing.iter().filter(|pair| pair.origin == "auto" && pair.status == "linked" && !alike.contains(pair.other.as_str())) {
        conn.execute(
            "DELETE FROM note_relations WHERE origin = 'auto' AND ((later_id = ?1 AND earlier_id = ?2) OR (later_id = ?2 AND earlier_id = ?1))",
            params![note_id, pair.other],
        )
        .map_err(db)?;
    }
    conn.execute(
        "INSERT INTO note_relation_scans (note_id, scanned_at) VALUES (?1, ?2) ON CONFLICT(note_id) DO UPDATE SET scanned_at = excluded.scanned_at",
        params![note_id, stamp],
    )
    .map_err(db)?;
    Ok(matches.len())
}

/// Links two notes by hand: a pair no scan undoes. One that was dismissed comes back.
pub fn link(conn: &Connection, note_id: &str, other_id: &str) -> Result<(), String> {
    if note_id == other_id {
        return Err("A note is not related to itself".into());
    }
    let db = |e: rusqlite::Error| e.to_string();
    let when = |id: &str| -> Result<(String, String, String), String> {
        conn.query_row(&format!("SELECT {WHEN}, n.workspace_id, n.scope FROM notes n WHERE n.id = ?1 AND n.deleted_at = ''"), params![id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .optional()
            .map_err(db)?
            .ok_or_else(|| "The note no longer exists".to_string())
    };
    let (own_when, own_home, _) = when(note_id)?;
    let (other_when, other_home, other_scope) = when(other_id)?;
    if other_scope != "global" && other_home != own_home {
        return Err("That note is in another workspace".into());
    }
    let (later, earlier) = ordered((note_id, &own_when), (other_id, &other_when));
    let stamp = now();
    conn.execute(
        "INSERT INTO note_relations (id, later_id, earlier_id, kind, origin, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'related', 'manual', 'linked', ?4, ?4)
         ON CONFLICT(later_id, earlier_id) DO UPDATE SET origin = 'manual', status = 'linked', updated_at = excluded.updated_at",
        params![uuid::Uuid::new_v4().to_string(), later, earlier, stamp],
    )
    .map_err(db)?;
    // The same two notes the other way round — written before one of them got its meeting.
    conn.execute("DELETE FROM note_relations WHERE later_id = ?1 AND earlier_id = ?2", params![earlier, later]).map_err(db)?;
    Ok(())
}

/// Takes a pair apart for good: it stays as dismissed, so their words do not bring it back.
pub fn unlink(conn: &Connection, note_id: &str, other_id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE note_relations SET status = 'dismissed', updated_at = ?3 WHERE (later_id = ?1 AND earlier_id = ?2) OR (later_id = ?2 AND earlier_id = ?1)",
        params![note_id, other_id, now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// A note and the pairs of it a model is to read.
pub struct Brief {
    pub main: judge::Shown,
    /// Each candidate and whether it came later than the note.
    pub candidates: Vec<(judge::Shown, bool)>,
    /// The note is in a local-only book: only a local model may read this.
    pub local_only: bool,
    /// The note holds a meeting.
    pub meeting: bool,
}

/// What a model is shown of a note: its body, or what was said when the body is still short.
fn shown(note: &Loaded) -> judge::Shown {
    let body = note.body.trim();
    let text = if body.chars().count() >= 400 || note.said.is_empty() { body.to_string() } else { format!("{body}\n\n{}", note.said.trim()) };
    let (text, _) = crate::secret_scan::redact(&text);
    let (title, _) = crate::secret_scan::redact(&note.title);
    judge::Shown { id: note.id.clone(), title, date: note.when.chars().take(10).collect(), text }
}

/// What to ask a model about `note_id`: its linked pairs, the likeliest first. `cloud`: the model
/// is not on this computer, so candidates in a local-only book are left out. `None` when there is
/// nothing to ask about.
pub fn brief(conn: &Connection, note_id: &str, cloud: bool) -> Result<Option<Brief>, String> {
    let db = |e: rusqlite::Error| e.to_string();
    let notes = corpus(conn, note_id).map_err(db)?;
    let Some(own) = notes.iter().find(|note| note.id == note_id) else { return Err("The note no longer exists".into()) };
    let local = |id: &str| crate::db::meeting_queries::note_is_local_only(conn, id).unwrap_or(true);
    let mut statement = conn
        .prepare(
            "SELECT CASE WHEN later_id = ?1 THEN earlier_id ELSE later_id END, later_id = ?1 FROM note_relations
             WHERE (later_id = ?1 OR earlier_id = ?1) AND status = 'linked' ORDER BY score DESC, updated_at DESC",
        )
        .map_err(db)?;
    let rows: Vec<(String, bool)> = statement.query_map(params![note_id], |row| Ok((row.get(0)?, row.get(1)?))).map_err(db)?.collect::<rusqlite::Result<_>>().map_err(db)?;
    let candidates: Vec<(judge::Shown, bool)> = rows
        .into_iter()
        .filter_map(|(other, own_is_later)| notes.iter().find(|note| note.id == other).map(|note| (note, !own_is_later)))
        .filter(|(note, _)| !(cloud && local(&note.id)))
        .take(MAX_JUDGED)
        .map(|(note, later)| (shown(note), later))
        .collect();
    if candidates.is_empty() {
        return Ok(None);
    }
    let meeting: bool = conn.query_row("SELECT EXISTS (SELECT 1 FROM meetings WHERE note_id = ?1)", params![note_id], |row| row.get(0)).map_err(db)?;
    Ok(Some(Brief { main: shown(own), candidates, local_only: local(note_id), meeting }))
}

/// How many earlier notes a preparation reads.
pub const MAX_PREP_SOURCES: usize = 6;

/// What a model is given to prepare the meeting `note_id` is about.
pub struct PrepBrief {
    /// What the note already says, as written.
    pub own: String,
    /// The earlier notes that speak of the subject, the likeliest first.
    pub sources: Vec<judge::Shown>,
    /// What earlier comparisons found still open between those notes: the later note's title and
    /// its pending lines.
    pub open: Vec<(String, Vec<String>)>,
    /// The note is in a local-only book: only a local model may read this.
    pub local_only: bool,
}

/// What to show a model so it can prepare the meeting about `topic` that `note_id` is for: the
/// notes of its workspace (and the global ones) that say the most of the topic's words, other than
/// itself. `cloud`: the model is not on this computer, so notes in a local-only book are left out.
pub fn prep_brief(conn: &Connection, note_id: &str, topic: &str, cloud: bool) -> Result<PrepBrief, String> {
    let db = |e: rusqlite::Error| e.to_string();
    let notes = corpus(conn, note_id).map_err(db)?;
    let Some(own) = notes.iter().find(|note| note.id == note_id) else { return Err("The note no longer exists".into()) };
    let local = |id: &str| crate::db::meeting_queries::note_is_local_only(conn, id).unwrap_or(true);
    let texts: Vec<String> = notes.iter().map(Loaded::text).collect();
    let others: Vec<similar::Doc<'_>> = notes
        .iter()
        .zip(&texts)
        .filter(|(note, _)| note.id != note_id && !(cloud && local(&note.id)))
        .map(|(note, text)| similar::Doc { id: &note.id, title: &note.title, tags: &note.tags, text })
        .collect();
    let found = similar::search(topic, &others, MAX_PREP_SOURCES);
    let sources: Vec<judge::Shown> = found.iter().filter_map(|hit| notes.iter().find(|note| note.id == hit.id)).map(shown).collect();
    let mut open = Vec::new();
    let mut statement = conn
        .prepare("SELECT n.title, r.pending FROM note_relations r JOIN notes n ON n.id = r.later_id WHERE r.later_id = ?1 AND r.kind = 'continues' AND r.status = 'linked' AND r.pending <> '[]'")
        .map_err(db)?;
    for source in &sources {
        let rows: Vec<(String, String)> = statement.query_map(params![source.id], |row| Ok((row.get(0)?, row.get(1)?))).map_err(db)?.collect::<rusqlite::Result<_>>().map_err(db)?;
        for (title, pending) in rows {
            let pending = list_of(&pending);
            if !pending.is_empty() {
                let (title, _) = crate::secret_scan::redact(&title);
                open.push((title, pending.into_iter().map(|line| crate::secret_scan::redact(&line).0).collect()));
            }
        }
    }
    let (own_text, _) = crate::secret_scan::redact(own.body.trim());
    Ok(PrepBrief { own: own_text, sources, open, local_only: local(note_id) })
}

/// Writes down what a model said of `note_id`'s pairs. A coincidence is dismissed — unless the
/// user linked the two by hand, which a model does not undo.
pub fn apply(conn: &Connection, note_id: &str, verdicts: &[judge::Verdict]) -> Result<(), String> {
    let db = |e: rusqlite::Error| e.to_string();
    let stamp = now();
    for verdict in verdicts {
        let pair = "((later_id = ?1 AND earlier_id = ?2) OR (later_id = ?2 AND earlier_id = ?1))";
        if verdict.kind == "none" {
            conn.execute(&format!("UPDATE note_relations SET status = 'dismissed', origin = 'ai', updated_at = ?3 WHERE {pair} AND origin != 'manual'"), params![note_id, verdict.id, stamp]).map_err(db)?;
            continue;
        }
        conn.execute(
            &format!(
                "UPDATE note_relations SET kind = ?3, reason = ?4, resolved = ?5, pending = ?6,
                        origin = CASE origin WHEN 'manual' THEN 'manual' ELSE 'ai' END, updated_at = ?7
                 WHERE {pair} AND status = 'linked'"
            ),
            params![
                note_id,
                verdict.id,
                verdict.kind,
                verdict.reason,
                serde_json::to_string(&verdict.resolved).unwrap_or_else(|_| "[]".into()),
                serde_json::to_string(&verdict.pending).unwrap_or_else(|_| "[]".into()),
                stamp
            ],
        )
        .map_err(db)?;
    }
    conn.execute(
        "INSERT INTO note_relation_scans (note_id, judged_at) VALUES (?1, ?2) ON CONFLICT(note_id) DO UPDATE SET judged_at = excluded.judged_at",
        params![note_id, stamp],
    )
    .map_err(db)?;
    Ok(())
}

/// What a model is told under a note it reads: the notes it is related to, by id, and what moved
/// between them. Empty when there are none. `cloud` leaves out every note in a local-only book.
pub fn for_model(conn: &Connection, workspace_id: Option<&str>, note_id: &str, cloud: bool) -> String {
    let Ok(rows) = list_for(conn, note_id, workspace_id) else { return String::new() };
    let lines: Vec<String> = rows
        .iter()
        .filter(|row| !(cloud && crate::db::meeting_queries::note_is_local_only(conn, &row.id).unwrap_or(true)))
        .map(|row| {
            let title = if row.title.trim().is_empty() { "untitled" } else { row.title.trim() };
            let date: String = row.when.chars().take(10).collect();
            let head = match (row.kind.as_str(), row.direction) {
                ("continues", "earlier") => format!("This note continues note:{} — «{title}» ({date})", row.id),
                ("continues", _) => format!("Continued in note:{} — «{title}» ({date})", row.id),
                _ => format!("Related: note:{} — «{title}» ({date}, {})", row.id, if row.direction == "earlier" { "earlier" } else { "later" }),
            };
            let mut line = head;
            if !row.reason.is_empty() {
                line.push_str(&format!(": {}", row.reason.trim_end_matches('.')));
            } else if !row.shared.is_empty() {
                line.push_str(&format!(": both are about {}", row.shared.join(", ")));
            }
            line.push('.');
            let settled_in = if row.direction == "earlier" { "Settled here" } else { "Settled there" };
            if !row.resolved.is_empty() {
                line.push_str(&format!(" {settled_in}: {}.", row.resolved.join("; ")));
            }
            if !row.pending.is_empty() {
                line.push_str(&format!(" Still open: {}.", row.pending.join("; ")));
            }
            format!("- {line}")
        })
        .collect();
    if lines.is_empty() {
        return String::new();
    }
    format!("Related notes of the user (read one with read_note to see what was said):\n{}", lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn.execute_batch(
            "DELETE FROM workspaces;
             INSERT INTO workspaces (id, name, icon, color, sort_order, created_at) VALUES ('w1', 'Flow', 'book', '#111', 0, '2026-01-01T00:00:00+00:00');
             INSERT INTO workspaces (id, name, icon, color, sort_order, created_at) VALUES ('w2', 'Otro', 'book', '#111', 1, '2026-01-01T00:00:00+00:00');
             INSERT INTO note_books (id, workspace_id, parent_id, name, color, sort_order, created_at, updated_at) VALUES ('b1', 'w1', NULL, 'Cuaderno', '', 0, '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
             INSERT INTO note_books (id, workspace_id, parent_id, name, color, sort_order, created_at, updated_at) VALUES ('b2', 'w2', NULL, 'Otro', '', 0, '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');
             INSERT INTO note_books (id, workspace_id, parent_id, name, color, sort_order, local_only, created_at, updated_at) VALUES ('secret', 'w1', NULL, 'Privado', '', 1, 1, '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00');",
        )
        .unwrap();
        conn
    }

    /// A note written on `day` of November.
    fn note(conn: &Connection, id: &str, workspace: &str, book: &str, day: u8, title: &str, body: &str) {
        let at = format!("2024-11-{day:02}T10:00:00+00:00");
        conn.execute(
            "INSERT INTO notes (id, workspace_id, book_id, title, content, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![id, workspace, book, title, body, at],
        )
        .unwrap();
    }

    const OUTBOX: &str = "Se acordó usar el patrón outbox para publicar los eventos de citas. El DBA crea la tabla outbox con un índice por estado y falta definir el schema.";
    const FOLLOW: &str = "La tabla outbox ya está creada con su índice por estado. Los eventos de citas se publican; el schema quedó como eventos.";

    fn seeded() -> Connection {
        let conn = workspace();
        note(&conn, "plan", "w1", "b1", 10, "Outbox para las citas", OUTBOX);
        note(&conn, "follow", "w1", "b1", 17, "Seguimiento del outbox", FOLLOW);
        note(&conn, "other", "w1", "b1", 12, "Vacaciones", "Calendario de vacaciones de diciembre y quién cubre las guardias de soporte.");
        conn
    }

    #[test]
    fn notes_about_the_same_thing_are_linked_from_either_side_by_date() {
        let conn = seeded();
        assert!(stale(&conn, "follow").unwrap());
        assert_eq!(scan(&conn, "follow").unwrap(), 1);
        assert!(!stale(&conn, "follow").unwrap());

        let seen = list_for(&conn, "follow", Some("w1")).unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!((seen[0].id.as_str(), seen[0].direction, seen[0].kind.as_str(), seen[0].origin.as_str()), ("plan", "earlier", "related", "auto"));
        assert!(seen[0].shared.iter().any(|w| w == "outbox"), "{:?}", seen[0].shared);
        // The same pair, read from the other note.
        let back = list_for(&conn, "plan", Some("w1")).unwrap();
        assert_eq!((back[0].id.as_str(), back[0].direction), ("follow", "later"));
        // Scanning the other side does not make a second row of it.
        scan(&conn, "plan").unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM note_relations", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert_eq!(edges(&conn, "w1").unwrap(), vec![("follow".to_string(), "plan".to_string(), "related".to_string())]);
    }

    #[test]
    fn a_pair_made_by_words_goes_when_the_words_go_and_one_removed_by_hand_stays_gone() {
        let conn = seeded();
        scan(&conn, "follow").unwrap();
        conn.execute("UPDATE notes SET content = 'Lista de compras: pan, leche y café.', updated_at = '2999-01-01T00:00:00+00:00' WHERE id = 'follow'", []).unwrap();
        assert!(stale(&conn, "follow").unwrap());
        assert_eq!(scan(&conn, "follow").unwrap(), 0);
        assert!(list_for(&conn, "plan", None).unwrap().is_empty());

        conn.execute("UPDATE notes SET content = ?1 WHERE id = 'follow'", params![FOLLOW]).unwrap();
        scan(&conn, "follow").unwrap();
        unlink(&conn, "plan", "follow").unwrap();
        assert!(list_for(&conn, "follow", None).unwrap().is_empty());
        scan(&conn, "follow").unwrap();
        scan(&conn, "plan").unwrap();
        assert!(list_for(&conn, "follow", None).unwrap().is_empty(), "their words do not bring it back");
        // By hand it comes back, and stays whatever the words say.
        link(&conn, "follow", "other").unwrap();
        link(&conn, "plan", "follow").unwrap();
        scan(&conn, "follow").unwrap();
        let ids: Vec<String> = list_for(&conn, "follow", None).unwrap().into_iter().map(|r| r.id).collect();
        assert!(ids.contains(&"other".to_string()) && ids.contains(&"plan".to_string()), "{ids:?}");
        assert!(link(&conn, "plan", "plan").is_err());
    }

    #[test]
    fn what_a_model_says_is_kept_and_a_coincidence_is_dismissed() {
        let conn = seeded();
        note(&conn, "noise", "w1", "b1", 15, "Outbox del correo", "La bandeja outbox del correo tiene eventos de citas atascados por estado en la tabla.");
        scan(&conn, "follow").unwrap();
        let brief = brief(&conn, "follow", true).unwrap().unwrap();
        assert_eq!(brief.main.id, "follow");
        assert!(brief.candidates.iter().all(|(_, later)| !later), "both came before it");
        assert!(!brief.local_only && !brief.meeting);

        let verdicts = judge::parse(
            "{\"relations\": [{\"id\": \"plan\", \"kind\": \"continues\", \"reason\": \"Da seguimiento al outbox de citas.\", \"resolved\": [\"La tabla outbox está creada\"], \"pending\": [\"Nombre del schema\"]}, {\"id\": \"noise\", \"kind\": \"none\"}]}",
            &["plan".to_string(), "noise".to_string()],
        )
        .unwrap();
        apply(&conn, "follow", &verdicts).unwrap();
        let seen = list_for(&conn, "follow", None).unwrap();
        assert_eq!(seen.len(), 1, "{seen:?}");
        assert_eq!((seen[0].kind.as_str(), seen[0].origin.as_str(), seen[0].direction), ("continues", "ai", "earlier"));
        assert_eq!(seen[0].resolved, vec!["La tabla outbox está creada"]);
        // The coincidence does not come back with the next scan, and the verdict is not undone by it.
        scan(&conn, "follow").unwrap();
        let seen = list_for(&conn, "follow", None).unwrap();
        assert_eq!((seen.len(), seen[0].kind.as_str()), (1, "continues"));

        let told = for_model(&conn, Some("w1"), "follow", true);
        assert!(told.contains("This note continues note:plan — «Outbox para las citas» (2024-11-10): Da seguimiento al outbox de citas. Settled here: La tabla outbox está creada. Still open: Nombre del schema."), "{told}");
        let told = for_model(&conn, Some("w1"), "plan", true);
        assert!(told.contains("Continued in note:follow") && told.contains("Settled there:"), "{told}");
        assert_eq!(for_model(&conn, Some("w1"), "other", true), "");
        // It is what a model gets under the note it reads.
        let read = crate::knowledge::read_note(&conn, Some("w1"), "follow", false).unwrap();
        assert!(read.contains(FOLLOW) && read.contains("This note continues note:plan"), "{read}");
        assert!(!crate::knowledge::read_note(&conn, Some("w1"), "other", false).unwrap().contains("Related notes"));
    }

    #[test]
    fn a_meeting_s_date_and_what_was_said_in_it_count() {
        let conn = workspace();
        note(&conn, "plan", "w1", "b1", 10, "Outbox para las citas", OUTBOX);
        // Written first, but its meeting was held after the plan: it is the later one.
        note(&conn, "call", "w1", "b1", 1, "Llamada del jueves", "");
        conn.execute_batch(
            "INSERT INTO meetings (id, workspace_id, note_id, started_at, created_at, updated_at) VALUES ('m1', 'w1', 'call', '2024-11-20T15:00:00+00:00', '2024-11-20T15:00:00+00:00', '2024-11-20T16:00:00+00:00');
             INSERT INTO meeting_lines (meeting_id, seq, channel, speaker, start_ms, end_ms, text) VALUES
               ('m1', 1, 'mic', 'me', 0, 4000, 'Revisemos el outbox de citas: la tabla outbox ya tiene su índice por estado.'),
               ('m1', 2, 'system', 's1', 4000, 9000, 'Sí, los eventos de citas ya se publican y el schema quedó definido.');",
        )
        .unwrap();
        assert_eq!(scan(&conn, "call").unwrap(), 1);
        let seen = list_for(&conn, "call", None).unwrap();
        assert_eq!((seen[0].id.as_str(), seen[0].direction), ("plan", "earlier"));
        let back = list_for(&conn, "plan", None).unwrap();
        assert!(back[0].meeting && back[0].when.starts_with("2024-11-20"), "{back:?}");
        // A body still empty: the model is shown what was said.
        let brief = brief(&conn, "call", true).unwrap().unwrap();
        assert!(brief.meeting && brief.main.text.contains("ya se publican"), "{}", brief.main.text);
    }

    #[test]
    fn a_preparation_reads_the_earlier_notes_on_its_subject_and_what_they_left_open() {
        let conn = seeded();
        note(&conn, "private", "w1", "secret", 16, "Outbox: detalle privado", FOLLOW);
        // The follow-up is known to continue the plan, with something still open.
        scan(&conn, "follow").unwrap();
        let verdicts = judge::parse("{\"relations\": [{\"id\": \"plan\", \"kind\": \"continues\", \"reason\": \"Sigue el outbox.\", \"pending\": [\"Nombre del schema\"]}]}", &["plan".to_string()]).unwrap();
        apply(&conn, "follow", &verdicts).unwrap();
        note(&conn, "prep", "w1", "b1", 20, "Preparación — Cierre del outbox", "## Preguntas que quiero hacer\n- [ ] ¿Quién mide el disco?");

        let brief = prep_brief(&conn, "prep", "Cierre del outbox de citas", true).unwrap();
        let ids: Vec<&str> = brief.sources.iter().map(|shown| shown.id.as_str()).collect();
        assert!(ids.contains(&"plan") && ids.contains(&"follow"), "{ids:?}");
        assert!(!ids.contains(&"prep") && !ids.contains(&"other"), "never itself, never a note on something else: {ids:?}");
        assert!(!ids.contains(&"private"), "a local-only note is not shown to a cloud engine");
        assert_eq!(brief.open, vec![("Seguimiento del outbox".to_string(), vec!["Nombre del schema".to_string()])]);
        assert!(brief.own.contains("¿Quién mide el disco?") && !brief.local_only);
        // A local model may read the private one; a subject nothing speaks of finds nothing.
        assert!(prep_brief(&conn, "prep", "Cierre del outbox de citas", false).unwrap().sources.iter().any(|shown| shown.id == "private"));
        assert!(prep_brief(&conn, "prep", "Migración a Kubernetes", true).unwrap().sources.is_empty());
    }

    #[test]
    fn other_workspaces_the_trash_and_local_only_books_stay_out() {
        let conn = seeded();
        note(&conn, "far", "w2", "b2", 16, "Outbox para las citas", OUTBOX);
        note(&conn, "private", "w1", "secret", 16, "Outbox: detalle privado", FOLLOW);
        scan(&conn, "follow").unwrap();
        let ids: Vec<String> = list_for(&conn, "follow", Some("w1")).unwrap().into_iter().map(|r| r.id).collect();
        assert!(!ids.contains(&"far".to_string()), "another workspace's note is never compared: {ids:?}");
        assert!(ids.contains(&"private".to_string()));
        assert!(link(&conn, "follow", "far").is_err());

        // A cloud engine is neither shown the local-only note nor told it exists.
        let brief = brief(&conn, "follow", true).unwrap().unwrap();
        assert!(brief.candidates.iter().all(|(shown, _)| shown.id != "private"));
        assert!(!for_model(&conn, Some("w1"), "follow", true).contains("private"));
        assert!(for_model(&conn, Some("w1"), "follow", false).contains("note:private"));
        // And a note in that book is for a local model only.
        scan(&conn, "private").unwrap();
        assert!(super::brief(&conn, "private", false).unwrap().unwrap().local_only);

        conn.execute("UPDATE notes SET deleted_at = '2024-11-21T00:00:00+00:00' WHERE id = 'plan'", []).unwrap();
        assert!(list_for(&conn, "follow", None).unwrap().iter().all(|r| r.id != "plan"));
        assert!(scan(&conn, "plan").is_err());
    }
}
