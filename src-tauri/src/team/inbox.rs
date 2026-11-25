//! Each agent's inbox: what is on its plate across every run and the board, and what of that waits
//! on the user.
//!
//! A run shows its own members; the board shows its own cards. Neither answers «what is Ana doing,
//! and is she stuck on me?» when Ana sits in three teams. This reads what is already there — the
//! items of the runs that are still going, the messages addressed to a member that it has not
//! heard yet, the questions it asked that nobody answered, and the board's cards assigned to it —
//! and files it under the roster's agent. Nothing is stored: it is a view.

use std::collections::HashMap;

use rusqlite::Connection;
use serde::Serialize;

use super::{Item, Message, Run};

/// How many entries of one agent are sent: the newest of each kind matter, not the fortieth.
const MAX_ENTRIES: usize = 40;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// `question` (it asked the user and waits), `failure` (a task of its failed), `gate` (a task
    /// waits for an approval), `task` (it is on it now), `queued` (it is next), `note` (a message
    /// for it that it has not heard yet) or `card` (a board card assigned to it, not started).
    pub kind: String,
    pub run_id: String,
    pub run_title: String,
    pub item_id: String,
    pub message_id: String,
    pub card_id: String,
    pub member_id: String,
    pub title: String,
    pub detail: String,
    pub at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentInbox {
    pub agent_id: String,
    pub name: String,
    pub role: String,
    pub provider: String,
    pub model: String,
    /// The teams it sits in, by name.
    pub teams: Vec<String>,
    /// Entries that wait on the user: questions, failures and approvals.
    pub waiting: usize,
    pub working: usize,
    pub queued: usize,
    pub entries: Vec<Entry>,
}

fn first_line(text: &str, max: usize) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or_default();
    if line.chars().count() > max {
        format!("{}…", line.chars().take(max).collect::<String>())
    } else {
        line.to_string()
    }
}

fn order(kind: &str) -> u8 {
    match kind {
        "question" => 0,
        "failure" => 1,
        "gate" => 2,
        "task" => 3,
        "note" => 4,
        "queued" => 5,
        _ => 6,
    }
}

/// One run's entries, by the agent they belong to.
pub fn of_run(run: &Run, items: &[Item], messages: &[Message]) -> Vec<(String, Entry)> {
    let agent_of: HashMap<&str, &str> = run.members.iter().map(|m| (m.member.id.as_str(), m.member.agent_id.as_str())).collect();
    let entry = |kind: &str, member: &str, item: &str, message: &str, title: &str, detail: &str, at: &str| Entry {
        kind: kind.into(),
        run_id: run.id.clone(),
        run_title: run.title.clone(),
        item_id: item.into(),
        message_id: message.into(),
        card_id: String::new(),
        member_id: member.into(),
        title: first_line(title, 120),
        detail: first_line(detail, 220),
        at: at.into(),
    };
    let mut out = Vec::new();
    for item in items {
        let Some(agent) = agent_of.get(item.member_id.as_str()).filter(|id| !id.is_empty()) else { continue };
        let made = match item.status.as_str() {
            "running" => {
                let detail = match item.intelligence.phase.as_str() {
                    "queued" => "En cola: espera un cupo",
                    "verifying" => "CodeFlow verifica lo que entregó",
                    _ => "",
                };
                Some(entry("task", &item.member_id, &item.id, "", &item.title, detail, if item.started_at.is_empty() { &item.updated_at } else { &item.started_at }))
            }
            "pending" => Some(entry("queued", &item.member_id, &item.id, "", &item.title, &item.feedback, &item.updated_at)),
            "error" => Some(entry("failure", &item.member_id, &item.id, "", &item.title, &item.last_error, &item.updated_at)),
            "gated" => Some(entry("gate", &item.member_id, &item.id, "", &item.title, "Espera tu aprobación", &item.updated_at)),
            // `waiting` with a question is filed below, from the question itself; this is the item
            // that waits on an engine to come back.
            "waiting" if item.intelligence.recovery.is_some() => Some(entry("gate", &item.member_id, &item.id, "", &item.title, "Espera a que su motor vuelva", &item.updated_at)),
            _ => None,
        };
        if let Some(made) = made {
            out.push((agent.to_string(), made));
        }
    }
    for message in messages {
        if message.kind == "question" && message.answered_at.is_empty() {
            if let Some(agent) = agent_of.get(message.from_id.as_str()).filter(|id| !id.is_empty()) {
                let title = items.iter().find(|i| i.id == message.item_id).map(|i| i.title.as_str()).unwrap_or("Pregunta");
                out.push((agent.to_string(), entry("question", &message.from_id, &message.item_id, &message.id, title, &message.body, &message.created_at)));
            }
        } else if !message.delivered && matches!(message.kind.as_str(), "note" | "answer" | "handoff") {
            if let Some(agent) = agent_of.get(message.to_id.as_str()).filter(|id| !id.is_empty()) {
                out.push((agent.to_string(), entry("note", &message.to_id, &message.item_id, &message.id, &format!("De {}", message.from_name), &message.body, &message.created_at)));
            }
        }
    }
    out
}

