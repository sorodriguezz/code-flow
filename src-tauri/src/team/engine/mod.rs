//! The team engine: what moves a run from its goal to its delivery. See `crate::team` for the
//! model; the commands a window calls are in `crate::commands::team_cmd`, and what calls the
//! engine with nobody at a window is `crate::runner`.
//!
//! One file per step of a run's life, so each can be read on its own:
//!
//! - [`start`] — a run begins: the roster as it is now, the integration worktrees, the first item.
//! - [`claim`] — every ready item is handed out: its worktree, its task, its budget.
//! - [`brief`] — what a member is told.
//! - [`settle`] — a turn is over: `ok`, a failure, a stop, a turn that never started.
//! - [`work`] — settling a piece of work: checks (here or isolated), commit, merge, conflicts.
//! - [`review`] — notes, handoffs and a peer's verdict.
//! - [`lead`] — the lead's rounds: reading a plan, retrying one that is unusable.
//! - [`advance`] — after any change, what happens next: a gate, a round, the final checks.
//! - [`deliver`] — landing on the target branch, or a pull request.
//! - [`decide`] — the user's answers and approvals, gate by gate.
//! - [`control`] — pause, resume, abort, retry, skip, and tidying up.
//! - [`fork`] — a new run from where another was.
//! - [`lab`] — the same task for several teams, scored alike (`crate::team::lab`).
//!
//! # Locks
//!
//! Every mutation of one run takes that run's async lock, so two items of a run finishing at the same
//! moment never merge into its integration branch at once and never both decide the run is over.
//! The database lock is only ever held for short synchronous stretches — never across a git command,
//! a check or an await.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::db::{models::AgentTask, queries, Db};
use crate::team::{self, coordination, gitops, hierarchy, intelligence, protocol, Item, MemberSnap, Policy, Run, RunRepo, RunState};

mod advance;
mod brief;
mod claim;
mod control;
mod decide;
mod deliver;
mod fork;
mod lab;
mod lead;
mod review;
mod settle;
mod start;
mod work;
#[cfg(test)]
pub(crate) mod tests;

pub(crate) use advance::*;
pub(crate) use brief::*;
pub(crate) use claim::*;
pub(crate) use control::*;
pub(crate) use decide::*;
pub(crate) use deliver::*;
pub(crate) use fork::*;
pub(crate) use lab::*;
pub(crate) use lead::*;
pub(crate) use review::*;
pub(crate) use settle::*;
pub(crate) use start::*;
pub(crate) use work::*;

pub(crate) static RUN_LOCKS: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = LazyLock::new(Default::default);

pub(crate) fn run_lock(run_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut map = RUN_LOCKS.lock().unwrap_or_else(|e| e.into_inner());
    map.entry(run_id.to_string()).or_default().clone()
}

/// Where a team worktree goes — the user's worktrees folder, or a test's own temporary one.
#[cfg(test)]
pub(crate) static WORKTREE_ROOT: Mutex<Option<std::path::PathBuf>> = Mutex::new(None);

pub(crate) fn wt_dir(repo_name: &str, folder: &str) -> std::path::PathBuf {
    #[cfg(test)]
    if let Some(root) = WORKTREE_ROOT.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        return root.join(repo_name).join(folder);
    }
    crate::paths::agent_worktree_dir(repo_name, folder)
}

pub(crate) fn with<T>(db: &Db, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    f(&conn)
}

pub(crate) fn e2s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

pub(crate) fn changed(app: &AppHandle, run_id: &str) {
    let _ = app.emit("team:changed", serde_json::json!({ "runId": run_id }));
    // Whatever changed may have made something ready; the runner claims it from here, whichever
    // window — if any — asked for the change.
    crate::runner::kick(app, run_id);
}

pub(crate) fn state_of(db: &Db, run_id: &str) -> Result<RunState, String> {
    with(db, |c| team::state(c, run_id).map_err(e2s)?.ok_or_else(|| "La corrida del equipo ya no existe.".to_string()))
}

pub(crate) async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(f).await.map_err(e2s)
}

pub(crate) fn slug(text: &str, max: usize) -> String {
    let s = protocol::key_slug(text);
    let s: String = s.chars().take(max).collect();
    let s = s.trim_matches('-').to_string();
    if s.is_empty() { "equipo".into() } else { s }
}

pub(crate) fn short(id: &str) -> String {
    id.chars().filter(|c| c.is_ascii_alphanumeric()).take(6).collect()
}

pub(crate) fn trim_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let head: String = text.chars().take(max * 2 / 3).collect();
    let tail: String = text.chars().rev().take(max / 3).collect::<Vec<_>>().into_iter().rev().collect();
    format!("{head}\n[…recortado…]\n{tail}")
}

pub(crate) fn first_line(text: &str, max: usize) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    trim_chars(line, max)
}

pub(crate) fn roster(run: &Run) -> Vec<protocol::RosterEntry> {
    run.members
        .iter()
        .map(|m| protocol::RosterEntry {
            id: m.member.id.clone(),
            name: m.member.name.clone(),
            role: m.member.role.clone(),
            edits: m.member.edits,
            repos: m.member.repos.clone(),
        })
        .collect()
}

pub(crate) fn member<'a>(run: &'a Run, id: &str) -> Option<&'a MemberSnap> {
    run.members.iter().find(|m| m.member.id == id)
}

pub(crate) fn members_of(run: &Run) -> Vec<team::Member> {
    run.members.iter().map(|m| m.member.clone()).collect()
}

