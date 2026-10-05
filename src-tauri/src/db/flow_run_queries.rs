//! Rows a flow produces and keeps beside its spec: executions, pinned output, remembered state,
//! the workspace's variables and its credentials. See `migrations::add_flow_run_tables` for why each
//! table is shaped the way it is, and `crate::flows::runs` for the files an execution writes.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;

// ------------------------------------------------------------------------------------------ runs

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowRunRow {
    pub id: String,
    pub flow_id: String,
    pub workspace_id: String,
    pub flow_name: String,
    pub flow_version: i64,
    /// `manual` (the whole flow), `partial` (up to a node), `step` (one node on stored input).
    pub mode: String,
    pub trigger_node: String,
    pub target_node: String,
    /// `running`, `waiting` (parked at a node until someone decides), `success`, `error`, `canceled`,
    /// `interrupted`.
    pub status: String,
    pub error: String,
    pub error_node: String,
    pub started_at: String,
    pub finished_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub data_bytes: i64,
    /// When this run's end becomes a notification (`never`, `failure`, `always`) — carried on the
    /// `flows:run` event for runs nobody started by hand; not a column.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notify: Option<String>,
}

const RUN_COLUMNS: &str = "id, flow_id, workspace_id, flow_name, flow_version, mode, trigger_node, target_node, \
     status, error, error_node, started_at, finished_at, duration_ms, data_bytes";

