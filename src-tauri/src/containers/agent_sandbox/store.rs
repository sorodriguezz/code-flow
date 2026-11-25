//! The broker's two tables: the sandboxes, and what happened in each (the evidence).
//!
//! Machine-local on purpose — a row names a container of this computer's engine and a folder of its
//! disk, neither of which exists anywhere a backup is restored to — so neither table is backed up
//! (see `backup::snapshot::NEVER_BACKED_UP`). A destroyed sandbox keeps its row and its evidence:
//! "what did the agent run, and what did it change" outlives the container, until the user forgets it.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Sandbox {
    pub id: String,
    pub workspace_id: String,
    pub project_id: String,
    /// The agent task it was made for, or empty.
    pub task_id: String,
    /// The story (`story_drafts.id`) it was made for, or empty.
    pub story_id: String,
    pub title: String,
    pub runtime: String,
    pub context: String,
    pub image: String,
    pub container_id: String,
    pub container_name: String,
    pub repo_path: String,
    pub worktree_path: String,
    pub branch: String,
    /// The commit the checkout started from: what the final diff is taken against.
    pub base_commit: String,
    /// The broker made the checkout, so destroying the sandbox may remove it; a task's own is the task's.
    pub worktree_owned: bool,
    /// `none`, `internal` or `internet`.
    pub network: String,
    pub memory_mb: f64,
    pub cpus: f64,
    pub pids_limit: f64,
    pub ports: Vec<String>,
    /// `creating`, `running`, `stopped`, `failed`, `blocked` or `destroyed`.
    pub status: String,
    /// `ok`, `warnings` (advisories only) or `blocked`.
    pub policy_status: String,
    pub error: String,
    pub created_at: String,
    pub updated_at: String,
}

impl Sandbox {
    /// Whether its container may still exist: what the orphan cleanup must leave alone.
    pub fn live(&self) -> bool {
        matches!(self.status.as_str(), "creating" | "running" | "stopped")
    }
}

/// One entry of a sandbox's timeline.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Evidence {
    pub id: i64,
    pub sandbox_id: String,
    /// `created`, `policy`, `hardening`, `scan`, `exec`, `test`, `diff`, `stopped`, `started`,
    /// `destroyed`, `cancelled`, `error`.
    pub kind: String,
    pub at: String,
    pub summary: String,
    pub data: Value,
}

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_sandboxes (
            id             TEXT PRIMARY KEY,
            workspace_id   TEXT NOT NULL DEFAULT '',
            project_id     TEXT NOT NULL DEFAULT '',
            task_id        TEXT NOT NULL DEFAULT '',
            story_id       TEXT NOT NULL DEFAULT '',
            title          TEXT NOT NULL DEFAULT '',
            runtime        TEXT NOT NULL,
            context        TEXT NOT NULL DEFAULT '',
            image          TEXT NOT NULL,
            container_id   TEXT NOT NULL DEFAULT '',
            container_name TEXT NOT NULL DEFAULT '',
            repo_path      TEXT NOT NULL DEFAULT '',
            worktree_path  TEXT NOT NULL DEFAULT '',
            branch         TEXT NOT NULL DEFAULT '',
            base_commit    TEXT NOT NULL DEFAULT '',
            worktree_owned INTEGER NOT NULL DEFAULT 0,
            network        TEXT NOT NULL DEFAULT 'none',
            memory_mb      REAL NOT NULL DEFAULT 0,
            cpus           REAL NOT NULL DEFAULT 0,
            pids_limit     REAL NOT NULL DEFAULT 0,
            ports          TEXT NOT NULL DEFAULT '[]',
            status         TEXT NOT NULL DEFAULT 'creating',
            policy_status  TEXT NOT NULL DEFAULT '',
            error          TEXT NOT NULL DEFAULT '',
            created_at     TEXT NOT NULL,
            updated_at     TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_agent_sandboxes_workspace ON agent_sandboxes(workspace_id, created_at);
         CREATE INDEX IF NOT EXISTS idx_agent_sandboxes_story ON agent_sandboxes(story_id);
         CREATE TABLE IF NOT EXISTS agent_sandbox_evidence (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            sandbox_id TEXT NOT NULL,
            kind       TEXT NOT NULL,
            at         TEXT NOT NULL,
            summary    TEXT NOT NULL DEFAULT '',
            data       TEXT NOT NULL DEFAULT '{}'
         );
         CREATE INDEX IF NOT EXISTS idx_agent_sandbox_evidence ON agent_sandbox_evidence(sandbox_id, id);",
    )
}

