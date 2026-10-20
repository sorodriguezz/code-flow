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
//! approved by the person who wrote it — the one case that skips the candidate step.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

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

const COLUMNS: &str = "id, scope, workspace_id, project_id, task_ref, kind, title, body, status, source, evidence, supersedes, local_only, expires_at, created_at, updated_at, used_at, use_count";

fn row_to_memory(r: &rusqlite::Row<'_>) -> rusqlite::Result<Memory> {
    let evidence: String = r.get(10)?;
    Ok(Memory {
        id: r.get(0)?,
        scope: r.get(1)?,
        workspace_id: r.get(2)?,
        project_id: r.get(3)?,
        task_ref: r.get(4)?,
        kind: r.get(5)?,
        title: r.get(6)?,
        body: r.get(7)?,
        status: r.get(8)?,
        source: r.get(9)?,
        evidence: serde_json::from_str(&evidence).unwrap_or_default(),
        supersedes: r.get(11)?,
        local_only: r.get(12)?,
        expires_at: r.get(13)?,
        created_at: r.get(14)?,
        updated_at: r.get(15)?,
        used_at: r.get(16)?,
        use_count: r.get(17)?,
    })
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

/// Creates a memory — or returns the one already there with the same title in the same scope, so a
/// rule said twice is one rule. The text is redacted first: a key is never a memory.
pub fn create(conn: &Connection, input: NewMemory) -> Result<Memory, String> {
    let title = crate::secret_scan::redact(input.title.trim()).0;
    let body = crate::secret_scan::redact(input.body.trim()).0;
    if title.is_empty() && body.is_empty() {
        return Err("a memory needs a title or a body".to_string());
    }
    let title = if title.is_empty() { body.chars().take(80).collect() } else { title };
    let scope = input.scope.unwrap_or(if input.project_id.is_some() { Scope::Project } else if input.workspace_id.is_some() { Scope::Workspace } else { Scope::Global });
    let (workspace_id, project_id) = match scope {
        Scope::Global => (None, None),
        Scope::Workspace => (input.workspace_id.clone(), None),
        Scope::Project | Scope::Task => (input.workspace_id.clone(), input.project_id.clone()),
    };
    for existing in list(conn, &Filter { scope: Some(scope.as_str().into()), workspace_id: workspace_id.clone(), project_id: project_id.clone(), ..Default::default() }).map_err(|e| e.to_string())? {
        if existing.status != "revoked" && normalized(&existing.title) == normalized(&title) {
            return Ok(existing);
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let status = if input.approved { "approved" } else { "candidate" };
    let source = input.source.unwrap_or_else(|| "user".to_string());
    let at = now();
    conn.execute(
        &format!("INSERT INTO ai_memories ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15, NULL, 0)"),
        params![
            id,
            scope.as_str(),
            workspace_id,
            project_id,
            input.task_ref,
            input.kind.unwrap_or(Kind::Preference).as_str(),
            title,
            body,
            status,
            source,
            serde_json::to_string(&input.evidence).unwrap_or_else(|_| "[]".into()),
            input.supersedes,
            input.local_only,
            input.expires_at,
            at,
        ],
    )
    .map_err(|e| e.to_string())?;
    revise(conn, &id, "created", &title, &body, if source == "user" { "user" } else { "system" }).map_err(|e| e.to_string())?;
    if input.approved {
        supersede_older(conn, &id).map_err(|e| e.to_string())?;
    }
    get(conn, &id).map_err(|e| e.to_string())?.ok_or_else(|| "memory vanished".to_string())
}

/// When a memory that replaces another is approved, the other is revoked — and says why.
fn supersede_older(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    let older: Option<String> = conn.query_row("SELECT supersedes FROM ai_memories WHERE id = ?1", params![id], |r| r.get(0)).optional()?.flatten();
    if let Some(older) = older {
        let changed = conn.execute("UPDATE ai_memories SET status = 'revoked', updated_at = ?1 WHERE id = ?2 AND status != 'revoked'", params![now(), older])?;
        if changed > 0 {
            revise(conn, &older, "superseded", "", id, "system")?;
        }
    }
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> rusqlite::Result<Option<Memory>> {
    conn.query_row(&format!("SELECT {COLUMNS} FROM ai_memories WHERE id = ?1"), params![id], row_to_memory).optional()
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
}

pub fn list(conn: &Connection, filter: &Filter) -> rusqlite::Result<Vec<Memory>> {
    expire(conn)?;
    let mut sql = format!("SELECT {COLUMNS} FROM ai_memories m WHERE 1 = 1");
    let mut values: Vec<String> = Vec::new();
    for (column, value) in [("scope", &filter.scope), ("status", &filter.status), ("workspace_id", &filter.workspace_id), ("project_id", &filter.project_id)] {
        if let Some(value) = value.as_ref().filter(|v| !v.is_empty()) {
            values.push(value.clone());
            sql.push_str(&format!(" AND m.{column} = ?{}", values.len()));
        }
    }
    if let Some(query) = filter.query.as_deref().and_then(crate::knowledge::index::fts_query) {
        values.push(query);
        sql.push_str(&format!(" AND m.id IN (SELECT memory_id FROM ai_memories_fts WHERE ai_memories_fts MATCH ?{})", values.len()));
    }
    sql.push_str(&format!(" ORDER BY CASE m.status WHEN 'candidate' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, m.updated_at DESC LIMIT {}", filter.limit.unwrap_or(500).clamp(1, 5_000)));
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(values.iter()), row_to_memory)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
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
}

pub fn edit(conn: &Connection, id: &str, patch: Patch) -> Result<Memory, String> {
    let current = get(conn, id).map_err(|e| e.to_string())?.ok_or("memory not found")?;
    let title = patch.title.map(|t| crate::secret_scan::redact(t.trim()).0).unwrap_or(current.title.clone());
    let body = patch.body.map(|b| crate::secret_scan::redact(b.trim()).0).unwrap_or(current.body.clone());
    let kind = patch.kind.map(|k| k.as_str().to_string()).unwrap_or(current.kind.clone());
    let local_only = patch.local_only.unwrap_or(current.local_only);
    let expires_at = if patch.clear_expiry { None } else { patch.expires_at.or(current.expires_at) };
    conn.execute(
        "UPDATE ai_memories SET title = ?1, body = ?2, kind = ?3, local_only = ?4, expires_at = ?5, updated_at = ?6 WHERE id = ?7",
        params![title, body, kind, local_only, expires_at, now(), id],
    )
    .map_err(|e| e.to_string())?;
    if title != current.title || body != current.body {
        revise(conn, id, "edited", &title, &body, "user").map_err(|e| e.to_string())?;
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
    let mut stmt = conn.prepare("SELECT at, action, title, body, actor FROM ai_memory_revisions WHERE memory_id = ?1 ORDER BY at DESC")?;
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

/// The approved memories that apply to a question in `project_id` (of `workspace_id`): its project's
/// and workspace's and the global ones, the ones matching the question first, within `budget`
/// characters. `cloud`: a cloud engine is asking, so local-only memories are left out. Marks what
/// it returns as used.
pub fn relevant(conn: &Connection, workspace_id: Option<&str>, project_id: Option<&str>, question: &str, cloud: bool, budget: usize) -> rusqlite::Result<Vec<Memory>> {
    expire(conn)?;
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM ai_memories WHERE status = 'approved'
           AND (scope = 'global'
                OR (scope = 'workspace' AND workspace_id IS ?1)
                OR (scope IN ('project', 'task') AND project_id IS ?2))
           AND (?3 = 0 OR local_only = 0)"
    ))?;
    let all: Vec<Memory> = stmt
        .query_map(params![workspace_id, project_id, cloud], row_to_memory)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if all.is_empty() {
        return Ok(Vec::new());
    }
    // The ones the question's words match, by bm25, then the narrowest scope.
    let matched: Vec<String> = match crate::knowledge::index::fts_query(question) {
        Some(query) => {
            let mut stmt = conn.prepare("SELECT memory_id FROM ai_memories_fts WHERE ai_memories_fts MATCH ?1 ORDER BY bm25(ai_memories_fts, 2.0, 1.0) LIMIT 50")?;
            let ids: Vec<String> = stmt.query_map(params![query], |r| r.get(0))?.filter_map(Result::ok).collect();
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
        (hit, preference, scope)
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
        let cost = memory.title.chars().count() + memory.body.chars().count() + 8;
        if used + cost > budget {
            continue;
        }
        used += cost;
        out.push(memory);
    }
    let at = now();
    for memory in &out {
        conn.execute("UPDATE ai_memories SET used_at = ?1, use_count = use_count + 1 WHERE id = ?2", params![at, memory.id])?;
    }
    Ok(out)
}

/// The block a model is shown, and the sources for «Contexto usado».
pub fn note(memories: &[Memory]) -> Option<(String, Vec<crate::context::ContextSource>)> {
    if memories.is_empty() {
        return None;
    }
    let lines: Vec<String> = memories
        .iter()
        .map(|m| if m.body.is_empty() || m.body == m.title { format!("- [{}] {}", m.kind, m.title) } else { format!("- [{}] {}: {}", m.kind, m.title, m.body) })
        .collect();
    let sources = memories.iter().map(|m| crate::context::ContextSource::new(crate::context::SourceKind::Memory, m.title.clone(), None)).collect();
    Some((
        format!(
            "\n\n---\nMemorias que el usuario aprobó en CodeFlow para este proyecto (respétalas; si alguna contradice lo que pide ahora, dilo):\n{}",
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
/// weeks is a sign the models keep getting that area wrong. Deterministic — no model writes them.
pub fn propose_from_experiences(conn: &Connection, workspace_id: &str) -> Result<Vec<Memory>, String> {
    let since = now() - 14 * 86_400_000;
    let mut stmt = conn
        .prepare("SELECT project_id, detail FROM ai_experiences WHERE workspace_id = ?1 AND signal IN ('reverted', 'rejected') AND created_at > ?2")
        .map_err(|e| e.to_string())?;
    let rows: Vec<(Option<String>, String)> = stmt
        .query_map(params![workspace_id, since], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;
    let mut counts: std::collections::HashMap<(Option<String>, String), (usize, Vec<String>)> = std::collections::HashMap::new();
    for (project, detail) in rows {
        let detail: serde_json::Value = serde_json::from_str(&detail).unwrap_or_default();
        let paths: Vec<String> = detail["paths"].as_array().map(|a| a.iter().filter_map(|p| p.as_str().map(str::to_string)).collect()).unwrap_or_default();
        for path in paths {
            counts.entry((project.clone(), path)).or_default().0 += 1;
        }
    }
    let mut out = Vec::new();
    for ((project, path), (count, _)) in counts {
        if count < 3 {
            continue;
        }
        let memory = create(
            conn,
            NewMemory {
                scope: Some(if project.is_some() { Scope::Project } else { Scope::Workspace }),
                workspace_id: Some(workspace_id.to_string()),
                project_id: project,
                kind: Some(Kind::Convention),
                title: format!("Cuidado al cambiar {path}"),
                body: format!("Los cambios de IA en {path} se revirtieron {count} veces en dos semanas: léelo completo y explica el cambio antes de tocarlo."),
                approved: false,
                source: Some("experience".into()),
                ..Default::default()
            },
        )?;
        out.push(memory);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON; CREATE TABLE workspaces (id TEXT PRIMARY KEY); CREATE TABLE projects (id TEXT PRIMARY KEY); CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);").unwrap();
        conn.execute_batch("INSERT INTO workspaces VALUES ('w1'), ('w2'); INSERT INTO projects VALUES ('p1'), ('p2');").unwrap();
        crate::db::migrations::add_ai_platform_tables(&conn).unwrap();
        conn
    }

    fn new(scope: Scope, kind: Kind, title: &str, body: &str, approved: bool) -> NewMemory {
        NewMemory {
            scope: Some(scope),
            workspace_id: Some("w1".into()),
            project_id: Some("p1".into()),
            kind: Some(kind),
            title: title.into(),
            body: body.into(),
            approved,
            ..Default::default()
        }
    }

    #[test]
    fn duplicates_fold_into_one_and_secrets_are_redacted() {
        let conn = db();
        let a = create(&conn, new(Scope::Project, Kind::Convention, "Usar pnpm", "Nunca npm.", true)).unwrap();
        let b = create(&conn, new(Scope::Project, Kind::Convention, "usar PNPM.", "otra vez", true)).unwrap();
        assert_eq!(a.id, b.id);
        // Built at run time so the source never holds a token-shaped literal (GitHub push protection).
        let token = ["ghp_", "abcdefghijklmnopqrstuvwxyz0123456789"].concat();
        let c = create(&conn, new(Scope::Project, Kind::Fact, "Token", &token, true)).unwrap();
        assert!(c.body.contains("[REDACTED"));
        assert_eq!(revisions(&conn, &a.id).unwrap()[0].action, "created");
    }

    #[test]
    fn only_approved_memories_of_the_right_scope_reach_a_model() {
        let conn = db();
        create(&conn, new(Scope::Project, Kind::Decision, "Base de datos", "Usamos SQLite, no PostgreSQL.", true)).unwrap();
        create(&conn, new(Scope::Project, Kind::Decision, "Colas", "Sin Kafka.", false)).unwrap();
        create(&conn, NewMemory { scope: Some(Scope::Global), kind: Some(Kind::Preference), title: "Responde en español".into(), approved: true, ..Default::default() }).unwrap();
        let mut other = new(Scope::Project, Kind::Decision, "Otra base", "MySQL", true);
        other.project_id = Some("p2".into());
        create(&conn, other).unwrap();
        let found = relevant(&conn, Some("w1"), Some("p1"), "¿qué base de datos usamos?", false, 2_000).unwrap();
        let titles: Vec<&str> = found.iter().map(|m| m.title.as_str()).collect();
        assert!(titles.contains(&"Base de datos"));
        assert!(titles.contains(&"Responde en español"), "a preference holds for every question");
        assert!(!titles.contains(&"Colas"), "a candidate is not shown");
        assert!(!titles.contains(&"Otra base"), "another project's decision is not shown");
        assert_eq!(get(&conn, &found[0].id).unwrap().unwrap().use_count, 1);
    }

    #[test]
    fn local_only_memories_stay_away_from_cloud_engines() {
        let conn = db();
        let mut secret = new(Scope::Project, Kind::Fact, "Servidor interno", "La base vive en db.interna.example", true);
        secret.local_only = true;
        create(&conn, secret).unwrap();
        assert!(relevant(&conn, Some("w1"), Some("p1"), "servidor base", true, 2_000).unwrap().is_empty());
        assert_eq!(relevant(&conn, Some("w1"), Some("p1"), "servidor base", false, 2_000).unwrap().len(), 1);
    }

    #[test]
    fn approving_a_replacement_revokes_the_old_one_and_expiry_revokes_too() {
        let conn = db();
        let old = create(&conn, new(Scope::Project, Kind::Decision, "Node 18", "Usamos Node 18.", true)).unwrap();
        let mut newer = new(Scope::Project, Kind::Decision, "Node 22", "Migramos a Node 22.", false);
        newer.supersedes = Some(old.id.clone());
        let newer = create(&conn, newer).unwrap();
        set_status(&conn, &newer.id, "approved").unwrap();
        assert_eq!(get(&conn, &old.id).unwrap().unwrap().status, "revoked");
        assert_eq!(revisions(&conn, &old.id).unwrap()[0].action, "superseded");
        let mut short = new(Scope::Project, Kind::Fact, "Sprint", "Congelado hasta el viernes", true);
        short.expires_at = Some(1);
        let short = create(&conn, short).unwrap();
        expire(&conn).unwrap();
        assert_eq!(get(&conn, &short.id).unwrap().unwrap().status, "revoked");
    }

    #[test]
    fn edits_are_kept_as_revisions() {
        let conn = db();
        let m = create(&conn, new(Scope::Workspace, Kind::Convention, "Commits", "En inglés", true)).unwrap();
        edit(&conn, &m.id, Patch { body: Some("En español, imperativo".into()), ..Default::default() }).unwrap();
        let history = revisions(&conn, &m.id).unwrap();
        assert_eq!(history[0].action, "edited");
        assert_eq!(history[0].body, "En español, imperativo");
    }

    #[test]
    fn remember_requests_are_read_from_either_language() {
        assert_eq!(remember_request("Recuerda que los commits van en español.").as_deref(), Some("los commits van en español"));
        assert_eq!(remember_request("Listo. Remember that we deploy on Fridays").as_deref(), Some("we deploy on Fridays"));
        assert!(remember_request("no recuerdo qué hace esto").is_none());
        assert!(remember_request("recuerda que x").is_none(), "too short to be a rule");
    }

    #[test]
    fn repeated_reverts_propose_a_candidate() {
        let conn = db();
        for i in 0..3 {
            crate::experiences::record(
                &conn,
                crate::experiences::NewExperience {
                    workspace_id: Some("w1".into()),
                    project_id: Some("p1".into()),
                    source: Some(crate::experiences::Source::CheckpointRestore),
                    signal: Some(crate::experiences::Signal::Reverted),
                    run_ref: Some(format!("checkpoint:{i}")),
                    detail: serde_json::json!({ "paths": ["src/pay.ts"] }),
                    ..Default::default()
                },
            )
            .unwrap();
        }
        let proposed = propose_from_experiences(&conn, "w1").unwrap();
        assert_eq!(proposed.len(), 1);
        assert_eq!(proposed[0].status, "candidate");
        assert!(proposed[0].body.contains("src/pay.ts"));
    }
}