fn run_row(row: &Row<'_>) -> rusqlite::Result<FlowRunRow> {
    Ok(FlowRunRow {
        id: row.get(0)?,
        flow_id: row.get(1)?,
        workspace_id: row.get(2)?,
        flow_name: row.get(3)?,
        flow_version: row.get(4)?,
        mode: row.get(5)?,
        trigger_node: row.get(6)?,
        target_node: row.get(7)?,
        status: row.get(8)?,
        error: row.get(9)?,
        error_node: row.get(10)?,
        started_at: row.get(11)?,
        finished_at: row.get(12)?,
        duration_ms: row.get(13)?,
        data_bytes: row.get(14)?,
        notify: None,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowRunNodeRow {
    pub run_id: String,
    pub node_id: String,
    pub node_name: String,
    pub node_type: String,
    /// `running`, `success`, `error`, `skipped`, `canceled`, `pinned`, `reused`.
    pub status: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub items_in: i64,
    /// Items per output port.
    pub items_out: Vec<i64>,
    pub attempts: i64,
    pub error: String,
    /// The order nodes started in, for the waterfall.
    pub seq: i64,
}

fn run_node_row(row: &Row<'_>) -> rusqlite::Result<FlowRunNodeRow> {
    let items_out: String = row.get(9)?;
    Ok(FlowRunNodeRow {
        run_id: row.get(0)?,
        node_id: row.get(1)?,
        node_name: row.get(2)?,
        node_type: row.get(3)?,
        status: row.get(4)?,
        started_at: row.get(5)?,
        finished_at: row.get(6)?,
        duration_ms: row.get(7)?,
        items_in: row.get(8)?,
        items_out: serde_json::from_str(&items_out).unwrap_or_default(),
        attempts: row.get(10)?,
        error: row.get(11)?,
        seq: row.get(12)?,
    })
}

const RUN_NODE_COLUMNS: &str = "run_id, node_id, node_name, node_type, status, started_at, finished_at, duration_ms, \
     items_in, items_out, attempts, error, seq";

pub fn insert_run(conn: &Connection, run: &FlowRunRow) -> rusqlite::Result<()> {
    conn.execute(
        &format!("INSERT INTO flow_runs ({RUN_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)"),
        params![
            run.id,
            run.flow_id,
            run.workspace_id,
            run.flow_name,
            run.flow_version,
            run.mode,
            run.trigger_node,
            run.target_node,
            run.status,
            run.error,
            run.error_node,
            run.started_at,
            run.finished_at,
            run.duration_ms,
            run.data_bytes
        ],
    )?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub fn finish_run(
    conn: &Connection,
    id: &str,
    status: &str,
    error: &str,
    error_node: &str,
    finished_at: &str,
    duration_ms: i64,
    data_bytes: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE flow_runs SET status = ?2, error = ?3, error_node = ?4, finished_at = ?5, duration_ms = ?6, data_bytes = ?7
         WHERE id = ?1",
        params![id, status, error, error_node, finished_at, duration_ms, data_bytes],
    )?;
    Ok(())
}

pub fn upsert_run_node(conn: &Connection, node: &FlowRunNodeRow) -> rusqlite::Result<()> {
    conn.execute(
        &format!(
            "INSERT INTO flow_run_nodes ({RUN_NODE_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(run_id, node_id) DO UPDATE SET
               status = excluded.status, started_at = excluded.started_at, finished_at = excluded.finished_at,
               duration_ms = excluded.duration_ms, items_in = excluded.items_in, items_out = excluded.items_out,
               attempts = excluded.attempts, error = excluded.error, seq = excluded.seq"
        ),
        params![
            node.run_id,
            node.node_id,
            node.node_name,
            node.node_type,
            node.status,
            node.started_at,
            node.finished_at,
            node.duration_ms,
            node.items_in,
            serde_json::to_string(&node.items_out).unwrap_or_else(|_| "[]".into()),
            node.attempts,
            node.error,
            node.seq
        ],
    )?;
    Ok(())
}

/// A flow's executions, newest first; `before` pages by `started_at`.
pub fn list_runs(conn: &Connection, flow_id: &str, limit: i64, before: Option<&str>) -> rusqlite::Result<Vec<FlowRunRow>> {
    let mut statement = conn.prepare(&format!(
        "SELECT {RUN_COLUMNS} FROM flow_runs
         WHERE flow_id = ?1 AND (?2 IS NULL OR started_at < ?2)
         ORDER BY started_at DESC LIMIT ?3"
    ))?;
    let rows = statement.query_map(params![flow_id, before, limit], run_row)?;
    rows.collect()
}

pub fn get_run(conn: &Connection, id: &str) -> rusqlite::Result<Option<FlowRunRow>> {
    conn.query_row(&format!("SELECT {RUN_COLUMNS} FROM flow_runs WHERE id = ?1"), params![id], run_row)
        .optional()
}

pub fn run_nodes(conn: &Connection, run_id: &str) -> rusqlite::Result<Vec<FlowRunNodeRow>> {
    let mut statement =
        conn.prepare(&format!("SELECT {RUN_NODE_COLUMNS} FROM flow_run_nodes WHERE run_id = ?1 ORDER BY seq, node_name"))?;
    let rows = statement.query_map(params![run_id], run_node_row)?;
    rows.collect()
}

pub fn delete_run(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM flow_runs WHERE id = ?1", params![id])?;
    conn.execute("DELETE FROM flow_waits WHERE run_id = ?1", params![id])?;
    Ok(())
}

/// A run's status alone — `waiting` while it is parked at a node, `running` again once decided.
pub fn set_run_status(conn: &Connection, id: &str, status: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE flow_runs SET status = ?2 WHERE id = ?1", params![id, status])?;
    Ok(())
}

/// A run parked at a node — see `migrations::add_flow_waits`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowWaitRow {
    pub id: String,
    pub run_id: String,
    pub flow_id: String,
    pub workspace_id: String,
    pub flow_name: String,
    pub node_id: String,
    pub node_name: String,
    /// `approval`, `webhook` or `time`.
    pub kind: String,
    pub message: String,
    pub created_at: String,
    pub expires_at: Option<String>,
    pub decided_at: Option<String>,
    /// `approved`, `rejected`, `resumed`, `expired`, `canceled`; empty while open.
    pub decision: String,
    pub decided_by: String,
    pub payload: Value,
}

const WAIT_COLUMNS: &str = "id, run_id, flow_id, workspace_id, flow_name, node_id, node_name, kind, message, \
     created_at, expires_at, decided_at, decision, decided_by, payload";

fn wait_row(row: &Row<'_>) -> rusqlite::Result<FlowWaitRow> {
    let payload: String = row.get(14)?;
    Ok(FlowWaitRow {
        id: row.get(0)?,
        run_id: row.get(1)?,
        flow_id: row.get(2)?,
        workspace_id: row.get(3)?,
        flow_name: row.get(4)?,
        node_id: row.get(5)?,
        node_name: row.get(6)?,
        kind: row.get(7)?,
        message: row.get(8)?,
        created_at: row.get(9)?,
        expires_at: row.get(10)?,
        decided_at: row.get(11)?,
        decision: row.get(12)?,
        decided_by: row.get(13)?,
        payload: serde_json::from_str(&payload).unwrap_or(Value::Null),
    })
}

pub fn insert_wait(conn: &Connection, wait: &FlowWaitRow) -> rusqlite::Result<()> {
    conn.execute(
        &format!("INSERT INTO flow_waits ({WAIT_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)"),
        params![
            wait.id,
            wait.run_id,
            wait.flow_id,
            wait.workspace_id,
            wait.flow_name,
            wait.node_id,
            wait.node_name,
            wait.kind,
            wait.message,
            wait.created_at,
            wait.expires_at,
            wait.decided_at,
            wait.decision,
            wait.decided_by,
            wait.payload.to_string(),
        ],
    )?;
    Ok(())
}

pub fn get_wait(conn: &Connection, id: &str) -> rusqlite::Result<Option<FlowWaitRow>> {
    conn.query_row(&format!("SELECT {WAIT_COLUMNS} FROM flow_waits WHERE id = ?1"), params![id], wait_row).optional()
}

/// Waits nobody has decided yet, oldest first — of one workspace, or every one.
pub fn open_waits(conn: &Connection, workspace_id: Option<&str>) -> rusqlite::Result<Vec<FlowWaitRow>> {
    let mut statement = conn.prepare(&format!(
        "SELECT {WAIT_COLUMNS} FROM flow_waits WHERE decided_at IS NULL AND (?1 IS NULL OR workspace_id = ?1) ORDER BY created_at"
    ))?;
    let rows = statement.query_map(params![workspace_id], wait_row)?;
    rows.collect()
}

pub fn waits_of_run(conn: &Connection, run_id: &str) -> rusqlite::Result<Vec<FlowWaitRow>> {
    let mut statement = conn.prepare(&format!("SELECT {WAIT_COLUMNS} FROM flow_waits WHERE run_id = ?1 ORDER BY created_at"))?;
    let rows = statement.query_map(params![run_id], wait_row)?;
    rows.collect()
}

/// Settles an open wait. `false` when it was already settled — the other device got there first.
pub fn decide_wait(conn: &Connection, id: &str, decision: &str, by: &str, payload: &Value, at: &str) -> rusqlite::Result<bool> {
    let changed = conn.execute(
        "UPDATE flow_waits SET decided_at = ?2, decision = ?3, decided_by = ?4, payload = ?5 WHERE id = ?1 AND decided_at IS NULL",
        params![id, at, decision, by, payload.to_string()],
    )?;
    Ok(changed == 1)
}

/// Every run of a flow — what deleting the flow takes with it.
pub fn run_ids_of_flow(conn: &Connection, flow_id: &str) -> rusqlite::Result<Vec<String>> {
    let mut statement = conn.prepare("SELECT id FROM flow_runs WHERE flow_id = ?1")?;
    let rows = statement.query_map(params![flow_id], |row| row.get(0))?;
    rows.collect()
}

pub fn delete_runs_of_flow(conn: &Connection, flow_id: &str) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM flow_runs WHERE flow_id = ?1", params![flow_id])
}

/// Runs a previous session left `running`: the app ended under them. Marked `interrupted`, and
/// their nodes still `running` with them. Returns how many.
pub fn mark_interrupted(conn: &Connection, now: &str) -> rusqlite::Result<usize> {
    conn.execute(
        "UPDATE flow_run_nodes SET status = 'canceled', finished_at = ?1
         WHERE status = 'running' AND run_id IN (SELECT id FROM flow_runs WHERE status = 'running')",
        params![now],
    )?;
    conn.execute(
        "UPDATE flow_runs SET status = 'interrupted', finished_at = ?1,
            error = CASE WHEN error = '' THEN 'interrupted' ELSE error END
         WHERE status = 'running'",
        params![now],
    )
}

/// Runs whose flow no longer exists — deleted, or replaced by a restore.
pub fn orphan_runs(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut statement =
        conn.prepare("SELECT id FROM flow_runs WHERE flow_id NOT IN (SELECT id FROM flows) AND status != 'running'")?;
    let rows = statement.query_map([], |row| row.get(0))?;
    rows.collect()
}

/// What the retention policy lets go for one flow: everything past the newest `keep`, successes
/// older than `success_before`, failures older than `failure_before`. Never a run still going.
pub fn runs_past_retention(
    conn: &Connection,
    flow_id: &str,
    keep: i64,
    success_before: &str,
    failure_before: &str,
) -> rusqlite::Result<Vec<String>> {
    let mut statement = conn.prepare(
        "SELECT id FROM (
            SELECT id, status, started_at,
                   ROW_NUMBER() OVER (ORDER BY started_at DESC) AS position
            FROM flow_runs WHERE flow_id = ?1 AND status NOT IN ('running', 'waiting')
         )
         WHERE position > ?2
            OR (status IN ('success', 'canceled') AND started_at < ?3)
            OR (status IN ('error', 'interrupted') AND started_at < ?4)",
    )?;
    let rows = statement.query_map(params![flow_id, keep, success_before, failure_before], |row| row.get(0))?;
    rows.collect()
}

