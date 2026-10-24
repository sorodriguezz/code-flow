//! What the database already knows about the period: the repositories in scope, the reviews
//! CodeFlow's reviewer ran, the meetings recorded in Notas › Reuniones, and the tickets moved.
//! Local reads only — all synchronous, called under the one connection lock.

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use super::{MeetingItem, Period, ReviewItem, TicketItem};

/// A repository the summary looks at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoRef {
    pub project_id: String,
    pub name: String,
    pub path: String,
    pub workspace_id: String,
    pub workspace: String,
}

/// The repositories of `workspace_id`, or of every workspace when it is `None`.
pub fn repos(conn: &Connection, workspace_id: Option<&str>) -> rusqlite::Result<Vec<RepoRef>> {
    let mut statement = conn.prepare(
        "SELECT p.id, p.name, p.local_path, p.workspace_id, w.name FROM projects p JOIN workspaces w ON w.id = p.workspace_id \
         WHERE (?1 IS NULL OR p.workspace_id = ?1) ORDER BY w.sort_order, p.sort_order, p.name",
    )?;
    let rows = statement.query_map(params![workspace_id], |row| {
        Ok(RepoRef { project_id: row.get(0)?, name: row.get(1)?, path: row.get(2)?, workspace_id: row.get(3)?, workspace: row.get(4)? })
    })?;
    rows.collect()
}

/// Most rows read per source — far above a week of anyone's work, a guard against a runaway table.
const MAX_ROWS: usize = 500;

/// The reviews CodeFlow's reviewer ran in the period on one repository, newest first.
pub fn reviews(conn: &Connection, project_id: &str, period: &Period) -> rusqlite::Result<Vec<ReviewItem>> {
    let mut statement = conn.prepare(
        "SELECT id, pr_id, level, meta, findings, created_at FROM review_runs WHERE project_id = ?1 ORDER BY created_at DESC LIMIT ?2",
    )?;
    let rows = statement.query_map(params![project_id, MAX_ROWS as i64], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (run_id, pr_id, level, meta, findings, at) = row?;
        if !period.contains_rfc3339(&at) {
            continue;
        }
        // `review_memory::ReviewMeta`, written verbatim — snake_case.
        let meta: Value = serde_json::from_str(&meta).unwrap_or(Value::Null);
        let field = |key: &str| meta.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
        let findings = serde_json::from_str::<Value>(&findings).ok().and_then(|v| v.as_array().map(Vec::len)).unwrap_or(0);
        out.push(ReviewItem { run_id, pr_id, pr_title: field("pr_title"), url: field("url"), author: field("author"), level, findings, at });
    }
    Ok(out)
}

/// What a meeting's note says first, as one paragraph — where its minutes are written.
fn summary_of(content: &str, max: usize) -> String {
    let mut text = String::new();
    for line in content.lines() {
        let line = line.trim();
        // Headings name sections, the meeting's own embed and HTML comments are not prose.
        if line.is_empty() || line.starts_with('#') || line.starts_with("<!--") || line.starts_with("```") || line.starts_with("::") {
            continue;
        }
        let line = line.trim_start_matches(['-', '*', '>', ' ']).trim();
        if line.is_empty() {
            continue;
        }
        if !text.is_empty() {
            text.push_str(" · ");
        }
        text.push_str(line);
        if text.chars().count() >= max {
            break;
        }
    }
    if text.chars().count() > max {
        let cut: String = text.chars().take(max.saturating_sub(1)).collect();
        format!("{}…", cut.trim_end())
    } else {
        text
    }
}

/// The meetings recorded in the period, oldest first, with the start of their note.
pub fn meetings(conn: &Connection, workspace_id: Option<&str>, period: &Period) -> rusqlite::Result<Vec<MeetingItem>> {
    let mut statement = conn.prepare(
        "SELECT m.id, m.note_id, m.started_at, m.duration_ms, n.title, n.content FROM meetings m JOIN notes n ON n.id = m.note_id \
         WHERE (?1 IS NULL OR m.workspace_id = ?1) AND n.deleted_at = '' AND m.status NOT IN ('recording', 'paused') \
         ORDER BY m.started_at DESC LIMIT ?2",
    )?;
    let rows = statement.query_map(params![workspace_id, MAX_ROWS as i64], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, i64>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (meeting_id, note_id, started_at, duration_ms, title, content) = row?;
        if !period.contains_rfc3339(&started_at) {
            continue;
        }
        out.push(MeetingItem { meeting_id, note_id, title, started_at, minutes: (duration_ms + 30_000) / 60_000, summary: summary_of(&content, 400) });
    }
    out.reverse();
    Ok(out)
}

