//! Subchats: which assistant conversation was started from which.
//!
//! A panel conversation (repository chat, `activity_log` rows grouped by `session_id`) or a
//! workspace chat (`chat_conversations` with `workspace_scope`) can be started *under* another one:
//! «Nuevo subchat» (a blank conversation on the same repository or workspace, kind `new`) or
//! «Bifurcar» (the turns up to a point copied over, kind `branch`). The UI nests the child under its
//! parent in the Inbox, the tab strip and the chat itself.
//!
//! One table for both surfaces, so neither `activity_log` nor `chat_conversations` changes shape:
//! a repository conversation has no row of its own to hang a column on, and the two kinds are
//! listed together anyway. `scope_id` is the project (panel) or the workspace (ws) the child runs
//! on — what the list is filtered by.
//!
//! A blank subchat is linked when it is *opened*, before its first question exists anywhere: the tab
//! has to show where it hangs from the first frame. One that is never written in leaves a row naming
//! a conversation that does not exist, which [`sweep`] collects on the next launch once it is old
//! enough not to be a tab someone has open right now.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::Db;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChatLink {
    pub conversation_id: String,
    /// `panel` (repository chat) or `ws` (workspace chat).
    pub surface: String,
    pub parent_id: String,
    /// `new` or `branch`.
    pub kind: String,
    pub scope_id: String,
    pub branched_turn: Option<i64>,
    pub created_at: String,
}

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS chat_lineage (
            conversation_id TEXT PRIMARY KEY,
            surface         TEXT NOT NULL,
            parent_id       TEXT NOT NULL,
            kind            TEXT NOT NULL,
            scope_id        TEXT NOT NULL,
            branched_turn   INTEGER,
            created_at      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_chat_lineage_parent ON chat_lineage(parent_id);
        CREATE INDEX IF NOT EXISTS idx_chat_lineage_scope ON chat_lineage(scope_id);",
    )?;
    sweep(conn, chrono::Utc::now() - chrono::Duration::days(2))?;
    Ok(())
}

/// Drops links to conversations that were never written in, once they are older than `before`.
fn sweep(conn: &Connection, before: chrono::DateTime<chrono::Utc>) -> rusqlite::Result<usize> {
    conn.execute(
        "DELETE FROM chat_lineage
         WHERE created_at < ?1
           AND NOT EXISTS (SELECT 1 FROM activity_log a WHERE a.session_id = chat_lineage.conversation_id)
           AND NOT EXISTS (SELECT 1 FROM chat_conversations c WHERE c.id = chat_lineage.conversation_id)",
        params![before.to_rfc3339()],
    )
}

fn valid_surface(surface: &str) -> bool {
    matches!(surface, "panel" | "ws")
}

/// Records `conversation_id` as a child of `parent_id`. A conversation has one parent: linking it
/// again replaces the old link. A link that would make a cycle (the parent is already below the
/// child) is refused.
pub fn link(
    conn: &Connection,
    conversation_id: &str,
    surface: &str,
    parent_id: &str,
    kind: &str,
    scope_id: &str,
    branched_turn: Option<i64>,
) -> rusqlite::Result<bool> {
    if conversation_id.is_empty() || parent_id.is_empty() || conversation_id == parent_id || !valid_surface(surface) {
        return Ok(false);
    }
    // Walk up from the parent: meeting the child on the way means the child is an ancestor.
    let mut cursor = parent_id.to_string();
    for _ in 0..64 {
        if cursor == conversation_id {
            return Ok(false);
        }
        match parent_of(conn, &cursor)? {
            Some(up) => cursor = up,
            None => break,
        }
    }
    let kind = if kind == "branch" { "branch" } else { "new" };
    conn.execute(
        "INSERT INTO chat_lineage (conversation_id, surface, parent_id, kind, scope_id, branched_turn, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(conversation_id) DO UPDATE SET surface = ?2, parent_id = ?3, kind = ?4, scope_id = ?5, branched_turn = ?6",
        params![conversation_id, surface, parent_id, kind, scope_id, branched_turn, chrono::Utc::now().to_rfc3339()],
    )?;
    Ok(true)
}

pub fn parent_of(conn: &Connection, conversation_id: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT parent_id FROM chat_lineage WHERE conversation_id = ?1",
        params![conversation_id],
        |row| row.get(0),
    )
    .optional()
}

/// A conversation is going away: its children move up to its own parent (or become roots), and
/// its own link goes.
pub fn forget(conn: &Connection, conversation_id: &str) -> rusqlite::Result<()> {
    match parent_of(conn, conversation_id)? {
        Some(grand) => {
            conn.execute(
                "UPDATE chat_lineage SET parent_id = ?2 WHERE parent_id = ?1",
                params![conversation_id, grand],
            )?;
        }
        None => {
            conn.execute("DELETE FROM chat_lineage WHERE parent_id = ?1", params![conversation_id])?;
        }
    }
    conn.execute("DELETE FROM chat_lineage WHERE conversation_id = ?1", params![conversation_id])?;
    Ok(())
}