/// The flows that have runs at all — the set retention walks.
pub fn flows_with_runs(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut statement = conn.prepare("SELECT DISTINCT flow_id FROM flow_runs")?;
    let rows = statement.query_map([], |row| row.get(0))?;
    rows.collect()
}

/// Every finished run, oldest first, with the bytes its files take — what the size cap trims from.
pub fn runs_by_age(conn: &Connection) -> rusqlite::Result<Vec<(String, i64)>> {
    let mut statement =
        conn.prepare("SELECT id, data_bytes FROM flow_runs WHERE status NOT IN ('running', 'waiting') ORDER BY started_at ASC")?;
    let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    rows.collect()
}

/// The newest run of a flow in which every one of `nodes` produced output — where "test this step"
/// reads the step's input from.
pub fn latest_run_covering(conn: &Connection, flow_id: &str, nodes: &[String]) -> rusqlite::Result<Option<String>> {
    if nodes.is_empty() {
        return Ok(None);
    }
    let mut statement = conn.prepare(
        "SELECT r.id FROM flow_runs r
         WHERE r.flow_id = ?1 AND r.status != 'running'
         ORDER BY r.started_at DESC LIMIT 25",
    )?;
    let candidates: Vec<String> = statement.query_map(params![flow_id], |row| row.get(0))?.collect::<Result<_, _>>()?;
    for run in candidates {
        let mut covered = 0usize;
        for node in nodes {
            let ok: Option<String> = conn
                .query_row(
                    "SELECT status FROM flow_run_nodes WHERE run_id = ?1 AND node_id = ?2
                       AND status IN ('success', 'pinned', 'reused')",
                    params![run, node],
                    |row| row.get(0),
                )
                .optional()?;
            if ok.is_some() {
                covered += 1;
            }
        }
        if covered == nodes.len() {
            return Ok(Some(run));
        }
    }
    Ok(None)
}