/// Whether a plan is what «chico» means: at most one task per repository, nothing to investigate
/// first. Not "one member": in a full-stack team a one-line change in the web and the matching one
/// in the API are two members' work and still small — requiring a single member is what turned
/// nearly every «chico» of such a team back into the full ceremony (user report, 2026-11-16).
pub(crate) fn is_small(plan: &[Item]) -> bool {
    if plan.is_empty() || plan.len() > SMALL_PLAN_ITEMS {
        return false;
    }
    let mut repos: Vec<&str> = plan.iter().map(|i| i.project_id.as_str()).collect();
    repos.sort_unstable();
    repos.dedup();
    plan.iter().all(|i| matches!(i.kind.as_str(), "work" | "delegate")) && repos.len() == plan.len()
}

/// The most tasks a «chico» plan may have — one per repository of a three-repository workspace.
pub(crate) const SMALL_PLAN_ITEMS: usize = 3;

/// Who a planner may hand work to: the lead plans for everyone, a sub-lead only for its branch.
/// A leader is in its own roster only when it is `hands_on`; an advisor is never assignable. A
/// sub-lead that does not edit is still offered as editing — what it gets is a `delegate`, which it
/// plans rather than writes.
pub(crate) fn planner_roster(run: &Run, planner: &str) -> Vec<protocol::RosterEntry> {
    let members = members_of(run);
    let scope: Vec<String> = if planner == run.lead || run.lead.is_empty() {
        members.iter().map(|m| m.id.clone()).collect()
    } else {
        hierarchy::subtree(&members, &run.lead, planner)
    };
    run.members
        .iter()
        .filter(|m| !m.member.advisor)
        .filter(|m| if m.member.id == planner { m.member.hands_on } else { scope.contains(&m.member.id) })
        .map(|m| protocol::RosterEntry {
            id: m.member.id.clone(),
            name: m.member.name.clone(),
            role: m.member.role.clone(),
            edits: m.member.edits || (m.member.leads && !m.member.hands_on && m.member.id != planner),
            repos: m.member.repos.clone(),
        })
        .collect()
}

/// Whether an item for `member` should be planned by it rather than done: a sub-lead that is not
/// hands-on, with someone under it.
pub(crate) fn delegates(run: &Run, member_id: &str, planner: &str) -> bool {
    if member_id == planner {
        return false;
    }
    let members = members_of(run);
    member(run, member_id).is_some_and(|m| m.member.leads && !m.member.hands_on) && hierarchy::is_planner(&members, &run.lead, member_id)
}

/// The team's advisor, if it has one.
pub(crate) fn advisor_of(run: &Run) -> Option<&MemberSnap> {
    run.members.iter().find(|m| m.member.advisor)
}

/// What the advisor reads instead of the whole transcript: the goal, every item in a line, and the
/// last messages. A few thousand characters, so calling it costs a fraction of a planner turn.
pub(crate) fn digest(run: &Run, items: &[Item], messages: &[team::Message], focus: &str) -> String {
    let mut out = format!("## Objetivo\n{}\n\n## Trabajo\n", run.goal);
    for i in items.iter().filter(|i| i.kind != "advise") {
        let detail = match i.status.as_str() {
            "done" => first_line(&protocol::prose(&i.output_text), 160),
            "error" => format!("falló: {}", first_line(&i.last_error, 160)),
            _ => String::new(),
        };
        out.push_str(&format!("- `{}` [{}] {} · {} · {}{}\n", i.key, i.status, i.member_name, i.kind, i.title, if detail.is_empty() { String::new() } else { format!(" — {detail}") }));
    }
    let recent: Vec<&team::Message> = messages.iter().filter(|m| m.kind != "status").rev().take(10).collect();
    if !recent.is_empty() {
        out.push_str("\n## Últimos mensajes\n");
        for m in recent.into_iter().rev() {
            out.push_str(&format!("- {} → {}: {}\n", m.from_name, m.to_name, first_line(&m.body, 200)));
        }
    }
    out.push_str(&format!("\n## Qué te piden\n{focus}\nDa como mucho tres consejos accionables, en pocas líneas. No escribas código."));
    trim_chars(&out, 7_000)
}

/// Calls the advisor in: an `advise` item, read-only. `about` is what its advice is for — `plan`,
/// `final` or the id of the item whose error repeats.
pub(crate) fn new_advice(conn: &Connection, run: &Run, about: &str, focus: &str) -> Result<Option<Item>, String> {
    let Some(adv) = advisor_of(run) else { return Ok(None) };
    let items = team::list_items(conn, &run.id).map_err(e2s)?;
    let messages = team::list_messages(conn, &run.id).map_err(e2s)?;
    let first_repo = team::list_repos(conn, &run.id).map_err(e2s)?.first().map(|r| r.project_id.clone()).unwrap_or_default();
    let key = team::free_key(&items, "asesor");
    let title = match about {
        "plan" => "El asesor revisa el plan".to_string(),
        "final" => "El asesor revisa antes de terminar".to_string(),
        _ => "El asesor mira un error que se repite".to_string(),
    };
    let mut item = team::new_item(run, &key, Some(adv), &first_repo, "advise", &title, &digest(run, &items, &messages, focus));
    item.ref_item = about.to_string();
    item.run_in = "headless".into();
    team::insert_item(conn, &item).map_err(e2s)?;
    Ok(Some(item))
}

/// The manager a member answers to, as a snapshot — `None` for the lead and for a fixed plan.
pub(crate) fn manager_of<'a>(run: &'a Run, member_id: &str) -> Option<&'a MemberSnap> {
    let members = members_of(run);
    let boss = hierarchy::manager(&members, &run.lead, member_id)?.to_string();
    member(run, &boss)
}

pub(crate) fn lead_name(run: &Run) -> String {
    member(run, &run.lead).map(|m| m.member.name.clone()).unwrap_or_else(|| "Líder".into())
}

/// What `team_run_state` answers for a run that no longer exists.
pub const RUN_GONE: &str = "team.run-gone";
