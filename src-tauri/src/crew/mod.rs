//! The Agents view's own records.
//!
//! - **The library** (`agent_library`): agent and team templates shared by every workspace. The
//!   built-in ones ship in the frontend (`lib/agents/builtinTemplates.ts`) and only land here when
//!   the user edits one (`based_on = "builtin:<key>"`), so a new release can improve them without a
//!   migration. The body is the frontend's JSON; this side only stores it and counts versions.
//! - **The backlog** (`agent_backlog_items` + `agent_backlog_links`): stories and tasks written
//!   locally, assignable to an agent or a team. Starting one creates ordinary tasks, chains or team
//!   runs and links them here; where a card stands past «ready» is derived from those links.
//! - **The decision log** (`agent_decisions`): every finite choice the decision layer made
//!   (`crate::decide`), with its probability and whether the code acted on it or escalated.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_library (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            icon TEXT NOT NULL DEFAULT '',
            color TEXT NOT NULL DEFAULT '',
            tags TEXT NOT NULL DEFAULT '[]',
            body TEXT NOT NULL DEFAULT '{}',
            based_on TEXT NOT NULL DEFAULT '',
            version INTEGER NOT NULL DEFAULT 1,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS agent_backlog_items (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            parent_id TEXT NOT NULL DEFAULT '',
            kind TEXT NOT NULL DEFAULT 'task',
            title TEXT NOT NULL,
            body TEXT NOT NULL DEFAULT '',
            criteria TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'backlog',
            rank REAL NOT NULL DEFAULT 0,
            priority INTEGER NOT NULL DEFAULT 0,
            labels TEXT NOT NULL DEFAULT '[]',
            repos TEXT NOT NULL DEFAULT '[]',
            assignee_kind TEXT NOT NULL DEFAULT '',
            assignee_id TEXT NOT NULL DEFAULT '',
            mode TEXT NOT NULL DEFAULT '',
            mode_config TEXT NOT NULL DEFAULT '{}',
            ticket TEXT NOT NULL DEFAULT '',
            agent_project_id TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_backlog_ws ON agent_backlog_items(workspace_id, status, rank);
        CREATE TABLE IF NOT EXISTS agent_backlog_links (
            id TEXT PRIMARY KEY,
            item_id TEXT NOT NULL REFERENCES agent_backlog_items(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            ref_id TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_backlog_links_item ON agent_backlog_links(item_id);
        CREATE INDEX IF NOT EXISTS idx_backlog_links_ref ON agent_backlog_links(kind, ref_id);
        CREATE TABLE IF NOT EXISTS agent_decisions (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL DEFAULT '',
            run_id TEXT NOT NULL DEFAULT '',
            item_id TEXT NOT NULL DEFAULT '',
            kind TEXT NOT NULL,
            question TEXT NOT NULL,
            options TEXT NOT NULL DEFAULT '[]',
            choice TEXT NOT NULL DEFAULT '',
            p REAL NOT NULL DEFAULT 0,
            sharp INTEGER NOT NULL DEFAULT 0,
            source TEXT NOT NULL DEFAULT '',
            votes TEXT NOT NULL DEFAULT '[]',
            ms INTEGER NOT NULL DEFAULT 0,
            saved_tokens INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_decisions_run ON agent_decisions(run_id, created_at);",
    )
}

fn list_of(raw: &str) -> Vec<String> {
    serde_json::from_str(raw).unwrap_or_default()
}

fn json_of<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".into())
}

// ---------- library ----------

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct LibraryItem {
    pub id: String,
    /// `agent` or `team`.
    pub kind: String,
    pub name: String,
    pub description: String,
    pub icon: String,
    pub color: String,
    pub tags: Vec<String>,
    pub body: serde_json::Value,
    pub based_on: String,
    pub version: i64,
    pub sort_order: i64,
    pub created_at: String,
    pub updated_at: String,
}

fn map_library(row: &rusqlite::Row) -> rusqlite::Result<LibraryItem> {
    let tags: String = row.get(6)?;
    let body: String = row.get(7)?;
    Ok(LibraryItem {
        id: row.get(0)?,
        kind: row.get(1)?,
        name: row.get(2)?,
        description: row.get(3)?,
        icon: row.get(4)?,
        color: row.get(5)?,
        tags: list_of(&tags),
        body: serde_json::from_str(&body).unwrap_or(serde_json::Value::Null),
        based_on: row.get(8)?,
        version: row.get(9)?,
        sort_order: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

const LIBRARY_COLUMNS: &str = "id, kind, name, description, icon, color, tags, body, based_on, version, sort_order, created_at, updated_at";

pub fn library_list(conn: &Connection, kind: Option<&str>) -> rusqlite::Result<Vec<LibraryItem>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {LIBRARY_COLUMNS} FROM agent_library WHERE (?1 IS NULL OR kind = ?1) ORDER BY sort_order, name COLLATE NOCASE"
    ))?;
    let rows = stmt.query_map(params![kind], map_library)?;
    rows.collect()
}

pub fn library_get(conn: &Connection, id: &str) -> rusqlite::Result<Option<LibraryItem>> {
    conn.query_row(&format!("SELECT {LIBRARY_COLUMNS} FROM agent_library WHERE id = ?1"), params![id], map_library).optional()
}

/// Saves a template. A new one starts at version 1; every save of an existing one bumps it, which
/// is what tells the agents made from it that there is something to sync.
pub fn library_save(conn: &Connection, item: &LibraryItem) -> Result<LibraryItem, String> {
    let kind = item.kind.trim();
    if kind != "agent" && kind != "team" {
        return Err(format!("tipo de plantilla desconocido: {kind}"));
    }
    if item.name.trim().is_empty() {
        return Err("La plantilla necesita un nombre.".into());
    }
    let existing = if item.id.trim().is_empty() { None } else { library_get(conn, &item.id).map_err(|e| e.to_string())? };
    let stamp = now();
    let saved = LibraryItem {
        id: existing.as_ref().map(|e| e.id.clone()).unwrap_or_else(|| {
            if item.id.trim().is_empty() { Uuid::new_v4().to_string() } else { item.id.trim().to_string() }
        }),
        kind: kind.to_string(),
        name: item.name.trim().to_string(),
        description: item.description.trim().to_string(),
        icon: item.icon.trim().to_string(),
        color: item.color.trim().to_string(),
        tags: item.tags.iter().map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect(),
        body: if item.body.is_null() { serde_json::json!({}) } else { item.body.clone() },
        based_on: item.based_on.trim().to_string(),
        version: existing.as_ref().map(|e| e.version + 1).unwrap_or(1),
        sort_order: item.sort_order,
        created_at: existing.as_ref().map(|e| e.created_at.clone()).unwrap_or_else(|| stamp.clone()),
        updated_at: stamp,
    };
    conn.execute(
        "INSERT INTO agent_library (id, kind, name, description, icon, color, tags, body, based_on, version, sort_order, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, name = excluded.name, description = excluded.description,
            icon = excluded.icon, color = excluded.color, tags = excluded.tags, body = excluded.body,
            based_on = excluded.based_on, version = excluded.version, sort_order = excluded.sort_order,
            updated_at = excluded.updated_at",
        params![
            saved.id, saved.kind, saved.name, saved.description, saved.icon, saved.color, json_of(&saved.tags),
            json_of(&saved.body), saved.based_on, saved.version, saved.sort_order, saved.created_at, saved.updated_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(saved)
}

pub fn library_delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM agent_library WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------- backlog ----------

pub const BACKLOG_STATUSES: [&str; 5] = ["backlog", "ready", "doing", "review", "done"];
pub const BACKLOG_KINDS: [&str; 3] = ["story", "task", "bug"];
pub const LINK_KINDS: [&str; 4] = ["task", "race", "chain", "team_run"];

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct Criterion {
    pub id: String,
    pub text: String,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct BacklogLink {
    pub id: String,
    pub item_id: String,
    pub kind: String,
    pub ref_id: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct BacklogItem {
    pub id: String,
    pub workspace_id: String,
    pub parent_id: String,
    pub kind: String,
    pub title: String,
    pub body: String,
    pub criteria: Vec<Criterion>,
    pub status: String,
    pub rank: f64,
    pub priority: i64,
    pub labels: Vec<String>,
    pub repos: Vec<String>,
    /// `""`, `agent` or `team`.
    pub assignee_kind: String,
    pub assignee_id: String,
    /// `""` (by assignee), `solo`, `race`, `team`, `flow`, `hybrid` or `story`.
    pub mode: String,
    /// The mode's settings as the frontend wrote them: racers, flow template, branches, policy.
    pub mode_config: serde_json::Value,
    /// The external ticket this card was imported from (`{provider, uid, key, url, title}`), or null.
    pub ticket: serde_json::Value,
    pub agent_project_id: String,
    pub created_at: String,
    pub updated_at: String,
    /// Filled on read: the work started from this card.
    pub links: Vec<BacklogLink>,
}

const BACKLOG_COLUMNS: &str = "id, workspace_id, parent_id, kind, title, body, criteria, status, rank, priority, labels, repos,
    assignee_kind, assignee_id, mode, mode_config, ticket, agent_project_id, created_at, updated_at";

fn map_backlog(row: &rusqlite::Row) -> rusqlite::Result<BacklogItem> {
    let criteria: String = row.get(6)?;
    let labels: String = row.get(10)?;
    let repos: String = row.get(11)?;
    let mode_config: String = row.get(15)?;
    let ticket: String = row.get(16)?;
    Ok(BacklogItem {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        parent_id: row.get(2)?,
        kind: row.get(3)?,
        title: row.get(4)?,
        body: row.get(5)?,
        criteria: serde_json::from_str(&criteria).unwrap_or_default(),
        status: row.get(7)?,
        rank: row.get(8)?,
        priority: row.get(9)?,
        labels: list_of(&labels),
        repos: list_of(&repos),
        assignee_kind: row.get(12)?,
        assignee_id: row.get(13)?,
        mode: row.get(14)?,
        mode_config: serde_json::from_str(&mode_config).unwrap_or(serde_json::json!({})),
        ticket: if ticket.trim().is_empty() { serde_json::Value::Null } else { serde_json::from_str(&ticket).unwrap_or(serde_json::Value::Null) },
        agent_project_id: row.get(17)?,
        created_at: row.get(18)?,
        updated_at: row.get(19)?,
        links: Vec::new(),
    })
}

fn links_of(conn: &Connection, item_id: &str) -> rusqlite::Result<Vec<BacklogLink>> {
    let mut stmt = conn.prepare("SELECT id, item_id, kind, ref_id, created_at FROM agent_backlog_links WHERE item_id = ?1 ORDER BY created_at")?;
    let rows = stmt.query_map(params![item_id], |row| {
        Ok(BacklogLink { id: row.get(0)?, item_id: row.get(1)?, kind: row.get(2)?, ref_id: row.get(3)?, created_at: row.get(4)? })
    })?;
    rows.collect()
}

pub fn backlog_get(conn: &Connection, id: &str) -> rusqlite::Result<Option<BacklogItem>> {
    let item = conn.query_row(&format!("SELECT {BACKLOG_COLUMNS} FROM agent_backlog_items WHERE id = ?1"), params![id], map_backlog).optional()?;
    match item {
        Some(mut item) => {
            item.links = links_of(conn, &item.id)?;
            Ok(Some(item))
        }
        None => Ok(None),
    }
}

pub fn backlog_list(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<BacklogItem>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {BACKLOG_COLUMNS} FROM agent_backlog_items WHERE workspace_id = ?1 ORDER BY status, rank, created_at"
    ))?;
    let mut items: Vec<BacklogItem> = stmt.query_map(params![workspace_id], map_backlog)?.collect::<rusqlite::Result<_>>()?;
    for item in &mut items {
        item.links = links_of(conn, &item.id)?;
    }
    Ok(items)
}

fn next_rank(conn: &Connection, workspace_id: &str, status: &str) -> f64 {
    conn.query_row(
        "SELECT COALESCE(MAX(rank), 0) + 1 FROM agent_backlog_items WHERE workspace_id = ?1 AND status = ?2",
        params![workspace_id, status],
        |row| row.get(0),
    )
    .unwrap_or(1.0)
}

/// Saves a card. Rules, each refused with a reason: a known kind and status, a title, and a parent
/// that is a top-level story of the same workspace — subtasks are one level deep.
pub fn backlog_save(conn: &Connection, item: &BacklogItem) -> Result<BacklogItem, String> {
    if item.title.trim().is_empty() {
        return Err("La tarjeta necesita un título.".into());
    }
    let kind = if BACKLOG_KINDS.contains(&item.kind.as_str()) { item.kind.clone() } else { "task".to_string() };
    let status = if BACKLOG_STATUSES.contains(&item.status.as_str()) { item.status.clone() } else { "backlog".to_string() };
    let parent_id = item.parent_id.trim().to_string();
    if !parent_id.is_empty() {
        if parent_id == item.id {
            return Err("Una tarjeta no puede ser subtarea de sí misma.".into());
        }
        let parent = backlog_get(conn, &parent_id).map_err(|e| e.to_string())?.ok_or("La historia madre ya no existe.")?;
        if parent.workspace_id != item.workspace_id {
            return Err("La historia madre es de otro workspace.".into());
        }
        if !parent.parent_id.is_empty() {
            return Err("Las subtareas tienen un solo nivel.".into());
        }
    }
    let existing = if item.id.trim().is_empty() { None } else { backlog_get(conn, &item.id).map_err(|e| e.to_string())? };
    let stamp = now();
    let id = existing.as_ref().map(|e| e.id.clone()).unwrap_or_else(|| {
        if item.id.trim().is_empty() { Uuid::new_v4().to_string() } else { item.id.trim().to_string() }
    });
    let rank = if existing.is_none() && item.rank == 0.0 { next_rank(conn, &item.workspace_id, &status) } else { item.rank };
    let criteria: Vec<Criterion> = item
        .criteria
        .iter()
        .filter(|c| !c.text.trim().is_empty())
        .map(|c| Criterion {
            id: if c.id.trim().is_empty() { Uuid::new_v4().to_string() } else { c.id.clone() },
            text: c.text.trim().to_string(),
            done: c.done,
        })
        .collect();
    let ticket = if item.ticket.is_null() { String::new() } else { json_of(&item.ticket) };
    let mode_config = if item.mode_config.is_null() { "{}".to_string() } else { json_of(&item.mode_config) };
    conn.execute(
        "INSERT INTO agent_backlog_items (id, workspace_id, parent_id, kind, title, body, criteria, status, rank, priority, labels,
            repos, assignee_kind, assignee_id, mode, mode_config, ticket, agent_project_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
         ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id, kind = excluded.kind, title = excluded.title,
            body = excluded.body, criteria = excluded.criteria, status = excluded.status, rank = excluded.rank,
            priority = excluded.priority, labels = excluded.labels, repos = excluded.repos,
            assignee_kind = excluded.assignee_kind, assignee_id = excluded.assignee_id, mode = excluded.mode,
            mode_config = excluded.mode_config, ticket = excluded.ticket, agent_project_id = excluded.agent_project_id,
            updated_at = excluded.updated_at",
        params![
            id,
            item.workspace_id,
            parent_id,
            kind,
            item.title.trim(),
            item.body,
            json_of(&criteria),
            status,
            rank,
            item.priority.clamp(0, 3),
            json_of(&item.labels),
            json_of(&item.repos),
            if matches!(item.assignee_kind.as_str(), "agent" | "team") { item.assignee_kind.as_str() } else { "" },
            item.assignee_id,
            item.mode,
            mode_config,
            ticket,
            item.agent_project_id,
            existing.as_ref().map(|e| e.created_at.clone()).unwrap_or_else(|| stamp.clone()),
            stamp,
        ],
    )
    .map_err(|e| e.to_string())?;
    backlog_get(conn, &id).map_err(|e| e.to_string())?.ok_or_else(|| "no se guardó la tarjeta".into())
}

/// Moves a card to a column at a rank. Ranks are fractional so a drop between two cards needs one
/// write; when two neighbours get closer than floats can tell apart, the column is renumbered.
pub fn backlog_move(conn: &Connection, id: &str, status: &str, rank: f64) -> Result<(), String> {
    if !BACKLOG_STATUSES.contains(&status) {
        return Err(format!("columna desconocida: {status}"));
    }
    let item = backlog_get(conn, id).map_err(|e| e.to_string())?.ok_or("La tarjeta ya no existe.")?;
    conn.execute(
        "UPDATE agent_backlog_items SET status = ?2, rank = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, status, rank, now()],
    )
    .map_err(|e| e.to_string())?;
    let ranks: Vec<(String, f64)> = {
        let mut stmt = conn
            .prepare("SELECT id, rank FROM agent_backlog_items WHERE workspace_id = ?1 AND status = ?2 ORDER BY rank, created_at")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![item.workspace_id, status], |row| Ok((row.get(0)?, row.get(1)?))).map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())?
    };
    let crowded = ranks.windows(2).any(|pair| (pair[1].1 - pair[0].1).abs() < 1e-9);
    if crowded {
        for (index, (card, _)) in ranks.iter().enumerate() {
            conn.execute("UPDATE agent_backlog_items SET rank = ?2 WHERE id = ?1", params![card, (index + 1) as f64]).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Deletes a card and its subtasks.
pub fn backlog_delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM agent_backlog_items WHERE parent_id = ?1", params![id])?;
    conn.execute("DELETE FROM agent_backlog_items WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn backlog_link(conn: &Connection, item_id: &str, kind: &str, ref_id: &str) -> Result<BacklogLink, String> {
    if !LINK_KINDS.contains(&kind) {
        return Err(format!("enlace desconocido: {kind}"));
    }
    if let Some(found) = links_of(conn, item_id).map_err(|e| e.to_string())?.into_iter().find(|l| l.kind == kind && l.ref_id == ref_id) {
        return Ok(found);
    }
    let link = BacklogLink { id: Uuid::new_v4().to_string(), item_id: item_id.to_string(), kind: kind.to_string(), ref_id: ref_id.to_string(), created_at: now() };
    conn.execute(
        "INSERT INTO agent_backlog_links (id, item_id, kind, ref_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![link.id, link.item_id, link.kind, link.ref_id, link.created_at],
    )
    .map_err(|e| e.to_string())?;
    Ok(link)
}

pub fn backlog_unlink(conn: &Connection, link_id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM agent_backlog_links WHERE id = ?1", params![link_id])?;
    Ok(())
}

/// The card a piece of work was started from, if any — what a run's view uses to show the story.
pub fn backlog_for_ref(conn: &Connection, kind: &str, ref_id: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT item_id FROM agent_backlog_links WHERE kind = ?1 AND ref_id = ?2", params![kind, ref_id], |row| row.get(0))
        .optional()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct TicketImport {
    pub provider: String,
    pub uid: String,
    pub key: String,
    pub url: String,
    pub title: String,
    /// `story`, `task` or `bug`.
    pub kind: String,
    pub body: String,
}

/// Turns external tickets into local cards in the backlog. A ticket already imported (same `uid`)
/// is skipped and its existing card returned, so dragging it twice never makes two.
pub fn backlog_import_tickets(conn: &Connection, workspace_id: &str, tickets: &[TicketImport]) -> Result<Vec<BacklogItem>, String> {
    let existing = backlog_list(conn, workspace_id).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for ticket in tickets {
        if ticket.uid.trim().is_empty() {
            continue;
        }
        if let Some(found) = existing.iter().find(|c| c.ticket.get("uid").and_then(|u| u.as_str()) == Some(ticket.uid.as_str())) {
            out.push(found.clone());
            continue;
        }
        let card = BacklogItem {
            workspace_id: workspace_id.to_string(),
            kind: if BACKLOG_KINDS.contains(&ticket.kind.as_str()) { ticket.kind.clone() } else { "story".into() },
            title: if ticket.title.trim().is_empty() { ticket.key.clone() } else { ticket.title.clone() },
            body: ticket.body.clone(),
            status: "backlog".into(),
            ticket: serde_json::json!({ "provider": ticket.provider, "uid": ticket.uid, "key": ticket.key, "url": ticket.url, "title": ticket.title }),
            ..Default::default()
        };
        out.push(backlog_save(conn, &card)?);
    }
    Ok(out)
}

// ---------- decisions ----------

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct DecisionRow {
    pub id: String,
    pub workspace_id: String,
    pub run_id: String,
    pub item_id: String,
    pub kind: String,
    pub question: String,
    pub options: Vec<String>,
    pub choice: String,
    pub p: f64,
    pub sharp: bool,
    pub source: String,
    pub votes: Vec<String>,
    pub ms: i64,
    pub saved_tokens: i64,
    pub created_at: String,
}

pub fn decision_insert(conn: &Connection, row: &DecisionRow) -> rusqlite::Result<DecisionRow> {
    let saved = DecisionRow {
        id: if row.id.is_empty() { Uuid::new_v4().to_string() } else { row.id.clone() },
        created_at: if row.created_at.is_empty() { now() } else { row.created_at.clone() },
        ..row.clone()
    };
    conn.execute(
        "INSERT INTO agent_decisions (id, workspace_id, run_id, item_id, kind, question, options, choice, p, sharp, source, votes, ms, saved_tokens, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![
            saved.id, saved.workspace_id, saved.run_id, saved.item_id, saved.kind, saved.question, json_of(&saved.options),
            saved.choice, saved.p, saved.sharp, saved.source, json_of(&saved.votes), saved.ms, saved.saved_tokens, saved.created_at,
        ],
    )?;
    Ok(saved)
}

pub fn decisions_for_run(conn: &Connection, run_id: &str, limit: i64) -> rusqlite::Result<Vec<DecisionRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, workspace_id, run_id, item_id, kind, question, options, choice, p, sharp, source, votes, ms, saved_tokens, created_at
         FROM agent_decisions WHERE run_id = ?1 ORDER BY created_at DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![run_id, limit.clamp(1, 500)], |row| {
        let options: String = row.get(6)?;
        let votes: String = row.get(11)?;
        Ok(DecisionRow {
            id: row.get(0)?,
            workspace_id: row.get(1)?,
            run_id: row.get(2)?,
            item_id: row.get(3)?,
            kind: row.get(4)?,
            question: row.get(5)?,
            options: list_of(&options),
            choice: row.get(7)?,
            p: row.get(8)?,
            sharp: row.get(9)?,
            source: row.get(10)?,
            votes: list_of(&votes),
            ms: row.get(12)?,
            saved_tokens: row.get(13)?,
            created_at: row.get(14)?,
        })
    })?;
    rows.collect()
}

pub fn delete_decisions_for_run(conn: &Connection, run_id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM agent_decisions WHERE run_id = ?1", params![run_id])?;
    Ok(())
}

/// Whether a conversation is a solo agent task whose agent may not edit files: its turns then run
/// in analysis mode, as a read-only team member's do (`team::read_only_conversation`). A team
/// item's task follows the team's member instead, so team batches are left out here.
pub fn agent_read_only(conn: &Connection, conversation_id: &str) -> bool {
    conn.query_row(
        "SELECT a.edits FROM agent_tasks t JOIN workspace_agents a ON a.id = t.agent_id
         WHERE t.conversation_id = ?1 AND COALESCE(t.batch_id, '') NOT LIKE 'team:%' LIMIT 1",
        params![conversation_id],
        |row| row.get::<_, i64>(0),
    )
    .optional()
    .ok()
    .flatten()
    .is_some_and(|edits| edits == 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> (Connection, String) {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        let ws = crate::db::queries::create_workspace(&conn, "ws", "folder", "#fff").unwrap();
        (conn, ws.id)
    }

    #[test]
    fn migrate_is_idempotent() {
        let (conn, _) = conn();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
    }

    #[test]
    fn library_bumps_version_on_every_save() {
        let (conn, _) = conn();
        let first = library_save(&conn, &LibraryItem { kind: "agent".into(), name: "Dev".into(), ..Default::default() }).unwrap();
        assert_eq!(first.version, 1);
        let second = library_save(&conn, &LibraryItem { name: "Dev backend".into(), ..first.clone() }).unwrap();
        assert_eq!(second.version, 2);
        assert_eq!(second.created_at, first.created_at);
        assert_eq!(library_list(&conn, Some("agent")).unwrap().len(), 1);
        assert!(library_list(&conn, Some("team")).unwrap().is_empty());
        assert!(library_save(&conn, &LibraryItem { kind: "otro".into(), name: "x".into(), ..Default::default() }).is_err());
    }

    #[test]
    fn subtasks_are_one_level_deep() {
        let (conn, ws) = conn();
        let story = backlog_save(&conn, &BacklogItem { workspace_id: ws.clone(), kind: "story".into(), title: "HU".into(), ..Default::default() }).unwrap();
        let sub = backlog_save(&conn, &BacklogItem { workspace_id: ws.clone(), parent_id: story.id.clone(), title: "sub".into(), ..Default::default() }).unwrap();
        let deeper = backlog_save(&conn, &BacklogItem { workspace_id: ws.clone(), parent_id: sub.id.clone(), title: "x".into(), ..Default::default() });
        assert!(deeper.is_err());
        backlog_delete(&conn, &story.id).unwrap();
        assert!(backlog_list(&conn, &ws).unwrap().is_empty());
    }

    #[test]
    fn new_cards_go_last_and_crowded_ranks_are_renumbered() {
        let (conn, ws) = conn();
        let a = backlog_save(&conn, &BacklogItem { workspace_id: ws.clone(), title: "a".into(), ..Default::default() }).unwrap();
        let b = backlog_save(&conn, &BacklogItem { workspace_id: ws.clone(), title: "b".into(), ..Default::default() }).unwrap();
        assert!(b.rank > a.rank);
        backlog_move(&conn, &b.id, "backlog", a.rank).unwrap();
        let ranks: Vec<f64> = backlog_list(&conn, &ws).unwrap().iter().map(|c| c.rank).collect();
        assert_eq!(ranks, vec![1.0, 2.0]);
        assert!(backlog_move(&conn, &a.id, "nowhere", 1.0).is_err());
    }

    #[test]
    fn links_dedupe_and_tickets_import_once() {
        let (conn, ws) = conn();
        let card = backlog_save(&conn, &BacklogItem { workspace_id: ws.clone(), title: "t".into(), ..Default::default() }).unwrap();
        let one = backlog_link(&conn, &card.id, "team_run", "r1").unwrap();
        let two = backlog_link(&conn, &card.id, "team_run", "r1").unwrap();
        assert_eq!(one.id, two.id);
        assert_eq!(backlog_for_ref(&conn, "team_run", "r1").unwrap(), Some(card.id.clone()));
        let ticket = TicketImport { provider: "azure".into(), uid: "azure:1".into(), key: "AB#1".into(), title: "HU 1".into(), ..Default::default() };
        let first = backlog_import_tickets(&conn, &ws, &[ticket.clone()]).unwrap();
        let again = backlog_import_tickets(&conn, &ws, &[ticket]).unwrap();
        assert_eq!(first[0].id, again[0].id);
        assert_eq!(backlog_list(&conn, &ws).unwrap().len(), 2);
    }

    #[test]
    fn decisions_round_trip() {
        let (conn, _) = conn();
        decision_insert(&conn, &DecisionRow { run_id: "r".into(), kind: "retry".into(), question: "¿reintentar?".into(), options: vec!["retry".into(), "stop".into()], choice: "retry".into(), p: 0.84, sharp: true, source: "local".into(), ..Default::default() }).unwrap();
        let rows = decisions_for_run(&conn, "r", 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].sharp);
        assert_eq!(rows[0].options.len(), 2);
    }

    #[test]
    fn an_agent_that_may_not_edit_runs_its_solo_tasks_read_only() {
        let (conn, ws) = conn();
        let project = crate::db::queries::create_project(
            &conn,
            crate::db::models::NewProject {
                workspace_id: ws.clone(),
                name: "repo".into(),
                local_path: "/tmp/cf-crew-repo".into(),
                remote_url: None,
                color: String::new(),
                icon: String::new(),
                ado_org: None,
                ado_project: None,
                ado_repo_id: None,
                github_owner: None,
                github_repo: None,
                github_host: None,
                gitlab_project: None,
                gitlab_host: None,
            },
        )
        .unwrap();
        let mut draft = crate::db::models::AgentDraft { workspace_id: ws.clone(), name: "Revisor".into(), provider: "claude".into(), model: "sonnet".into(), edits: false, ..Default::default() };
        let agent = crate::db::queries::save_workspace_agent(&conn, &draft).unwrap();
        let task = crate::db::queries::create_agent_task(&conn, &ws, &project.id, &agent.id, &agent.name, "claude", "sonnet", "", "g", "t", "", None).unwrap();
        assert!(agent_read_only(&conn, &task.conversation_id));
        draft.id = Some(agent.id.clone());
        draft.edits = true;
        crate::db::queries::save_workspace_agent(&conn, &draft).unwrap();
        assert!(!agent_read_only(&conn, &task.conversation_id));
        assert!(!agent_read_only(&conn, "agent-nobody"));
    }
}
