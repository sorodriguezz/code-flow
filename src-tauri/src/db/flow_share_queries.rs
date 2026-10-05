//! `flow_shares` — which flows this machine shares through a Supabase project, and how far each
//! one's sync has come. See `migrations::add_flow_shares` for the columns and `flows::share` for
//! the merge they serve. Secrets are not here: the share token and the host's own secret live in
//! the credential store under the flow's id, as a shared collection's do under its own.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowShareRow {
    pub flow_id: String,
    pub project_url: String,
    pub name: String,
    /// `owner` (this machine shared it) or `member` (it joined).
    pub role: String,
    pub cursor: String,
    pub base: String,
    /// The remote version waiting while both sides changed, as JSON.
    pub conflict: Option<String>,
    pub conflict_at: Option<String>,
    pub last_error: String,
    /// This machine's clock at the last round that went through.
    pub synced_at: String,
}

const COLUMNS: &str = "flow_id, project_url, name, role, cursor, base, conflict, conflict_at, last_error, synced_at";

fn map(row: &rusqlite::Row) -> rusqlite::Result<FlowShareRow> {
    Ok(FlowShareRow {
        flow_id: row.get(0)?,
        project_url: row.get(1)?,
        name: row.get(2)?,
        role: row.get(3)?,
        cursor: row.get(4)?,
        base: row.get(5)?,
        conflict: row.get(6)?,
        conflict_at: row.get(7)?,
        last_error: row.get(8)?,
        synced_at: row.get(9)?,
    })
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<FlowShareRow>> {
    let mut statement = conn.prepare(&format!("SELECT {COLUMNS} FROM flow_shares ORDER BY name"))?;
    let rows = statement.query_map([], map)?.collect();
    rows
}

pub fn get(conn: &Connection, flow_id: &str) -> rusqlite::Result<Option<FlowShareRow>> {
    conn.query_row(&format!("SELECT {COLUMNS} FROM flow_shares WHERE flow_id = ?1"), params![flow_id], map).optional()
}

/// Files a share — a new one starts with nothing agreed, so its first round pushes (host) or applies
/// (member) the whole flow.
pub fn insert(conn: &Connection, flow_id: &str, project_url: &str, name: &str, role: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO flow_shares (flow_id, project_url, name, role) VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT(flow_id) DO UPDATE SET project_url = excluded.project_url, name = excluded.name, role = excluded.role, \
                                            cursor = '', base = '', conflict = NULL, conflict_at = NULL, last_error = ''",
        params![flow_id, project_url, name, role],
    )?;
    Ok(())
}

pub fn forget(conn: &Connection, flow_id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM flow_shares WHERE flow_id = ?1", params![flow_id])?;
    Ok(())
}

/// A round that went through: where the cursor and the base are now.
pub fn record_round(conn: &Connection, flow_id: &str, cursor: &str, base: &str, at: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE flow_shares SET cursor = ?2, base = ?3, last_error = '', synced_at = ?4 WHERE flow_id = ?1",
        params![flow_id, cursor, base, at],
    )?;
    Ok(())
}

pub fn record_error(conn: &Connection, flow_id: &str, error: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE flow_shares SET last_error = ?2 WHERE flow_id = ?1", params![flow_id, error])?;
    Ok(())
}

/// Freezes the remote version: both sides changed it, so neither is applied nor sent.
pub fn freeze(conn: &Connection, flow_id: &str, cursor: &str, payload: &str, updated_at: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE flow_shares SET cursor = ?2, conflict = ?3, conflict_at = ?4, last_error = '' WHERE flow_id = ?1",
        params![flow_id, cursor, payload, updated_at],
    )?;
    Ok(())
}

/// The user picked a side. `base` is what the comparison runs from afterwards.
pub fn thaw(conn: &Connection, flow_id: &str, base: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE flow_shares SET conflict = NULL, conflict_at = NULL, base = ?2 WHERE flow_id = ?1",
        params![flow_id, base],
    )?;
    Ok(())
}
