//! What this machine remembers about its sessions, in SQLite: which sessions it is in, the worktree
//! of each repository, and the last state it agreed with the session for every path it synced.
//!
//! The person key and the owner secret are credentials and live in the OS credential store
//! ([`person_key`], [`owner_secret`]), never in these tables.

use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::manifest::FileState;

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS collab_sessions (
            id            TEXT PRIMARY KEY,
            project_url   TEXT NOT NULL,
            name          TEXT NOT NULL,
            role          TEXT NOT NULL,
            nick          TEXT NOT NULL,
            person_id     TEXT NOT NULL,
            workspace_id  TEXT NOT NULL,
            chat_id       TEXT NOT NULL,
            status        TEXT NOT NULL DEFAULT 'active',
            last_seq      INTEGER NOT NULL DEFAULT 0,
            context_seq   INTEGER NOT NULL DEFAULT 0,
            created_at    TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_collab_sessions_chat ON collab_sessions(chat_id);
        CREATE TABLE IF NOT EXISTS collab_repos (
            session_id     TEXT NOT NULL REFERENCES collab_sessions(id) ON DELETE CASCADE,
            repo_key       TEXT NOT NULL,
            name           TEXT NOT NULL,
            project_id     TEXT NOT NULL,
            checkout_path  TEXT NOT NULL,
            worktree_path  TEXT NOT NULL,
            branch         TEXT NOT NULL,
            base_sha       TEXT NOT NULL,
            epoch          INTEGER NOT NULL DEFAULT 0,
            session_project_id TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (session_id, repo_key)
        );
        CREATE TABLE IF NOT EXISTS collab_agreed (
            session_id  TEXT NOT NULL REFERENCES collab_sessions(id) ON DELETE CASCADE,
            repo_key    TEXT NOT NULL,
            path        TEXT NOT NULL,
            state       TEXT NOT NULL,
            version     INTEGER NOT NULL,
            PRIMARY KEY (session_id, repo_key, path)
        );
        CREATE TABLE IF NOT EXISTS collab_conflicts (
            session_id   TEXT NOT NULL REFERENCES collab_sessions(id) ON DELETE CASCADE,
            repo_key     TEXT NOT NULL,
            path         TEXT NOT NULL,
            local_state  TEXT NOT NULL,
            remote_state TEXT NOT NULL,
            remote_by    TEXT NOT NULL DEFAULT '',
            detected_at  TEXT NOT NULL,
            PRIMARY KEY (session_id, repo_key, path)
        );",
    )
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub project_url: String,
    pub name: String,
    /// `owner` or `editor`.
    pub role: String,
    pub nick: String,
    pub person_id: String,
    pub workspace_id: String,
    /// The local workspace-chat conversation this session is shown in.
    pub chat_id: String,
    /// `active`, `left` or `ended`.
    pub status: String,
    /// The newest shared-thread message this machine has taken in.
    pub last_seq: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub session_id: String,
    pub repo_key: String,
    pub name: String,
    pub project_id: String,
    pub checkout_path: String,
    pub worktree_path: String,
    pub branch: String,
    pub base_sha: String,
    pub epoch: i64,
    /// The workspace project that shows the worktree in the sidebar, the Editor and Git while the
    /// session lasts («api · sesión»). Removed on leaving.
    pub session_project_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub repo_key: String,
    pub path: String,
    pub local: FileState,
    pub remote: FileState,
    /// The nick of whoever last wrote the session's side.
    pub remote_by: String,
    pub detected_at: String,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn session_row(row: &rusqlite::Row) -> rusqlite::Result<Session> {
    Ok(Session {
        id: row.get(0)?,
        project_url: row.get(1)?,
        name: row.get(2)?,
        role: row.get(3)?,
        nick: row.get(4)?,
        person_id: row.get(5)?,
        workspace_id: row.get(6)?,
        chat_id: row.get(7)?,
        status: row.get(8)?,
        last_seq: row.get(9)?,
        created_at: row.get(10)?,
    })
}

const SESSION_COLS: &str = "id, project_url, name, role, nick, person_id, workspace_id, chat_id, status, last_seq, created_at";

pub fn insert_session(conn: &Connection, s: &Session) -> rusqlite::Result<()> {
    conn.execute(
        &format!("INSERT OR REPLACE INTO collab_sessions ({SESSION_COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)"),
        params![s.id, s.project_url, s.name, s.role, s.nick, s.person_id, s.workspace_id, s.chat_id, s.status, s.last_seq, if s.created_at.is_empty() { now() } else { s.created_at.clone() }],
    )?;
    Ok(())
}

