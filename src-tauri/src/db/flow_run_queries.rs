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

/// How a flow has been doing: its finished executions since a moment, counted, timed and by day.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowMetrics {
    pub runs: i64,
    pub success: i64,
    pub error: i64,
    pub canceled: i64,
    pub median_ms: Option<i64>,
    pub p95_ms: Option<i64>,
    /// One entry per local day that had a run, oldest first.
    pub days: Vec<DayCount>,
    /// The nodes runs failed at most, most first (three at most).
    pub failing_nodes: Vec<NodeCount>,
    /// The nodes that take longest on average in successful runs (three at most).
    pub slow_nodes: Vec<NodeTime>,
    /// Runs by how they started: `manual`, `trigger`, `retry`, `subflow`…
    pub by_mode: Vec<(String, i64)>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DayCount {
    pub date: String,
    pub success: i64,
    pub error: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NodeCount {
    pub node_id: String,
    pub name: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NodeTime {
    pub node_id: String,
    pub name: String,
    pub avg_ms: i64,
}

/// The value at `share` (0..=1) of sorted durations — nearest rank.
fn percentile(sorted: &[i64], share: f64) -> Option<i64> {
    if sorted.is_empty() {
        return None;
    }
    let rank = ((share * sorted.len() as f64).ceil() as usize).clamp(1, sorted.len());
    Some(sorted[rank - 1])
}

/// A flow's finished executions since `since` (RFC 3339). Days are local: `offset_minutes` is how
/// far the person's clock is from UTC (`-180` in Santiago in winter… as JavaScript's
/// `getTimezoneOffset`, negated by the caller).
pub fn flow_metrics(conn: &Connection, flow_id: &str, since: &str, offset_minutes: i64) -> rusqlite::Result<FlowMetrics> {
    let mut metrics = FlowMetrics::default();
    let finished = "flow_id = ?1 AND started_at >= ?2 AND status NOT IN ('running', 'waiting')";
    let mut statement = conn.prepare(&format!("SELECT status, COUNT(*) FROM flow_runs WHERE {finished} GROUP BY status"))?;
    for row in statement.query_map(params![flow_id, since], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))? {
        let (status, count) = row?;
        metrics.runs += count;
        match status.as_str() {
            "success" => metrics.success += count,
            "error" => metrics.error += count,
            _ => metrics.canceled += count,
        }
    }
    let mut statement = conn.prepare(&format!("SELECT duration_ms FROM flow_runs WHERE {finished} AND status = 'success' AND duration_ms IS NOT NULL ORDER BY duration_ms"))?;
    let durations: Vec<i64> = statement.query_map(params![flow_id, since], |row| row.get(0))?.collect::<rusqlite::Result<_>>()?;
    metrics.median_ms = percentile(&durations, 0.5);
    metrics.p95_ms = percentile(&durations, 0.95);
    let shift = format!("{offset_minutes:+} minutes");
    let mut statement = conn.prepare(&format!(
        "SELECT date(started_at, ?3) AS day, SUM(status = 'success'), SUM(status = 'error') FROM flow_runs WHERE {finished} GROUP BY day ORDER BY day"
    ))?;
    metrics.days = statement
        .query_map(params![flow_id, since, shift], |row| Ok(DayCount { date: row.get(0)?, success: row.get(1)?, error: row.get(2)? }))?
        .collect::<rusqlite::Result<_>>()?;
    let mut statement = conn.prepare(&format!(
        "SELECT r.error_node, COALESCE((SELECT n.node_name FROM flow_run_nodes n WHERE n.run_id = r.id AND n.node_id = r.error_node), r.error_node), COUNT(*) AS c
         FROM flow_runs r WHERE r.{finished_r} AND r.status = 'error' AND r.error_node != ''
         GROUP BY r.error_node ORDER BY c DESC LIMIT 3",
        finished_r = "flow_id = ?1 AND r.started_at >= ?2"
    ))?;
    metrics.failing_nodes = statement
        .query_map(params![flow_id, since], |row| Ok(NodeCount { node_id: row.get(0)?, name: row.get(1)?, count: row.get(2)? }))?
        .collect::<rusqlite::Result<_>>()?;
    let mut statement = conn.prepare(
        "SELECT n.node_id, MAX(n.node_name), CAST(AVG(n.duration_ms) AS INTEGER) AS average
         FROM flow_run_nodes n JOIN flow_runs r ON r.id = n.run_id
         WHERE r.flow_id = ?1 AND r.started_at >= ?2 AND r.status = 'success' AND n.status = 'success' AND n.duration_ms IS NOT NULL
         GROUP BY n.node_id ORDER BY average DESC LIMIT 3",
    )?;
    metrics.slow_nodes = statement
        .query_map(params![flow_id, since], |row| Ok(NodeTime { node_id: row.get(0)?, name: row.get(1)?, avg_ms: row.get(2)? }))?
        .collect::<rusqlite::Result<_>>()?;
    let mut statement = conn.prepare(&format!("SELECT mode, COUNT(*) AS c FROM flow_runs WHERE {finished} GROUP BY mode ORDER BY c DESC"))?;
    metrics.by_mode = statement.query_map(params![flow_id, since], |row| Ok((row.get(0)?, row.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
    Ok(metrics)
}

/// Weeks or months, for [`run_periods`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeriodUnit {
    Week,
    Month,
}

impl PeriodUnit {
    pub fn parse(text: &str) -> Self {
        if text == "month" {
            Self::Month
        } else {
            Self::Week
        }
    }

    /// The first day of the period `day` falls in: its Monday, or the 1st.
    fn start_of(self, day: chrono::NaiveDate) -> chrono::NaiveDate {
        use chrono::Datelike;
        match self {
            Self::Week => day - chrono::Days::new(u64::from(day.weekday().num_days_from_monday())),
            Self::Month => day.with_day(1).unwrap_or(day),
        }
    }

    /// The start of the period `back` periods before the one starting at `start`.
    fn back(self, start: chrono::NaiveDate, back: u32) -> chrono::NaiveDate {
        match self {
            Self::Week => start - chrono::Days::new(7 * u64::from(back)),
            Self::Month => start.checked_sub_months(chrono::Months::new(back)).unwrap_or(start),
        }
    }
}

/// One week or month of a workspace's executions, from the day counters (`flow_run_days`).
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunPeriod {
    /// Its first day, `YYYY-MM-DD`: a Monday, or the 1st.
    pub start: String,
    pub success: i64,
    pub error: i64,
    /// Canceled and interrupted, as [`flow_metrics`] counts them.
    pub canceled: i64,
    /// Each flow that ran in it, most runs first.
    pub flows: Vec<FlowPeriodCount>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FlowPeriodCount {
    pub flow_id: String,
    pub name: String,
    pub success: i64,
    pub error: i64,
    pub canceled: i64,
}

/// The last `count` weeks or months up to the one holding `today`, oldest first and every one of
/// them, empty or not: the executions of the flows `workspace_id` sees — its own and the global
/// ones, as Programación lists them. A deleted flow's runs go with it; nothing would name them.
pub fn run_periods(
    conn: &Connection,
    workspace_id: &str,
    unit: PeriodUnit,
    count: usize,
    today: chrono::NaiveDate,
) -> rusqlite::Result<Vec<RunPeriod>> {
    let current = unit.start_of(today);
    let starts: Vec<chrono::NaiveDate> = (0..count.max(1) as u32).rev().map(|back| unit.back(current, back)).collect();
    let mut periods: Vec<RunPeriod> = starts
        .iter()
        .map(|start| RunPeriod { start: start.format("%Y-%m-%d").to_string(), ..RunPeriod::default() })
        .collect();
    let from = periods[0].start.clone();
    let mut statement = conn.prepare(
        "SELECT d.flow_id, f.name, d.day, d.success, d.error, d.canceled
         FROM flow_run_days d JOIN flows f ON f.id = d.flow_id
         WHERE (f.workspace_id = ?1 OR f.scope = 'global') AND d.day >= ?2",
    )?;
    let rows = statement.query_map(params![workspace_id, from], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, i64>(5)?,
        ))
    })?;
    for row in rows {
        let (flow_id, name, day, success, error, canceled) = row?;
        let Ok(day) = chrono::NaiveDate::parse_from_str(&day, "%Y-%m-%d") else { continue };
        // A day past the current period (a clock set back) belongs to none of them.
        let Some(index) = starts.iter().position(|start| *start == unit.start_of(day)) else { continue };
        let period = &mut periods[index];
        period.success += success;
        period.error += error;
        period.canceled += canceled;
        match period.flows.iter_mut().find(|flow| flow.flow_id == flow_id) {
            Some(flow) => {
                flow.success += success;
                flow.error += error;
                flow.canceled += canceled;
            }
            None => period.flows.push(FlowPeriodCount { flow_id, name, success, error, canceled }),
        }
    }
    for period in &mut periods {
        period.flows.sort_by(|a, b| {
            (b.success + b.error + b.canceled).cmp(&(a.success + a.error + a.canceled)).then_with(|| a.name.cmp(&b.name))
        });
    }
    Ok(periods)
}

/// Day counts whose flow no longer exists — deleted, or replaced by a restore.
pub fn delete_orphan_run_days(conn: &Connection) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM flow_run_days WHERE flow_id NOT IN (SELECT id FROM flows)", [])
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
    fn metrics_count_time_and_bucket_finished_runs_by_local_day() {
        let conn = conn();
        let finished = |id: &str, status: &str, started: &str, ms: i64, error_node: &str| {
            let mut row = run(id, status, started);
            row.duration_ms = Some(ms);
            row.error_node = error_node.into();
            insert_run(&conn, &row).unwrap();
        };
        finished("a", "success", "2026-10-05T02:00:00Z", 1000, "");
        finished("b", "success", "2026-10-05T15:00:00Z", 3000, "");
        finished("c", "error", "2026-10-06T10:00:00Z", 500, "n2");
        finished("d", "success", "2026-10-06T11:00:00Z", 2000, "");
        insert_run(&conn, &run("e", "running", "2026-10-06T12:00:00Z")).unwrap();
        finished("old", "error", "2026-09-01T10:00:00Z", 9, "n9");
        let node = |run_id: &str, ms: i64| FlowRunNodeRow {
            run_id: run_id.into(),
            node_id: "n2".into(),
            node_name: "Enviar".into(),
            node_type: "net.email".into(),
            status: "success".into(),
            started_at: None,
            finished_at: None,
            duration_ms: Some(ms),
            items_in: 1,
            items_out: vec![1],
            attempts: 1,
            error: String::new(),
            seq: 1,
        };
        upsert_run_node(&conn, &node("a", 800)).unwrap();
        upsert_run_node(&conn, &node("b", 1200)).unwrap();
        let metrics = flow_metrics(&conn, "f1", "2026-10-01T00:00:00Z", -180).unwrap();
        assert_eq!((metrics.runs, metrics.success, metrics.error), (4, 3, 1), "running and old runs are left out");
        assert_eq!((metrics.median_ms, metrics.p95_ms), (Some(2000), Some(3000)));
        // 02:00 UTC on the 5th is still the 4th three hours west.
        assert_eq!(metrics.days.iter().map(|d| (d.date.as_str(), d.success, d.error)).collect::<Vec<_>>(), vec![("2026-10-04", 1, 0), ("2026-10-05", 1, 0), ("2026-10-06", 1, 1)]);
        assert_eq!(metrics.failing_nodes, vec![NodeCount { node_id: "n2".into(), name: "n2".into(), count: 1 }]);
        assert_eq!(metrics.slow_nodes, vec![NodeTime { node_id: "n2".into(), name: "Enviar".into(), avg_ms: 1000 }]);
        assert_eq!(metrics.by_mode, vec![("manual".to_string(), 4)]);
        assert_eq!(percentile(&[], 0.5), None);
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

    /// The local day SQLite files a run under — whatever zone the test runs in.
    fn local_day(conn: &Connection, at: &str) -> String {
        conn.query_row("SELECT date(?1, 'localtime')", params![at], |row| row.get(0)).unwrap()
    }

    fn day_counts(conn: &Connection) -> Vec<(String, String, i64, i64, i64)> {
        let mut statement = conn.prepare("SELECT flow_id, day, success, error, canceled FROM flow_run_days ORDER BY flow_id, day").unwrap();
        let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))).unwrap();
        rows.map(Result::unwrap).collect()
    }

    fn date(text: &str) -> chrono::NaiveDate {
        chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn a_run_is_counted_once_on_the_day_it_started() {
        let conn = conn();
        let noon = "2026-10-06T12:00:00Z";
        let day = local_day(&conn, noon);
        insert_run(&conn, &run("ok", "running", noon)).unwrap();
        assert!(day_counts(&conn).is_empty(), "a run still going counts for nothing");
        finish_run(&conn, "ok", "success", "", "", noon, 10, 0).unwrap();
        // Written twice, counted once.
        finish_run(&conn, "ok", "success", "", "", noon, 10, 0).unwrap();
        insert_run(&conn, &run("bad", "running", noon)).unwrap();
        finish_run(&conn, "bad", "error", "boom", "n1", noon, 10, 0).unwrap();
        // Parked and picked up again is not an end; being canceled while parked is.
        insert_run(&conn, &run("parked", "running", noon)).unwrap();
        set_run_status(&conn, "parked", "waiting").unwrap();
        set_run_status(&conn, "parked", "running").unwrap();
        set_run_status(&conn, "parked", "waiting").unwrap();
        finish_run(&conn, "parked", "canceled", "", "", noon, 10, 0).unwrap();
        // The app ending under a run: interrupted, counted with the canceled ones.
        insert_run(&conn, &run("cut", "running", noon)).unwrap();
        mark_interrupted(&conn, noon).unwrap();
        assert_eq!(day_counts(&conn), vec![("f1".into(), day, 1, 1, 2)]);
    }

    #[test]
    fn the_counters_start_from_the_runs_still_kept() {
        let conn = conn();
        let noon = "2026-10-01T12:00:00Z";
        insert_run(&conn, &run("a", "success", noon)).unwrap();
        insert_run(&conn, &run("b", "error", noon)).unwrap();
        insert_run(&conn, &run("c", "running", noon)).unwrap();
        conn.execute_batch("DROP TRIGGER flow_run_days_count; DROP TABLE flow_run_days;").unwrap();
        crate::db::migrations::add_flow_run_days(&conn).unwrap();
        let seeded = vec![("f1".to_string(), local_day(&conn, noon), 1, 1, 0)];
        assert_eq!(day_counts(&conn), seeded);
        // Every launch runs the list again; the seed happens once.
        crate::db::migrations::add_flow_run_days(&conn).unwrap();
        assert_eq!(day_counts(&conn), seeded);
    }

    #[test]
    fn weeks_start_on_monday_and_empty_ones_are_kept() {
        let conn = conn();
        conn.execute_batch(
            "INSERT INTO flow_run_days (flow_id, day, success, error, canceled) VALUES
               ('f1', '2026-10-05', 3, 0, 0),
               ('f1', '2026-10-04', 0, 2, 0),
               ('f1', '2026-09-07', 1, 0, 1),
               ('f1', '2026-08-01', 9, 9, 9);",
        )
        .unwrap();
        // Wednesday 2026-10-07: six weeks back to Monday 2026-08-31; August 1st is before them.
        let weeks = run_periods(&conn, "w1", PeriodUnit::Week, 6, date("2026-10-07")).unwrap();
        let starts: Vec<&str> = weeks.iter().map(|week| week.start.as_str()).collect();
        assert_eq!(starts, ["2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05"]);
        let totals: Vec<(i64, i64, i64)> = weeks.iter().map(|week| (week.success, week.error, week.canceled)).collect();
        // Sunday the 4th closes the week of the 28th.
        assert_eq!(totals, [(0, 0, 0), (1, 0, 1), (0, 0, 0), (0, 0, 0), (0, 2, 0), (3, 0, 0)]);
        assert_eq!(weeks[5].flows, vec![FlowPeriodCount { flow_id: "f1".into(), name: "Demo".into(), success: 3, error: 0, canceled: 0 }]);
    }

    #[test]
    fn months_count_the_flows_the_workspace_sees() {
        let conn = conn();
        conn.execute_batch(
            "INSERT INTO flows (id, workspace_id, name, spec, created_at, updated_at) VALUES
               ('f2', 'w2', 'Ajeno', '{\"schema\":1}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
               ('f3', 'w2', 'Global', '{\"schema\":1}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
             UPDATE flows SET scope = 'global' WHERE id = 'f3';
             INSERT INTO flow_run_days (flow_id, day, success, error, canceled) VALUES
               ('f1', '2026-10-01', 2, 0, 0),
               ('f1', '2026-10-06', 0, 1, 0),
               ('f2', '2026-10-02', 50, 0, 0),
               ('f3', '2026-10-03', 4, 1, 0),
               ('f1', '2026-08-31', 7, 0, 0);",
        )
        .unwrap();
        let months = run_periods(&conn, "w1", PeriodUnit::Month, 3, date("2026-10-07")).unwrap();
        let starts: Vec<&str> = months.iter().map(|month| month.start.as_str()).collect();
        assert_eq!(starts, ["2026-08-01", "2026-09-01", "2026-10-01"]);
        assert_eq!((months[0].success, months[1].success), (7, 0));
        // Its own flow and the global one, never another workspace's; most runs first.
        let october = &months[2];
        assert_eq!((october.success, october.error), (6, 2));
        let names: Vec<&str> = october.flows.iter().map(|flow| flow.name.as_str()).collect();
        assert_eq!(names, ["Global", "Demo"]);
    }

    #[test]
    fn day_counts_go_with_their_flow() {
        let conn = conn();
        conn.execute_batch(
            "INSERT INTO flow_run_days (flow_id, day, success) VALUES ('f1', '2026-10-01', 1), ('gone', '2026-10-01', 1);",
        )
        .unwrap();
        assert_eq!(delete_orphan_run_days(&conn).unwrap(), 1);
        crate::db::flow_queries::delete_flow(&conn, "f1").unwrap();
        assert!(day_counts(&conn).is_empty());
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