fn table_exists(conn: &Connection, name: &str) -> bool {
    conn.query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1", params![name], |_| Ok(()))
        .optional()
        .ok()
        .flatten()
        .is_some()
}

fn columns(conn: &Connection, table: &str) -> Vec<String> {
    let Ok(mut statement) = conn.prepare(&format!("PRAGMA table_info({table})")) else { return Vec::new() };
    statement.query_map([], |row| row.get::<_, String>(1)).map(|rows| rows.flatten().collect()).unwrap_or_default()
}

/// The tickets moved, started or linked to a branch in the period — the hook for «Tickets →
/// código», built at the same time as this (2026-10-23): its `ticket_links` table (a ticket started
/// on a branch, moved to review or done) is read when it is there. Any other ticket table is read by
/// the columns it turns out to have, and no table at all is no tickets — a missing section, never a
/// failed summary.
pub fn tickets_moved(conn: &Connection, workspace_id: Option<&str>, period: &Period) -> Vec<TicketItem> {
    if table_exists(conn, "ticket_links") && columns(conn, "ticket_links").iter().any(|c| c == "ticket") {
        return ticket_links(conn, workspace_id, period);
    }
    generic_tickets(conn, workspace_id, period)
}

/// `boards::ticket_links` — a row per (repository, branch) started from a ticket, with the ticket as
/// it was last seen (JSON) and its stage (`started` → `review` → `done`). Started or moved in the
/// period counts.
fn ticket_links(conn: &Connection, workspace_id: Option<&str>, period: &Period) -> Vec<TicketItem> {
    let sql = format!(
        "SELECT ticket, branch, stage, pr_url, created_at, updated_at FROM ticket_links WHERE (?1 IS NULL OR workspace_id = ?1) \
         ORDER BY updated_at DESC LIMIT {MAX_ROWS}"
    );
    let Ok(mut statement) = conn.prepare(&sql) else { return Vec::new() };
    let rows = statement.query_map(params![workspace_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?))
    });
    let Ok(rows) = rows else { return Vec::new() };
    let mut out = Vec::new();
    for (ticket, branch, stage, pr_url, created, updated) in rows.flatten() {
        let at = if period.contains_rfc3339(&updated) {
            updated
        } else if period.contains_rfc3339(&created) {
            created
        } else {
            continue;
        };
        let ticket: Value = serde_json::from_str(&ticket).unwrap_or(Value::Null);
        let field = |key: &str| ticket.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
        let key = match field("key") {
            k if !k.is_empty() => k,
            _ => ticket.get("id").and_then(Value::as_i64).map(|id| format!("#{id}")).unwrap_or_default(),
        };
        let state = match field("state") {
            s if !s.is_empty() => s,
            _ => stage,
        };
        let url = match field("url") {
            u if !u.is_empty() => u,
            _ => pr_url,
        };
        out.push(TicketItem { key, title: field("title"), state, branch, url, at });
    }
    out.reverse();
    out
}