/// Every link of a workspace: its workspace chats and the chats of its repositories.
pub fn list_for_workspace(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<ChatLink>> {
    let mut stmt = conn.prepare(
        "SELECT conversation_id, surface, parent_id, kind, scope_id, branched_turn, created_at
         FROM chat_lineage
         WHERE scope_id = ?1 OR scope_id IN (SELECT id FROM projects WHERE workspace_id = ?1)
         ORDER BY created_at",
    )?;
    let rows = stmt.query_map(params![workspace_id], |row| {
        Ok(ChatLink {
            conversation_id: row.get(0)?,
            surface: row.get(1)?,
            parent_id: row.get(2)?,
            kind: row.get(3)?,
            scope_id: row.get(4)?,
            branched_turn: row.get(5)?,
            created_at: row.get(6)?,
        })
    })?;
    rows.collect()
}

#[tauri::command]
pub fn chat_lineage_list(db: State<'_, Db>, workspace_id: String) -> Result<Vec<ChatLink>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    list_for_workspace(&conn, &workspace_id).map_err(|e| e.to_string())
}

/// Links a conversation under another — «Nuevo subchat» calls this as it opens the blank tab.
/// `false` when the link was refused (a cycle, an unknown surface, a conversation under itself).
#[tauri::command]
pub fn chat_lineage_link(
    db: State<'_, Db>,
    conversation_id: String,
    surface: String,
    parent_id: String,
    kind: String,
    scope_id: String,
    branched_turn: Option<i64>,
) -> Result<bool, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    link(&conn, &conversation_id, &surface, &parent_id, &kind, &scope_id, branched_turn).map_err(|e| e.to_string())
}

/// A subchat closed before anything was written in it: its link goes. Its own children (there can
/// be none yet, but the rule is the same) move up.
#[tauri::command]
pub fn chat_lineage_forget(db: State<'_, Db>, conversation_id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    forget(&conn, &conversation_id).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE projects (id TEXT PRIMARY KEY, workspace_id TEXT);
             CREATE TABLE activity_log (id TEXT, session_id TEXT);
             CREATE TABLE chat_conversations (id TEXT PRIMARY KEY);
             INSERT INTO projects VALUES ('p1', 'w1'), ('p2', 'w2');",
        )
        .unwrap();
        migrate(&conn).unwrap();
        conn
    }

    #[test]
    fn links_list_by_workspace_through_projects() {
        let c = conn();
        assert!(link(&c, "b", "panel", "a", "new", "p1", None).unwrap());
        assert!(link(&c, "y", "ws", "x", "branch", "w1", Some(3)).unwrap());
        assert!(link(&c, "z", "panel", "q", "new", "p2", None).unwrap());
        let got: Vec<String> = list_for_workspace(&c, "w1").unwrap().into_iter().map(|l| l.conversation_id).collect();
        assert_eq!(got, vec!["b", "y"]);
        let y = list_for_workspace(&c, "w1").unwrap().into_iter().find(|l| l.conversation_id == "y").unwrap();
        assert_eq!((y.kind.as_str(), y.branched_turn), ("branch", Some(3)));
    }

    #[test]
    fn refuses_cycles_self_links_and_unknown_surfaces() {
        let c = conn();
        assert!(link(&c, "b", "panel", "a", "new", "p1", None).unwrap());
        assert!(link(&c, "c", "panel", "b", "new", "p1", None).unwrap());
        assert!(!link(&c, "a", "panel", "c", "new", "p1", None).unwrap(), "a is above c");
        assert!(!link(&c, "a", "panel", "a", "new", "p1", None).unwrap());
        assert!(!link(&c, "d", "other", "a", "new", "p1", None).unwrap());
        // Relinking replaces.
        assert!(link(&c, "c", "panel", "a", "branch", "p1", None).unwrap());
        assert_eq!(parent_of(&c, "c").unwrap().as_deref(), Some("a"));
    }

    #[test]
    fn forgetting_moves_children_up() {
        let c = conn();
        link(&c, "b", "panel", "a", "new", "p1", None).unwrap();
        link(&c, "c", "panel", "b", "new", "p1", None).unwrap();
        link(&c, "d", "panel", "b", "branch", "p1", None).unwrap();
        forget(&c, "b").unwrap();
        assert_eq!(parent_of(&c, "c").unwrap().as_deref(), Some("a"));
        assert_eq!(parent_of(&c, "d").unwrap().as_deref(), Some("a"));
        assert_eq!(parent_of(&c, "b").unwrap(), None);
        // A root going away leaves its children as roots.
        forget(&c, "a").unwrap();
        assert!(list_for_workspace(&c, "w1").unwrap().is_empty());
    }

    #[test]
    fn sweep_drops_only_old_links_to_conversations_that_never_existed() {
        let c = conn();
        link(&c, "ghost", "panel", "a", "new", "p1", None).unwrap();
        link(&c, "real", "panel", "a", "new", "p1", None).unwrap();
        link(&c, "wsreal", "ws", "a", "new", "w1", None).unwrap();
        c.execute("INSERT INTO activity_log VALUES ('r1', 'real')", []).unwrap();
        c.execute("INSERT INTO chat_conversations VALUES ('wsreal')", []).unwrap();
        // Nothing is old enough yet.
        assert_eq!(sweep(&c, chrono::Utc::now() - chrono::Duration::days(2)).unwrap(), 0);
        assert_eq!(sweep(&c, chrono::Utc::now() + chrono::Duration::seconds(5)).unwrap(), 1);
        let left: Vec<String> = list_for_workspace(&c, "w1").unwrap().into_iter().map(|l| l.conversation_id).collect();
        assert_eq!(left, vec!["real", "wsreal"]);
    }
}