/// Every agent of the workspace with what it has, the ones something waits on first.
pub fn list(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<AgentInbox>> {
    let agents = crate::db::queries::list_workspace_agents(conn, workspace_id)?;
    let teams = super::list_teams(conn, workspace_id)?;
    let mut filed: HashMap<String, Vec<Entry>> = HashMap::new();
    for run in super::list_runs(conn, workspace_id)?.into_iter().filter(|run| matches!(run.status.as_str(), "running" | "gated" | "paused")) {
        let items = super::list_items(conn, &run.id)?;
        let messages = super::list_messages(conn, &run.id)?;
        for (agent, entry) in of_run(&run, &items, &messages) {
            filed.entry(agent).or_default().push(entry);
        }
    }
    for card in crate::crew::backlog_list(conn, workspace_id)? {
        // A card that already started something shows as that work, not twice.
        if card.assignee_kind != "agent" || card.assignee_id.is_empty() || !card.links.is_empty() || matches!(card.status.as_str(), "done" | "archived") {
            continue;
        }
        filed.entry(card.assignee_id.clone()).or_default().push(Entry {
            kind: "card".into(),
            run_id: String::new(),
            run_title: String::new(),
            item_id: String::new(),
            message_id: String::new(),
            card_id: card.id.clone(),
            member_id: String::new(),
            title: first_line(&card.title, 120),
            detail: first_line(&card.body, 220),
            at: card.updated_at.clone(),
        });
    }
    let mut out: Vec<AgentInbox> = agents
        .into_iter()
        .map(|agent| {
            let mut entries = filed.remove(&agent.id).unwrap_or_default();
            // What waits on the user first; within a kind, the newest first.
            entries.sort_by(|a, b| order(&a.kind).cmp(&order(&b.kind)).then_with(|| b.at.cmp(&a.at)));
            let count = |kinds: &[&str]| entries.iter().filter(|e| kinds.contains(&e.kind.as_str())).count();
            let (waiting, working, queued) = (count(&["question", "failure", "gate"]), count(&["task"]), count(&["queued", "card"]));
            entries.truncate(MAX_ENTRIES);
            let mut sits: Vec<String> = teams.iter().filter(|team| team.members.iter().any(|m| m.agent_id == agent.id)).map(|team| team.name.clone()).collect();
            sits.sort();
            AgentInbox { agent_id: agent.id, name: agent.name, role: agent.role, provider: agent.provider, model: agent.model, teams: sits, waiting, working, queued, entries }
        })
        .collect();
    out.sort_by(|a, b| b.waiting.cmp(&a.waiting).then_with(|| b.working.cmp(&a.working)).then_with(|| b.queued.cmp(&a.queued)).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::team::{Member, MemberSnap};

    fn run() -> Run {
        let member = |id: &str, agent: &str| MemberSnap { member: Member { id: id.into(), agent_id: agent.into(), name: id.into(), ..Default::default() }, ..Default::default() };
        Run { id: "r".into(), title: "Pagos".into(), members: vec![member("d", "agent-dev"), member("q", "agent-qa")], ..Default::default() }
    }

    fn item(id: &str, member: &str, status: &str) -> Item {
        Item { id: id.into(), member_id: member.into(), title: format!("tarea {id}"), status: status.into(), updated_at: "2026-11-25T10:00:00Z".into(), ..Default::default() }
    }

    #[test]
    fn a_run_is_filed_under_the_agents_behind_its_members() {
        let mut queued = item("1", "d", "running");
        queued.intelligence.phase = "queued".into();
        let mut failed = item("2", "d", "error");
        failed.last_error = "npm test falló\nmás detalle".into();
        let items = vec![queued, failed, item("3", "q", "pending"), item("4", "d", "done"), item("5", "nobody", "running")];
        let message = |id: &str, kind: &str, from: &str, to: &str, delivered: bool| Message {
            id: id.into(),
            kind: kind.into(),
            from_id: from.into(),
            from_name: from.into(),
            to_id: to.into(),
            body: "¿REST o gRPC?".into(),
            delivered,
            item_id: "1".into(),
            ..Default::default()
        };
        let mut answered = message("m3", "question", "d", "user", false);
        answered.answered_at = "2026-11-25T10:05:00Z".into();
        let messages = vec![message("m1", "question", "d", "user", false), message("m2", "note", "d", "q", false), answered, message("m4", "note", "d", "q", true)];
        let filed = of_run(&run(), &items, &messages);
        let kinds = |agent: &str| filed.iter().filter(|(a, _)| a == agent).map(|(_, e)| e.kind.as_str()).collect::<Vec<_>>();
        assert_eq!(kinds("agent-dev"), vec!["task", "failure", "question"], "done work and answered questions are not on anybody's plate");
        assert_eq!(kinds("agent-qa"), vec!["queued", "note"], "only what it has not heard yet");
        let task = &filed.iter().find(|(_, e)| e.kind == "task").unwrap().1;
        assert_eq!(task.detail, "En cola: espera un cupo");
        let failure = &filed.iter().find(|(_, e)| e.kind == "failure").unwrap().1;
        assert_eq!(failure.detail, "npm test falló", "the first line says it");
        let question = &filed.iter().find(|(_, e)| e.kind == "question").unwrap().1;
        assert_eq!((question.title.as_str(), question.message_id.as_str()), ("tarea 1", "m1"));
    }

    #[test]
    fn the_agents_something_waits_on_come_first() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        let ws = crate::db::queries::create_workspace(&conn, "ws", "folder", "#fff").unwrap();
        let agent = |name: &str| crate::db::queries::upsert_workspace_agent(&conn, None, &ws.id, name, "rol", "claude", "sonnet", "", true, None).unwrap();
        let (ana, beto, caro) = (agent("Ana"), agent("Beto"), agent("Caro"));
        let member = |id: &str, agent: &str| Member { id: id.into(), agent_id: agent.into(), name: id.into(), ..Default::default() };
        crate::team::save_team(&conn, crate::team::Team { workspace_id: ws.id.clone(), name: "Pagos".into(), members: vec![member("a", &ana.id), member("b", &beto.id)], plan: vec![crate::team::PlanStep { key: "k".into(), member: "a".into(), instruction: "x".into(), ..Default::default() }], ..Default::default() }).unwrap();
        let snap = |id: &str, agent: &str| MemberSnap { member: member(id, agent), provider: "claude".into(), model: "sonnet".into(), ..Default::default() };
        let run = Run { id: "r1".into(), workspace_id: ws.id.clone(), title: "Cobros".into(), status: "running".into(), members: vec![snap("a", &ana.id), snap("b", &beto.id)], created_at: "2026-11-25T10:00:00Z".into(), updated_at: "2026-11-25T10:00:00Z".into(), ..Default::default() };
        crate::team::insert_run(&conn, &run).unwrap();
        let put = |id: &str, member: &str, status: &str| {
            let mut i = item(id, member, status);
            i.run_id = "r1".into();
            i.key = id.into();
            i.kind = "work".into();
            i.created_at = "2026-11-25T10:00:00Z".into();
            crate::team::insert_item(&conn, &i).unwrap();
        };
        put("1", "a", "running");
        put("2", "b", "error");
        // A finished run is nobody's inbox any more.
        let old = Run { id: "r0".into(), status: "done".into(), ..run.clone() };
        crate::team::insert_run(&conn, &old).unwrap();
        let mut stale = item("9", "a", "error");
        stale.run_id = "r0".into();
        stale.key = "9".into();
        stale.created_at = "2026-11-25T09:00:00Z".into();
        crate::team::insert_item(&conn, &stale).unwrap();

        let inboxes = list(&conn, &ws.id).unwrap();
        let names: Vec<&str> = inboxes.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, vec!["Beto", "Ana", "Caro"], "a failure waits on the user; work in hand next; the idle last");
        assert_eq!((inboxes[0].waiting, inboxes[1].working, inboxes[2].entries.len()), (1, 1, 0));
        assert_eq!(inboxes[1].teams, vec!["Pagos"]);
        assert!(inboxes[2].teams.is_empty());
        assert_eq!(caro.name, "Caro");
    }
}
