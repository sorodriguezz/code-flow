//! «Rutinas»: the flows that put the workspace's agents and teams to work — on a schedule, on an
//! event, or by hand — read from Flows, where they live.
//!
//! Nothing here runs anything, and nothing is stored here. An agent that works on its own every
//! Monday, or whenever a pull request opens, already exists: it is a flow with a trigger and an
//! agent or team node (`flows::nodes::ai::agents`), run by the flows engine with the team's own
//! budgets. What was missing is seeing them from where the agents are: which of my agents and
//! teams work without me, started by what, and how the last time went. That is a read over the
//! flows' specs, kept beside the teams it is about.

use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::Value;

/// The node types that put an agent or a team to work, and what each is.
const AGENT_NODES: [(&str, &str); 4] = [("ai.team", "team"), ("ai.agent", "agent"), ("ai.agents", "agents"), ("ai.orchestrator", "lead")];

/// One agent or team a routine puts to work.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Worker {
    pub node_id: String,
    pub node_name: String,
    /// `team`, `agent`, `agents` (several at once) or `lead` (one that hands work to helpers).
    pub kind: String,
    /// The team's id, or the roster agents' ids. A value written as an expression (`{{ … }}`) is
    /// decided when the flow runs and is left out.
    pub refs: Vec<String>,
    /// What it is asked to do, shortened.
    pub ask: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LastRun {
    pub status: String,
    pub started_at: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Routine {
    pub flow_id: String,
    pub name: String,
    pub description: String,
    /// Whether its triggers are armed: an inactive routine only runs when started by hand.
    pub active: bool,
    pub global: bool,
    /// Trigger type ids, in canvas order (`trigger.schedule`, `trigger.github`…).
    pub triggers: Vec<String>,
    pub workers: Vec<Worker>,
    pub last_run: Option<LastRun>,
    /// Runs and failed runs in the last thirty days.
    pub runs: i64,
    pub failed: i64,
}

fn text(params: &Value, key: &str) -> String {
    params.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string()
}

/// An id a parameter names outright — not one computed when the flow runs.
fn literal(value: &str) -> Option<String> {
    (!value.is_empty() && !value.contains("{{")).then(|| value.to_string())
}

/// The ids a list parameter names outright, whether written as ids or as `{ agent }` rows.
fn listed(params: &Value, key: &str) -> Vec<String> {
    params
        .get(key)
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(|v| v.as_str().or_else(|| v.get("agent").and_then(Value::as_str))).filter_map(|id| literal(id.trim())).collect())
        .unwrap_or_default()
}

fn shorten(value: &str) -> String {
    let line = value.lines().find(|line| !line.trim().is_empty()).unwrap_or_default().trim();
    let mut out: String = line.chars().take(180).collect();
    if line.chars().count() > 180 {
        out.push('…');
    }
    out
}

/// The agents and teams a flow's spec puts to work; empty for a flow that has none.
pub fn workers(spec: &str) -> Vec<Worker> {
    let Ok(spec) = serde_json::from_str::<Value>(spec) else { return Vec::new() };
    let Some(nodes) = spec.get("nodes").and_then(Value::as_array) else { return Vec::new() };
    nodes
        .iter()
        .filter(|node| !node.get("disabled").and_then(Value::as_bool).unwrap_or(false))
        .filter_map(|node| {
            let type_id = node.get("type").and_then(Value::as_str)?;
            let kind = AGENT_NODES.iter().find(|(id, _)| *id == type_id)?.1;
            let empty = Value::Null;
            let params = node.get("params").unwrap_or(&empty);
            let refs: Vec<String> = match kind {
                "team" => literal(&text(params, "team")).into_iter().collect(),
                "agent" => literal(&text(params, "agent")).into_iter().collect(),
                // The lead first, then the helpers it hands work to.
                "lead" => literal(&text(params, "agent")).into_iter().chain(listed(params, "helpers")).collect(),
                // Several on the same task, or one of them going through every item.
                _ => match listed(params, "agents") {
                    several if !several.is_empty() => several,
                    _ => literal(&text(params, "agent")).into_iter().collect(),
                },
            };
            let ask = ["prompt", "instruction", "goal"].iter().map(|key| text(params, key)).find(|value| !value.is_empty()).unwrap_or_default();
            Some(Worker {
                node_id: node.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
                node_name: node.get("name").and_then(Value::as_str).unwrap_or_default().to_string(),
                kind: kind.to_string(),
                refs,
                ask: shorten(&ask),
            })
        })
        .collect()
}

