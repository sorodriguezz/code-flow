//! The Memory Engine: what CodeFlow remembers between conversations — owned by the app, so a
//! decision learned while working with Qwen is there when working with Nemotron, or with Claude.
//!
//! Four scopes, narrowest wins: `global` (preferences that hold everywhere), `workspace`, `project`
//! (a repository's decisions and conventions) and `task`. A memory is a **candidate** until the user
//! approves it, then **approved**; it can be edited (each change kept in `ai_memory_revisions`),
//! revoked, replaced by a newer one (`supersedes`) or left to expire. Only approved memories are ever
//! shown to a model.
//!
//! **Who asks decides what is seen**, as with knowledge: a memory marked local-only never reaches a
//! cloud engine. And the user's explicit "recuerda que…" / "remember that…" in a chat is a memory
//! approved by the person who wrote it — the one case that skips the candidate step. That case goes
//! through [`remember`], which says what really happened ([`Remembered`]): a chat that answered
//! "learned" while the rule sat unapproved as somebody else's candidate was lying to the user.
//!
//! Two doors, then, and they differ on purpose:
//! - [`remember`] is the user speaking. An existing candidate with the same title is the user
//!   confirming it (approved, their wording wins); an approved one with a new body is the user
//!   correcting it (a new revision).
//! - [`propose`] (and [`create`] for anything not approved) is an agent, a flow or the experience
//!   log suggesting. A near-duplicate of something already there — same title, same body, or a
//!   title that is a phrase of another's — is folded into it as evidence and a `proposed` revision,
//!   never a second row the user has to triage twice. And a proposal with no kind is a `fact`, not
//!   a `preference`: a preference rides every turn once approved, and an agent should not be able to
//!   make something always-on by forgetting to say what it is.
//!
//! What a model is shown ([`note`]) carries each memory's kind and the day the user approved it, so
//! the model can weigh a three-month-old convention against the code in front of it — and it is
//! told to say so when they disagree, not to pick one silently. A memory nobody has used in
//! [`STALE_DAYS`] is flagged `stale` for the Memory pane to show as «sin uso»; nothing is deleted on
//! a timer, since a rule that is rarely needed is not therefore wrong.

use rusqlite::{params, types::Value as SqlValue, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// Days without use (counted from the last use, or from the approval when it was never used) after
/// which an approved memory is flagged for review. A flag, not a deletion.
pub const STALE_DAYS: i64 = 90;
const DAY_MS: i64 = 86_400_000;
/// How many evidence entries one memory keeps: the oldest ones are the ones that made the case, and
/// a list of hundreds says nothing a list of fifty does not.
const MAX_EVIDENCE: usize = 50;
/// How long one evidence entry may be: an id, a path, a line — not a pasted file.
const MAX_EVIDENCE_CHARS: usize = 500;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Scope {
    Global,
    Workspace,
    Project,
    Task,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Scope::Global => "global",
            Scope::Workspace => "workspace",
            Scope::Project => "project",
            Scope::Task => "task",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Preference,
    Convention,
    Decision,
    Fact,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Preference => "preference",
            Kind::Convention => "convention",
            Kind::Decision => "decision",
            Kind::Fact => "fact",
        }
    }
}