pub fn session(conn: &Connection, id: &str) -> rusqlite::Result<Option<Session>> {
    conn.query_row(&format!("SELECT {SESSION_COLS} FROM collab_sessions WHERE id = ?1"), [id], session_row).optional()
}

/// The active session shown in a local chat, if any.
pub fn session_for_chat(conn: &Connection, chat_id: &str) -> rusqlite::Result<Option<Session>> {
    conn.query_row(
        &format!("SELECT {SESSION_COLS} FROM collab_sessions WHERE chat_id = ?1 AND status = 'active' ORDER BY created_at DESC LIMIT 1"),
        [chat_id],
        session_row,
    )
    .optional()
}

pub fn active_sessions(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<Session>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {SESSION_COLS} FROM collab_sessions WHERE workspace_id = ?1 AND status = 'active' ORDER BY created_at"
    ))?;
    let rows = stmt.query_map([workspace_id], session_row)?;
    rows.collect()
}

pub fn set_status(conn: &Connection, id: &str, status: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE collab_sessions SET status = ?2 WHERE id = ?1", params![id, status])?;
    Ok(())
}

pub fn set_last_seq(conn: &Connection, id: &str, seq: i64) -> rusqlite::Result<()> {
    conn.execute("UPDATE collab_sessions SET last_seq = MAX(last_seq, ?2) WHERE id = ?1", params![id, seq])?;
    Ok(())
}

/// The newest shared message this machine's engine has already been told about. Before each turn,
/// what the others did after it goes into the prompt as the session's context.
pub fn context_seq(conn: &Connection, id: &str) -> rusqlite::Result<i64> {
    conn.query_row("SELECT context_seq FROM collab_sessions WHERE id = ?1", [id], |r| r.get(0)).optional().map(|v| v.unwrap_or(0))
}

pub fn set_context_seq(conn: &Connection, id: &str, seq: i64) -> rusqlite::Result<()> {
    conn.execute("UPDATE collab_sessions SET context_seq = MAX(context_seq, ?2) WHERE id = ?1", params![id, seq])?;
    Ok(())
}

pub fn insert_repo(conn: &Connection, r: &Repo) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO collab_repos (session_id, repo_key, name, project_id, checkout_path, worktree_path, branch, base_sha, epoch, session_project_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![r.session_id, r.repo_key, r.name, r.project_id, r.checkout_path, r.worktree_path, r.branch, r.base_sha, r.epoch, r.session_project_id],
    )?;
    Ok(())
}

pub fn repos(conn: &Connection, session_id: &str) -> rusqlite::Result<Vec<Repo>> {
    let mut stmt = conn.prepare(
        "SELECT session_id, repo_key, name, project_id, checkout_path, worktree_path, branch, base_sha, epoch, session_project_id
         FROM collab_repos WHERE session_id = ?1 ORDER BY name",
    )?;
    let rows = stmt.query_map([session_id], |row| {
        Ok(Repo {
            session_id: row.get(0)?,
            repo_key: row.get(1)?,
            name: row.get(2)?,
            project_id: row.get(3)?,
            checkout_path: row.get(4)?,
            worktree_path: row.get(5)?,
            branch: row.get(6)?,
            base_sha: row.get(7)?,
            epoch: row.get(8)?,
            session_project_id: row.get(9)?,
        })
    })?;
    rows.collect()
}

pub fn set_base(conn: &Connection, session_id: &str, repo_key: &str, base: &str, epoch: i64) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE collab_repos SET base_sha = ?3, epoch = ?4 WHERE session_id = ?1 AND repo_key = ?2",
        params![session_id, repo_key, base, epoch],
    )?;
    Ok(())
}

/// Every session in which `path` (a worktree folder) is a repository: what the editor and the chat
/// ask to know whether a file they touch belongs to a shared copy.
pub fn repo_by_worktree(conn: &Connection, worktree_path: &str) -> rusqlite::Result<Option<Repo>> {
    let mut stmt = conn.prepare(
        "SELECT r.session_id, r.repo_key, r.name, r.project_id, r.checkout_path, r.worktree_path, r.branch, r.base_sha, r.epoch, r.session_project_id
         FROM collab_repos r JOIN collab_sessions s ON s.id = r.session_id
         WHERE r.worktree_path = ?1 AND s.status = 'active'",
    )?;
    stmt.query_row([worktree_path], |row| {
        Ok(Repo {
            session_id: row.get(0)?,
            repo_key: row.get(1)?,
            name: row.get(2)?,
            project_id: row.get(3)?,
            checkout_path: row.get(4)?,
            worktree_path: row.get(5)?,
            branch: row.get(6)?,
            base_sha: row.get(7)?,
            epoch: row.get(8)?,
            session_project_id: row.get(9)?,
        })
    })
    .optional()
}