/// Any other ticket table, read by the columns it turns out to have.
fn generic_tickets(conn: &Connection, workspace_id: Option<&str>, period: &Period) -> Vec<TicketItem> {
    const CANDIDATES: &[&str] = &["ticket_links", "ticket_branches", "board_ticket_links", "tickets"];
    let Some(table) = CANDIDATES.iter().find(|t| table_exists(conn, t)) else { return Vec::new() };
    let have = columns(conn, table);
    let pick = |names: &[&str]| names.iter().find(|n| have.iter().any(|h| h == *n)).map(|n| n.to_string());
    let (Some(key), Some(at)) = (pick(&["ticket_key", "key", "ticket_id", "item_id", "external_id"]), pick(&["updated_at", "linked_at", "created_at", "moved_at"])) else {
        return Vec::new();
    };
    let title = pick(&["title", "ticket_title", "summary"]);
    let state = pick(&["state", "status", "column"]);
    let branch = pick(&["branch", "branch_name"]);
    let url = pick(&["url", "ticket_url", "web_url"]);
    let workspace = pick(&["workspace_id"]);
    let expr = |c: &Option<String>| c.clone().map(|c| format!("COALESCE(CAST({c} AS TEXT), '')")).unwrap_or_else(|| "''".into());
    let filter = if workspace.is_some() { "WHERE (?1 IS NULL OR workspace_id = ?1)" } else { "WHERE (?1 IS NULL OR 1 = 1)" };
    let sql = format!(
        "SELECT CAST({key} AS TEXT), {}, {}, {}, {}, CAST({at} AS TEXT) FROM {table} {filter} ORDER BY {at} DESC LIMIT {MAX_ROWS}",
        expr(&title),
        expr(&state),
        expr(&branch),
        expr(&url)
    );
    let Ok(mut statement) = conn.prepare(&sql) else { return Vec::new() };
    let rows = statement.query_map(params![workspace_id], |row| {
        Ok(TicketItem { key: row.get(0)?, title: row.get(1)?, state: row.get(2)?, branch: row.get(3)?, url: row.get(4)?, at: row.get(5)? })
    });
    let Ok(rows) = rows else { return Vec::new() };
    let mut out: Vec<TicketItem> = rows.flatten().filter(|t| period.contains_rfc3339(&t.at)).collect();
    out.reverse();
    out
}