/// What [`remember`] (and [`propose`]) did with what it was given — so a chat can tell the user the
/// truth instead of a blanket "learned".
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Remembered {
    /// A new memory.
    New,
    /// An existing candidate with the same title, which the user has just confirmed: approved now.
    Approved,
    /// An approved memory with the same title and a different body: the body changed, with a revision.
    Updated,
    /// Already there with the same text: nothing changed (a proposal's evidence may have been added).
    AlreadyKnown,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub id: String,
    pub scope: String,
    pub workspace_id: Option<String>,
    pub project_id: Option<String>,
    pub task_ref: Option<String>,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub status: String,
    pub source: String,
    pub evidence: Vec<String>,
    pub supersedes: Option<String>,
    pub local_only: bool,
    pub expires_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub used_at: Option<i64>,
    pub use_count: i64,
    /// When the user last vouched for this text — the latest approval, or the latest edit the user
    /// made to it — for approved memories only. Read from the revisions, not stored: the history is
    /// the record, and a column would be one more thing to keep in step with it.
    pub approved_at: Option<i64>,
    /// Approved and not used in [`STALE_DAYS`]: the pane shows it as «sin uso» for review.
    pub stale: bool,
    /// The title of the memory this one replaces, when it still exists — so the pane can say
    /// «reemplaza a …» without a second lookup.
    pub supersedes_title: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMemory {
    pub scope: Option<Scope>,
    pub workspace_id: Option<String>,
    pub project_id: Option<String>,
    pub task_ref: Option<String>,
    pub kind: Option<Kind>,
    pub title: String,
    pub body: String,
    /// `true`: approved on creation (the user wrote it, or said "remember").
    #[serde(default)]
    pub approved: bool,
    pub source: Option<String>,
    #[serde(default)]
    pub evidence: Vec<String>,
    pub supersedes: Option<String>,
    #[serde(default)]
    pub local_only: bool,
    pub expires_at: Option<i64>,
}

/// The table's own columns, in the order [`row_to_memory`] reads them and the INSERT writes them.
const COLUMNS: &str = "id, scope, workspace_id, project_id, task_ref, kind, title, body, status, source, evidence, supersedes, local_only, expires_at, created_at, updated_at, used_at, use_count";

/// The latest moment the user vouched for a memory's text: an approval, or an edit they made. A
/// memory created approved has neither, and falls back to its creation (see [`select_sql`]).
const VOUCHED_AT: &str = "(SELECT MAX(r.at) FROM ai_memory_revisions r WHERE r.memory_id = m.id AND (r.action = 'approved' OR (r.action = 'edited' AND r.actor = 'user')))";

/// `SELECT` of every column plus the two derived ones (the approval date, the replaced memory's
/// title), from `ai_memories m` — every reader goes through it, so the alias is always `m` and the
/// derived columns are always the 19th and 20th.
fn select_sql() -> String {
    let columns = COLUMNS.split(", ").map(|c| format!("m.{c}")).collect::<Vec<_>>().join(", ");
    format!(
        "SELECT {columns}, CASE WHEN m.status = 'approved' THEN COALESCE({VOUCHED_AT}, m.created_at) END, \
         (SELECT o.title FROM ai_memories o WHERE o.id = m.supersedes) FROM ai_memories m"
    )
}

fn row_to_memory(r: &rusqlite::Row<'_>) -> rusqlite::Result<Memory> {
    let evidence: String = r.get(10)?;
    let status: String = r.get(8)?;
    let created_at: i64 = r.get(14)?;
    let used_at: Option<i64> = r.get(16)?;
    let approved_at: Option<i64> = r.get(18)?;
    Ok(Memory {
        id: r.get(0)?,
        scope: r.get(1)?,
        workspace_id: r.get(2)?,
        project_id: r.get(3)?,
        task_ref: r.get(4)?,
        kind: r.get(5)?,
        title: r.get(6)?,
        body: r.get(7)?,
        stale: is_stale(&status, approved_at, used_at, created_at, now()),
        status,
        source: r.get(9)?,
        evidence: serde_json::from_str(&evidence).unwrap_or_default(),
        supersedes: r.get(11)?,
        local_only: r.get(12)?,
        expires_at: r.get(13)?,
        created_at,
        updated_at: r.get(15)?,
        used_at,
        use_count: r.get(17)?,
        approved_at,
        supersedes_title: r.get(19)?,
    })
}

/// Approved, and neither used nor re-approved in [`STALE_DAYS`] as of `at`.
fn is_stale(status: &str, approved_at: Option<i64>, used_at: Option<i64>, created_at: i64, at: i64) -> bool {
    status == "approved" && used_at.unwrap_or(0).max(approved_at.unwrap_or(created_at)) < at - STALE_DAYS * DAY_MS
}

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn revise(conn: &Connection, memory_id: &str, action: &str, title: &str, body: &str, actor: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO ai_memory_revisions (id, memory_id, at, action, title, body, actor) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![uuid::Uuid::new_v4().to_string(), memory_id, now(), action, title, body, actor],
    )?;
    Ok(())
}