// ------------------------------------------------------------------------------------------ pins

/// `(node_id, items JSON)` for every pinned node of a flow.
pub fn list_pins(conn: &Connection, flow_id: &str) -> rusqlite::Result<Vec<(String, String)>> {
    let mut statement = conn.prepare("SELECT node_id, items FROM flow_pins WHERE flow_id = ?1")?;
    let rows = statement.query_map(params![flow_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
    rows.collect()
}

pub fn set_pin(conn: &Connection, flow_id: &str, node_id: &str, items: &str, now: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO flow_pins (flow_id, node_id, items, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(flow_id, node_id) DO UPDATE SET items = excluded.items, updated_at = excluded.updated_at",
        params![flow_id, node_id, items, now],
    )?;
    Ok(())
}

pub fn delete_pin(conn: &Connection, flow_id: &str, node_id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM flow_pins WHERE flow_id = ?1 AND node_id = ?2", params![flow_id, node_id])?;
    Ok(())
}

// ----------------------------------------------------------------------------------------- state

pub fn state_get(conn: &Connection, flow_id: &str, key: &str) -> rusqlite::Result<Option<Value>> {
    let text: Option<String> = conn
        .query_row("SELECT value FROM flow_state WHERE flow_id = ?1 AND key = ?2", params![flow_id, key], |row| {
            row.get(0)
        })
        .optional()?;
    Ok(text.and_then(|text| serde_json::from_str(&text).ok()))
}

pub fn state_set(conn: &Connection, flow_id: &str, key: &str, value: &Value, now: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO flow_state (flow_id, key, value, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(flow_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![flow_id, key, value.to_string(), now],
    )?;
    Ok(())
}

pub fn state_delete(conn: &Connection, flow_id: &str, key: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM flow_state WHERE flow_id = ?1 AND key = ?2", params![flow_id, key])?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowStateEntry {
    pub key: String,
    pub value: Value,
    pub updated_at: String,
}

pub fn state_list(conn: &Connection, flow_id: &str) -> rusqlite::Result<Vec<FlowStateEntry>> {
    let mut statement = conn.prepare("SELECT key, value, updated_at FROM flow_state WHERE flow_id = ?1 ORDER BY key")?;
    let rows = statement.query_map(params![flow_id], |row| {
        let text: String = row.get(1)?;
        Ok(FlowStateEntry {
            key: row.get(0)?,
            value: serde_json::from_str(&text).unwrap_or(Value::Null),
            updated_at: row.get(2)?,
        })
    })?;
    rows.collect()
}

pub fn state_clear(conn: &Connection, flow_id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM flow_state WHERE flow_id = ?1", params![flow_id])?;
    Ok(())
}

// ------------------------------------------------------------------------------------- variables

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowVariable {
    pub id: String,
    pub workspace_id: String,
    pub scope: String,
    pub name: String,
    pub value: String,
    pub updated_at: String,
}

fn variable_row(row: &Row<'_>) -> rusqlite::Result<FlowVariable> {
    Ok(FlowVariable {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        scope: row.get(2)?,
        name: row.get(3)?,
        value: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

/// The variables a workspace sees: its own and every global one. A name defined both ways reads
/// the workspace's own — see [`variables_map`].
pub fn list_variables(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<FlowVariable>> {
    let mut statement = conn.prepare(
        "SELECT id, workspace_id, scope, name, value, updated_at FROM flow_variables
         WHERE workspace_id = ?1 OR scope = 'global' ORDER BY name, scope DESC",
    )?;
    let rows = statement.query_map(params![workspace_id], variable_row)?;
    rows.collect()
}

/// `$vars` for a workspace: globals first, then its own on top.
pub fn variables_map(conn: &Connection, workspace_id: &str) -> rusqlite::Result<serde_json::Map<String, Value>> {
    let mut out = serde_json::Map::new();
    let all = list_variables(conn, workspace_id)?;
    for variable in all.iter().filter(|v| v.scope == "global" && v.workspace_id != workspace_id) {
        out.insert(variable.name.clone(), Value::String(variable.value.clone()));
    }
    for variable in all.iter().filter(|v| v.workspace_id == workspace_id) {
        out.insert(variable.name.clone(), Value::String(variable.value.clone()));
    }
    Ok(out)
}

/// Sets a variable the workspace sees, by name: the workspace's own row if it has one, else a
/// global one it sees, else a new row of its own.
pub fn put_variable(conn: &Connection, workspace_id: &str, name: &str, value: &str, now: &str) -> rusqlite::Result<FlowVariable> {
    let existing: Option<String> = conn
        .query_row(
            "SELECT id FROM flow_variables WHERE name = ?2 AND (workspace_id = ?1 OR scope = 'global')
             ORDER BY CASE WHEN workspace_id = ?1 THEN 0 ELSE 1 END LIMIT 1",
            params![workspace_id, name],
            |row| row.get(0),
        )
        .optional()?;
    let id = match existing {
        Some(id) => {
            conn.execute(
                "UPDATE flow_variables SET value = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, value, now],
            )?;
            id
        }
        None => {
            let id = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO flow_variables (id, workspace_id, scope, name, value, updated_at)
                 VALUES (?1, ?2, 'workspace', ?3, ?4, ?5)",
                params![id, workspace_id, name, value, now],
            )?;
            id
        }
    };
    conn.query_row(
        "SELECT id, workspace_id, scope, name, value, updated_at FROM flow_variables WHERE id = ?1",
        params![id],
        variable_row,
    )
}

pub fn rename_variable(conn: &Connection, id: &str, name: &str, now: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE flow_variables SET name = ?2, updated_at = ?3 WHERE id = ?1", params![id, name, now])?;
    Ok(())
}

pub fn set_variable_scope(conn: &Connection, id: &str, global: bool) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE flow_variables SET scope = ?2 WHERE id = ?1",
        params![id, if global { "global" } else { "workspace" }],
    )?;
    Ok(())
}

/// Deletes the variable `name` the workspace sees (its own first). True when one was deleted.
pub fn delete_variable_named(conn: &Connection, workspace_id: &str, name: &str) -> rusqlite::Result<bool> {
    let id: Option<String> = conn
        .query_row(
            "SELECT id FROM flow_variables WHERE name = ?2 AND (workspace_id = ?1 OR scope = 'global')
             ORDER BY CASE WHEN workspace_id = ?1 THEN 0 ELSE 1 END LIMIT 1",
            params![workspace_id, name],
            |row| row.get(0),
        )
        .optional()?;
    match id {
        Some(id) => Ok(conn.execute("DELETE FROM flow_variables WHERE id = ?1", params![id])? > 0),
        None => Ok(false),
    }
}

pub fn delete_variable(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM flow_variables WHERE id = ?1", params![id])?;
    Ok(())
}

// ----------------------------------------------------------------------------------- credentials

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowCredential {
    pub id: String,
    pub workspace_id: String,
    pub scope: String,
    pub name: String,
    /// `bearer`, `basic`, `header`, `query`.
    pub kind: String,
    /// What is safe to show: the user of a basic credential, the header or parameter name.
    pub meta: Value,
    pub created_at: String,
    pub updated_at: String,
}

fn credential_row(row: &Row<'_>) -> rusqlite::Result<FlowCredential> {
    let meta: String = row.get(5)?;
    Ok(FlowCredential {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        scope: row.get(2)?,
        name: row.get(3)?,
        kind: row.get(4)?,
        meta: serde_json::from_str(&meta).unwrap_or(Value::Object(Default::default())),
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

const CREDENTIAL_COLUMNS: &str = "id, workspace_id, scope, name, kind, meta, created_at, updated_at";

pub fn list_credentials(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<FlowCredential>> {
    let mut statement = conn.prepare(&format!(
        "SELECT {CREDENTIAL_COLUMNS} FROM flow_credentials WHERE workspace_id = ?1 OR scope = 'global' ORDER BY name"
    ))?;
    let rows = statement.query_map(params![workspace_id], credential_row)?;
    rows.collect()
}

pub fn get_credential(conn: &Connection, id: &str) -> rusqlite::Result<Option<FlowCredential>> {
    conn.query_row(&format!("SELECT {CREDENTIAL_COLUMNS} FROM flow_credentials WHERE id = ?1"), params![id], credential_row)
        .optional()
}

pub fn insert_credential(conn: &Connection, credential: &FlowCredential) -> rusqlite::Result<()> {
    conn.execute(
        &format!("INSERT INTO flow_credentials ({CREDENTIAL_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"),
        params![
            credential.id,
            credential.workspace_id,
            credential.scope,
            credential.name,
            credential.kind,
            credential.meta.to_string(),
            credential.created_at,
            credential.updated_at
        ],
    )?;
    Ok(())
}

pub fn update_credential(conn: &Connection, id: &str, name: &str, meta: &Value, now: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE flow_credentials SET name = ?2, meta = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, name, meta.to_string(), now],
    )?;
    Ok(())
}

pub fn set_credential_scope(conn: &Connection, id: &str, global: bool) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE flow_credentials SET scope = ?2 WHERE id = ?1",
        params![id, if global { "global" } else { "workspace" }],
    )?;
    Ok(())
}

pub fn delete_credential(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM flow_credentials WHERE id = ?1", params![id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn.execute_batch(
            "DELETE FROM workspaces;
             INSERT INTO workspaces (id, name, icon, color, sort_order, created_at) VALUES
               ('w1', 'Uno', 'folder', '#111111', 0, '2026-01-01T00:00:00Z'),
               ('w2', 'Dos', 'folder', '#222222', 1, '2026-01-01T00:00:00Z');
             INSERT INTO flows (id, workspace_id, name, spec, created_at, updated_at)
               VALUES ('f1', 'w1', 'Demo', '{\"schema\":1}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');",
        )
        .unwrap();
        conn
    }

    fn run(id: &str, status: &str, started: &str) -> FlowRunRow {
        FlowRunRow {
            id: id.into(),
            flow_id: "f1".into(),
            workspace_id: "w1".into(),
            flow_name: "Demo".into(),
            flow_version: 1,
            mode: "manual".into(),
            trigger_node: "n1".into(),
            target_node: String::new(),
            status: status.into(),
            error: String::new(),
            error_node: String::new(),
            started_at: started.into(),
            finished_at: None,
            duration_ms: None,
            data_bytes: 0,
            notify: None,
        }
    }

    #[test]
    fn runs_list_newest_first_and_nodes_upsert() {
        let conn = conn();
        insert_run(&conn, &run("r1", "success", "2026-10-01T10:00:00Z")).unwrap();
        insert_run(&conn, &run("r2", "running", "2026-10-02T10:00:00Z")).unwrap();
        let ids: Vec<String> = list_runs(&conn, "f1", 10, None).unwrap().into_iter().map(|r| r.id).collect();
        assert_eq!(ids, vec!["r2", "r1"]);
        let mut node = FlowRunNodeRow {
            run_id: "r2".into(),
            node_id: "n1".into(),
            node_name: "Manual".into(),
            node_type: "trigger.manual".into(),
            status: "running".into(),
            started_at: Some("2026-10-02T10:00:00Z".into()),
            finished_at: None,
            duration_ms: None,
            items_in: 0,
            items_out: vec![],
            attempts: 1,
            error: String::new(),
            seq: 0,
        };
        upsert_run_node(&conn, &node).unwrap();
        node.status = "success".into();
        node.items_out = vec![3];
        upsert_run_node(&conn, &node).unwrap();
        let nodes = run_nodes(&conn, "r2").unwrap();
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].items_out, vec![3]);
        assert_eq!(latest_run_covering(&conn, "f1", &["n1".to_string()]).unwrap(), None, "a running run is not a source");
        finish_run(&conn, "r2", "success", "", "", "2026-10-02T10:00:01Z", 1000, 10).unwrap();
        assert_eq!(latest_run_covering(&conn, "f1", &["n1".to_string()]).unwrap().as_deref(), Some("r2"));
    }

    #[test]
    fn interrupted_runs_and_retention() {
        let conn = conn();
        insert_run(&conn, &run("old-ok", "success", "2026-01-01T00:00:00Z")).unwrap();
        insert_run(&conn, &run("old-bad", "error", "2026-01-01T00:00:00Z")).unwrap();
        insert_run(&conn, &run("new-ok", "success", "2026-10-01T00:00:00Z")).unwrap();
        insert_run(&conn, &run("live", "running", "2026-10-02T00:00:00Z")).unwrap();
        // Successes older than September go; failures only older than March.
        let mut gone = runs_past_retention(&conn, "f1", 100, "2026-09-01", "2025-12-01").unwrap();
        gone.sort();
        assert_eq!(gone, vec!["old-ok"]);
        // A count of one keeps only the newest finished run.
        let mut gone = runs_past_retention(&conn, "f1", 1, "2000-01-01", "2000-01-01").unwrap();
        gone.sort();
        assert_eq!(gone, vec!["old-bad", "old-ok"]);
        assert_eq!(mark_interrupted(&conn, "2026-10-03T00:00:00Z").unwrap(), 1);
        assert_eq!(get_run(&conn, "live").unwrap().unwrap().status, "interrupted");
    }

    #[test]
    fn orphans_are_runs_without_a_flow() {
        let conn = conn();
        insert_run(&conn, &run("r1", "success", "2026-10-01T00:00:00Z")).unwrap();
        let mut stray = run("r2", "success", "2026-10-01T00:00:00Z");
        stray.flow_id = "gone".into();
        insert_run(&conn, &stray).unwrap();
        assert_eq!(orphan_runs(&conn).unwrap(), vec!["r2"]);
    }

    #[test]
    fn pins_and_state_die_with_their_flow() {
        let conn = conn();
        set_pin(&conn, "f1", "n1", "[{\"json\":{}}]", "now").unwrap();
        state_set(&conn, "f1", "lastId", &serde_json::json!(41), "now").unwrap();
        assert_eq!(state_get(&conn, "f1", "lastId").unwrap(), Some(serde_json::json!(41)));
        conn.execute("DELETE FROM flows WHERE id = 'f1'", []).unwrap();
        assert!(list_pins(&conn, "f1").unwrap().is_empty());
        assert!(state_list(&conn, "f1").unwrap().is_empty());
    }

    #[test]
    fn variables_prefer_the_workspace_over_the_global() {
        let conn = conn();
        let global = put_variable(&conn, "w2", "REGION", "us", "now").unwrap();
        set_variable_scope(&conn, &global.id, true).unwrap();
        assert_eq!(variables_map(&conn, "w1").unwrap()["REGION"], "us");
        put_variable(&conn, "w1", "OTHER", "x", "now").unwrap();
        // Setting a name the workspace sees only as a global updates the global.
        put_variable(&conn, "w1", "REGION", "eu", "now").unwrap();
        assert_eq!(variables_map(&conn, "w2").unwrap()["REGION"], "eu");
        assert!(delete_variable_named(&conn, "w1", "OTHER").unwrap());
        assert!(!variables_map(&conn, "w1").unwrap().contains_key("OTHER"));
    }
}