/// Every flow of the workspace (and every global one) that puts an agent or a team to work, the
/// armed ones first and then by name.
pub fn list(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<Routine>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, description, spec, trigger_types, active, scope FROM flows
         WHERE (workspace_id = ?1 OR scope = 'global') AND spec LIKE '%\"ai.%'
         ORDER BY active DESC, name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map(params![workspace_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, bool>(5)?,
            row.get::<_, String>(6)?,
        ))
    })?;
    let since = (chrono::Utc::now() - chrono::Duration::days(30)).to_rfc3339();
    let mut out = Vec::new();
    for row in rows {
        let (flow_id, name, description, spec, trigger_types, active, scope) = row?;
        let workers = workers(&spec);
        if workers.is_empty() {
            continue;
        }
        let last_run = conn
            .query_row(
                "SELECT status, started_at, error FROM flow_runs WHERE flow_id = ?1 ORDER BY started_at DESC LIMIT 1",
                params![flow_id],
                |row| Ok(LastRun { status: row.get(0)?, started_at: row.get(1)?, error: row.get(2)? }),
            )
            .ok();
        let (runs, failed) = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(status IN ('error', 'failed')), 0) FROM flow_runs WHERE flow_id = ?1 AND started_at >= ?2",
                params![flow_id, since],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .unwrap_or((0, 0));
        out.push(Routine {
            flow_id,
            name,
            description,
            active,
            global: scope == "global",
            triggers: serde_json::from_str(&trigger_types).unwrap_or_default(),
            workers,
            last_run,
            runs,
            failed,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_agents_and_teams_a_flow_puts_to_work() {
        let spec = serde_json::json!({
            "schema": 1,
            "nodes": [
                { "id": "t", "type": "trigger.schedule", "name": "Lunes 9:00", "pos": [0, 0], "params": {} },
                { "id": "a", "type": "ai.team", "name": "Auditoría", "pos": [0, 0], "params": { "team": "team-1", "prompt": "\n  Revisa la arquitectura del Core\ny reporta." } },
                { "id": "b", "type": "ai.agent", "name": "Resumen", "pos": [0, 0], "params": { "agent": "{{ $json.agent }}", "instruction": "Resume" } },
                { "id": "c", "type": "ai.agent", "name": "Apagado", "pos": [0, 0], "disabled": true, "params": { "agent": "x" } },
                { "id": "d", "type": "http.request", "name": "Otro", "pos": [0, 0], "params": {} }
            ]
        })
        .to_string();
        let found = workers(&spec);
        assert_eq!(found.len(), 2, "{found:?}");
        assert_eq!((found[0].kind.as_str(), found[0].refs.clone(), found[0].ask.as_str()), ("team", vec!["team-1".to_string()], "Revisa la arquitectura del Core"));
        assert!(found[1].refs.is_empty(), "an id decided at run time is not a reference");
        assert!(workers("no es json").is_empty());
    }

    #[test]
    fn a_lead_with_helpers_and_an_agent_per_item_are_routines_too() {
        let spec = serde_json::json!({
            "schema": 1,
            "nodes": [
                { "id": "l", "type": "ai.orchestrator", "name": "Informe", "pos": [0, 0], "params": { "runAs": "rosterAgent", "agent": "jefe", "helpers": ["ana", "luis"], "prompt": "Prepara el informe" } },
                { "id": "p", "type": "ai.agents", "name": "Por ítem", "pos": [0, 0], "params": { "mode": "perItem", "agent": "ana", "agents": [], "prompt": "Revisa cada uno" } },
                { "id": "s", "type": "ai.agents", "name": "A la vez", "pos": [0, 0], "params": { "mode": "sameTask", "agents": ["ana", "luis"], "prompt": "Opinen" } }
            ]
        })
        .to_string();
        let found = workers(&spec);
        let seen: Vec<(&str, Vec<&str>)> = found.iter().map(|w| (w.kind.as_str(), w.refs.iter().map(String::as_str).collect())).collect();
        assert_eq!(seen, vec![("lead", vec!["jefe", "ana", "luis"]), ("agents", vec!["ana"]), ("agents", vec!["ana", "luis"])]);
    }

    #[test]
    fn lists_only_flows_with_agents_and_says_how_the_last_run_went() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        let ws = crate::db::queries::create_workspace(&conn, "ws", "folder", "#fff").unwrap();
        let with_team = serde_json::json!({ "schema": 1, "nodes": [{ "id": "a", "type": "ai.team", "name": "Equipo", "pos": [0, 0], "params": { "team": "t1", "prompt": "Audita" } }] }).to_string();
        let plain = serde_json::json!({ "schema": 1, "nodes": [{ "id": "a", "type": "ai.llm", "name": "Modelo", "pos": [0, 0], "params": {} }] }).to_string();
        for (id, name, spec, active) in [("f1", "Auditoría semanal", &with_team, true), ("f2", "Sin agentes", &plain, true)] {
            conn.execute(
                "INSERT INTO flows (id, workspace_id, name, spec, trigger_types, active, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, '[\"trigger.schedule\"]', ?5, 'x', 'x')",
                params![id, ws.id, name, spec, active],
            )
            .unwrap();
        }
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO flow_runs (id, flow_id, workspace_id, mode, status, error, started_at) VALUES ('r1', 'f1', ?1, 'trigger', 'error', 'sin cuota', ?2)",
            params![ws.id, now],
        )
        .unwrap();
        let routines = list(&conn, &ws.id).unwrap();
        assert_eq!(routines.len(), 1, "a flow that only calls a model is not a routine of agents");
        let routine = &routines[0];
        assert_eq!((routine.name.as_str(), routine.active, routine.triggers.clone()), ("Auditoría semanal", true, vec!["trigger.schedule".to_string()]));
        assert_eq!((routine.runs, routine.failed), (1, 1));
        assert_eq!(routine.last_run.as_ref().map(|run| run.error.as_str()), Some("sin cuota"));
    }
}