/// How a title is compared for duplicates: case, accents and punctuation folded.
fn normalized(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .map(|c| match c {
            'á' | 'à' | 'ä' => 'a',
            'é' | 'è' | 'ë' => 'e',
            'í' | 'ì' | 'ï' => 'i',
            'ó' | 'ò' | 'ö' => 'o',
            'ú' | 'ù' | 'ü' => 'u',
            other => other,
        })
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// `needle` appears in `haystack` as whole consecutive words (both already [`normalized`]). Word
/// boundaries matter: "cuidado al cambiar srcpayts" must not be found inside "… srcpaytsx", or the
/// experience log's warnings about two different files would fold into one.
fn contains_phrase(haystack: &str, needle: &str) -> bool {
    let hay: Vec<&str> = haystack.split(' ').collect();
    let words: Vec<&str> = needle.split(' ').collect();
    !words.is_empty() && words.len() <= hay.len() && hay.windows(words.len()).any(|window| window == words.as_slice())
}

/// The shortest title that may count as a phrase of another's: two words and eight letters. Below
/// that ("tests", "ci") containment says nothing about two memories being the same.
fn phrase_worthy(title: &str) -> bool {
    title.split(' ').count() >= 2 && title.chars().count() >= 8
}

/// Where a memory lives, resolved the same way for every writer.
struct Place {
    scope: Scope,
    workspace_id: Option<String>,
    project_id: Option<String>,
}

fn place_of(input: &NewMemory) -> Place {
    let scope = input.scope.unwrap_or(if input.project_id.is_some() { Scope::Project } else if input.workspace_id.is_some() { Scope::Workspace } else { Scope::Global });
    let (workspace_id, project_id) = match scope {
        Scope::Global => (None, None),
        Scope::Workspace => (input.workspace_id.clone(), None),
        Scope::Project | Scope::Task => (input.workspace_id.clone(), input.project_id.clone()),
    };
    Place { scope, workspace_id, project_id }
}

/// The live (not revoked) memories of one place, approved ones first — what a new memory is checked
/// against for duplicates. No row limit: a duplicate missed because it was the 501st is still a
/// duplicate. A project's (or task's) place is its project alone, whatever workspace id the writer
/// happened to know.
fn live_in(conn: &Connection, place: &Place) -> rusqlite::Result<Vec<Memory>> {
    let column = match place.scope {
        Scope::Global => None,
        Scope::Workspace => Some(("workspace_id", place.workspace_id.clone())),
        Scope::Project | Scope::Task => Some(("project_id", place.project_id.clone())),
    };
    let mut values: Vec<SqlValue> = vec![SqlValue::Text(place.scope.as_str().to_string())];
    let mut sql = format!("{} WHERE m.scope = ?1 AND m.status != 'revoked'", select_sql());
    if let Some((column, key)) = column {
        values.push(key.map_or(SqlValue::Null, SqlValue::Text));
        sql.push_str(&format!(" AND m.{column} IS ?2"));
    }
    sql.push_str(" ORDER BY CASE m.status WHEN 'approved' THEN 0 ELSE 1 END, m.updated_at DESC");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(values.iter()), row_to_memory)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Evidence as stored: each entry redacted (a key in a log line is still a key), trimmed, capped,
/// without repeats.
fn clean_evidence(items: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for item in items {
        let item = crate::secret_scan::redact(item.trim()).0;
        let item: String = item.chars().take(MAX_EVIDENCE_CHARS).collect();
        if item.is_empty() || out.contains(&item) {
            continue;
        }
        out.push(item);
        if out.len() == MAX_EVIDENCE {
            break;
        }
    }
    out
}

/// `existing` followed by whatever of `more` it lacks, within [`MAX_EVIDENCE`].
fn merge_evidence(existing: &[String], more: &[String]) -> Vec<String> {
    let mut out = existing.to_vec();
    for item in more {
        if out.len() >= MAX_EVIDENCE {
            break;
        }
        if !out.contains(item) {
            out.push(item.clone());
        }
    }
    out
}

/// Title, body and evidence as stored: redacted first — a key is never a memory — and a title made
/// from the body when only a body was given.
fn cleaned(input: &NewMemory) -> Result<(String, String, Vec<String>), String> {
    let title = crate::secret_scan::redact(input.title.trim()).0;
    let body = crate::secret_scan::redact(input.body.trim()).0;
    if title.is_empty() && body.is_empty() {
        return Err("a memory needs a title or a body".to_string());
    }
    let title = if title.is_empty() { body.chars().take(80).collect() } else { title };
    Ok((title, body, clean_evidence(&input.evidence)))
}

/// Writes a new row. The kind, when the writer gave none, is a `preference` only when the user is
/// the source — anyone else's proposal is a `fact`, which reaches a model only when a question
/// matches it, so an agent cannot make something always-on by leaving the kind out.
fn insert(conn: &Connection, input: &NewMemory, place: &Place, title: &str, body: &str, evidence: &[String]) -> Result<Memory, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let status = if input.approved { "approved" } else { "candidate" };
    let source = input.source.clone().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "user".to_string());
    let kind = input.kind.unwrap_or(if source == "user" { Kind::Preference } else { Kind::Fact });
    let supersedes = input.supersedes.clone().filter(|s| !s.is_empty());
    let at = now();
    conn.execute(
        &format!("INSERT INTO ai_memories ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15, NULL, 0)"),
        params![
            id,
            place.scope.as_str(),
            place.workspace_id,
            place.project_id,
            input.task_ref,
            kind.as_str(),
            title,
            body,
            status,
            source,
            serde_json::to_string(evidence).unwrap_or_else(|_| "[]".into()),
            supersedes,
            input.local_only,
            input.expires_at,
            at,
        ],
    )
    .map_err(|e| e.to_string())?;
    revise(conn, &id, "created", title, body, &source).map_err(|e| e.to_string())?;
    if input.approved {
        supersede_older(conn, &id).map_err(|e| e.to_string())?;
    }
    get(conn, &id).map_err(|e| e.to_string())?.ok_or_else(|| "memory vanished".to_string())
}

/// Creates a memory. Approved input is the user's own word and goes through [`remember`] (so an
/// existing candidate with that title is approved, not returned unapproved as if it were learned);
/// anything else is a proposal and goes through [`propose`]. Kept for the writers that only need
/// the memory; the chats and the pane call [`remember`] / [`propose`] to know what happened.
pub fn create(conn: &Connection, input: NewMemory) -> Result<Memory, String> {
    if input.approved {
        remember(conn, input).map(|(memory, _)| memory)
    } else {
        propose(conn, input).map(|(memory, _)| memory)
    }
}