/// The last agreed `(state, version)` of every synced path of one repository.
pub fn agreed(conn: &Connection, session_id: &str, repo_key: &str) -> rusqlite::Result<BTreeMap<String, (FileState, i64)>> {
    let mut stmt = conn.prepare("SELECT path, state, version FROM collab_agreed WHERE session_id = ?1 AND repo_key = ?2")?;
    let rows = stmt.query_map(params![session_id, repo_key], |row| {
        let path: String = row.get(0)?;
        let state: String = row.get(1)?;
        let version: i64 = row.get(2)?;
        Ok((path, state, version))
    })?;
    let mut out = BTreeMap::new();
    for row in rows {
        let (path, state, version) = row?;
        if let Ok(state) = serde_json::from_str::<FileState>(&state) {
            out.insert(path, (state, version));
        }
    }
    Ok(out)
}

pub fn set_agreed(conn: &Connection, session_id: &str, repo_key: &str, path: &str, state: &FileState, version: i64) -> rusqlite::Result<()> {
    let json = serde_json::to_string(state).unwrap_or_else(|_| "{\"state\":\"base\"}".into());
    conn.execute(
        "INSERT OR REPLACE INTO collab_agreed (session_id, repo_key, path, state, version) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![session_id, repo_key, path, json, version],
    )?;
    Ok(())
}

/// Forgets the agreed state of paths the session no longer records (the base moved past them).
pub fn drop_agreed_except(conn: &Connection, session_id: &str, repo_key: &str, keep: &[String]) -> rusqlite::Result<usize> {
    let existing: Vec<String> = agreed(conn, session_id, repo_key)?.into_keys().collect();
    let mut dropped = 0;
    for path in existing.iter().filter(|p| !keep.contains(p)) {
        dropped += conn.execute(
            "DELETE FROM collab_agreed WHERE session_id = ?1 AND repo_key = ?2 AND path = ?3",
            params![session_id, repo_key, path],
        )?;
    }
    Ok(dropped)
}

pub fn set_conflict(conn: &Connection, session_id: &str, c: &Conflict) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO collab_conflicts (session_id, repo_key, path, local_state, remote_state, remote_by, detected_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(session_id, repo_key, path) DO UPDATE SET local_state = excluded.local_state,
            remote_state = excluded.remote_state, remote_by = excluded.remote_by",
        params![
            session_id,
            c.repo_key,
            c.path,
            serde_json::to_string(&c.local).unwrap_or_default(),
            serde_json::to_string(&c.remote).unwrap_or_default(),
            c.remote_by,
            if c.detected_at.is_empty() { now() } else { c.detected_at.clone() },
        ],
    )?;
    Ok(())
}

pub fn clear_conflict(conn: &Connection, session_id: &str, repo_key: &str, path: &str) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM collab_conflicts WHERE session_id = ?1 AND repo_key = ?2 AND path = ?3",
        params![session_id, repo_key, path],
    )?;
    Ok(())
}

