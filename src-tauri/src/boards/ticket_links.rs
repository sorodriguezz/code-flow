//! The record that ties a ticket to the code written for it: which repository, which branch, which
//! worktree, and — once there is one — which pull request.
//!
//! Written by «Empezar» (see `commands::tickets_cmd`), read by the PR form (to add the reference),
//! by the PR-created and merged hooks (to move the ticket), and by the projects panel (the chip on a
//! repository's row). It is the *only* thing that makes CodeFlow move a ticket on its own: a branch
//! someone named `ABC-123-x` by hand is recognised for the chip, but never moved
//! (user, 2026-10-23: «… nunca mover un ticket sin opt-in»).
//!
//! A row per (repository, branch). Starting the same ticket again on the same repository reuses
//! the row; on another repository it is a second row, which is what working a ticket across a
//! front end and its API looks like.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::tickets::Ticket;

/// `crate::db::migrations` calls this in its run list — the table lives beside the code that owns it.
pub(crate) fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    retire_legacy(conn)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS ticket_links (
            id             TEXT PRIMARY KEY,
            workspace_id   TEXT NOT NULL,
            project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            provider       TEXT NOT NULL,
            account        TEXT NOT NULL,
            ticket_uid     TEXT NOT NULL,
            ticket         TEXT NOT NULL DEFAULT '{}',
            branch         TEXT NOT NULL,
            worktree_path  TEXT NOT NULL DEFAULT '',
            pr_id          INTEGER NOT NULL DEFAULT 0,
            pr_url         TEXT NOT NULL DEFAULT '',
            stage          TEXT NOT NULL DEFAULT 'started',
            created_at     TEXT NOT NULL,
            updated_at     TEXT NOT NULL,
            UNIQUE (project_id, branch)
        );
        CREATE INDEX IF NOT EXISTS idx_ticket_links_workspace ON ticket_links(workspace_id);",
    )
}

/// An older ticket feature, since removed from the code, left a `ticket_links` of its own in some
/// databases — `(project_id, branch, ticket_id → tickets, linked_at)`. `CREATE TABLE IF NOT EXISTS`
/// then kept that one, and the index on `workspace_id` stopped the whole database from opening
/// (user report, 2026-10-23: «No se pudo preparar la base de datos … no such column: workspace_id»).
/// A table without `workspace_id` is that one: dropped when empty — it always was in practice —
/// and otherwise renamed aside, so nothing anyone wrote is lost.
fn retire_legacy(conn: &Connection) -> rusqlite::Result<()> {
    let columns: Vec<String> = {
        let mut stmt = conn.prepare("SELECT name FROM pragma_table_info('ticket_links')")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    if columns.is_empty() || columns.iter().any(|c| c == "workspace_id") {
        return Ok(());
    }
    let rows: i64 = conn.query_row("SELECT COUNT(*) FROM ticket_links", [], |r| r.get(0))?;
    if rows == 0 {
        conn.execute_batch("DROP TABLE ticket_links;")
    } else {
        conn.execute_batch("ALTER TABLE ticket_links RENAME TO ticket_links_legacy;")
    }
}

/// One link. `ticket` is the row as it was last seen — enough to draw the chip and to address a
/// move without asking the board first.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TicketLink {
    pub id: String,
    pub workspace_id: String,
    pub project_id: String,
    pub ticket_uid: String,
    pub ticket: Ticket,
    pub branch: String,
    pub worktree_path: String,
    pub pr_id: i64,
    pub pr_url: String,
    /// `started` → `review` (a pull request was opened) → `done` (it merged).
    pub stage: String,
    pub created_at: String,
    pub updated_at: String,
}

const COLUMNS: &str =
    "id, workspace_id, project_id, ticket_uid, ticket, branch, worktree_path, pr_id, pr_url, stage, created_at, updated_at";

fn read(row: &rusqlite::Row<'_>) -> rusqlite::Result<TicketLink> {
    let ticket: String = row.get(4)?;
    Ok(TicketLink {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        project_id: row.get(2)?,
        ticket_uid: row.get(3)?,
        ticket: serde_json::from_str(&ticket).unwrap_or_default(),
        branch: row.get(5)?,
        worktree_path: row.get(6)?,
        pr_id: row.get(7)?,
        pr_url: row.get(8)?,
        stage: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
    })
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub fn list_for_workspace(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<TicketLink>> {
    let mut statement =
        conn.prepare(&format!("SELECT {COLUMNS} FROM ticket_links WHERE workspace_id = ?1 ORDER BY updated_at DESC"))?;
    let rows = statement.query_map(params![workspace_id], read)?;
    rows.collect()
}

pub fn by_branch(conn: &Connection, project_id: &str, branch: &str) -> rusqlite::Result<Option<TicketLink>> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM ticket_links WHERE project_id = ?1 AND branch = ?2"),
        params![project_id, branch.trim()],
        read,
    )
    .optional()
}

pub fn by_ticket(conn: &Connection, project_id: &str, ticket_uid: &str) -> rusqlite::Result<Option<TicketLink>> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM ticket_links WHERE project_id = ?1 AND ticket_uid = ?2 ORDER BY updated_at DESC LIMIT 1"),
        params![project_id, ticket_uid],
        read,
    )
    .optional()
}

