//! What the live view shows about a run beyond its items: what each member spent, who talks to
//! whom, and the things worth a look — a budget running out, two members passing a review back and
//! forth, a turn that has been running too long, a member with nothing to do.
//!
//! Computed here because the spend is the backend's: each task's cost and tokens are summed as its
//! turns finish (`queries::add_agent_task_usage`), and a window's copy of those rows is stale.

use std::collections::HashMap;

use rusqlite::{params, Connection};
use serde::Serialize;

use super::{Item, Message, Run};

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct MemberMetrics {
    pub member_id: String,
    pub name: String,
    pub usd: f64,
    pub tokens: i64,
    pub minutes: f64,
    pub done: i64,
    pub failed: i64,
    pub running: i64,
    pub attempts: i64,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct Edge {
    pub from: String,
    pub to: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct Alert {
    /// `budget_warn`, `budget_hit`, `ping_pong`, `stalled`, `idle`.
    pub kind: String,
    /// The members it is about, by id.
    pub members: Vec<String>,
    pub item_id: String,
    /// A number the message shows: laps, minutes, percent.
    pub value: f64,
}

#[derive(Debug, Clone, Serialize, Default, PartialEq)]
pub struct RunMetrics {
    pub usd: f64,
    pub tokens: i64,
    pub minutes: f64,
    pub budget_usd: f64,
    pub budget_tokens: i64,
    pub budget_minutes: i64,
    pub running: i64,
    pub members: Vec<MemberMetrics>,
    pub edges: Vec<Edge>,
    pub alerts: Vec<Alert>,
}

/// Cost and tokens of every task of a run, by task id.
pub fn spend(conn: &Connection, run_id: &str) -> rusqlite::Result<HashMap<String, (f64, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT id, COALESCE(cost_usd, 0), COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)
         FROM agent_tasks WHERE batch_id = ?1",
    )?;
    let rows = stmt.query_map(params![format!("{}{run_id}", super::TASK_BATCH_PREFIX)], |row| {
        Ok((row.get::<_, String>(0)?, (row.get::<_, f64>(1)?, row.get::<_, i64>(2)?)))
    })?;
    rows.collect()
}

fn minutes_between(start: &str, end: &str, now: chrono::DateTime<chrono::Utc>) -> f64 {
    let Ok(started) = chrono::DateTime::parse_from_rfc3339(start) else { return 0.0 };
    let finished = chrono::DateTime::parse_from_rfc3339(end).map(|d| d.with_timezone(&chrono::Utc)).unwrap_or(now);
    ((finished - started.with_timezone(&chrono::Utc)).num_seconds().max(0) as f64) / 60.0
}

/// Agent-minutes spent so far: the running time of every item.
pub fn agent_minutes(items: &[Item], now: chrono::DateTime<chrono::Utc>) -> f64 {
    items.iter().filter(|i| !i.started_at.is_empty()).map(|i| minutes_between(&i.started_at, if i.status == "running" { "" } else { &i.finished_at }, now)).sum()
}

/// Whether a run has spent past one of its budgets, and which.
pub fn over_budget(run: &Run, usd: f64, tokens: i64, minutes: f64) -> Option<String> {
    let p = &run.policy;
    if p.budget_usd > 0.0 && usd >= p.budget_usd {
        return Some(format!("Se gastó el presupuesto: ${usd:.2} de ${:.2}.", p.budget_usd));
    }
    if p.budget_tokens > 0 && tokens >= p.budget_tokens {
        return Some(format!("Se usaron los tokens previstos: {tokens} de {}.", p.budget_tokens));
    }
    if p.budget_minutes > 0 && minutes >= p.budget_minutes as f64 {
        return Some(format!("Se agotó el tiempo previsto: {} de {} minutos de agente.", minutes.round(), p.budget_minutes));
    }
    None
}