pub fn conflicts(conn: &Connection, session_id: &str) -> rusqlite::Result<Vec<Conflict>> {
    let mut stmt = conn.prepare(
        "SELECT repo_key, path, local_state, remote_state, remote_by, detected_at FROM collab_conflicts WHERE session_id = ?1 ORDER BY path",
    )?;
    let rows = stmt.query_map([session_id], |row| {
        let local: String = row.get(2)?;
        let remote: String = row.get(3)?;
        Ok(Conflict {
            repo_key: row.get(0)?,
            path: row.get(1)?,
            local: serde_json::from_str(&local).unwrap_or(FileState::Base),
            remote: serde_json::from_str(&remote).unwrap_or(FileState::Base),
            remote_by: row.get(4)?,
            detected_at: row.get(5)?,
        })
    })?;
    rows.collect()
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

fn person_key_name(session_id: &str) -> String {
    format!("collab-person:{session_id}")
}

fn owner_secret_name(session_id: &str) -> String {
    format!("collab-owner:{session_id}")
}

pub fn set_person_key(session_id: &str, key: &str) -> Result<(), String> {
    crate::secrets::set_secret(&person_key_name(session_id), key)
}

pub fn person_key(session_id: &str) -> Result<String, String> {
    crate::secrets::get_secret(&person_key_name(session_id))?.ok_or_else(|| "esta máquina no tiene la clave de la sesión".to_string())
}

pub fn set_owner_secret(session_id: &str, secret: &str) -> Result<(), String> {
    crate::secrets::set_secret(&owner_secret_name(session_id), secret)
}

pub fn owner_secret(session_id: &str) -> Result<String, String> {
    crate::secrets::get_secret(&owner_secret_name(session_id))?.ok_or_else(|| "solo el anfitrión puede hacer esto".to_string())
}

pub fn forget_credentials(session_id: &str) {
    let _ = crate::secrets::delete_secret(&person_key_name(session_id));
    let _ = crate::secrets::delete_secret(&owner_secret_name(session_id));
}

/// 32 random bytes as hex, from two v4 uuids (the OS random source, the same way `supabase` mints).
pub fn mint_secret() -> String {
    format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        migrate(&conn).unwrap();
        conn
    }

    fn session(id: &str, chat: &str) -> Session {
        Session {
            id: id.into(),
            project_url: "https://x.supabase.co".into(),
            name: "Reintentos SAP".into(),
            role: "owner".into(),
            nick: "Dev A".into(),
            person_id: "p1".into(),
            workspace_id: "ws".into(),
            chat_id: chat.into(),
            status: "active".into(),
            last_seq: 0,
            created_at: String::new(),
        }
    }

    #[test]
    fn sessions_repos_and_agreed_state_round_trip() {
        let c = conn();
        insert_session(&c, &session("s1", "chat-1")).unwrap();
        assert_eq!(session_for_chat(&c, "chat-1").unwrap().unwrap().id, "s1");
        insert_repo(&c, &Repo {
            session_id: "s1".into(),
            repo_key: "github.com/acme/api".into(),
            name: "api".into(),
            project_id: "p".into(),
            checkout_path: "/c/api".into(),
            worktree_path: "/w/api".into(),
            branch: "codeflow/sesion-s1".into(),
            base_sha: "a".repeat(40),
            epoch: 0,
            session_project_id: String::new(),
        })
        .unwrap();
        assert_eq!(repo_by_worktree(&c, "/w/api").unwrap().unwrap().repo_key, "github.com/acme/api");

        let present = FileState::Present { sha: "f".repeat(64), size: 3, binary: false };
        set_agreed(&c, "s1", "github.com/acme/api", "a.txt", &present, 2).unwrap();
        set_agreed(&c, "s1", "github.com/acme/api", "b.txt", &FileState::Deleted, 1).unwrap();
        let map = agreed(&c, "s1", "github.com/acme/api").unwrap();
        assert_eq!(map.get("a.txt"), Some(&(present.clone(), 2)));
        assert_eq!(drop_agreed_except(&c, "s1", "github.com/acme/api", &["a.txt".into()]).unwrap(), 1);
        assert_eq!(agreed(&c, "s1", "github.com/acme/api").unwrap().len(), 1);

        set_last_seq(&c, "s1", 9).unwrap();
        set_last_seq(&c, "s1", 4).unwrap();
        assert_eq!(super::session(&c, "s1").unwrap().unwrap().last_seq, 9, "the watermark never goes back");

        set_status(&c, "s1", "left").unwrap();
        assert!(session_for_chat(&c, "chat-1").unwrap().is_none());
        assert!(repo_by_worktree(&c, "/w/api").unwrap().is_none());
    }

    #[test]
    fn conflicts_are_kept_once_per_path() {
        let c = conn();
        insert_session(&c, &session("s1", "chat-1")).unwrap();
        let conflict = Conflict {
            repo_key: "r".into(),
            path: "a.txt".into(),
            local: FileState::Deleted,
            remote: FileState::Present { sha: "1".repeat(64), size: 1, binary: false },
            remote_by: "Dev B".into(),
            detected_at: String::new(),
        };
        set_conflict(&c, "s1", &conflict).unwrap();
        set_conflict(&c, "s1", &Conflict { local: FileState::Base, ..conflict.clone() }).unwrap();
        let all = conflicts(&c, "s1").unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].local, FileState::Base);
        clear_conflict(&c, "s1", "r", "a.txt").unwrap();
        assert!(conflicts(&c, "s1").unwrap().is_empty());
    }
}