/// Records (or refreshes) the link for a branch. A branch belongs to one ticket: starting another
/// ticket on a branch that already had one re-points it, since the newest «Empezar» is the intent.
pub fn upsert(
    conn: &Connection,
    workspace_id: &str,
    project_id: &str,
    ticket: &Ticket,
    branch: &str,
    worktree_path: &str,
) -> rusqlite::Result<TicketLink> {
    let at = now();
    let json = serde_json::to_string(ticket).unwrap_or_else(|_| "{}".into());
    conn.execute(
        "INSERT INTO ticket_links (id, workspace_id, project_id, provider, account, ticket_uid, ticket, branch, worktree_path, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
         ON CONFLICT (project_id, branch) DO UPDATE SET
            ticket_uid = excluded.ticket_uid, ticket = excluded.ticket, provider = excluded.provider,
            account = excluded.account, worktree_path = excluded.worktree_path, updated_at = excluded.updated_at",
        params![
            uuid::Uuid::new_v4().to_string(),
            workspace_id,
            project_id,
            ticket.provider,
            ticket.account,
            ticket.uid(),
            json,
            branch.trim(),
            worktree_path,
            at,
        ],
    )?;
    by_branch(conn, project_id, branch)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

pub fn set_pr(conn: &Connection, id: &str, pr_id: i64, pr_url: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE ticket_links SET pr_id = ?2, pr_url = ?3, stage = CASE WHEN stage = 'done' THEN stage ELSE 'review' END, updated_at = ?4 WHERE id = ?1",
        params![id, pr_id, pr_url, now()],
    )?;
    Ok(())
}

pub fn set_stage(conn: &Connection, id: &str, stage: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE ticket_links SET stage = ?2, updated_at = ?3 WHERE id = ?1", params![id, stage, now()])?;
    Ok(())
}

/// Keeps the stored copy in step with what the board last said (its state above all), so the chip
/// does not go on saying «Por hacer» about a ticket that moved.
pub fn refresh_ticket(conn: &Connection, ticket: &Ticket) -> rusqlite::Result<usize> {
    let json = serde_json::to_string(ticket).unwrap_or_else(|_| "{}".into());
    conn.execute("UPDATE ticket_links SET ticket = ?2 WHERE ticket_uid = ?1", params![ticket.uid(), json])
}

pub fn delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM ticket_links WHERE id = ?1", params![id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE projects (id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('p1');").unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        conn
    }

    fn ticket(key: &str, state: &str) -> Ticket {
        Ticket { provider: "jira".into(), account: "https://acme.atlassian.net".into(), key: key.into(), id: 5, title: "x".into(), state: state.into(), ..Default::default() }
    }

    /// The older feature's table, empty or not, never stops the database from opening.
    #[test]
    fn a_legacy_table_is_dropped_when_empty_and_kept_aside_otherwise() {
        const LEGACY: &str = "CREATE TABLE projects (id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('p1');
             CREATE TABLE ticket_links (project_id TEXT NOT NULL, branch TEXT NOT NULL, ticket_id TEXT NOT NULL,
                                        linked_at TEXT NOT NULL, PRIMARY KEY (project_id, branch));";
        let empty = Connection::open_in_memory().unwrap();
        empty.execute_batch(LEGACY).unwrap();
        migrate(&empty).unwrap();
        upsert(&empty, "w1", "p1", &ticket("ABC-1", "To Do"), "feature/ABC-1-x", "").unwrap();

        let used = Connection::open_in_memory().unwrap();
        used.execute_batch(LEGACY).unwrap();
        used.execute_batch("INSERT INTO ticket_links VALUES ('p1', 'main', 't1', 'now');").unwrap();
        migrate(&used).unwrap();
        let kept: i64 = used.query_row("SELECT COUNT(*) FROM ticket_links_legacy", [], |r| r.get(0)).unwrap();
        assert_eq!(kept, 1);
        upsert(&used, "w1", "p1", &ticket("ABC-1", "To Do"), "feature/ABC-1-x", "").unwrap();
    }

    #[test]
    fn a_branch_holds_one_ticket_and_follows_its_pr() {
        let conn = db();
        let link = upsert(&conn, "w1", "p1", &ticket("ABC-5", "To Do"), "feature/ABC-5-x", "/tmp/wt").unwrap();
        assert_eq!(link.stage, "started");
        assert_eq!(link.ticket.key, "ABC-5");
        assert!(by_ticket(&conn, "p1", "jira:https://acme.atlassian.net:ABC-5").unwrap().is_some());

        set_pr(&conn, &link.id, 42, "https://example.test/pr/42").unwrap();
        let link = by_branch(&conn, "p1", "feature/ABC-5-x").unwrap().unwrap();
        assert_eq!((link.pr_id, link.stage.as_str()), (42, "review"));

        refresh_ticket(&conn, &ticket("ABC-5", "In Review")).unwrap();
        set_stage(&conn, &link.id, "done").unwrap();
        set_pr(&conn, &link.id, 42, "https://example.test/pr/42").unwrap();
        let link = by_branch(&conn, "p1", "feature/ABC-5-x").unwrap().unwrap();
        assert_eq!(link.stage, "done", "a later PR record does not reopen a merged link");
        assert_eq!(link.ticket.state, "In Review");

        let again = upsert(&conn, "w1", "p1", &ticket("ABC-6", "To Do"), "feature/ABC-5-x", "/tmp/wt").unwrap();
        assert_eq!(again.id, link.id);
        assert_eq!(again.ticket.key, "ABC-6");
        assert_eq!(list_for_workspace(&conn, "w1").unwrap().len(), 1);
        delete(&conn, &again.id).unwrap();
        assert!(list_for_workspace(&conn, "w1").unwrap().is_empty());
    }
}