pub fn compute(run: &Run, items: &[Item], messages: &[Message], spend: &HashMap<String, (f64, i64)>, now: chrono::DateTime<chrono::Utc>) -> RunMetrics {
    let mut members: Vec<MemberMetrics> = run
        .members
        .iter()
        .map(|m| MemberMetrics { member_id: m.member.id.clone(), name: m.member.name.clone(), ..Default::default() })
        .collect();
    let mut seen_tasks: HashMap<&str, &str> = HashMap::new();
    for item in items {
        let Some(m) = members.iter_mut().find(|m| m.member_id == item.member_id) else { continue };
        match item.status.as_str() {
            "done" => m.done += 1,
            "error" => m.failed += 1,
            "running" => m.running += 1,
            _ => {}
        }
        m.attempts += item.attempts;
        if !item.started_at.is_empty() {
            m.minutes += minutes_between(&item.started_at, if item.status == "running" { "" } else { &item.finished_at }, now);
        }
        // A task can carry several items (the lead's conversation, a fix and its review): count it once.
        if !item.task_id.is_empty() && !seen_tasks.contains_key(item.task_id.as_str()) {
            seen_tasks.insert(&item.task_id, &item.member_id);
            if let Some((usd, tokens)) = spend.get(&item.task_id) {
                m.usd += usd;
                m.tokens += tokens;
            }
        }
    }
    let usd: f64 = members.iter().map(|m| m.usd).sum();
    let tokens: i64 = members.iter().map(|m| m.tokens).sum();
    let minutes: f64 = members.iter().map(|m| m.minutes).sum();

    let mut edge_map: HashMap<(String, String), i64> = HashMap::new();
    for msg in messages.iter().filter(|m| m.kind != "status") {
        if msg.from_id == "system" {
            continue;
        }
        *edge_map.entry((msg.from_id.clone(), msg.to_id.clone())).or_default() += 1;
    }
    let mut edges: Vec<Edge> = edge_map.into_iter().map(|((from, to), count)| Edge { from, to, count }).collect();
    edges.sort_by(|a, b| b.count.cmp(&a.count).then(a.from.cmp(&b.from)).then(a.to.cmp(&b.to)));

    let mut alerts = Vec::new();
    let p = &run.policy;
    let warn = p.budget_warn_pct as f64 / 100.0;
    for (spent, budget) in [(usd, p.budget_usd), (tokens as f64, p.budget_tokens as f64), (minutes, p.budget_minutes as f64)] {
        if budget > 0.0 {
            let ratio = spent / budget;
            if ratio >= 1.0 {
                alerts.push(Alert { kind: "budget_hit".into(), value: (ratio * 100.0).round(), ..Default::default() });
            } else if ratio >= warn {
                alerts.push(Alert { kind: "budget_warn".into(), value: (ratio * 100.0).round(), ..Default::default() });
            }
        }
    }
    // Ping-pong: a review lap at or past the policy's threshold, reviewer ↔ author.
    for review in items.iter().filter(|i| i.kind == "review" && i.lap >= p.ping_pong_laps) {
        if let Some(work) = items.iter().find(|w| w.id == review.ref_item) {
            if !alerts.iter().any(|a| a.kind == "ping_pong" && a.members.contains(&work.member_id) && a.members.contains(&review.member_id)) {
                alerts.push(Alert { kind: "ping_pong".into(), members: vec![review.member_id.clone(), work.member_id.clone()], item_id: work.id.clone(), value: review.lap as f64 });
            }
        }
    }
    for item in items.iter().filter(|i| i.status == "running" && !i.started_at.is_empty()) {
        let running_for = minutes_between(&item.started_at, "", now);
        if running_for >= 20.0 {
            alerts.push(Alert { kind: "stalled".into(), members: vec![item.member_id.clone()], item_id: item.id.clone(), value: running_for.round() });
        }
    }
    if run.status == "running" && items.iter().any(|i| i.status == "pending") {
        for m in run.members.iter().filter(|m| m.member.id != run.lead && !m.member.advisor) {
            if !items.iter().any(|i| i.member_id == m.member.id) {
                alerts.push(Alert { kind: "idle".into(), members: vec![m.member.id.clone()], ..Default::default() });
            }
        }
    }

    RunMetrics {
        usd,
        tokens,
        minutes,
        budget_usd: p.budget_usd,
        budget_tokens: p.budget_tokens,
        budget_minutes: p.budget_minutes,
        running: items.iter().filter(|i| i.status == "running").count() as i64,
        members,
        edges,
        alerts,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::team::{Member, MemberSnap, Policy};

    fn run_with(policy: Policy) -> Run {
        let snap = |id: &str| MemberSnap { member: Member { id: id.into(), name: id.into(), ..Default::default() }, ..Default::default() };
        Run { id: "r".into(), status: "running".into(), lead: "L".into(), policy, members: vec![snap("L"), snap("dev"), snap("qa"), snap("idle")], ..Default::default() }
    }

    fn item(id: &str, member: &str, kind: &str, status: &str, task: &str) -> Item {
        Item { id: id.into(), member_id: member.into(), kind: kind.into(), status: status.into(), task_id: task.into(), ..Default::default() }
    }

    #[test]
    fn sums_spend_once_per_task_and_flags_budget_ping_pong_and_idle() {
        let run = run_with(Policy { budget_usd: 1.0, budget_warn_pct: 80, ping_pong_laps: 3, ..Default::default() });
        let mut review = item("rev", "qa", "review", "done", "t2");
        review.ref_item = "w".into();
        review.lap = 3;
        let items = vec![item("w", "dev", "work", "done", "t1"), item("w-fix", "dev", "work", "pending", "t1"), review];
        let spend = HashMap::from([("t1".to_string(), (0.6, 1000)), ("t2".to_string(), (0.25, 500))]);
        let msgs = vec![
            Message { from_id: "qa".into(), to_id: "dev".into(), kind: "finding".into(), ..Default::default() },
            Message { from_id: "qa".into(), to_id: "dev".into(), kind: "finding".into(), ..Default::default() },
            Message { from_id: "dev".into(), to_id: "all".into(), kind: "status".into(), ..Default::default() },
        ];
        let m = compute(&run, &items, &msgs, &spend, chrono::Utc::now());
        assert!((m.usd - 0.85).abs() < 1e-9);
        assert_eq!(m.tokens, 1500);
        assert_eq!(m.edges, vec![Edge { from: "qa".into(), to: "dev".into(), count: 2 }]);
        assert!(m.alerts.iter().any(|a| a.kind == "budget_warn"));
        assert!(m.alerts.iter().any(|a| a.kind == "ping_pong" && a.members.len() == 2));
        assert!(m.alerts.iter().any(|a| a.kind == "idle" && a.members == vec!["idle".to_string()]));
    }

    #[test]
    fn over_budget_names_what_ran_out() {
        let run = run_with(Policy { budget_tokens: 100, ..Default::default() });
        assert!(over_budget(&run, 5.0, 99, 0.0).is_none());
        assert!(over_budget(&run, 0.0, 100, 0.0).unwrap().contains("tokens"));
    }
}