const COLUMNS: &str = "id, workspace_id, project_id, task_id, story_id, title, runtime, context, image, container_id, container_name, repo_path, \
     worktree_path, branch, base_commit, worktree_owned, network, memory_mb, cpus, pids_limit, ports, status, policy_status, error, created_at, updated_at";

fn map(row: &Row) -> rusqlite::Result<Sandbox> {
    Ok(Sandbox {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        project_id: row.get(2)?,
        task_id: row.get(3)?,
        story_id: row.get(4)?,
        title: row.get(5)?,
        runtime: row.get(6)?,
        context: row.get(7)?,
        image: row.get(8)?,
        container_id: row.get(9)?,
        container_name: row.get(10)?,
        repo_path: row.get(11)?,
        worktree_path: row.get(12)?,
        branch: row.get(13)?,
        base_commit: row.get(14)?,
        worktree_owned: row.get::<_, i64>(15)? != 0,
        network: row.get(16)?,
        memory_mb: row.get(17)?,
        cpus: row.get(18)?,
        pids_limit: row.get(19)?,
        ports: serde_json::from_str(&row.get::<_, String>(20)?).unwrap_or_default(),
        status: row.get(21)?,
        policy_status: row.get(22)?,
        error: row.get(23)?,
        created_at: row.get(24)?,
        updated_at: row.get(25)?,
    })
}

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub fn insert(conn: &Connection, s: &Sandbox) -> rusqlite::Result<()> {
    conn.execute(
        &format!("INSERT INTO agent_sandboxes ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26)"),
        params![
            s.id,
            s.workspace_id,
            s.project_id,
            s.task_id,
            s.story_id,
            s.title,
            s.runtime,
            s.context,
            s.image,
            s.container_id,
            s.container_name,
            s.repo_path,
            s.worktree_path,
            s.branch,
            s.base_commit,
            s.worktree_owned as i64,
            s.network,
            s.memory_mb,
            s.cpus,
            s.pids_limit,
            serde_json::to_string(&s.ports).unwrap_or_else(|_| "[]".into()),
            s.status,
            s.policy_status,
            s.error,
            s.created_at,
            s.updated_at,
        ],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> rusqlite::Result<Option<Sandbox>> {
    conn.query_row(&format!("SELECT {COLUMNS} FROM agent_sandboxes WHERE id = ?1"), params![id], map).optional()
}

/// A workspace's sandboxes (every one for `None`), newest first.
pub fn list(conn: &Connection, workspace_id: Option<&str>) -> rusqlite::Result<Vec<Sandbox>> {
    let mut statement = conn.prepare(&format!("SELECT {COLUMNS} FROM agent_sandboxes WHERE (?1 IS NULL OR workspace_id = ?1) ORDER BY created_at DESC, rowid DESC"))?;
    let rows = statement.query_map(params![workspace_id], map)?;
    rows.collect()
}

pub fn for_story(conn: &Connection, story_id: &str) -> rusqlite::Result<Vec<Sandbox>> {
    let mut statement = conn.prepare(&format!("SELECT {COLUMNS} FROM agent_sandboxes WHERE story_id = ?1 ORDER BY created_at DESC, rowid DESC"))?;
    let rows = statement.query_map(params![story_id], map)?;
    rows.collect()
}

/// The running sandbox whose checkout is `worktree` — what binds an agent's run to its sandbox.
pub fn running_at(conn: &Connection, worktree: &str) -> rusqlite::Result<Option<Sandbox>> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM agent_sandboxes WHERE worktree_path = ?1 AND status = 'running' ORDER BY created_at DESC LIMIT 1"),
        params![worktree],
        map,
    )
    .optional()
}

/// Every sandbox whose container may still exist.
pub fn live_ids(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut statement = conn.prepare("SELECT id FROM agent_sandboxes WHERE status IN ('creating', 'running', 'stopped')")?;
    let rows = statement.query_map([], |r| r.get(0))?;
    rows.collect()
}

pub fn set_status(conn: &Connection, id: &str, status: &str, error: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE agent_sandboxes SET status = ?2, error = ?3, updated_at = ?4 WHERE id = ?1", params![id, status, error, now()])?;
    Ok(())
}

pub fn set_container(conn: &Connection, id: &str, container_id: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE agent_sandboxes SET container_id = ?2, updated_at = ?3 WHERE id = ?1", params![id, container_id, now()])?;
    Ok(())
}