/// The user's explicit instruction — "recuerda que…", or a memory written in the pane — and what
/// became of it. Matched by normalized title in the same place:
/// - nothing there: a new approved memory ([`Remembered::New`]);
/// - a **candidate** (an agent's or a flow's proposal): approved now, with the user's body and kind
///   when given, the change kept as revisions ([`Remembered::Approved`]);
/// - an **approved** one with a different body: the body replaced, with an `edited` revision
///   ([`Remembered::Updated`]); an empty body never wipes one (the chat sends only the rule);
/// - an approved one with the same text: nothing changes ([`Remembered::AlreadyKnown`]).
///
/// Local-only is only ever added, never taken away: restating a rule must not quietly send it to a
/// cloud engine. A revoked memory with the same title is history, not a match: a new one is made.
pub fn remember(conn: &Connection, input: NewMemory) -> Result<(Memory, Remembered), String> {
    let mut input = input;
    input.approved = true;
    let (title, body, evidence) = cleaned(&input)?;
    let place = place_of(&input);
    let key = normalized(&title);
    let existing = live_in(conn, &place).map_err(|e| e.to_string())?.into_iter().find(|m| normalized(&m.title) == key);
    let Some(existing) = existing else {
        return insert(conn, &input, &place, &title, &body, &evidence).map(|memory| (memory, Remembered::New));
    };
    let new_body = !body.is_empty() && normalized(&body) != normalized(&existing.body);
    let outcome = if existing.status == "candidate" {
        Remembered::Approved
    } else if new_body {
        Remembered::Updated
    } else {
        Remembered::AlreadyKnown
    };
    let merged = merge_evidence(&existing.evidence, &evidence);
    if outcome == Remembered::AlreadyKnown {
        if merged != existing.evidence {
            conn.execute(
                "UPDATE ai_memories SET evidence = ?1 WHERE id = ?2",
                params![serde_json::to_string(&merged).unwrap_or_else(|_| "[]".into()), existing.id],
            )
            .map_err(|e| e.to_string())?;
        }
        let memory = get(conn, &existing.id).map_err(|e| e.to_string())?.ok_or("memory vanished")?;
        return Ok((memory, outcome));
    }
    let body = if new_body { body } else { existing.body.clone() };
    let kind = input.kind.map(|k| k.as_str().to_string()).unwrap_or_else(|| existing.kind.clone());
    let supersedes = input.supersedes.clone().filter(|s| !s.is_empty() && *s != existing.id).or_else(|| existing.supersedes.clone());
    conn.execute(
        "UPDATE ai_memories SET body = ?1, kind = ?2, status = 'approved', evidence = ?3, supersedes = ?4,
             local_only = ?5, expires_at = ?6, updated_at = ?7 WHERE id = ?8",
        params![
            body,
            kind,
            serde_json::to_string(&merged).unwrap_or_else(|_| "[]".into()),
            supersedes,
            existing.local_only || input.local_only,
            input.expires_at.or(existing.expires_at),
            now(),
            existing.id,
        ],
    )
    .map_err(|e| e.to_string())?;
    if new_body {
        revise(conn, &existing.id, "edited", &existing.title, &body, "user").map_err(|e| e.to_string())?;
    }
    if outcome == Remembered::Approved {
        revise(conn, &existing.id, "approved", &existing.title, &body, "user").map_err(|e| e.to_string())?;
    }
    supersede_older(conn, &existing.id).map_err(|e| e.to_string())?;
    let memory = get(conn, &existing.id).map_err(|e| e.to_string())?.ok_or("memory vanished")?;
    Ok((memory, outcome))
}

/// A proposal from an agent, a flow or the experience log: a **candidate** no model reads until the
/// user approves it. A near-duplicate of a live memory in the same place is not a second row: the
/// existing one comes back ([`Remembered::AlreadyKnown`]) with the proposal's evidence added and,
/// when it said something new, a `proposed` revision holding its wording — so the pane shows "this
/// was proposed again, and how" without the user triaging the same rule twice.
///
/// Near-duplicate, in this order: the same normalized title; the same normalized body; or one title
/// a whole-word phrase of the other's (see [`contains_phrase`], [`phrase_worthy`]).
pub fn propose(conn: &Connection, input: NewMemory) -> Result<(Memory, Remembered), String> {
    let mut input = input;
    input.approved = false;
    let (title, body, evidence) = cleaned(&input)?;
    let place = place_of(&input);
    let live = live_in(conn, &place).map_err(|e| e.to_string())?;
    let Some(existing) = near_duplicate(&live, &title, &body) else {
        return insert(conn, &input, &place, &title, &body, &evidence).map(|memory| (memory, Remembered::New));
    };
    let merged = merge_evidence(&existing.evidence, &evidence);
    let says_more = normalized(&title) != normalized(&existing.title) || (!body.is_empty() && normalized(&body) != normalized(&existing.body));
    if merged != existing.evidence || says_more {
        conn.execute(
            "UPDATE ai_memories SET evidence = ?1, updated_at = ?2 WHERE id = ?3",
            params![serde_json::to_string(&merged).unwrap_or_else(|_| "[]".into()), now(), existing.id],
        )
        .map_err(|e| e.to_string())?;
        let actor = input.source.as_deref().filter(|s| !s.trim().is_empty()).unwrap_or("system");
        revise(conn, &existing.id, "proposed", &title, &body, actor).map_err(|e| e.to_string())?;
    }
    let memory = get(conn, &existing.id).map_err(|e| e.to_string())?.ok_or("memory vanished")?;
    Ok((memory, Remembered::AlreadyKnown))
}