/// The emails the user commits with besides each repository's own: every workspace identity
/// CodeFlow keeps (`workspace_git_identity`) — a person with a work and a personal address has both.
pub fn extra_emails(conn: &Connection) -> Vec<String> {
    let Ok(mut statement) = conn.prepare("SELECT email FROM workspace_git_identity") else { return Vec::new() };
    statement.query_map([], |row| row.get::<_, String>(0)).map(|rows| rows.flatten().filter(|e| e.contains('@')).collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worklog::{period, PeriodKind};
    use chrono::NaiveDate;

    fn seeded() -> crate::db::Db {
        let db = crate::db::init_scratch().unwrap();
        {
            let conn = db.0.lock().unwrap();
            conn.execute_batch(
                "INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Clientes', '2026-01-01T00:00:00+00:00'), ('w2', 'Casa', '2026-01-01T00:00:00+00:00');
                 INSERT INTO projects (id, workspace_id, name, local_path, created_at) VALUES ('p1', 'w1', 'api-pagos', '/tmp/x', '2026-01-01T00:00:00+00:00'),
                   ('p2', 'w2', 'blog', '/tmp/y', '2026-01-01T00:00:00+00:00');
                 INSERT INTO review_runs (id, project_id, workspace_id, pr_id, iter, level, meta, review_md, findings, created_at) VALUES
                   ('r1', 'p1', 'w1', 42, 1, 'standard', '{\"pr_title\":\"Pagos en cuotas\",\"url\":\"https://example.com/pr/42\",\"author\":\"ana\"}', '', '[{},{}]', '2026-10-23T14:00:00+00:00'),
                   ('r2', 'p1', 'w1', 43, 1, 'quick', '{}', '', '[]', '2026-10-20T14:00:00+00:00');
                 INSERT INTO notes (id, workspace_id, title, content, created_at, updated_at) VALUES
                   ('n1', 'w1', 'Planning', '# Planning\n\n- Se decidió lanzar el viernes\n- Ana revisa el login\n', '2026-10-23T00:00:00+00:00', '2026-10-23T00:00:00+00:00');
                 INSERT INTO meetings (id, workspace_id, note_id, status, started_at, duration_ms, created_at, updated_at) VALUES
                   ('m1', 'w1', 'n1', 'done', '2026-10-23T15:00:00+00:00', 1800000, '2026-10-23T15:00:00+00:00', '2026-10-23T15:00:00+00:00'),
                   ('m2', 'w1', 'n1', 'recording', '2026-10-23T16:00:00+00:00', 0, '2026-10-23T16:00:00+00:00', '2026-10-23T16:00:00+00:00');",
            )
            .unwrap();
        }
        db
    }

    fn friday() -> Period {
        // UTC-wide, so the fixture's stamps fall in it in any time zone the tests run in.
        period(PeriodKind::Custom, NaiveDate::from_ymd_opt(2026, 10, 26).unwrap(), NaiveDate::from_ymd_opt(2026, 10, 22), NaiveDate::from_ymd_opt(2026, 10, 24)).unwrap()
    }

    #[test]
    fn repos_follow_the_workspace_or_all() {
        let db = seeded();
        let conn = db.0.lock().unwrap();
        assert_eq!(repos(&conn, Some("w1")).unwrap().iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), vec!["api-pagos"]);
        assert_eq!(repos(&conn, None).unwrap().len(), 2);
    }

    #[test]
    fn reviews_and_meetings_of_the_period() {
        let db = seeded();
        let conn = db.0.lock().unwrap();
        let p = friday();
        let found = reviews(&conn, "p1", &p).unwrap();
        assert_eq!(found.len(), 1, "the one of the 20th is outside");
        assert_eq!((found[0].pr_id, found[0].pr_title.as_str(), found[0].findings), (42, "Pagos en cuotas", 2));
        let met = meetings(&conn, Some("w1"), &p).unwrap();
        assert_eq!(met.len(), 1, "one still recording is not a meeting yet");
        assert_eq!(met[0].minutes, 30);
        assert_eq!(met[0].summary, "Se decidió lanzar el viernes · Ana revisa el login");
        assert!(meetings(&conn, Some("w2"), &p).unwrap().is_empty());
    }

    #[test]
    fn tickets_started_or_moved_in_the_period_are_read() {
        let db = seeded();
        let conn = db.0.lock().unwrap();
        let p = friday();
        conn.execute_batch(
            "INSERT INTO ticket_links (id, workspace_id, project_id, provider, account, ticket_uid, ticket, branch, stage, created_at, updated_at) VALUES
               ('t1', 'w1', 'p1', 'jira', 'site', 'u1', '{\"key\":\"PAY-12\",\"id\":12,\"title\":\"Cuotas\",\"state\":\"En curso\",\"url\":\"https://example.com/PAY-12\"}', 'feature/pay', 'started', '2026-10-23T12:00:00+00:00', '2026-10-23T12:00:00+00:00'),
               ('t2', 'w1', 'p1', 'jira', 'site', 'u2', '{\"key\":\"PAY-1\",\"id\":1,\"title\":\"Viejo\",\"state\":\"Hecho\",\"url\":\"\"}', 'feature/old', 'done', '2026-09-01T12:00:00+00:00', '2026-09-02T12:00:00+00:00'),
               ('t3', 'w1', 'p1', 'azure', 'org', 'u3', '{\"id\":7,\"title\":\"Movido\",\"state\":\"\",\"url\":\"\"}', 'feature/x', 'review', '2026-09-01T12:00:00+00:00', '2026-10-23T09:00:00+00:00');",
        )
        .unwrap();
        let found = tickets_moved(&conn, Some("w1"), &p);
        assert_eq!(found.len(), 2, "{found:?}");
        assert_eq!((found[0].key.as_str(), found[0].state.as_str()), ("#7", "review"), "moved in the period, by its stage");
        assert_eq!((found[1].key.as_str(), found[1].branch.as_str(), found[1].state.as_str()), ("PAY-12", "feature/pay", "En curso"));
        assert!(tickets_moved(&conn, Some("w2"), &p).is_empty());
    }

    #[test]
    fn another_ticket_table_is_read_by_its_columns() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE tickets (key TEXT, title TEXT, workspace_id TEXT, updated_at TEXT);
             INSERT INTO tickets VALUES ('ABC-1', 'Uno', 'w1', '2026-10-23T12:00:00+00:00'), ('ABC-2', 'Dos', 'w1', '2026-08-01T12:00:00+00:00');",
        )
        .unwrap();
        let found = tickets_moved(&conn, None, &friday());
        assert_eq!(found.iter().map(|t| t.key.as_str()).collect::<Vec<_>>(), vec!["ABC-1"]);
        assert!(tickets_moved(&Connection::open_in_memory().unwrap(), None, &friday()).is_empty(), "no table, no tickets");
    }

    #[test]
    fn a_summary_is_prose_only_and_capped() {
        assert_eq!(summary_of("# T\n\n## Acuerdos\n- uno\n- dos\n<!-- x -->", 100), "uno · dos");
        assert!(summary_of(&"palabra ".repeat(100), 20).ends_with('…'));
    }
}