pub fn set_checkout(conn: &Connection, id: &str, worktree: &str, branch: &str, base: &str, owned: bool) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE agent_sandboxes SET worktree_path = ?2, branch = ?3, base_commit = ?4, worktree_owned = ?5, updated_at = ?6 WHERE id = ?1",
        params![id, worktree, branch, base, owned as i64, now()],
    )?;
    Ok(())
}

pub fn add_evidence(conn: &Connection, sandbox_id: &str, kind: &str, summary: &str, data: &Value) -> rusqlite::Result<Evidence> {
    let at = now();
    let text = serde_json::to_string(data).unwrap_or_else(|_| "{}".into());
    conn.execute(
        "INSERT INTO agent_sandbox_evidence (sandbox_id, kind, at, summary, data) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![sandbox_id, kind, at, summary, text],
    )?;
    Ok(Evidence { id: conn.last_insert_rowid(), sandbox_id: sandbox_id.into(), kind: kind.into(), at, summary: summary.into(), data: data.clone() })
}

/// A sandbox's timeline, oldest first.
pub fn evidence(conn: &Connection, sandbox_id: &str) -> rusqlite::Result<Vec<Evidence>> {
    let mut statement = conn.prepare("SELECT id, sandbox_id, kind, at, summary, data FROM agent_sandbox_evidence WHERE sandbox_id = ?1 ORDER BY id")?;
    let rows = statement.query_map(params![sandbox_id], |r| {
        Ok(Evidence {
            id: r.get(0)?,
            sandbox_id: r.get(1)?,
            kind: r.get(2)?,
            at: r.get(3)?,
            summary: r.get(4)?,
            data: serde_json::from_str(&r.get::<_, String>(5)?).unwrap_or(Value::Null),
        })
    })?;
    rows.collect()
}

/// Forgets a sandbox and its evidence.
pub fn delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM agent_sandbox_evidence WHERE sandbox_id = ?1", params![id])?;
    conn.execute("DELETE FROM agent_sandboxes WHERE id = ?1", params![id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample(id: &str, workspace: &str, status: &str) -> Sandbox {
        Sandbox {
            id: id.into(),
            workspace_id: workspace.into(),
            runtime: "docker".into(),
            image: "node:22".into(),
            worktree_path: format!("/w/{id}"),
            network: "none".into(),
            ports: vec!["3000".into()],
            status: status.into(),
            created_at: format!("2026-11-24T10:00:0{}Z", id.len()),
            updated_at: now(),
            ..Default::default()
        }
    }

    #[test]
    fn sandboxes_and_their_timeline_round_trip() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        insert(&conn, &sample("a", "w1", "running")).unwrap();
        insert(&conn, &Sandbox { story_id: "story-1".into(), ..sample("bb", "w2", "destroyed") }).unwrap();
        let a = get(&conn, "a").unwrap().unwrap();
        assert_eq!((a.ports.clone(), a.live()), (vec!["3000".to_string()], true));
        assert_eq!(list(&conn, Some("w1")).unwrap().len(), 1);
        assert_eq!(list(&conn, None).unwrap().iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), vec!["bb", "a"], "newest first");
        assert_eq!(for_story(&conn, "story-1").unwrap().len(), 1);
        assert_eq!(running_at(&conn, "/w/a").unwrap().map(|s| s.id), Some("a".into()));
        assert_eq!(running_at(&conn, "/w/bb").unwrap(), None, "a destroyed sandbox binds no run");
        assert_eq!(live_ids(&conn).unwrap(), vec!["a".to_string()]);

        set_status(&conn, "a", "stopped", "").unwrap();
        assert_eq!(running_at(&conn, "/w/a").unwrap(), None);
        set_container(&conn, "a", "c0ffee").unwrap();
        set_checkout(&conn, "a", "/w/a2", "codeflow/x", "abc", true).unwrap();
        let a = get(&conn, "a").unwrap().unwrap();
        assert_eq!((a.container_id.as_str(), a.worktree_path.as_str(), a.worktree_owned), ("c0ffee", "/w/a2", true));

        add_evidence(&conn, "a", "exec", "ls", &json!({"exitCode": 0})).unwrap();
        add_evidence(&conn, "a", "test", "npm test", &json!({"exitCode": 1})).unwrap();
        let timeline = evidence(&conn, "a").unwrap();
        assert_eq!(timeline.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(), vec!["exec", "test"]);
        assert_eq!(timeline[1].data["exitCode"], 1);
        delete(&conn, "a").unwrap();
        assert!(get(&conn, "a").unwrap().is_none());
        assert!(evidence(&conn, "a").unwrap().is_empty());
    }
}