fn near_duplicate<'a>(live: &'a [Memory], title: &str, body: &str) -> Option<&'a Memory> {
    let title = normalized(title);
    let body = normalized(body);
    live.iter()
        .find(|m| normalized(&m.title) == title)
        .or_else(|| (!body.is_empty()).then(|| live.iter().find(|m| normalized(&m.body) == body)).flatten())
        .or_else(|| {
            live.iter().find(|m| {
                let other = normalized(&m.title);
                (phrase_worthy(&title) && contains_phrase(&other, &title)) || (phrase_worthy(&other) && contains_phrase(&title, &other))
            })
        })
}

/// When a memory that replaces another is approved, the other is revoked — and says why.
fn supersede_older(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    let older: Option<String> = conn.query_row("SELECT supersedes FROM ai_memories WHERE id = ?1", params![id], |r| r.get(0)).optional()?.flatten();
    if let Some(older) = older.filter(|older| older != id) {
        let changed = conn.execute("UPDATE ai_memories SET status = 'revoked', updated_at = ?1 WHERE id = ?2 AND status != 'revoked'", params![now(), older])?;
        if changed > 0 {
            revise(conn, &older, "superseded", "", id, "system")?;
        }
    }
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> rusqlite::Result<Option<Memory>> {
    conn.query_row(&format!("{} WHERE m.id = ?1", select_sql()), params![id], row_to_memory).optional()
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    pub scope: Option<String>,
    pub status: Option<String>,
    pub workspace_id: Option<String>,
    pub project_id: Option<String>,
    /// Words to match in title and body.
    pub query: Option<String>,
    pub limit: Option<usize>,
    /// Rows to skip — the pane pages through a workspace's memories instead of loading them all.
    pub offset: Option<usize>,
    /// With `workspace_id` / `project_id`: the global memories match too — "what applies here",
    /// which is what the pane lists by default.
    #[serde(default)]
    pub include_global: bool,
    /// Only approved memories unused in [`STALE_DAYS`] («sin uso»).
    #[serde(default)]
    pub stale: bool,
}

/// One page of the Memory pane: the rows, how many match in all, and the two counts its chips show
/// for the same place whatever the status filter says — proposals to review and memories unused.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub rows: Vec<Memory>,
    pub total: usize,
    pub candidates: usize,
    pub stale: usize,
}

/// The `WHERE` of a [`Filter`], its values pushed onto `values`.
fn where_of(filter: &Filter, values: &mut Vec<SqlValue>) -> String {
    fn push(values: &mut Vec<SqlValue>, value: SqlValue) -> usize {
        values.push(value);
        values.len()
    }
    let mut sql = String::from(" WHERE 1 = 1");
    for (column, value) in [("scope", &filter.scope), ("status", &filter.status)] {
        if let Some(value) = value.as_ref().filter(|v| !v.is_empty()) {
            let n = push(values, SqlValue::Text(value.clone()));
            sql.push_str(&format!(" AND m.{column} = ?{n}"));
        }
    }
    let mut place: Vec<String> = Vec::new();
    for (column, value) in [("workspace_id", &filter.workspace_id), ("project_id", &filter.project_id)] {
        if let Some(value) = value.as_ref().filter(|v| !v.is_empty()) {
            let n = push(values, SqlValue::Text(value.clone()));
            place.push(format!("m.{column} = ?{n}"));
        }
    }
    if !place.is_empty() {
        let place = place.join(" AND ");
        sql.push_str(&if filter.include_global { format!(" AND (m.scope = 'global' OR ({place}))") } else { format!(" AND {place}") });
    }
    if let Some(query) = filter.query.as_deref().and_then(crate::knowledge::index::fts_query) {
        let n = push(values, SqlValue::Text(query));
        sql.push_str(&format!(" AND m.id IN (SELECT memory_id FROM ai_memories_fts WHERE ai_memories_fts MATCH ?{n})"));
    }
    if filter.stale {
        let n = push(values, SqlValue::Integer(now() - STALE_DAYS * DAY_MS));
        sql.push_str(&format!(" AND m.status = 'approved' AND MAX(COALESCE(m.used_at, 0), COALESCE({VOUCHED_AT}, m.created_at)) < ?{n}"));
    }
    sql
}

pub fn list(conn: &Connection, filter: &Filter) -> rusqlite::Result<Vec<Memory>> {
    expire(conn)?;
    let mut values = Vec::new();
    let mut sql = format!("{}{}", select_sql(), where_of(filter, &mut values));
    sql.push_str(&format!(
        " ORDER BY CASE m.status WHEN 'candidate' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, m.updated_at DESC, m.id LIMIT {} OFFSET {}",
        filter.limit.unwrap_or(500).clamp(1, 5_000),
        filter.offset.unwrap_or(0)
    ));
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(values.iter()), row_to_memory)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// How many memories match `filter` (its limit and offset ignored).
pub fn count(conn: &Connection, filter: &Filter) -> rusqlite::Result<usize> {
    let mut values = Vec::new();
    let sql = format!("SELECT COUNT(*) FROM ai_memories m{}", where_of(filter, &mut values));
    conn.query_row(&sql, rusqlite::params_from_iter(values.iter()), |r| r.get::<_, i64>(0)).map(|n| n as usize)
}

/// [`list`] as the pane pages it: the rows, the total, and the place's proposal and «sin uso»
/// counts (the place being the filter's scope, workspace and project — not its status or words).
pub fn page(conn: &Connection, filter: &Filter) -> rusqlite::Result<Page> {
    let rows = list(conn, filter)?;
    let total = count(conn, filter)?;
    let place = Filter { status: None, query: None, stale: false, limit: None, offset: None, ..filter.clone() };
    let candidates = count(conn, &Filter { status: Some("candidate".into()), ..place.clone() })?;
    let stale = count(conn, &Filter { stale: true, ..place })?;
    Ok(Page { rows, total, candidates, stale })
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Patch {
    pub title: Option<String>,
    pub body: Option<String>,
    pub kind: Option<Kind>,
    pub local_only: Option<bool>,
    pub expires_at: Option<i64>,
    /// Removes the expiry (wins over `expires_at`).
    #[serde(default)]
    pub clear_expiry: bool,
    /// The memory this one replaces: revoked when this one is approved — at once, when it already is.
    pub supersedes: Option<String>,
    /// Forgets what it replaces (wins over `supersedes`).
    #[serde(default)]
    pub clear_supersedes: bool,
}

pub fn edit(conn: &Connection, id: &str, patch: Patch) -> Result<Memory, String> {
    let current = get(conn, id).map_err(|e| e.to_string())?.ok_or("memory not found")?;
    let title = patch.title.map(|t| crate::secret_scan::redact(t.trim()).0).unwrap_or(current.title.clone());
    let body = patch.body.map(|b| crate::secret_scan::redact(b.trim()).0).unwrap_or(current.body.clone());
    if title.is_empty() && body.is_empty() {
        return Err("a memory needs a title or a body".to_string());
    }
    let kind = patch.kind.map(|k| k.as_str().to_string()).unwrap_or(current.kind.clone());
    let local_only = patch.local_only.unwrap_or(current.local_only);
    let expires_at = if patch.clear_expiry { None } else { patch.expires_at.or(current.expires_at) };
    let supersedes = if patch.clear_supersedes { None } else { patch.supersedes.filter(|s| !s.is_empty()).or(current.supersedes.clone()) };
    if supersedes.as_deref() == Some(id) {
        return Err("a memory cannot replace itself".to_string());
    }
    if supersedes != current.supersedes {
        if let Some(older) = supersedes.as_deref() {
            if get(conn, older).map_err(|e| e.to_string())?.is_none() {
                return Err("the memory it replaces does not exist".to_string());
            }
        }
    }
    conn.execute(
        "UPDATE ai_memories SET title = ?1, body = ?2, kind = ?3, local_only = ?4, expires_at = ?5, supersedes = ?6, updated_at = ?7 WHERE id = ?8",
        params![title, body, kind, local_only, expires_at, supersedes, now(), id],
    )
    .map_err(|e| e.to_string())?;
    if title != current.title || body != current.body {
        revise(conn, id, "edited", &title, &body, "user").map_err(|e| e.to_string())?;
    }
    // Approval is when a replacement takes effect; on a memory already approved, that is now.
    if current.status == "approved" && supersedes.is_some() && supersedes != current.supersedes {
        supersede_older(conn, id).map_err(|e| e.to_string())?;
    }
    get(conn, id).map_err(|e| e.to_string())?.ok_or_else(|| "memory vanished".to_string())
}

/// `approved` | `revoked` | `candidate`.
pub fn set_status(conn: &Connection, id: &str, status: &str) -> Result<(), String> {
    let status = match status {
        "approved" | "revoked" | "candidate" => status,
        other => return Err(format!("unknown status {other}")),
    };
    let current = get(conn, id).map_err(|e| e.to_string())?.ok_or("memory not found")?;
    conn.execute("UPDATE ai_memories SET status = ?1, updated_at = ?2 WHERE id = ?3", params![status, now(), id]).map_err(|e| e.to_string())?;
    revise(conn, id, status, &current.title, &current.body, "user").map_err(|e| e.to_string())?;
    if status == "approved" {
        supersede_older(conn, id).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Approves a memory as `kind` (or as it is): an agent's proposal arrives as a `fact`, and the user
/// is the one who decides it is a convention or a preference that should ride every turn.
pub fn approve(conn: &Connection, id: &str, kind: Option<Kind>) -> Result<(), String> {
    if let Some(kind) = kind {
        conn.execute("UPDATE ai_memories SET kind = ?1 WHERE id = ?2", params![kind.as_str(), id]).map_err(|e| e.to_string())?;
    }
    set_status(conn, id, "approved")
}

pub fn delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM ai_memories WHERE id = ?1", params![id])?;
    Ok(())
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub at: i64,
    pub action: String,
    pub title: String,
    pub body: String,
    pub actor: String,
}

pub fn revisions(conn: &Connection, id: &str) -> rusqlite::Result<Vec<Revision>> {
    let mut stmt = conn.prepare("SELECT at, action, title, body, actor FROM ai_memory_revisions WHERE memory_id = ?1 ORDER BY at DESC, rowid DESC")?;
    let rows = stmt
        .query_map(params![id], |r| Ok(Revision { at: r.get(0)?, action: r.get(1)?, title: r.get(2)?, body: r.get(3)?, actor: r.get(4)? }))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Approved memories past their expiry become revoked, with a revision saying so.
pub fn expire(conn: &Connection) -> rusqlite::Result<()> {
    let at = now();
    let mut stmt = conn.prepare("SELECT id FROM ai_memories WHERE status = 'approved' AND expires_at IS NOT NULL AND expires_at < ?1")?;
    let ids: Vec<String> = stmt.query_map(params![at], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    for id in ids {
        conn.execute("UPDATE ai_memories SET status = 'revoked', updated_at = ?1 WHERE id = ?2", params![at, id])?;
        revise(conn, &id, "expired", "", "", "system")?;
    }
    Ok(())
}

/// Which approved memories a question in `project_id` (of `workspace_id`) may see: its project's,
/// its workspace's and the global ones, unexpired, and — for a cloud engine — not local-only. A
/// workspace or project scope needs its id: a question with no project sees no project memory, not
/// every project memory that lacks one.
const IN_SCOPE: &str = "m.status = 'approved'
       AND (m.expires_at IS NULL OR m.expires_at >= ?4)
       AND (m.scope = 'global'
            OR (m.scope = 'workspace' AND ?1 IS NOT NULL AND m.workspace_id = ?1)
            OR (m.scope IN ('project', 'task') AND ?2 IS NOT NULL AND m.project_id = ?2))
       AND (?3 = 0 OR m.local_only = 0)";

/// The approved memories that apply to a question in `project_id` (of `workspace_id`): its project's
/// and workspace's and the global ones, the ones matching the question first, within `budget`
/// characters. `cloud`: a cloud engine is asking, so local-only memories are left out. Marks what
/// it returns as used.
///
/// The full-text match is joined to the same scope, so the ranking only ever compares memories this
/// question may see: a cap over every memory of every project once let fifty matches elsewhere
/// crowd the one in this repository out. Ties go to the memory used more, then more recently.
pub fn relevant(conn: &Connection, workspace_id: Option<&str>, project_id: Option<&str>, question: &str, cloud: bool, budget: usize) -> rusqlite::Result<Vec<Memory>> {
    expire(conn)?;
    let at = now();
    let mut stmt = conn.prepare(&format!("{} WHERE {IN_SCOPE}", select_sql()))?;
    let all: Vec<Memory> = stmt
        .query_map(params![workspace_id, project_id, cloud, at], row_to_memory)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if all.is_empty() {
        return Ok(Vec::new());
    }
    // The ones the question's words match, by bm25 (the title weighs double; `memory_id` is the
    // first, unindexed column, so it gets the first weight, zero), then the narrowest scope.
    let matched: Vec<String> = match crate::knowledge::index::fts_query(question) {
        Some(query) => {
            let mut stmt = conn.prepare(&format!(
                "SELECT m.id FROM ai_memories_fts JOIN ai_memories m ON m.id = ai_memories_fts.memory_id
                 WHERE ai_memories_fts MATCH ?5 AND {IN_SCOPE}
                 ORDER BY bm25(ai_memories_fts, 0.0, 2.0, 1.0)"
            ))?;
            let ids: Vec<String> = stmt.query_map(params![workspace_id, project_id, cloud, at, query], |r| r.get(0))?.filter_map(Result::ok).collect();
            ids
        }
        None => Vec::new(),
    };
    let rank = |m: &Memory| {
        let hit = matched.iter().position(|id| id == &m.id).unwrap_or(usize::MAX);
        let scope = match m.scope.as_str() {
            "task" => 0,
            "project" => 1,
            "workspace" => 2,
            _ => 3,
        };
        // Preferences hold for every question; the rest earn their place by matching it.
        let preference = if m.kind == "preference" { 0 } else { 1 };
        (hit, preference, scope, std::cmp::Reverse(m.use_count), std::cmp::Reverse(m.used_at.unwrap_or(0)))
    };
    let mut sorted = all;
    sorted.sort_by_key(rank);
    let mut out = Vec::new();
    let mut used = 0;
    for memory in sorted {
        let is_match = matched.contains(&memory.id);
        if !is_match && memory.kind != "preference" && memory.kind != "convention" {
            continue;
        }
        let cost = note_line(&memory).chars().count() + 1;
        if used + cost > budget {
            continue;
        }
        used += cost;
        out.push(memory);
    }
    for memory in &out {
        conn.execute("UPDATE ai_memories SET used_at = ?1, use_count = use_count + 1 WHERE id = ?2", params![at, memory.id])?;
    }
    Ok(out)
}

/// A kind as the note names it — in Spanish, as the rest of the note.
fn kind_label(kind: &str) -> &str {
    match kind {
        "preference" => "preferencia",
        "convention" => "convención",
        "decision" => "decisión",
        "fact" => "hecho",
        other => other,
    }
}

/// Who proposed a memory, when it was not the user — in the note's few words.
fn source_label(source: &str) -> &str {
    match source {
        "agent" => "agente",
        "flow" => "flujo",
        "experience" => "historial",
        other => other,
    }
}

/// A day, in the user's time zone, as the note and the pane show it.
fn day(ms: i64) -> Option<String> {
    use chrono::TimeZone;
    chrono::Local.timestamp_millis_opt(ms).single().map(|d| d.format("%Y-%m-%d").to_string())
}

/// One memory's line in the note: `- [convención · aprobada 2026-10-02] Título: cuerpo`, plus the
/// origin when somebody other than the user proposed it.
fn note_line(m: &Memory) -> String {
    let mut tag = kind_label(&m.kind).to_string();
    if let Some(date) = m.approved_at.and_then(day) {
        tag.push_str(&format!(" · aprobada {date}"));
    }
    if m.source != "user" {
        tag.push_str(&format!(" · origen: {}", source_label(&m.source)));
    }
    if m.body.is_empty() || m.body == m.title {
        format!("- [{tag}] {}", m.title)
    } else {
        format!("- [{tag}] {}: {}", m.title, m.body)
    }
}

/// The block a model is shown, and the sources for «Contexto usado». Short on purpose — it rides
/// every turn: what these are (the user's approved rules), what to do (follow them) and what to do
/// when the code or the request disagrees with one (say so, rather than quietly pick a side).
pub fn note(memories: &[Memory]) -> Option<(String, Vec<crate::context::ContextSource>)> {
    if memories.is_empty() {
        return None;
    }
    let lines: Vec<String> = memories.iter().map(note_line).collect();
    let sources = memories.iter().map(|m| crate::context::ContextSource::new(crate::context::SourceKind::Memory, m.title.clone(), None)).collect();
    Some((
        format!(
            "\n\n---\nReglas que el usuario aprobó en CodeFlow; síguelas. Si el código o lo que pide ahora contradice alguna, dilo en vez de suponer cuál vale:\n{}",
            lines.join("\n")
        ),
        sources,
    ))
}

/// "recuerda que …" / "remember that …" at the start of a sentence: what to remember.
pub fn remember_request(message: &str) -> Option<String> {
    static PATTERN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        regex::Regex::new(r"(?im)(?:^|[.!?,:;]\s*)(?:recuerda(?:\s+siempre)?\s+que|recuerda:|acu[eé]rdate\s+de\s+que|(?:always\s+)?remember\s+that|remember:)\s+([^\n]+)").unwrap()
    });
    let rest = pattern.captures(message)?.get(1)?.as_str().trim().trim_end_matches('.').trim().to_string();
    (rest.chars().count() >= 6).then_some(rest)
}

/// Candidates the evidence suggests: AI changes to the same file reverted three or more times in two
/// weeks is a sign the models keep getting that area wrong. Deterministic — no model writes them,
/// and no experience text reaches one: what is kept is the path (redacted on capture, and again
/// here as any memory is) and the experiences' ids as evidence (`experience:<id>`). Proposed as a
/// `fact`, which a model sees only when a question names the area; the user can make it a
/// convention when approving. Returns only the proposals that are new — the ones already there
/// just gain the new evidence.
pub fn propose_from_experiences(conn: &Connection, workspace_id: &str) -> Result<Vec<Memory>, String> {
    let since = now() - 14 * DAY_MS;
    let mut stmt = conn
        .prepare("SELECT id, project_id, detail FROM ai_experiences WHERE workspace_id = ?1 AND signal IN ('reverted', 'rejected') AND created_at > ?2 ORDER BY created_at")
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, Option<String>, String)> = stmt
        .query_map(params![workspace_id, since], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;
    let mut counts: std::collections::BTreeMap<(Option<String>, String), (usize, Vec<String>)> = std::collections::BTreeMap::new();
    for (id, project, detail) in rows {
        let detail: serde_json::Value = serde_json::from_str(&detail).unwrap_or_default();
        let paths: Vec<String> = detail["paths"].as_array().map(|a| a.iter().filter_map(|p| p.as_str().map(str::to_string)).collect()).unwrap_or_default();
        for path in paths {
            let entry = counts.entry((project.clone(), path)).or_default();
            entry.0 += 1;
            entry.1.push(format!("experience:{id}"));
        }
    }
    let mut out = Vec::new();
    for ((project, path), (count, evidence)) in counts {
        if count < 3 {
            continue;
        }
        let (memory, outcome) = propose(
            conn,
            NewMemory {
                scope: Some(if project.is_some() { Scope::Project } else { Scope::Workspace }),
                workspace_id: Some(workspace_id.to_string()),
                project_id: project,
                kind: Some(Kind::Fact),
                title: format!("Cuidado al cambiar {path}"),
                body: format!("Los cambios de IA en {path} se revirtieron {count} veces en dos semanas: léelo completo y explica el cambio antes de tocarlo."),
                source: Some("experience".into()),
                evidence,
                ..Default::default()
            },
        )?;
        if outcome == Remembered::New {
            out.push(memory);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests;
