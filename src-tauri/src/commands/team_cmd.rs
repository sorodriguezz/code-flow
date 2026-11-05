//! Tauri commands for «Equipo» — see `crate::team` for the model and `.claude/plans/agent-team.md`.
//!
//! The engine lives here: starting a run (integration worktrees), handing out every ready item
//! ([`team_claim`]), settling one ([`team_settle`]: notes, checks, commit, review, merge, conflicts),
//! the lead's rounds, the user's answers and approvals, and landing the work on the target branch.
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
use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::{models::AgentTask, queries, Db};
use crate::team::{self, gitops, hierarchy, protocol, Item, MemberSnap, Policy, Run, RunRepo, RunState};

static RUN_LOCKS: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = LazyLock::new(Default::default);

fn run_lock(run_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    let mut map = RUN_LOCKS.lock().unwrap_or_else(|e| e.into_inner());
    map.entry(run_id.to_string()).or_default().clone()
}

/// Where a team worktree goes — the user's worktrees folder, or a test's own temporary one.
#[cfg(test)]
static WORKTREE_ROOT: Mutex<Option<std::path::PathBuf>> = Mutex::new(None);

fn wt_dir(repo_name: &str, folder: &str) -> std::path::PathBuf {
    #[cfg(test)]
    if let Some(root) = WORKTREE_ROOT.lock().unwrap_or_else(|e| e.into_inner()).clone() {
        return root.join(repo_name).join(folder);
    }
    crate::paths::agent_worktree_dir(repo_name, folder)
}

fn with<T>(db: &Db, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    f(&conn)
}

fn e2s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn changed(app: &AppHandle, run_id: &str) {
    let _ = app.emit("team:changed", serde_json::json!({ "runId": run_id }));
    // Whatever changed may have made something ready; the runner claims it from here, whichever
    // window — if any — asked for the change.
    crate::runner::kick(app, run_id);
}

/// Moves a run from any window: the runner claims what is ready. What `teamStore.pump` calls now.
#[tauri::command]
pub fn team_pump(app: AppHandle, run_id: String) {
    crate::runner::kick(&app, &run_id);
}

fn state_of(db: &Db, run_id: &str) -> Result<RunState, String> {
    with(db, |c| team::state(c, run_id).map_err(e2s)?.ok_or_else(|| "La corrida del equipo ya no existe.".to_string()))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(f).await.map_err(e2s)
}

fn slug(text: &str, max: usize) -> String {
    let s = protocol::key_slug(text);
    let s: String = s.chars().take(max).collect();
    let s = s.trim_matches('-').to_string();
    if s.is_empty() { "equipo".into() } else { s }
}

fn short(id: &str) -> String {
    id.chars().filter(|c| c.is_ascii_alphanumeric()).take(6).collect()
}

fn trim_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let head: String = text.chars().take(max * 2 / 3).collect();
    let tail: String = text.chars().rev().take(max / 3).collect::<Vec<_>>().into_iter().rev().collect();
    format!("{head}\n[…recortado…]\n{tail}")
}

fn first_line(text: &str, max: usize) -> String {
    let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    trim_chars(line, max)
}

fn roster(run: &Run) -> Vec<protocol::RosterEntry> {
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

fn member<'a>(run: &'a Run, id: &str) -> Option<&'a MemberSnap> {
    run.members.iter().find(|m| m.member.id == id)
}

fn members_of(run: &Run) -> Vec<team::Member> {
    run.members.iter().map(|m| m.member.clone()).collect()
}

/// Whether a plan is what «chico» means: one member — the one who does it, or the sub-lead of its
/// area — at most one task per repository, nothing to investigate first.
fn is_small(plan: &[Item]) -> bool {
    let Some(first) = plan.first() else { return false };
    let mut repos: Vec<&str> = plan.iter().map(|i| i.project_id.as_str()).collect();
    repos.sort_unstable();
    repos.dedup();
    plan.iter().all(|i| i.member_id == first.member_id && matches!(i.kind.as_str(), "work" | "delegate")) && repos.len() == plan.len()
}

/// Who a planner may hand work to: the lead plans for everyone, a sub-lead only for its branch.
/// A leader is in its own roster only when it is `hands_on`; an advisor is never assignable. A
/// sub-lead that does not edit is still offered as editing — what it gets is a `delegate`, which it
/// plans rather than writes.
fn planner_roster(run: &Run, planner: &str) -> Vec<protocol::RosterEntry> {
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
fn delegates(run: &Run, member_id: &str, planner: &str) -> bool {
    if member_id == planner {
        return false;
    }
    let members = members_of(run);
    member(run, member_id).is_some_and(|m| m.member.leads && !m.member.hands_on) && hierarchy::is_planner(&members, &run.lead, member_id)
}

/// The team's advisor, if it has one.
fn advisor_of(run: &Run) -> Option<&MemberSnap> {
    run.members.iter().find(|m| m.member.advisor)
}

/// What the advisor reads instead of the whole transcript: the goal, every item in a line, and the
/// last messages. A few thousand characters, so calling it costs a fraction of a planner turn.
fn digest(run: &Run, items: &[Item], messages: &[team::Message], focus: &str) -> String {
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
fn new_advice(conn: &Connection, run: &Run, about: &str, focus: &str) -> Result<Option<Item>, String> {
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
fn manager_of<'a>(run: &'a Run, member_id: &str) -> Option<&'a MemberSnap> {
    let members = members_of(run);
    let boss = hierarchy::manager(&members, &run.lead, member_id)?.to_string();
    member(run, &boss)
}

fn lead_name(run: &Run) -> String {
    member(run, &run.lead).map(|m| m.member.name.clone()).unwrap_or_else(|| "Líder".into())
}

// ---------------------------------------------------------------- teams

#[tauri::command]
pub fn team_list(db: State<'_, Db>, workspace_id: String) -> Result<Vec<team::Team>, String> {
    with(&db, |c| team::list_teams(c, &workspace_id).map_err(e2s))
}

#[tauri::command]
pub fn team_save(db: State<'_, Db>, team: team::Team) -> Result<team::Team, String> {
    with(&db, |c| team::save_team(c, team))
}

#[tauri::command]
pub fn team_delete(db: State<'_, Db>, id: String) -> Result<(), String> {
    with(&db, |c| team::delete_team(c, &id).map_err(e2s))
}

#[tauri::command]
pub fn team_runs(db: State<'_, Db>, workspace_id: String) -> Result<Vec<Run>, String> {
    with(&db, |c| team::list_runs(c, &workspace_id).map_err(e2s))
}

#[tauri::command]
pub fn team_run_state(db: State<'_, Db>, run_id: String) -> Result<RunState, String> {
    state_of(&db, &run_id)
}

#[tauri::command]
pub fn team_run_meta(db: State<'_, Db>, run_id: String, title: Option<String>, pinned: Option<bool>, agent_project_id: Option<String>) -> Result<(), String> {
    with(&db, |c| team::set_run_meta(c, &run_id, title.as_deref(), pinned, agent_project_id.as_deref()).map_err(e2s))
}

// ---------------------------------------------------------------- start

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoPick {
    pub project_id: String,
    /// `""` is the branch the repository has checked out now.
    #[serde(default)]
    pub target_branch: String,
}

/// Starts a run: copies the roster and the policy, makes one integration worktree per repository
/// off its target branch, and seeds the graph — the lead's first plan, or the team's fixed plan.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn team_start(
    app: AppHandle,
    db: State<'_, Db>,
    workspace_id: String,
    team_id: String,
    goal: String,
    title: Option<String>,
    repos: Vec<RepoPick>,
    policy: Option<Policy>,
    agent_project_id: Option<String>,
) -> Result<RunState, String> {
    let state = start_run(&db, workspace_id, team_id, goal, title, repos, policy, agent_project_id).await?;
    changed(&app, &state.run.id);
    Ok(state)
}

#[allow(clippy::too_many_arguments)]
pub async fn start_run(
    db: &Db,
    workspace_id: String,
    team_id: String,
    goal: String,
    title: Option<String>,
    repos: Vec<RepoPick>,
    policy: Option<Policy>,
    agent_project_id: Option<String>,
) -> Result<RunState, String> {
    let goal = goal.trim().to_string();
    if goal.is_empty() {
        return Err("Dile al equipo qué tiene que hacer.".into());
    }
    if repos.is_empty() {
        return Err("Elige al menos un repositorio.".into());
    }
    if repos.len() > team::MAX_REPOS {
        return Err(format!("Una tarea de equipo abarca como máximo {} repositorios.", team::MAX_REPOS));
    }
    let (tm, agents, projects) = with(&db, |c| {
        let tm = team::get_team(c, &team_id).map_err(e2s)?.ok_or("El equipo ya no existe.")?;
        let agents = queries::list_workspace_agents(c, &workspace_id).map_err(e2s)?;
        let mut projects = Vec::new();
        for pick in &repos {
            let p = queries::get_project(c, &pick.project_id).map_err(e2s)?.ok_or("Un repositorio elegido ya no existe.")?;
            projects.push((p, pick.target_branch.trim().to_string()));
        }
        Ok((tm, agents, projects))
    })?;
    team::runnable(&tm)?;

    // The roster as it is now, so editing an agent mid-run never reroutes work already planned.
    let mut members = Vec::new();
    for m in &tm.members {
        let Some(agent) = agents.iter().find(|a| a.id == m.agent_id) else {
            return Err(format!("El agente de «{}» ya no está en el roster.", if m.name.is_empty() { "un miembro" } else { &m.name }));
        };
        if agent.provider.trim().is_empty() || agent.model.trim().is_empty() {
            return Err(format!("«{}» no tiene proveedor y modelo: complétalo en Agentes.", agent.name));
        }
        let mut member = m.clone();
        if member.name.trim().is_empty() {
            member.name = agent.name.clone();
        }
        if member.role.trim().is_empty() {
            member.role = agent.role.clone();
        }
        members.push(MemberSnap {
            member,
            provider: agent.provider.clone(),
            model: agent.model.clone(),
            effort: agent.effort.clone(),
            prompt: agent.prompt.clone(),
            account_id: agent.account_id.clone(),
        });
    }

    let run_id = uuid::Uuid::new_v4().to_string();
    let shown_title = title.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).unwrap_or_else(|| first_line(&goal, 64));
    let run_slug = format!("{}-{}", slug(&shown_title, 28), short(&run_id));
    let integration_branch = format!("codeflow/team-{run_slug}");

    // Integration worktrees, outside every lock. One that fails undoes the ones already made.
    let mut made: Vec<RunRepo> = Vec::new();
    for (position, (project, target)) in projects.iter().enumerate() {
        let repo_path = project.local_path.clone();
        let target = if target.is_empty() {
            let p = repo_path.clone();
            blocking(move || gitops::current_branch(&p)).await?.ok_or_else(|| format!("{} no tiene commits todavía o no está en ninguna rama: haz un primer commit o elige la rama destino.", project.name))?
        } else {
            target.clone()
        };
        let path = wt_dir(&project.name, &format!("team-{run_slug}")).to_string_lossy().into_owned();
        let (r, p, b, t) = (repo_path.clone(), path.clone(), integration_branch.clone(), target.clone());
        let result = blocking(move || {
            if !gitops::branch_exists(&r, &t) {
                if gitops::head_sha(&r).is_err() {
                    return Err(format!("todavía no tiene commits: haz un primer commit en «{t}» y vuelve a lanzar"));
                }
                return Err(format!("la rama «{t}» no existe"));
            }
            // The team integrates into its target at the end: a branch locked against merges is
            // not one it may deliver to.
            if crate::git::branch::guard_branch_unlocked_at(&r, &t).is_err() {
                return Err(format!("la rama «{t}» está bloqueada: elige otra rama destino o desbloquéala"));
            }
            gitops::add_worktree(&r, &p, &b, &t)
        })
        .await?;
        if let Err(e) = result {
            for done in &made {
                let (r, p) = (done.local_path.clone(), done.integration_path.clone());
                let _ = blocking(move || gitops::remove_worktree(&r, &p)).await;
            }
            return Err(format!("{}: {e}", project.name));
        }
        made.push(RunRepo {
            run_id: run_id.clone(),
            project_id: project.id.clone(),
            name: project.name.clone(),
            local_path: repo_path,
            target_branch: target,
            integration_branch: integration_branch.clone(),
            integration_path: path,
            status: "ready".into(),
            last_error: String::new(),
            position: position as i64,
        });
    }

    let stamp = queries::now();
    let run = Run {
        id: run_id.clone(),
        workspace_id: workspace_id.clone(),
        team_id: tm.id.clone(),
        team_name: tm.name.clone(),
        title: shown_title,
        goal: goal.clone(),
        status: "running".into(),
        lead: tm.lead.clone(),
        agent_project_id: agent_project_id.unwrap_or_default(),
        created_at: stamp.clone(),
        updated_at: stamp,
        policy: policy.unwrap_or_else(|| tm.policy.clone()).sane(),
        members,
        ..Default::default()
    };
    with(&db, |c| {
        let tx = c.unchecked_transaction().map_err(e2s)?;
        team::insert_run(&tx, &run).map_err(e2s)?;
        for repo in &made {
            team::insert_repo(&tx, repo).map_err(e2s)?;
        }
        team::post(&tx, &run.id, "", ("user", "Tú"), ("all", "Equipo"), "plan", &goal, &[]).map_err(e2s)?;
        if run.lead.is_empty() {
            seed_fixed_plan(&tx, &run, &tm.plan, &made)?;
        } else {
            new_lead_item(&tx, &run, "plan", &goal, "")?;
        }
        tx.commit().map_err(e2s)
    })?;
    state_of(db, &run_id)
}

/// The team's own plan, expanded: a step on `"*"` becomes one item per repository, and a dependency
/// on such a step waits for all of them.
fn seed_fixed_plan(conn: &Connection, run: &Run, plan: &[team::PlanStep], repos: &[RunRepo]) -> Result<(), String> {
    let mut by_key: HashMap<String, Vec<String>> = HashMap::new();
    let mut made: Vec<(Item, Vec<String>)> = Vec::new();
    for (at, step) in plan.iter().enumerate() {
        let Some(m) = member(run, &step.member) else { continue };
        let targets: Vec<&RunRepo> = match step.repo.as_str() {
            "*" => repos.iter().filter(|r| m.member.repos.is_empty() || m.member.repos.contains(&r.project_id)).collect(),
            "" => repos.first().into_iter().collect(),
            id => repos.iter().filter(|r| r.project_id == id).collect(),
        };
        let base = {
            let k = protocol::key_slug(&step.key);
            if k.is_empty() { format!("p{}", at + 1) } else { k }
        };
        let kind = if step.kind == "investigate" || !m.member.edits { "investigate" } else { "work" };
        for repo in targets {
            let existing: Vec<Item> = made.iter().map(|(i, _)| i.clone()).collect();
            let key = team::free_key(&existing, &if repos.len() > 1 && step.repo == "*" { format!("{base}-{}", slug(&repo.name, 10)) } else { base.clone() });
            let title = if step.title.trim().is_empty() { first_line(&step.instruction, 60) } else { step.title.clone() };
            let item = team::new_item(run, &key, Some(m), &repo.project_id, kind, &title, &step.instruction);
            by_key.entry(protocol::key_slug(&step.key)).or_default().push(item.id.clone());
            made.push((item, step.depends_on.iter().map(|d| protocol::key_slug(d)).collect()));
        }
    }
    for (mut item, deps) in made {
        item.depends_on = deps.iter().flat_map(|d| by_key.get(d).cloned().unwrap_or_default()).filter(|d| d != &item.id).collect();
        team::insert_item(conn, &item).map_err(e2s)?;
    }
    Ok(())
}

/// A new lead turn, inside the budget. `None` (and the run gated) once the rounds are spent.
/// A planning turn for any planner: the lead (see [`new_lead_item`]) or a sub-lead, whose rounds are
/// counted on its own items against `sub_lead_rounds`. `parent` is the delegate it plans under.
fn new_planner_item(conn: &Connection, run: &Run, planner: &str, kind: &str, instruction: &str, feedback: &str, parent: &str) -> Result<Option<Item>, String> {
    if planner == run.lead {
        return new_lead_item(conn, run, kind, instruction, feedback);
    }
    let Some(m) = member(run, planner) else { return Ok(None) };
    let items = team::list_items(conn, &run.id).map_err(e2s)?;
    let used = items.iter().filter(|i| i.member_id == planner && matches!(i.kind.as_str(), "delegate" | "answer")).count() as i64;
    if used >= run.policy.sub_lead_rounds {
        team::post(conn, &run.id, "", ("system", "CodeFlow"), ("lead", &lead_name(run)), "error", &format!("{} agotó sus rondas de planificación.", m.member.name), &[])
            .map_err(e2s)?;
        return Ok(None);
    }
    let first_repo = team::list_repos(conn, &run.id).map_err(e2s)?.first().map(|r| r.project_id.clone()).unwrap_or_default();
    let slug = protocol::key_slug(&m.member.name);
    let key = team::free_key(&items, &format!("{}-{}", if slug.is_empty() { "sub" } else { &slug }, if kind == "answer" { "respuesta" } else { "plan" }));
    let title = if kind == "answer" { format!("{} responde", m.member.name) } else { format!("{} replanifica", m.member.name) };
    let mut item = team::new_item(run, &key, Some(m), &first_repo, kind, &title, instruction);
    item.feedback = feedback.to_string();
    item.parent = parent.to_string();
    item.run_in = "headless".into();
    team::insert_item(conn, &item).map_err(e2s)?;
    Ok(Some(item))
}

fn new_lead_item(conn: &Connection, run: &Run, kind: &str, instruction: &str, feedback: &str) -> Result<Option<Item>, String> {
    let current = team::get_run(conn, &run.id).map_err(e2s)?.unwrap_or_else(|| run.clone());
    if current.lead_rounds_used >= current.policy.lead_rounds {
        team::set_run_status(conn, &run.id, "gated", "stuck:", "El líder agotó sus rondas. Continúa a mano o aumenta el presupuesto.").map_err(e2s)?;
        return Ok(None);
    }
    let Some(lead) = member(run, &run.lead) else { return Ok(None) };
    let items = team::list_items(conn, &run.id).map_err(e2s)?;
    let first_repo = team::list_repos(conn, &run.id).map_err(e2s)?.first().map(|r| r.project_id.clone()).unwrap_or_default();
    let key = team::free_key(&items, match kind {
        "final" => "revision-final",
        "answer" => "respuesta",
        _ => "plan",
    });
    let title = match kind {
        "final" => "Última revisión del líder".to_string(),
        "answer" => "El líder responde".to_string(),
        _ if current.lead_rounds_used == 0 => "Plan".to_string(),
        _ => "Replanificar".to_string(),
    };
    let mut item = team::new_item(run, &key, Some(lead), &first_repo, kind, &title, instruction);
    item.feedback = feedback.to_string();
    item.round = current.lead_rounds_used + 1;
    // The lead is always a background turn: it only plans, and its answer is read by the app.
    item.run_in = "headless".into();
    team::insert_item(conn, &item).map_err(e2s)?;
    team::bump_lead_round(conn, &run.id).map_err(e2s)?;
    Ok(Some(item))
}

// ---------------------------------------------------------------- claim

/// One item handed to the frontend to run.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dispatch {
    pub item: Item,
    /// The task it runs as — `None` for an item run in a terminal.
    pub task: Option<AgentTask>,
    pub message: String,
    pub cwd: String,
    pub run_in: String,
    pub provider: String,
    pub model: String,
    pub effort: String,
    pub title: String,
}

/// Marks every item that may start now as running and returns what to run. Items that need the
/// user's approval first park the run on a gate instead.
#[tauri::command]
// No `team:changed` here: the caller refreshes itself, and the event is what makes other listeners
// claim — announcing a claim would have every claim start another.
pub async fn team_claim(db: State<'_, Db>, run_id: String) -> Result<Vec<Dispatch>, String> {
    claim_run(&db, &run_id, None).await
}

/// [`claim_limited`] under the run's lock, taking at most `limit` items — what the runner calls with the
/// governor's free slots, so an item is only marked running when it can start.
pub async fn claim_run(db: &Db, run_id: &str, limit: Option<usize>) -> Result<Vec<Dispatch>, String> {
    let lock = run_lock(run_id);
    let _guard = lock.lock().await;
    claim_limited(db, run_id, limit).await
}

/// Where a run keeps the plan windows it started from, per account key.
fn session_base_key(run_id: &str) -> String {
    format!("team_session_base:{run_id}")
}

/// The shortest plan window of every engine account the run's members use that publishes one —
/// Claude, Codex, Gemini, opencode: `(account key, used %, resets at)`.
///
/// Claude's comes from what its own runs report (no keychain read — the members are running it
/// anyway); the others through `ai_quota`'s cache, which reads at most once a minute (Gemini's CLI
/// once per half hour, behind the answer). An engine with no window is left to [`unmetered_over`].
async fn plan_windows(db: &Db, run_id: &str) -> Vec<(String, f64, String)> {
    let engines = with(db, |c| {
        let Some(run) = team::get_run(c, run_id).map_err(e2s)? else { return Ok(Vec::new()) };
        let mut seen: Vec<String> = Vec::new();
        let mut out = Vec::new();
        for m in &run.members {
            if !crate::ai_quota::QUOTA_PROVIDERS.contains(&m.provider.as_str()) {
                continue;
            }
            let key = m.account_id.as_ref().map(|id| format!("{}|{id}", m.provider)).unwrap_or_else(|| m.provider.clone());
            if seen.contains(&key) {
                continue;
            }
            seen.push(key.clone());
            if m.provider == "claude" {
                out.push((key, None));
                continue;
            }
            let configured = queries::get_setting(c, &format!("{}_binary_path", m.provider)).ok().flatten().filter(|p| !p.trim().is_empty());
            let binary = configured.unwrap_or_else(|| crate::ai::engine_for(&m.provider).default_binary().to_string());
            let Some(binary) = crate::ai::find_on_path(&binary) else { continue };
            let account = m.account_id.as_ref().filter(|_| crate::ai_accounts::supports_accounts(&m.provider)).map(|id| crate::ai_accounts::AccountEnv::for_account(&m.provider, id));
            out.push((key, Some(crate::ai_quota::QuotaEngine { provider: m.provider.clone(), account, binary })));
        }
        Ok(out)
    })
    .unwrap_or_default();
    let mut windows = Vec::new();
    for (key, engine) in engines {
        match engine {
            None => {
                if let Some((limit, _)) = crate::claude::last_rate_limit(&key) {
                    if limit.five_hour_resets_at > 0 {
                        windows.push((key, limit.five_hour_pct, limit.five_hour_resets_at.to_string()));
                    }
                }
            }
            Some(engine) => {
                let quota = crate::ai_quota::fetch(engine, crate::ai_quota::Trigger::Open).await;
                // The session-like window when there is one: the week moves too slowly to stop a run.
                let pick = quota.limits.iter().find(|l| l.kind == "session").or_else(|| quota.limits.first());
                if let Some(limit) = pick {
                    windows.push((key, limit.used_percent, limit.resets_at.clone()));
                }
            }
        }
    }
    windows
}

/// Members on an engine that publishes no plan window (Grok, Cline, a custom command) have no
/// percentage to watch, so their agent-minutes are the measure. The local model costs nothing and
/// is left out.
fn unmetered_over(run: &Run, items: &[Item]) -> Option<String> {
    let cap = run.policy.unmetered_minutes;
    if cap <= 0 {
        return None;
    }
    let unmetered: Vec<&str> = run
        .members
        .iter()
        .filter(|m| !crate::ai_quota::QUOTA_PROVIDERS.contains(&m.provider.as_str()) && m.provider != crate::local_agent::PROVIDER_ID)
        .map(|m| m.member.id.as_str())
        .collect();
    if unmetered.is_empty() {
        return None;
    }
    let mine: Vec<Item> = items.iter().filter(|i| unmetered.contains(&i.member_id.as_str())).cloned().collect();
    let minutes = team::metrics::agent_minutes(&mine, chrono::Utc::now());
    (minutes >= cap as f64).then(|| {
        format!("Los agentes sin medidor de cuota (Grok, Cline…) ya llevan {} minutos de trabajo (tope {cap}). Aprueba para darles otros {cap} o detén la tarea.", minutes.round())
    })
}

/// How much of a plan window the run has used since it started, in points of the window.
///
/// A window counts as rolled over only when its use went *down* and its reset moved at least half an
/// hour later — then it is what was left of the old one plus the new one's use. Anything else is the
/// same window: some engines report the reset instant a little differently on every read (Codex),
/// and taking that jitter for a rollover once charged a run 100% of a plan it had barely touched.
fn session_used(base: (f64, &str), now: (f64, &str)) -> f64 {
    let instant = |text: &str| -> Option<i64> {
        text.parse::<i64>().ok().or_else(|| chrono::DateTime::parse_from_rfc3339(text).ok().map(|d| d.timestamp()))
    };
    let rolled = now.0 < base.0 && matches!((instant(base.1), instant(now.1)), (Some(b), Some(n)) if n - b >= 1800);
    if rolled {
        (100.0 - base.0).max(0.0) + now.0
    } else {
        (now.0 - base.0).max(0.0)
    }
}

/// `Some(note)` when the run has used more of a member account's session than its policy allows.
/// The first reading of an account becomes its baseline.
fn session_over(c: &Connection, run: &Run, windows: &[(String, f64, String)]) -> Result<Option<String>, String> {
    if run.policy.max_session_pct <= 0 || windows.is_empty() {
        return Ok(None);
    }
    let key = session_base_key(&run.id);
    let mut base: std::collections::BTreeMap<String, (f64, String)> =
        queries::get_setting(c, &key).map_err(e2s)?.and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default();
    let mut changed = false;
    let mut worst = 0.0_f64;
    let mut who = String::new();
    for (account, pct, resets) in windows {
        match base.get(account) {
            Some(start) => {
                let used = session_used((start.0, &start.1), (*pct, resets));
                if used > worst {
                    worst = used;
                    who = account.split('|').next().unwrap_or(account).to_string();
                }
            }
            None => {
                base.insert(account.clone(), (*pct, resets.clone()));
                changed = true;
            }
        }
    }
    if changed {
        queries::set_setting(c, &key, &serde_json::to_string(&base).map_err(e2s)?).map_err(e2s)?;
    }
    let cap = run.policy.max_session_pct as f64;
    Ok((worst >= cap).then(|| {
        format!("Esta tarea ya usó ~{worst:.0}% de tu plan de {} (tope {cap:.0}% por tarea). Lo que corre termina; aprueba para darle otro {cap:.0}% o detenla.", engine_name(&who))
    }))
}

fn engine_name(provider: &str) -> &str {
    match provider {
        "claude" => "Claude",
        "codex" => "Codex",
        "gemini" => "Gemini",
        "opencode" => "opencode",
        other => other,
    }
}

struct Picked {
    item: Item,
    repo: RunRepo,
}

#[cfg(test)]
pub async fn claim(db: &Db, run_id: &str) -> Result<Vec<Dispatch>, String> {
    claim_limited(db, run_id, None).await
}

async fn claim_limited(db: &Db, run_id: &str, limit: Option<usize>) -> Result<Vec<Dispatch>, String> {
    // The plan windows, read before the lock: the fallback reads a setting through the same handle.
    let windows = plan_windows(db, run_id).await;
    // 1. Decide, under the database lock.
    let (run, picked) = with(db, |c| {
        let Some(run) = team::get_run(c, run_id).map_err(e2s)? else { return Ok((None, Vec::new())) };
        if run.status != "running" {
            return Ok((Some(run), Vec::new()));
        }
        let items = team::list_items(c, run_id).map_err(e2s)?;
        let repos = team::list_repos(c, run_id).map_err(e2s)?;
        // Budgets: past any of them nothing new starts; what runs finishes.
        let spend = team::metrics::spend(c, run_id).map_err(e2s)?;
        let (usd, tokens) = spend.values().fold((0.0, 0i64), |(u, t), (du, dt)| (u + du, t + dt));
        let minutes = team::metrics::agent_minutes(&items, chrono::Utc::now());
        if let Some(note) = team::metrics::over_budget(&run, usd, tokens, minutes).or(session_over(c, &run, &windows)?).or_else(|| unmetered_over(&run, &items)) {
            if team::ready_items(&run, &items).first().is_some() {
                team::set_run_status(c, run_id, "gated", "budget", &note).map_err(e2s)?;
            }
            return Ok((Some(run), Vec::new()));
        }
        let ready: Vec<Item> = team::ready_items(&run, &items).into_iter().take(limit.unwrap_or(usize::MAX)).cloned().collect();
        let mut picked = Vec::new();
        let mut dispatches = run.dispatches;
        for mut item in ready {
            if team::needs_code_approval(&run, &item, &items) {
                item.status = "gated".into();
                team::update_item(c, &item).map_err(e2s)?;
                team::set_run_status(c, run_id, "gated", &format!("item:{}", item.id), &format!("«{}» quiere empezar a escribir código.", item.title)).map_err(e2s)?;
                break;
            }
            if dispatches >= run.policy.max_dispatches {
                team::set_run_status(c, run_id, "gated", "stuck:", "Se agotó el presupuesto de ejecuciones de esta tarea.").map_err(e2s)?;
                break;
            }
            let Some(repo) = repos.iter().find(|r| r.project_id == item.project_id).cloned() else {
                item.status = "error".into();
                item.last_error = "su repositorio ya no está en la tarea".into();
                team::update_item(c, &item).map_err(e2s)?;
                continue;
            };
            dispatches += 1;
            item.status = "running".into();
            item.attempts += 1;
            item.started_at = queries::now();
            team::update_item(c, &item).map_err(e2s)?;
            picked.push(Picked { item, repo });
        }
        c.execute("UPDATE agent_team_runs SET dispatches = ?2, updated_at = ?3 WHERE id = ?1", rusqlite::params![run_id, dispatches, queries::now()])
            .map_err(e2s)?;
        Ok((Some(run), picked))
    })?;
    let Some(run) = run else { return Ok(Vec::new()) };

    // 2. Worktrees for new work, with no lock held.
    let mut ready: Vec<Picked> = Vec::new();
    for mut p in picked {
        if p.item.kind == "work" && p.item.worktree_path.is_empty() {
            let run_slug = p.repo.integration_branch.trim_start_matches("codeflow/team-").to_string();
            let branch = format!("codeflow/team-{run_slug}-{}", p.item.key);
            let path = wt_dir(&p.repo.name, &format!("team-{run_slug}-{}", p.item.key)).to_string_lossy().into_owned();
            let (r, t, b, s) = (p.repo.local_path.clone(), path.clone(), branch.clone(), p.repo.integration_branch.clone());
            match blocking(move || gitops::add_worktree(&r, &t, &b, &s)).await? {
                Ok(()) => {
                    p.item.worktree_path = path;
                    p.item.branch = branch;
                }
                Err(e) => {
                    p.item.status = "pending".into();
                    p.item.last_error = format!("no se pudo crear su carpeta: {e}");
                    with(db, |c| team::update_item(c, &p.item).map_err(e2s))?;
                    continue;
                }
            }
        }
        ready.push(p);
    }

    // 3. Tasks and messages, under the lock again.
    with(db, |c| {
        let items = team::list_items(c, run_id).map_err(e2s)?;
        let repos = team::list_repos(c, run_id).map_err(e2s)?;
        let messages = team::list_messages(c, run_id).map_err(e2s)?;
        let mut out = Vec::new();
        for Picked { mut item, repo } in ready {
            let Some(m) = member(&run, &item.member_id).cloned() else {
                item.status = "error".into();
                item.last_error = "su miembro ya no está en el equipo".into();
                team::update_item(c, &item).map_err(e2s)?;
                continue;
            };
            let cwd = cwd_of(&item, &items, &repo);
            team::artifacts::mirror_into(run_id, std::slice::from_ref(&cwd));
            let (message, delivered) = compose(&run, &repos, &items, &messages, &item, &m, &cwd);
            team::mark_delivered(c, &delivered).map_err(e2s)?;
            let task = if item.run_in == "terminal" {
                None
            } else {
                Some(task_for(c, &run, &mut item, &items, &m, &cwd)?)
            };
            team::update_item(c, &item).map_err(e2s)?;
            team::post(c, run_id, &item.id, (&m.member.id, &m.member.name), ("all", "Equipo"), "status", &format!("empezó «{}»", item.title), &[])
                .map_err(e2s)?;
            out.push(Dispatch {
                title: format!("{} · {}", m.member.name, item.title),
                provider: m.provider.clone(),
                model: if item.model.is_empty() { m.model.clone() } else { item.model.clone() },
                effort: m.effort.clone(),
                run_in: item.run_in.clone(),
                cwd,
                message,
                task,
                item,
            });
        }
        Ok(out)
    })
}

/// Where an item runs: its own worktree for work and conflict resolution, the reviewed work's for a
/// review, and the repository's integration tree for everything that only reads.
fn cwd_of(item: &Item, items: &[Item], repo: &RunRepo) -> String {
    match item.kind.as_str() {
        "work" | "integrate" if !item.worktree_path.is_empty() => item.worktree_path.clone(),
        "review" => items.iter().find(|i| i.id == item.ref_item).map(|i| i.worktree_path.clone()).filter(|p| !p.is_empty()).unwrap_or_else(|| repo.integration_path.clone()),
        _ => repo.integration_path.clone(),
    }
}

/// The task an item runs as: the work it continues (a fix after review), the lead's single
/// conversation, or a new one in the item's folder.
fn task_for(conn: &Connection, run: &Run, item: &mut Item, items: &[Item], m: &MemberSnap, cwd: &str) -> Result<AgentTask, String> {
    if !item.task_id.is_empty() {
        if let Some(task) = queries::get_agent_task(conn, &item.task_id).map_err(e2s)? {
            return Ok(task);
        }
    }
    // Each planner keeps one conversation of its own: the lead's, and each sub-lead's for its branch.
    let reuse = if item.is_lead() {
        items.iter().filter(|i| i.is_lead() && i.member_id == item.member_id && !i.task_id.is_empty()).map(|i| i.task_id.clone()).last()
    } else if item.kind == "review" {
        // The same reviewer looking at the same branch again keeps its conversation: it remembers
        // what it already raised.
        let branch = items.iter().find(|i| i.id == item.ref_item).map(|i| i.branch.clone()).unwrap_or_default();
        items
            .iter()
            .filter(|i| i.kind == "review" && i.member_id == item.member_id && !i.task_id.is_empty())
            .filter(|i| items.iter().find(|w| w.id == i.ref_item).is_some_and(|w| w.branch == branch))
            .map(|i| i.task_id.clone())
            .last()
    } else {
        None
    };
    if let Some(task_id) = reuse {
        if let Some(task) = queries::get_agent_task(conn, &task_id).map_err(e2s)? {
            item.task_id = task.id.clone();
            return Ok(task);
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let task = queries::create_agent_task_with_id(
        conn,
        &id,
        &run.workspace_id,
        &item.project_id,
        &m.member.agent_id,
        &m.member.name,
        &m.provider,
        &m.model,
        &m.prompt,
        &item.title,
        &format!("{} · {}", run.title, item.title),
        &run.agent_project_id,
        m.account_id.as_deref(),
        (cwd, if item.kind == "work" { &item.branch } else { "" }),
        &format!("{}{}", team::TASK_BATCH_PREFIX, run.id),
    )
    .map_err(e2s)?;
    item.task_id = task.id.clone();
    Ok(task)
}

/// The message an item starts with.
fn compose(run: &Run, repos: &[RunRepo], items: &[Item], messages: &[team::Message], item: &Item, m: &MemberSnap, cwd: &str) -> (String, Vec<String>) {
    let mut out = String::new();
    let mut delivered = Vec::new();
    let repo = repos.iter().find(|r| r.project_id == item.project_id);
    out.push_str(&format!("# Equipo «{}»\n\n## Objetivo del equipo\n{}\n\n", run.team_name, run.goal));
    out.push_str(&format!("Eres **{}**{}.\n\n", m.member.name, if m.member.role.trim().is_empty() { String::new() } else { format!(" — {}", m.member.role.trim()) }));

    let inbox: Vec<&team::Message> = messages
        .iter()
        .filter(|msg| !msg.delivered && msg.from_id != m.member.id)
        .filter(|msg| msg.to_id == m.member.id || msg.to_id == "all" || (item.is_lead() && msg.to_id == "lead" && m.member.id == run.lead))
        .filter(|msg| matches!(msg.kind.as_str(), "note" | "finding" | "decision" | "answer") || msg.from_id == "user")
        .collect();

    if item.is_lead() {
        let scope: Vec<String> = planner_roster(run, &item.member_id).into_iter().map(|r| r.id).collect();
        if item.member_id != run.lead {
            out.push_str("Planificas tu propia rama del equipo: reparte solo entre quienes están abajo. Cuando todo lo que delegaste termine, te toca revisar y cerrar.\n\n");
        }
        out.push_str("## El equipo\n");
        for mm in &run.members {
            if !scope.contains(&mm.member.id) {
                continue;
            }
            let repos_of = if mm.member.repos.is_empty() {
                "todos los repositorios".to_string()
            } else {
                repos.iter().filter(|r| mm.member.repos.contains(&r.project_id)).map(|r| r.name.clone()).collect::<Vec<_>>().join(", ")
            };
            // Where it sits: a sub-lead says whom it leads, someone under one says whose it is — the
            // lead routes an area's work to its sub-lead, and only a small change straight to the hands.
            let members = members_of(run);
            let mut place = String::new();
            if delegates(run, &mm.member.id, &item.member_id) {
                let under: Vec<String> = hierarchy::subtree(&members, &run.lead, &mm.member.id)
                    .iter()
                    .filter(|id| **id != mm.member.id)
                    .filter_map(|id| member(run, id).map(|m| m.member.name.clone()))
                    .collect();
                place = format!(" · **sub-líder**: dale el trabajo de su área entero y él lo reparte entre {}", under.join(", "));
            } else if let Some(boss) = manager_of(run, &mm.member.id).filter(|boss| boss.member.id != item.member_id && delegates(run, &boss.member.id, &item.member_id)) {
                // Only under a sub-lead that hands work out: reporting to someone who does not
                // delegate is an org chart line, not a route the lead must take.
                place = format!(" · en el área de {}", boss.member.name);
            }
            out.push_str(&format!(
                "- **{}** — {} · {} · {}{} · {}{}\n",
                mm.member.name,
                if mm.member.role.trim().is_empty() { "sin rol descrito" } else { mm.member.role.trim() },
                if mm.member.edits { "escribe código" } else { "solo lectura" },
                mm.model,
                if mm.effort.is_empty() { String::new() } else { format!(" ({})", mm.effort) },
                repos_of,
                place
            ));
        }
        out.push_str("\n## Repositorios\n");
        for r in repos {
            out.push_str(&format!("- **{}** — rama destino `{}`, trabajo integrado en `{}` ({})\n", r.name, r.target_branch, r.integration_branch, r.integration_path));
        }
        let others: Vec<&Item> = if item.member_id != run.lead && !run.lead.is_empty() {
            items.iter().filter(|i| i.parent == item.id || (i.parent.is_empty() && scope.contains(&i.member_id) && !i.is_lead())).filter(|i| i.id != item.id).collect()
        } else {
            items.iter().filter(|i| !i.is_lead() || (i.kind == "delegate" && i.member_id != run.lead)).collect()
        };
        if !others.is_empty() {
            out.push_str("\n## Estado del trabajo\n");
            for i in others {
                let note = match i.status.as_str() {
                    "done" => format!(" — {}", first_line(&protocol::prose(&i.output_text), 300)),
                    "error" => format!(" — falló: {}", first_line(&i.last_error, 300)),
                    _ => String::new(),
                };
                out.push_str(&format!("- `{}` [{}] {} · {} · {}{}\n", i.key, i.status, i.member_name, i.kind, i.title, note));
            }
        }
        out.push_str(&format!("\n## Ahora\n{}\n", item.instruction));
    } else {
        if let Some(r) = repo {
            out.push_str(&format!("## Dónde trabajas\nRepositorio **{}**, carpeta `{cwd}`", r.name));
            if !item.branch.is_empty() {
                out.push_str(&format!(", rama `{}` (sale de `{}`)", item.branch, r.integration_branch));
            }
            out.push_str(".\nNo cambies de rama ni hagas checkout, rebase, reset ni stash.");
            if item.writes() {
                out.push_str(" No hagas commit: el equipo guarda tu trabajo al terminar.");
            } else {
                out.push_str(" Esta tarea es de solo lectura.");
            }
            let others: Vec<&RunRepo> = repos.iter().filter(|x| x.project_id != r.project_id).collect();
            if !others.is_empty() {
                out.push_str("\nLos otros repositorios de esta tarea, para leer: ");
                out.push_str(&others.iter().map(|x| format!("{} (`{}`)", x.name, x.integration_path)).collect::<Vec<_>>().join(", "));
            }
            out.push_str("\n\n");
        }
        match item.kind.as_str() {
            "review" => {
                let target = items.iter().find(|i| i.id == item.ref_item);
                let exigence = crate::chain_review::Exigence::parse(&run.policy.review.exigence);
                if let (Some(t), Some(r)) = (target, repo) {
                    out.push_str(&format!(
                        "## Tu tarea\nRevisa el trabajo de **{}** en «{}»: {}\nLos cambios son `git diff {}...{}` en esta carpeta.\n\n",
                        t.member_name, t.title, t.instruction, r.integration_branch, t.branch
                    ));
                }
                out.push_str(&crate::chain_review::instruction(exigence));
                out.push_str("\n\n");
            }
            "integrate" => {
                out.push_str(&format!("## Tu tarea\n{}\n\n", item.instruction));
            }
            _ => out.push_str(&format!("## Tu tarea\n{}\n\n", item.instruction)),
        }
        let deps: Vec<&Item> = item.depends_on.iter().filter_map(|d| items.iter().find(|i| i.id == *d)).collect();
        if !deps.is_empty() {
            out.push_str("## Lo que te entregan\n");
            for d in deps {
                let prose = team::artifacts::strip(&protocol::prose(&d.output_text));
                out.push_str(&format!("### `{}` — {}: {}\n{}\n", d.key, d.member_name, d.title, trim_chars(&prose, team::HANDOFF_PER_DEP)));
                let files = team::artifacts::files_of(&run.id, &d.key);
                if !files.is_empty() {
                    let folder = team::artifacts::relative_folder(&run.id);
                    out.push_str(&format!("Artefactos que dejó, para abrir cuando los necesites: {}\n", files.iter().map(|f| format!("`{folder}/{f}`")).collect::<Vec<_>>().join(", ")));
                }
                out.push('\n');
            }
        }
    }
    if !inbox.is_empty() {
        out.push_str("## Mensajes para ti\n");
        for msg in &inbox {
            out.push_str(&format!("- **{}**: {}\n", msg.from_name, msg.body));
            delivered.push(msg.id.clone());
        }
        out.push('\n');
    }
    if !item.feedback.trim().is_empty() {
        out.push_str(&format!("## Antes de seguir\n{}\n\n", item.feedback.trim()));
    }
    if item.is_lead() {
        let may_ask = match run.policy.questions.as_str() {
            "allow" => true,
            "plan" => item.kind == "plan",
            _ => false,
        };
        out.push_str(&protocol::lead_protocol(may_ask));
    } else {
        out.push_str(&protocol::member_protocol(run.policy.members_may_ask()));
    }
    (out, delivered)
}

// ---------------------------------------------------------------- settle

/// One item's turn is over. `outcome` is `ok`, `error`, `busy` (it never ran) or `cancelled`.
#[tauri::command]
pub async fn team_settle(app: AppHandle, db: State<'_, Db>, item_id: String, outcome: String, text: Option<String>, error: Option<String>) -> Result<RunState, String> {
    settle_item(&app, &db, &item_id, &outcome, text.as_deref().unwrap_or_default(), error.as_deref().unwrap_or_default()).await
}

/// [`team_settle`] for callers without a `State` — `cf done` from a member's terminal.
pub async fn settle_from_terminal(app: &AppHandle, item_id: &str, text: &str) -> Result<(), String> {
    let db = app.state::<Db>();
    settle_item(app, db.inner(), item_id, "ok", text, "").await.map(|_| ())
}

pub async fn settle_item(app: &AppHandle, db: &Db, item_id: &str, outcome: &str, text: &str, error: &str) -> Result<RunState, String> {
    let state = settle_core(db, item_id, outcome, text, error).await?;
    changed(app, &state.run.id);
    Ok(state)
}

pub async fn settle_core(db: &Db, item_id: &str, outcome: &str, text: &str, error: &str) -> Result<RunState, String> {
    let item = with(db, |c| team::get_item(c, item_id).map_err(e2s)?.ok_or_else(|| "El ítem ya no existe.".to_string()))?;
    let run_id = item.run_id.clone();
    let lock = run_lock(&run_id);
    let _guard = lock.lock().await;
    let (run, mut item) = with(db, |c| {
        let run = team::get_run(c, &run_id).map_err(e2s)?.ok_or("La corrida ya no existe.")?;
        let item = team::get_item(c, item_id).map_err(e2s)?.ok_or("El ítem ya no existe.")?;
        Ok((run, item))
    })?;
    if item.status != "running" {
        return state_of(db, &run_id);
    }
    item.terminal_session.clear();
    match outcome {
        "busy" => {
            item.status = "pending".into();
            item.attempts = (item.attempts - 1).max(0);
            with(db, |c| team::update_item(c, &item).map_err(e2s))?;
        }
        "cancelled" => {
            item.status = "pending".into();
            item.attempts = (item.attempts - 1).max(0);
            item.last_error = "team.stopped".into();
            with(db, |c| {
                team::update_item(c, &item).map_err(e2s)?;
                if team::get_run(c, &run_id).map_err(e2s)?.is_some_and(|r| r.status == "running") {
                    team::set_run_status(c, &run_id, "paused", "", "").map_err(e2s)?;
                    team::set_run_reason(c, &run_id, "team.stopped").map_err(e2s)?;
                }
                Ok(())
            })?;
        }
        "ok" => on_ok(db, &run, item, text).await?,
        _ => on_failure(db, &run, item, if error.is_empty() { "falló sin decir por qué" } else { error }, "error").await?,
    }
    advance(db, &run_id).await?;
    state_of(db, &run_id)
}

/// A turn that did not get its job done. Retried while attempts remain (with the reason in front of
/// it), then handed to the member's escalation, then to the lead, then to the user.
async fn on_failure(db: &Db, run: &Run, mut item: Item, reason: &str, kind: &str) -> Result<(), String> {
    let repeated = !item.last_error.is_empty() && first_line(&item.last_error, 200) == first_line(reason, 200);
    // Before paying for another attempt: is retrying it even the right call? The decision layer
    // answers when it is sure; when it is not, the policy's own order (retry, then escalate) stands.
    let escalate_to = member(run, &item.member_id).map(|m| m.member.escalate_to.clone()).filter(|e| !e.is_empty());
    let mut options: Vec<String> = vec!["reintentar".into()];
    if escalate_to.is_some() {
        options.push("escalar".into());
    }
    if !run.lead.is_empty() && !item.is_lead() {
        options.push("replanificar".into());
    }
    let verdict = if run.policy.decider && item.attempts < run.policy.max_attempts && options.len() > 1 {
        let context = format!(
            "Tarea `{}` de {} ({}): {}\nIntento {} de {}. Tipo de fallo: {kind}.{}\nError:\n{}",
            item.key,
            item.member_name,
            item.kind,
            item.title,
            item.attempts,
            run.policy.max_attempts,
            if repeated { " El error es el mismo que en el intento anterior." } else { "" },
            trim_chars(reason, 1500)
        );
        Some(
            crate::decide::decide(
                db,
                crate::decide::Decision {
                    kind: "retry".into(),
                    question: "¿Qué conviene hacer con esta tarea que falló?".into(),
                    options,
                    context,
                    workspace_id: run.workspace_id.clone(),
                    run_id: run.id.clone(),
                    item_id: item.id.clone(),
                },
            )
            .await,
        )
    } else {
        None
    };
    let sharp_choice = verdict.as_ref().filter(|v| v.sharp).and_then(|v| v.choice.clone());
    with(db, |c| {
        if let (Some(v), Some(choice)) = (verdict.as_ref(), sharp_choice.as_deref()) {
            team::post(c, &run.id, &item.id, ("system", "Decisor"), ("all", "Equipo"), "decision", &format!("«{}» falló: {choice} (p = {:.2}, {})", item.title, v.p, v.source), &[]).map_err(e2s)?;
        }
        let decided_stop = matches!(sharp_choice.as_deref(), Some("escalar") | Some("replanificar"));
        item.last_error = reason.to_string();
        if item.attempts < run.policy.max_attempts && !decided_stop {
            // The same error twice: the advisor looks before the third try, which waits for it.
            if repeated && item.attempts >= 2 {
                if let Some(advice) = new_advice(c, run, &item.id, &format!("La tarea `{}` falló dos veces con el mismo error. ¿Qué debería cambiar el próximo intento?", item.key))? {
                    if !item.depends_on.contains(&advice.id) {
                        item.depends_on.push(advice.id.clone());
                    }
                }
            }
            // A retry climbs the member's model ladder, cheapest first, one step per failure.
            if let Some(m) = member(run, &item.member_id) {
                let ladder = &m.member.model_ladder;
                if !ladder.is_empty() {
                    let step = ((item.attempts - 1).max(0) as usize).min(ladder.len() - 1);
                    item.model = ladder[step].clone();
                }
            }
            item.status = "pending".into();
            item.feedback = format!("El intento anterior no sirvió: {}\nCorrígelo.", trim_chars(reason, 6000));
            team::update_item(c, &item).map_err(e2s)?;
            return Ok(());
        }
        item.status = "error".into();
        item.finished_at = queries::now();
        team::update_item(c, &item).map_err(e2s)?;
        let who = (item.member_id.as_str(), item.member_name.as_str());
        team::post(c, &run.id, &item.id, who, ("all", "Equipo"), "error", &format!("«{}» falló {} veces: {}", item.title, item.attempts, first_line(reason, 400)), &[])
            .map_err(e2s)?;
        // Escalation: the same item, from scratch, for the member the policy names — unless the
        // decision layer said the plan, not the member, is what has to change.
        let escalation = if sharp_choice.as_deref() == Some("replanificar") { None } else { escalate_to.clone() };
        if let Some(next) = escalation.and_then(|e| member(run, &e).cloned()) {
            if !item.key.ends_with("-esc") && (next.member.edits || !item.writes()) {
                let items = team::list_items(c, &run.id).map_err(e2s)?;
                let mut again = team::new_item(run, &team::free_key(&items, &format!("{}-esc", item.key)), Some(&next), &item.project_id, &item.kind, &item.title, &item.instruction);
                again.depends_on = item.depends_on.clone();
                again.ref_item = item.ref_item.clone();
                again.feedback = format!("{} no pudo con esto ({}). Te toca a ti.", item.member_name, first_line(reason, 400));
                team::insert_item(c, &again).map_err(e2s)?;
                // Whatever waited on the failed item waits on its replacement.
                for mut dependent in items.into_iter().filter(|i| i.depends_on.contains(&item.id)) {
                    dependent.depends_on = dependent.depends_on.iter().map(|d| if d == &item.id { again.id.clone() } else { d.clone() }).collect();
                    team::update_item(c, &dependent).map_err(e2s)?;
                }
                team::post(c, &run.id, &again.id, ("system", "CodeFlow"), (&next.member.id, &next.member.name), "decision", &format!("«{}» pasa a {}", item.title, next.member.name), &[])
                    .map_err(e2s)?;
                return Ok(());
            }
        }
        if !item.is_lead() && !run.lead.is_empty() {
            let instruction = format!(
                "La tarea `{}` ({}, {}) falló {} veces ({kind}): {}\nDecide: reasígnala, divídela, cancela lo que dependía de ella o termina.",
                item.key, item.member_name, item.title, item.attempts, trim_chars(reason, 3000)
            );
            if new_lead_item(c, run, "plan", &instruction, "")?.is_some() {
                return Ok(());
            }
            return Ok(());
        }
        team::set_run_status(c, &run.id, "gated", &format!("stuck:{}", item.id), &format!("«{}» falló: {}", item.title, first_line(reason, 300))).map_err(e2s)
    })
}

async fn on_ok(db: &Db, run: &Run, mut item: Item, text: &str) -> Result<(), String> {
    item.output_text = text.to_string();
    // What the answer carried as artifacts becomes files the next members open (`team::artifacts`).
    let filed = with(db, |c| Ok(team::artifacts::file_item(c, run, &item, text)))?;
    if !filed.is_empty() {
        with(db, |c| {
            let names: Vec<String> = filed.iter().map(|f| format!("`{f}`")).collect();
            team::post(c, &run.id, &item.id, (&item.member_id, &item.member_name), ("all", "Equipo"), "note", &format!("publicó {}", names.join(", ")), &[])
                .map(|_| ())
                .map_err(e2s)
        })?;
    }
    if item.is_lead() {
        return on_lead(db, run, item, text);
    }
    // Notes first: whatever the member asked or told, it said it.
    let waiting = with(db, |c| post_notes(c, run, &item, text))?;
    if waiting {
        item.status = "waiting".into();
        with(db, |c| team::update_item(c, &item).map_err(e2s))?;
        return Ok(());
    }
    if item.kind == "advise" {
        return with(db, |c| on_advice(c, run, item, text));
    }
    let repo = with(db, |c| team::list_repos(c, &run.id).map_err(e2s))?.into_iter().find(|r| r.project_id == item.project_id);
    match item.kind.as_str() {
        "review" => on_review(db, run, item, text).await,
        "integrate" => {
            let files: Vec<String> = item.feedback.lines().filter_map(|l| l.strip_prefix("- ")).map(str::to_string).collect();
            let path = item.worktree_path.clone();
            let message = format!("Merge: integrar «{}»", item.title);
            match blocking(move || gitops::finish_resolution(&path, &files, &message)).await? {
                Err(e) => on_failure(db, run, item, &e, "conflicto").await,
                Ok(_) => {
                    item.status = "done".into();
                    item.finished_at = queries::now();
                    with(db, |c| {
                        team::update_item(c, &item).map_err(e2s)?;
                        team::post(c, &run.id, &item.id, (&item.member_id, &item.member_name), ("all", "Equipo"), "merge", "resolvió los conflictos", &[]).map_err(e2s)?;
                        Ok(())
                    })?;
                    if let Some(target) = with(db, |c| team::get_item(c, &item.ref_item).map_err(e2s))? {
                        integrate(db, run, target).await?;
                    }
                    Ok(())
                }
            }
        }
        "work" => {
            // Checks the policy runs after each piece of work, in its own folder.
            let checks: Vec<String> = run
                .policy
                .checks
                .iter()
                .filter(|c| c.when == "item" && (c.repo == "*" || c.repo == item.project_id))
                .map(|c| c.command.clone())
                .collect();
            for command in checks {
                let (passed, output) = crate::commands::agents_cmd::run_shell_check(&command, &item.worktree_path).await;
                if !passed {
                    return on_failure(db, run, item, &format!("`{command}` falló:\n{}", trim_chars(&output, 6000)), "check").await;
                }
            }
            let path = item.worktree_path.clone();
            let message = gitops::commit_message(&run.policy.commit_style, &item.key, &item.title);
            let sha = match blocking(move || gitops::commit_all(&path, &message)).await? {
                Ok(sha) => sha,
                Err(e) => return on_failure(db, run, item, &e, "commit").await,
            };
            // A fix commits on the same branch as the work it fixes; what is reviewed and merged is
            // the branch, so the original's sha follows.
            if let Some(sha) = &sha {
                item.commit_sha = sha.clone();
            } else if !item.ref_item.is_empty() {
                if let Some(original) = with(db, |c| team::get_item(c, &item.ref_item).map_err(e2s))? {
                    item.commit_sha = original.commit_sha.clone();
                }
            }
            item.status = "done".into();
            item.feedback.clear();
            item.finished_at = queries::now();
            with(db, |c| {
                team::update_item(c, &item).map_err(e2s)?;
                handoff(c, run, &item)
            })?;
            if item.commit_sha.is_empty() {
                return Ok(());
            }
            if needs_review(run, &item) {
                with(db, |c| new_review(c, run, &item))?;
                return Ok(());
            }
            integrate(db, run, item).await
        }
        _ => {
            item.status = "done".into();
            item.feedback.clear();
            item.finished_at = queries::now();
            with(db, |c| {
                team::update_item(c, &item).map_err(e2s)?;
                handoff(c, run, &item)
            })?;
            let _ = repo;
            Ok(())
        }
    }
}

/// The advisor answered: its advice goes to the lead and to you, and into whatever it was asked
/// about — the plan's gate, the final look, or the next attempt of a failing item.
fn on_advice(conn: &Connection, run: &Run, mut item: Item, text: &str) -> Result<(), String> {
    let advice = protocol::prose(text);
    item.status = "done".into();
    item.finished_at = queries::now();
    team::update_item(conn, &item).map_err(e2s)?;
    let from = (item.member_id.as_str(), item.member_name.as_str());
    let lead = if run.lead.is_empty() { ("user".to_string(), "Tú".to_string()) } else { ("lead".to_string(), lead_name(run)) };
    team::post(conn, &run.id, &item.id, from, (&lead.0, &lead.1), "advice", &trim_chars(&advice, 2000), &[]).map_err(e2s)?;
    match item.ref_item.as_str() {
        "plan" => {
            if run.policy.approve_plan {
                team::set_run_status(conn, &run.id, "gated", "plan", &format!("Revisa el plan del líder. El asesor dice: {}", first_line(&advice, 300))).map_err(e2s)?;
            }
        }
        "final" => {}
        target => {
            if let Some(mut failing) = team::get_item(conn, target).map_err(e2s)? {
                failing.feedback = format!("{}\n\nEl asesor sugiere:\n{}", failing.feedback, trim_chars(&advice, 2000)).trim().to_string();
                team::update_item(conn, &failing).map_err(e2s)?;
            }
        }
    }
    Ok(())
}

fn handoff(conn: &Connection, run: &Run, item: &Item) -> Result<(), String> {
    let summary = first_line(&protocol::prose(&item.output_text), 400);
    let dependents: Vec<Item> = team::list_items(conn, &run.id).map_err(e2s)?.into_iter().filter(|i| i.depends_on.contains(&item.id)).collect();
    if dependents.is_empty() {
        team::post(conn, &run.id, &item.id, (&item.member_id, &item.member_name), ("all", "Equipo"), "handoff", &format!("terminó «{}»: {summary}", item.title), &[])
            .map_err(e2s)?;
    } else {
        for d in dependents {
            team::post(conn, &run.id, &item.id, (&item.member_id, &item.member_name), (&d.member_id, &d.member_name), "handoff", &format!("«{}» listo para «{}»: {summary}", item.title, d.title), &[])
                .map_err(e2s)?;
        }
    }
    Ok(())
}

/// The notes in a member's answer, posted. `true` when one of them is a question that has to be
/// answered before the member can go on.
fn post_notes(conn: &Connection, run: &Run, item: &Item, text: &str) -> Result<bool, String> {
    let roster = roster(run);
    let (notes, errors) = protocol::member_notes(text, &roster);
    let from = (item.member_id.as_str(), item.member_name.as_str());
    let members = members_of(run);
    let boss = manager_of(run, &item.member_id).cloned();
    let mut waiting = false;
    let cap = run.policy.max_notes_per_item;
    for (index, note) in notes.into_iter().enumerate() {
        if cap > 0 && index as i64 >= cap {
            team::post(conn, &run.id, &item.id, ("system", "CodeFlow"), from, "error", &format!("se descartaron las notas pasadas las {cap} de esta tarea"), &[]).map_err(e2s)?;
            break;
        }
        let (mut to_id, mut to_name) = match &note.to {
            protocol::Recipient::User => ("user".to_string(), "Tú".to_string()),
            // «El líder» is whoever this member answers to: its sub-lead, or the lead.
            protocol::Recipient::Lead => match &boss {
                Some(b) if b.member.id != run.lead => (b.member.id.clone(), b.member.name.clone()),
                _ if !run.lead.is_empty() => ("lead".to_string(), lead_name(run)),
                _ => ("user".to_string(), "Tú".to_string()),
            },
            protocol::Recipient::All => ("all".to_string(), "Equipo".to_string()),
            protocol::Recipient::Member(id) => (id.clone(), member(run, id).map(|m| m.member.name.clone()).unwrap_or_default()),
        };
        let mut body = note.text.clone();
        // A note the hierarchy does not allow goes through the sender's manager, said so.
        if !hierarchy::may_message(&members, &run.lead, &run.policy.comms, &item.member_id, &to_id) {
            if let Some(b) = &boss {
                body = format!("Para {to_name}: {body}");
                team::post(conn, &run.id, &item.id, ("system", "CodeFlow"), from, "note", &format!("tu nota para {to_name} pasa por {}", b.member.name), &[]).map_err(e2s)?;
                to_id = if b.member.id == run.lead { "lead".into() } else { b.member.id.clone() };
                to_name = b.member.name.clone();
            }
        }
        // With questions escalating, the user is asked only by the lead: a member asks up.
        if note.question && to_id == "user" && run.policy.escalate_questions {
            if let Some(b) = &boss {
                to_id = if b.member.id == run.lead { "lead".into() } else { b.member.id.clone() };
                to_name = b.member.name.clone();
            }
        }
        let note = protocol::Note { text: body, ..note };
        let to_planner = to_id == "lead" || (to_id != "user" && to_id != "all" && boss.as_ref().is_some_and(|b| b.member.id == to_id));
        if note.question && to_planner && to_id != "lead" {
            let asked = team::post(conn, &run.id, &item.id, from, (&to_id, &to_name), "question", &note.text, &note.options).map_err(e2s)?;
            let instruction = format!("{} te pregunta, desde «{}»: {}\nRespóndele en tu texto (lo recibe tal cual). Si no lo sabes, pregúntale a quien te lidera.", item.member_name, item.title, note.text);
            if let Some(answer_item) = new_planner_item(conn, run, &to_id, "answer", &instruction, "", "")? {
                conn.execute("UPDATE agent_team_items SET ref_item = ?2 WHERE id = ?1", rusqlite::params![answer_item.id, asked.id]).map_err(e2s)?;
                waiting = true;
            }
            continue;
        }
        if note.question && to_id == "user" {
            if run.policy.members_may_ask() {
                team::post(conn, &run.id, &item.id, from, ("user", "Tú"), "question", &note.text, &note.options).map_err(e2s)?;
                waiting = true;
            } else {
                team::post(conn, &run.id, &item.id, from, ("user", "Tú"), "note", &format!("(no puede preguntar, decidió solo) {}", note.text), &[]).map_err(e2s)?;
            }
        } else if note.question && to_id == "lead" {
            let asked = team::post(conn, &run.id, &item.id, from, ("lead", &to_name), "question", &note.text, &note.options).map_err(e2s)?;
            let instruction = format!("{} pregunta, desde «{}»: {}\nRespóndele en tu texto (lo recibe tal cual).", item.member_name, item.title, note.text);
            if let Some(mut lead_item) = new_lead_item(conn, run, "answer", &instruction, "")? {
                lead_item.ref_item = asked.id.clone();
                conn.execute("UPDATE agent_team_items SET ref_item = ?2 WHERE id = ?1", rusqlite::params![lead_item.id, asked.id]).map_err(e2s)?;
                waiting = true;
            }
        } else {
            team::post(conn, &run.id, &item.id, from, (&to_id, &to_name), if note.question { "question" } else { "note" }, &note.text, &note.options).map_err(e2s)?;
        }
    }
    for e in errors {
        team::post(conn, &run.id, &item.id, ("system", "CodeFlow"), from, "error", &format!("una nota no se pudo leer: {e}"), &[]).map_err(e2s)?;
    }
    Ok(waiting)
}

fn needs_review(run: &Run, item: &Item) -> bool {
    let review = &run.policy.review;
    review.enabled
        && !review.reviewer.is_empty()
        && review.reviewer != item.member_id
        && member(run, &review.reviewer).is_some()
        && (review.of.is_empty() || review.of.contains(&item.member_id))
}

fn new_review(conn: &Connection, run: &Run, work: &Item) -> Result<(), String> {
    let Some(reviewer) = member(run, &run.policy.review.reviewer) else { return Ok(()) };
    let items = team::list_items(conn, &run.id).map_err(e2s)?;
    let lap = items.iter().filter(|i| i.kind == "review" && items.iter().any(|w| w.id == i.ref_item && w.branch == work.branch)).count() as i64 + 1;
    let mut review = team::new_item(run, &team::free_key(&items, &format!("{}-rev", work.key)), Some(reviewer), &work.project_id, "review", &format!("Revisar «{}»", work.title), &work.instruction);
    review.ref_item = work.id.clone();
    review.lap = lap;
    review.run_in = "headless".into();
    team::insert_item(conn, &review).map_err(e2s)?;
    team::post(conn, &run.id, &review.id, (&work.member_id, &work.member_name), (&reviewer.member.id, &reviewer.member.name), "handoff", &format!("«{}» listo para revisar (vuelta {lap})", work.title), &[])
        .map_err(e2s)?;
    Ok(())
}

async fn on_review(db: &Db, run: &Run, mut item: Item, text: &str) -> Result<(), String> {
    let Some(review) = crate::chain_review::parse(text) else {
        return on_failure(db, run, item, "la revisión no tiene una línea `VERDICT: OK | FIX`", "revisión").await;
    };
    let target = with(db, |c| team::get_item(c, &item.ref_item).map_err(e2s))?;
    let Some(target) = target else {
        item.status = "done".into();
        with(db, |c| team::update_item(c, &item).map_err(e2s))?;
        return Ok(());
    };
    let roots = vec![target.worktree_path.clone()];
    let grounded = crate::chain_review::ground(review.findings.clone(), &roots, &|p: &std::path::Path| p.exists());
    let blocking_findings = crate::chain_review::blocking(&grounded, crate::chain_review::Exigence::parse(&run.policy.review.exigence));
    item.status = "done".into();
    item.finished_at = queries::now();
    with(db, |c| team::update_item(c, &item).map_err(e2s))?;
    let from = (item.member_id.clone(), item.member_name.clone());
    if blocking_findings.is_empty() {
        with(db, |c| {
            team::post(c, &run.id, &item.id, (&from.0, &from.1), (&target.member_id, &target.member_name), "finding", &format!("aprobó «{}»", target.title), &[])
                .map(|_| ())
                .map_err(e2s)
        })?;
        return integrate(db, run, target).await;
    }
    let listing = blocking_findings
        .iter()
        .map(|f| format!("[{:?}] {}{} — {}", f.severity, f.file, f.line.map(|l| format!(":{l}")).unwrap_or_default(), f.problem).to_lowercase())
        .collect::<Vec<_>>()
        .join("\n");
    with(db, |c| {
        team::post(c, &run.id, &item.id, (&from.0, &from.1), (&target.member_id, &target.member_name), "finding", &format!("devuelve «{}»:\n{listing}", target.title), &[])
            .map_err(e2s)?;
        if item.lap >= run.policy.review.laps {
            return team::set_run_status(
                c,
                &run.id,
                "gated",
                &format!("review:{}", target.id),
                &format!("«{}» sigue sin aprobarse tras {} vueltas. Aprueba para integrarlo igual, o rechaza para descartarlo.", target.title, item.lap),
            )
            .map_err(e2s);
        }
        // The fix continues the same task in the same worktree: the author remembers what it did.
        let items = team::list_items(c, &run.id).map_err(e2s)?;
        let author = member(run, &target.member_id).cloned();
        let mut fix = team::new_item(run, &team::free_key(&items, &format!("{}-fix", target.key)), author.as_ref(), &target.project_id, "work", &format!("Corregir «{}»", target.title), &target.instruction);
        fix.ref_item = target.id.clone();
        fix.task_id = target.task_id.clone();
        fix.worktree_path = target.worktree_path.clone();
        fix.branch = target.branch.clone();
        fix.run_in = target.run_in.clone();
        fix.approved = true;
        fix.lap = item.lap;
        fix.feedback = crate::chain_review::note_for_worker(&blocking_findings, &[], item.lap);
        team::insert_item(c, &fix).map_err(e2s)?;
        // Whatever waits on the original keeps waiting: it is merged when the fix is approved.
        Ok(())
    })
}

/// Merges a work item's branch into its repository's integration branch, or routes the conflict.
async fn integrate(db: &Db, run: &Run, work: Item) -> Result<(), String> {
    let Some(repo) = with(db, |c| team::list_repos(c, &run.id).map_err(e2s))?.into_iter().find(|r| r.project_id == work.project_id) else {
        return Ok(());
    };
    let (integ, branch) = (repo.integration_path.clone(), work.branch.clone());
    let message = format!("Merge «{}» ({})", work.title, work.member_name);
    let merged = blocking(move || {
        let _git = crate::git::write_lock();
        gitops::merge_into_integration(&integ, &branch, &message)
    })
    .await?;
    match merged {
        Ok(gitops::Merge::Done(_)) | Ok(gitops::Merge::Nothing) => with(db, |c| {
            // Every done item on this branch (the work and its fixes) is in now.
            c.execute("UPDATE agent_team_items SET merged = 1 WHERE run_id = ?1 AND branch = ?2 AND status = 'done'", rusqlite::params![run.id, work.branch])
                .map_err(e2s)?;
            team::post(c, &run.id, &work.id, ("system", "CodeFlow"), ("all", "Equipo"), "merge", &format!("«{}» integrado en {}", work.title, repo.integration_branch), &[])
                .map_err(e2s)?;
            Ok(())
        }),
        Ok(gitops::Merge::Conflict(files)) => route_conflict(db, run, &repo, work, files).await,
        Err(e) => with(db, |c| {
            team::set_run_status(c, &run.id, "gated", &format!("stuck:{}", work.id), &format!("No se pudo integrar «{}»: {e}", work.title)).map_err(e2s)
        }),
    }
}

async fn route_conflict(db: &Db, run: &Run, repo: &RunRepo, work: Item, files: Vec<String>) -> Result<(), String> {
    let resolver = match run.policy.conflicts.as_str() {
        "user" => None,
        "author" | "" => member(run, &work.member_id).cloned(),
        id => member(run, id).cloned().or_else(|| member(run, &work.member_id).cloned()),
    }
    .filter(|m| m.member.edits);
    let Some(resolver) = resolver else {
        return with(db, |c| {
            team::set_run_status(c, &run.id, "gated", &format!("stuck:{}", work.id), &format!("«{}» choca con el trabajo ya integrado en: {}. Resuélvelo en {} y aprueba.", work.title, files.join(", "), work.worktree_path))
                .map_err(e2s)
        });
    };
    let (path, integ_branch) = (work.worktree_path.clone(), repo.integration_branch.clone());
    let conflicts = blocking(move || gitops::bring_conflicts_into(&path, &integ_branch)).await??;
    if conflicts.is_empty() {
        // It merged cleanly the other way round: try again.
        return Box::pin(integrate(db, run, work)).await;
    }
    with(db, |c| {
        let items = team::list_items(c, &run.id).map_err(e2s)?;
        let mut fix = team::new_item(
            run,
            &team::free_key(&items, &format!("{}-merge", work.key)),
            Some(&resolver),
            &work.project_id,
            "integrate",
            &format!("Resolver conflictos de «{}»", work.title),
            &format!(
                "Al integrar «{}» de {} con lo que el equipo ya integró, chocan estos archivos. El merge está a medias en esta carpeta: resuelve cada conflicto conservando lo que quiere cada lado, quita todas las marcas y deja que el equipo cierre el merge (no hagas commit).",
                work.title, work.member_name
            ),
        );
        fix.ref_item = work.id.clone();
        fix.worktree_path = work.worktree_path.clone();
        fix.branch = work.branch.clone();
        fix.approved = true;
        if resolver.member.id == work.member_id {
            fix.task_id = work.task_id.clone();
        }
        fix.feedback = conflicts.iter().map(|f| format!("- {f}")).collect::<Vec<_>>().join("\n");
        team::insert_item(c, &fix).map_err(e2s)?;
        team::post(c, &run.id, &fix.id, ("system", "CodeFlow"), (&resolver.member.id, &resolver.member.name), "merge", &format!("conflicto al integrar «{}»: {}", work.title, conflicts.join(", ")), &[])
            .map_err(e2s)?;
        Ok(())
    })
}

/// A lead's turn: its plan, its questions, its decisions.
fn on_lead(db: &Db, run: &Run, mut item: Item, text: &str) -> Result<(), String> {
    with(db, |c| {
        let items = team::list_items(c, &run.id).map_err(e2s)?;
        let repos = team::list_repos(c, &run.id).map_err(e2s)?;
        let planner = item.member_id.clone();
        let sub_lead = !run.lead.is_empty() && planner != run.lead;
        let roster: Vec<protocol::RosterEntry> = planner_roster(run, &planner);
        let repo_entries: Vec<protocol::RepoEntry> = repos.iter().map(|r| protocol::RepoEntry { project_id: r.project_id.clone(), name: r.name.clone() }).collect();
        let keys: Vec<String> = items.iter().map(|i| i.key.clone()).collect();
        let reply = protocol::lead_reply(text, &roster, &repo_entries, &keys);
        let lead = if sub_lead { (planner.clone(), item.member_name.clone()) } else { (run.lead.clone(), lead_name(run)) };
        let from = (lead.0.as_str(), lead.1.as_str());

        // An answer to a member's question: the lead's text is the answer.
        if item.kind == "answer" {
            if let Some(asked) = team::get_message(c, &item.ref_item).map_err(e2s)? {
                let answer = if reply.message.is_empty() { protocol::prose(text) } else { reply.message.clone() };
                team::answer_message(c, &asked.id, &answer).map_err(e2s)?;
                if let Some(mut waiting) = team::get_item(c, &asked.item_id).map_err(e2s)? {
                    if waiting.status == "waiting" {
                        waiting.status = "pending".into();
                        waiting.attempts = (waiting.attempts - 1).max(0);
                        waiting.feedback = format!("Le preguntaste a {}: {}\nTe responde: {answer}", item.member_name, asked.body);
                        team::update_item(c, &waiting).map_err(e2s)?;
                    }
                }
            }
        } else if !reply.message.is_empty() {
            team::post(c, &run.id, &item.id, from, ("all", "Equipo"), "decision", &reply.message, &[]).map_err(e2s)?;
        }
        if !reply.rejected.is_empty() {
            team::post(c, &run.id, &item.id, ("system", "CodeFlow"), ("lead", &lead.1), "error", &format!("se descartó parte del plan:\n- {}", reply.rejected.join("\n- ")), &[])
                .map_err(e2s)?;
        }

        // Questions for the user stop the lead until they are answered.
        let may_ask = match run.policy.questions.as_str() {
            "allow" => true,
            "plan" => item.kind == "plan",
            _ => false,
        };
        // A sub-lead asks up its chain of command, never the user directly.
        if sub_lead && !reply.questions.is_empty() {
            let boss = manager_of(run, &planner).map(|b| b.member.id.clone()).unwrap_or_else(|| run.lead.clone());
            let boss_name = member(run, &boss).map(|b| b.member.name.clone()).unwrap_or_else(|| lead_name(run));
            let mut asked_any = false;
            for q in &reply.questions {
                let asked = team::post(c, &run.id, &item.id, from, (&boss, &boss_name), "question", &q.text, &q.options).map_err(e2s)?;
                let instruction = format!("{} te pregunta, mientras planifica su rama: {}\nRespóndele en tu texto.", item.member_name, q.text);
                if let Some(answer_item) = new_planner_item(c, run, &boss, "answer", &instruction, "", "")? {
                    c.execute("UPDATE agent_team_items SET ref_item = ?2 WHERE id = ?1", rusqlite::params![answer_item.id, asked.id]).map_err(e2s)?;
                    asked_any = true;
                }
            }
            if asked_any {
                item.status = "waiting".into();
                team::update_item(c, &item).map_err(e2s)?;
                return Ok(());
            }
        }
        if !reply.questions.is_empty() && !sub_lead {
            if may_ask {
                for q in &reply.questions {
                    team::post(c, &run.id, &item.id, from, ("user", "Tú"), "question", &q.text, &q.options).map_err(e2s)?;
                }
                item.status = "waiting".into();
                team::update_item(c, &item).map_err(e2s)?;
                return Ok(());
            }
            if reply.items.is_empty() && !reply.finish && item.attempts < run.policy.max_attempts {
                item.status = "pending".into();
                item.feedback = "No puedes preguntarle al usuario. Decide con lo que hay, anota lo que supones y planifica.".into();
                team::update_item(c, &item).map_err(e2s)?;
                return Ok(());
            }
        }

        // Cancellations: only what has not started.
        for key in &reply.cancel {
            let slug = protocol::key_slug(key);
            for mut i in items.iter().filter(|i| i.key == slug && matches!(i.status.as_str(), "pending" | "gated")).cloned() {
                i.status = "skipped".into();
                team::update_item(c, &i).map_err(e2s)?;
                team::post(c, &run.id, &i.id, from, (&i.member_id, &i.member_name), "decision", &format!("canceló «{}»", i.title), &[]).map_err(e2s)?;
            }
        }

        // New items, their dependencies resolved from keys to ids (this plan's and the run's).
        let mut key_to_id: HashMap<String, String> = items.iter().map(|i| (i.key.clone(), i.id.clone())).collect();
        let mut fresh = Vec::new();
        for p in &reply.items {
            let m = member(run, &p.member_id);
            let kind = if delegates(run, &p.member_id, &planner) { "delegate" } else { p.kind.as_str() };
            let mut new = team::new_item(run, &p.key, m, &p.project_id, kind, &p.title, &p.instruction);
            new.round = item.round;
            if kind == "delegate" {
                new.run_in = "headless".into();
            }
            if sub_lead {
                new.parent = item.id.clone();
            }
            key_to_id.insert(p.key.clone(), new.id.clone());
            fresh.push((new, p.depends_on.clone()));
        }
        let added = fresh.len();
        // The first plan of the lead is read by the advisor before anything in it starts.
        let first_plan_now = !sub_lead && item.kind == "plan" && added > 0 && !items.iter().any(|i| i.kind == "plan" && i.id != item.id && i.status == "done");
        // A small request — one member, at most one piece of work per repository — skips the
        // ceremony: no advisor on the plan, and no last look of the lead's (nor the advisor's) once
        // it is delivered. Checks and integration still run.
        let small = first_plan_now && reply.small && is_small(&fresh.iter().map(|(new, _)| new.clone()).collect::<Vec<_>>());
        if first_plan_now && reply.small && !small {
            team::post(c, &run.id, "", ("system", "CodeFlow"), ("all", "Equipo"), "status", "el líder lo marcó como chico, pero su plan reparte trabajo entre varios: sigue como tarea normal", &[]).map_err(e2s)?;
        }
        let advice = if first_plan_now && !small {
            let plan_text: Vec<String> = reply.items.iter().map(|p| format!("- `{}` {} → {}", p.key, p.title, member(run, &p.member_id).map(|m| m.member.name.clone()).unwrap_or_default())).collect();
            new_advice(c, run, "plan", &format!("El líder propone este plan:\n{}\n¿Falta algo, sobra algo, o hay un riesgo que no vio?", plan_text.join("\n")))?
        } else {
            None
        };
        for (mut new, deps) in fresh {
            new.depends_on = deps.iter().filter_map(|k| key_to_id.get(k).cloned()).collect();
            if let Some(a) = &advice {
                new.depends_on.push(a.id.clone());
            }
            team::insert_item(c, &new).map_err(e2s)?;
            team::post(c, &run.id, &new.id, from, (&new.member_id, &new.member_name), "plan", &format!("asignó «{}»", new.title), &[]).map_err(e2s)?;
        }
        if !sub_lead {
            if reply.finish || small {
                if small {
                    team::post(c, &run.id, "", ("system", "CodeFlow"), ("all", "Equipo"), "status", "tarea chica: se integra al entregarse, sin revisión final", &[]).map_err(e2s)?;
                }
                team::set_lead_done(c, &run.id, true).map_err(e2s)?;
            } else if added > 0 {
                team::set_lead_done(c, &run.id, false).map_err(e2s)?;
            }
        }

        // A plan that decided nothing at all is retried once with that said.
        let open = team::open_items(&team::list_items(c, &run.id).map_err(e2s)?.into_iter().filter(|i| i.id != item.id).collect::<Vec<_>>());
        if added == 0 && !reply.finish && open == 0 && item.kind != "answer" && item.attempts < run.policy.max_attempts {
            item.status = "pending".into();
            item.feedback = if reply.rejected.is_empty() {
                "No asignaste ninguna tarea ni terminaste. Responde con el bloque ```equipo``` que se te pidió.".into()
            } else {
                format!("Nada de tu plan se pudo usar:\n- {}\nCorrígelo.", reply.rejected.join("\n- "))
            };
            team::update_item(c, &item).map_err(e2s)?;
            return Ok(());
        }
        // A sub-lead's branch stays open until what it handed out closes (see `advance`).
        item.status = if item.kind == "delegate" && added > 0 && !reply.finish { "delegated".into() } else { "done".into() };
        item.feedback.clear();
        if item.status == "done" {
            item.finished_at = queries::now();
        }
        team::update_item(c, &item).map_err(e2s)?;
        if item.kind == "delegate" && item.status == "done" {
            handoff(c, run, &item)?;
        }

        // The first plan waits for the user when the policy says so.
        let first_plan = !sub_lead && item.kind == "plan" && !items.iter().any(|i| i.kind == "plan" && i.id != item.id && i.status == "done");
        // With an advisor reading the plan, the gate waits for its advice (`on_advice`).
        if first_plan && run.policy.approve_plan && added > 0 && advice.is_none() {
            team::set_run_status(c, &run.id, "gated", "plan", "Revisa el plan del líder antes de que el equipo empiece.").map_err(e2s)?;
        }
        Ok(())
    })
}

// ---------------------------------------------------------------- advance & finish

/// After any change: if nothing is moving any more, decide what happens next — a blocked graph goes
/// back to the lead (or to the user), and a finished one is checked and landed.
async fn advance(db: &Db, run_id: &str) -> Result<(), String> {
    let (run, items, repos) = with(db, |c| {
        let run = team::get_run(c, run_id).map_err(e2s)?.ok_or("La corrida ya no existe.")?;
        Ok((run, team::list_items(c, run_id).map_err(e2s)?, team::list_repos(c, run_id).map_err(e2s)?))
    })?;
    if run.status != "running" {
        return Ok(());
    }
    // A sub-lead's branch whose work has all closed hands its summary up, and stops being open.
    let closed_branches = with(db, |c| {
        let mut closed = 0;
        for mut d in items.iter().filter(|i| i.status == "delegated").cloned() {
            let children: Vec<&Item> = items.iter().filter(|i| i.parent == d.id).collect();
            if children.iter().all(|i| matches!(i.status.as_str(), "done" | "skipped" | "cancelled" | "error")) {
                let lines: Vec<String> = children
                    .iter()
                    .map(|i| format!("- `{}` {} · {}: {}", i.key, i.member_name, i.status, first_line(&protocol::prose(&i.output_text), 200)))
                    .collect();
                d.output_text = format!("{}\n\nLo que hizo la rama de {}:\n{}", protocol::prose(&d.output_text), d.member_name, lines.join("\n"));
                d.status = "done".into();
                d.finished_at = queries::now();
                team::update_item(c, &d).map_err(e2s)?;
                handoff(c, &run, &d)?;
                closed += 1;
            }
        }
        Ok(closed)
    })?;
    let items = if closed_branches > 0 { with(db, |c| team::list_items(c, run_id).map_err(e2s))? } else { items };
    let moving = items.iter().filter(|i| matches!(i.status.as_str(), "running" | "waiting" | "gated" | "delegated")).count();
    if moving > 0 {
        return Ok(());
    }
    let pending: Vec<&Item> = items.iter().filter(|i| i.status == "pending").collect();
    if !pending.is_empty() {
        if !team::ready_items(&run, &items).is_empty() {
            return Ok(());
        }
        // Blocked: everything left waits on something that failed or was skipped.
        let blocked = pending.iter().map(|i| format!("`{}` {}", i.key, i.title)).collect::<Vec<_>>().join(", ");
        return with(db, |c| {
            if !run.lead.is_empty() {
                let instruction = format!("El trabajo está bloqueado: estas tareas esperan a otras que fallaron o se cancelaron: {blocked}. Reasigna, cancela o termina.");
                if new_lead_item(c, &run, "plan", &instruction, "")?.is_some() {
                    return Ok(());
                }
                return Ok(());
            }
            team::set_run_status(c, run_id, "gated", "stuck:", &format!("Hay tareas bloqueadas: {blocked}.")).map_err(e2s)
        });
    }
    let unmerged: Vec<Item> = team::unmerged_work(&items).into_iter().cloned().collect();
    if !unmerged.is_empty() {
        for work in unmerged {
            integrate(db, &run, work).await?;
        }
        return Box::pin(advance(db, run_id)).await;
    }
    // The lead's last look.
    if !run.lead.is_empty() && !run.lead_done && run.policy.lead_final_check {
        let made = with(db, |c| {
            let made = new_lead_item(c, &run, "final", "Todo lo asignado está hecho. Revisa las entregas: si falta algo, asígnalo; si está completo, responde `\"terminar\": true`.", "")?;
            if let Some(mut final_item) = made.clone() {
                if let Some(advice) = new_advice(c, &run, "final", "El equipo cree que terminó. ¿Hay algo que se le escapó antes de integrar?")? {
                    final_item.depends_on.push(advice.id.clone());
                    team::update_item(c, &final_item).map_err(e2s)?;
                }
            }
            Ok(made)
        })?;
        if made.is_some() {
            return Ok(());
        }
        return Ok(());
    }
    // Final checks, in each integration tree.
    for repo in repos.iter().filter(|r| r.status == "ready") {
        for check in run.policy.checks.iter().filter(|c| c.when == "final" && (c.repo == "*" || c.repo == repo.project_id)) {
            let (passed, output) = crate::commands::agents_cmd::run_shell_check(&check.command, &repo.integration_path).await;
            with(db, |c| {
                team::post(c, run_id, "", ("system", "CodeFlow"), ("all", "Equipo"), if passed { "status" } else { "error" }, &format!("{} · `{}` {}", repo.name, check.command, if passed { "pasó" } else { "falló" }), &[])
                    .map(|_| ())
                    .map_err(e2s)
            })?;
            if !passed {
                return with(db, |c| {
                    if !run.lead.is_empty() {
                        team::set_lead_done(c, run_id, false).map_err(e2s)?;
                        let instruction = format!("En {} la verificación `{}` falló con todo integrado:\n{}\nAsigna quién lo arregla.", repo.name, check.command, trim_chars(&output, 6000));
                        if new_lead_item(c, &run, "plan", &instruction, "")?.is_some() {
                            return Ok(());
                        }
                        return Ok(());
                    }
                    team::set_run_status(c, run_id, "gated", "stuck:", &format!("`{}` falló en {}:\n{}", check.command, repo.name, trim_chars(&output, 2000))).map_err(e2s)
                });
            }
        }
    }
    if run.policy.integrate == "branch" {
        return with(db, |c| {
            for r in &repos {
                team::set_repo_status(c, run_id, &r.project_id, "left", "").map_err(e2s)?;
            }
            let names = repos.iter().map(|r| format!("{} → `{}`", r.name, r.integration_branch)).collect::<Vec<_>>().join(", ");
            team::post(c, run_id, "", ("system", "CodeFlow"), ("user", "Tú"), "merge", &format!("Trabajo listo en: {names}"), &[]).map_err(e2s)?;
            team::set_run_status(c, run_id, "done", "", "").map_err(e2s)
        });
    }
    if run.policy.approve_merge {
        let names = repos.iter().map(|r| format!("{} → {}", r.name, r.target_branch)).collect::<Vec<_>>().join(", ");
        return with(db, |c| team::set_run_status(c, run_id, "gated", "merge", &format!("Todo está hecho. ¿Integrar en {names}?")).map_err(e2s));
    }
    land_all(db, &run).await
}

/// Lands every ready repository on its target branch, by the policy.
async fn land_all(db: &Db, run: &Run) -> Result<(), String> {
    let repos = with(db, |c| team::list_repos(c, &run.id).map_err(e2s))?;
    for repo in repos.iter().filter(|r| r.status == "ready") {
        let (r, t, p, b, mode, push) = (
            repo.local_path.clone(),
            repo.target_branch.clone(),
            repo.integration_path.clone(),
            repo.integration_branch.clone(),
            run.policy.commit.clone(),
            run.policy.push,
        );
        let message = gitops::commit_message(&run.policy.commit_style, "", &run.title);
        let landed = blocking(move || {
            let _git = crate::git::write_lock();
            gitops::land(&r, &t, &p, &b, &mode, &message, push)
        })
        .await?;
        match landed {
            Ok(gitops::Landed::Done(summary)) => with(db, |c| {
                team::set_repo_status(c, &run.id, &repo.project_id, "merged", "").map_err(e2s)?;
                team::post(c, &run.id, "", ("system", "CodeFlow"), ("user", "Tú"), "merge", &format!("{}: {summary}", repo.name), &[]).map(|_| ()).map_err(e2s)
            })?,
            Ok(gitops::Landed::Conflict(files)) => {
                // The target moved and conflicts with the team's work: a member resolves it in the
                // integration tree, then the landing runs again.
                let resolver = match run.policy.conflicts.as_str() {
                    "user" | "author" | "" => None,
                    id => member(run, id).cloned(),
                }
                .or_else(|| run.members.iter().find(|m| m.member.edits && m.member.id != run.lead).cloned());
                return with(db, |c| match resolver.filter(|_| run.policy.conflicts != "user") {
                    Some(resolver) => {
                        let items = team::list_items(c, &run.id).map_err(e2s)?;
                        let mut fix = team::new_item(
                            run,
                            &team::free_key(&items, "merge-destino"),
                            Some(&resolver),
                            &repo.project_id,
                            "integrate",
                            &format!("Resolver conflictos con {}", repo.target_branch),
                            &format!("{} cambió mientras el equipo trabajaba y choca con el trabajo integrado. El merge está a medias en esta carpeta: resuelve los conflictos conservando ambos lados y quita las marcas (no hagas commit).", repo.target_branch),
                        );
                        fix.worktree_path = repo.integration_path.clone();
                        fix.approved = true;
                        fix.feedback = files.iter().map(|f| format!("- {f}")).collect::<Vec<_>>().join("\n");
                        team::insert_item(c, &fix).map_err(e2s)?;
                        Ok(())
                    }
                    None => team::set_run_status(c, &run.id, "gated", "stuck:", &format!("{} choca con {} en: {}. Resuélvelo en {} y aprueba.", repo.target_branch, repo.integration_branch, files.join(", "), repo.integration_path))
                        .map_err(e2s),
                });
            }
            Err(e) => {
                return with(db, |c| {
                    team::set_repo_status(c, &run.id, &repo.project_id, "failed", &e).map_err(e2s)?;
                    team::set_run_status(c, &run.id, "gated", "merge", &format!("{}: no se pudo integrar — {e}", repo.name)).map_err(e2s)
                });
            }
        }
    }
    // Everything landed: tidy up — the worktrees, and the branches whose work is now in the target.
    if run.policy.cleanup {
        tidy_run(db, &run.id).await?;
    }
    with(db, |c| team::set_run_status(c, &run.id, "done", "", "").map_err(e2s))
}

// ---------------------------------------------------------------- the user

/// Answers a question a member or the lead asked the user. Once every question an item asked is
/// answered, it goes on with the answers in front of it.
#[tauri::command]
pub async fn team_answer(app: AppHandle, db: State<'_, Db>, message_id: String, answer: String) -> Result<RunState, String> {
    let state = answer_question(&db, &message_id, &answer).await?;
    changed(&app, &state.run.id);
    Ok(state)
}

pub async fn answer_question(db: &Db, message_id: &str, answer: &str) -> Result<RunState, String> {
    let message_id = message_id.to_string();
    let answer = answer.to_string();
    let message = with(db, |c| team::get_message(c, &message_id).map_err(e2s)?.ok_or_else(|| "La pregunta ya no existe.".to_string()))?;
    let lock = run_lock(&message.run_id);
    let _guard = lock.lock().await;
    with(db, |c| {
        team::answer_message(c, &message_id, answer.trim()).map_err(e2s)?;
        let messages = team::list_messages(c, &message.run_id).map_err(e2s)?;
        let asked: Vec<&team::Message> = messages.iter().filter(|m| m.item_id == message.item_id && m.kind == "question" && m.to_id == "user").collect();
        if asked.iter().all(|m| !m.answer.is_empty() || m.id == message_id) {
            if let Some(mut item) = team::get_item(c, &message.item_id).map_err(e2s)? {
                if item.status == "waiting" {
                    let answers = asked
                        .iter()
                        .map(|m| format!("- {} → {}", m.body, if m.id == message_id { answer.trim().to_string() } else { m.answer.clone() }))
                        .collect::<Vec<_>>()
                        .join("\n");
                    item.status = "pending".into();
                    item.attempts = (item.attempts - 1).max(0);
                    item.feedback = format!("El usuario respondió:\n{answers}");
                    team::update_item(c, &item).map_err(e2s)?;
                }
            }
        }
        Ok(())
    })?;
    advance(db, &message.run_id).await?;
    state_of(db, &message.run_id)
}

/// A note from the user to a member, the lead or everyone — delivered with their next item.
#[tauri::command]
pub fn team_note(app: AppHandle, db: State<'_, Db>, run_id: String, to_id: String, body: String) -> Result<RunState, String> {
    if body.trim().is_empty() {
        return state_of(&db, &run_id);
    }
    with(&db, |c| {
        let run = team::get_run(c, &run_id).map_err(e2s)?.ok_or("La corrida ya no existe.")?;
        let to_name = match to_id.as_str() {
            "all" => "Equipo".to_string(),
            "lead" => lead_name(&run),
            id => member(&run, id).map(|m| m.member.name.clone()).unwrap_or_else(|| "Equipo".into()),
        };
        team::post(c, &run_id, "", ("user", "Tú"), (&to_id, &to_name), "note", body.trim(), &[]).map_err(e2s)?;
        Ok(())
    })?;
    changed(&app, &run_id);
    state_of(&db, &run_id)
}

/// Answers whatever a gated run waits for. `approve` false is "no": the plan goes back to the lead
/// (with `comment`), an item is skipped, the merge is left for later, a stuck run fails.
#[tauri::command]
pub async fn team_decide(app: AppHandle, db: State<'_, Db>, run_id: String, approve: bool, comment: Option<String>) -> Result<RunState, String> {
    let state = decide(&db, &run_id, approve, comment.as_deref().unwrap_or_default()).await?;
    changed(&app, &run_id);
    Ok(state)
}

pub async fn decide(db: &Db, run_id: &str, approve: bool, comment: &str) -> Result<RunState, String> {
    let run_id = run_id.to_string();
    let lock = run_lock(&run_id);
    let _guard = lock.lock().await;
    let comment = comment.trim().to_string();
    let run = with(db, |c| team::get_run(c, &run_id).map_err(e2s)?.ok_or_else(|| "La corrida ya no existe.".to_string()))?;
    if run.status != "gated" {
        return state_of(db, &run_id);
    }
    if !comment.is_empty() {
        with(db, |c| team::post(c, &run_id, "", ("user", "Tú"), ("all", "Equipo"), "note", &comment, &[]).map(|_| ()).map_err(e2s))?;
    }
    let gate = run.gate.clone();
    let mut land = false;
    with(db, |c| {
        if gate == "plan" {
            if approve {
                return team::set_run_status(c, &run_id, "running", "", "").map_err(e2s);
            }
            let items = team::list_items(c, &run_id).map_err(e2s)?;
            for mut i in items.into_iter().filter(|i| i.status == "pending" && !i.is_lead()) {
                i.status = "skipped".into();
                team::update_item(c, &i).map_err(e2s)?;
            }
            team::set_run_status(c, &run_id, "running", "", "").map_err(e2s)?;
            let instruction = format!("El usuario rechazó el plan{}. Propón otro.", if comment.is_empty() { String::new() } else { format!(": «{comment}»") });
            new_lead_item(c, &run, "plan", &instruction, "")?;
            return Ok(());
        }
        if let Some(id) = gate.strip_prefix("item:") {
            if let Some(mut item) = team::get_item(c, id).map_err(e2s)? {
                if approve {
                    item.status = "pending".into();
                    item.approved = true;
                } else {
                    item.status = "skipped".into();
                }
                team::update_item(c, &item).map_err(e2s)?;
            }
            return team::set_run_status(c, &run_id, "running", "", "").map_err(e2s);
        }
        if gate == "merge" {
            if approve {
                land = true;
                return team::set_run_status(c, &run_id, "running", "", "").map_err(e2s);
            }
            let repos = team::list_repos(c, &run_id).map_err(e2s)?;
            for r in repos.iter().filter(|r| r.status == "ready" || r.status == "failed") {
                team::set_repo_status(c, &run_id, &r.project_id, "left", "").map_err(e2s)?;
            }
            team::post(c, &run_id, "", ("system", "CodeFlow"), ("user", "Tú"), "merge", "No se integró: el trabajo queda en las ramas del equipo.", &[]).map_err(e2s)?;
            return team::set_run_status(c, &run_id, "done", "", "").map_err(e2s);
        }
        if let Some(id) = gate.strip_prefix("review:") {
            if approve {
                // Integrate anyway: the advance below merges every unmerged done work item.
                team::set_run_status(c, &run_id, "running", "", "").map_err(e2s)?;
            } else {
                if let Some(mut item) = team::get_item(c, id).map_err(e2s)? {
                    item.status = "skipped".into();
                    team::update_item(c, &item).map_err(e2s)?;
                }
                team::set_run_status(c, &run_id, "running", "", "").map_err(e2s)?;
            }
            return Ok(());
        }
        if gate == "budget" {
            if !approve {
                return team::set_run_status(c, &run_id, "failed", "", "").map_err(e2s);
            }
            // Approving is «give it more»: every budget it ran out of grows by half.
            let mut policy = run.policy.clone();
            let spend = team::metrics::spend(c, &run_id).map_err(e2s)?;
            let (usd, tokens) = spend.values().fold((0.0, 0i64), |(u, t), (du, dt)| (u + du, t + dt));
            let minutes = team::metrics::agent_minutes(&team::list_items(c, &run_id).map_err(e2s)?, chrono::Utc::now());
            if policy.budget_usd > 0.0 && usd >= policy.budget_usd {
                policy.budget_usd = (policy.budget_usd * 1.5 * 100.0).round() / 100.0;
            }
            if policy.budget_tokens > 0 && tokens >= policy.budget_tokens {
                policy.budget_tokens = policy.budget_tokens * 3 / 2;
            }
            if policy.budget_minutes > 0 && minutes >= policy.budget_minutes as f64 {
                policy.budget_minutes = policy.budget_minutes * 3 / 2;
            }
            set_run_policy(c, &run_id, &policy)?;
            if policy.unmetered_minutes > 0 && unmetered_over(&run, &team::list_items(c, &run_id).map_err(e2s)?).is_some() {
                policy.unmetered_minutes *= 2;
            }
            // Past the plan cap: start counting again from here, another cap's worth.
            c.execute("DELETE FROM app_settings WHERE key = ?1", rusqlite::params![session_base_key(&run_id)]).map_err(e2s)?;
            return team::set_run_status(c, &run_id, "running", "", "").map_err(e2s);
        }
        if let Some(id) = gate.strip_prefix("stuck:") {
            if !approve {
                return team::set_run_status(c, &run_id, "failed", "", "").map_err(e2s);
            }
            if let Some(mut item) = team::get_item(c, id).map_err(e2s)? {
                if matches!(item.status.as_str(), "error" | "done") {
                    if item.status == "error" {
                        item.status = "pending".into();
                        item.attempts = 0;
                        if !comment.is_empty() {
                            item.feedback = format!("El usuario dice: {comment}");
                        }
                        team::update_item(c, &item).map_err(e2s)?;
                    }
                }
            }
            // More budget when that is what stopped it — a quarter more, never a fresh full allowance:
            // resetting to zero handed a looping team its whole budget again on every «seguir».
            let more = (run.policy.max_dispatches / 4).max(4);
            c.execute(
                "UPDATE agent_team_runs SET dispatches = MAX(0, dispatches - ?2), lead_rounds_used = MAX(0, lead_rounds_used - 1) WHERE id = ?1 AND (gate_note LIKE '%presupuesto%' OR gate_note LIKE '%rondas%')",
                rusqlite::params![run_id, more],
            )
            .map_err(e2s)?;
            return team::set_run_status(c, &run_id, "running", "", "").map_err(e2s);
        }
        team::set_run_status(c, &run_id, "running", "", "").map_err(e2s)
    })?;
    if land {
        let run = with(db, |c| team::get_run(c, &run_id).map_err(e2s)?.ok_or_else(|| "La corrida ya no existe.".to_string()))?;
        land_all(db, &run).await?;
    } else {
        advance(db, &run_id).await?;
    }
    state_of(db, &run_id)
}

/// `pause`, `resume`, `abort`, or per item `retry:<id>` / `skip:<id>`. Returns the tasks that were
/// running, so the caller can stop their turns on `abort`.
#[tauri::command]
pub async fn team_control(app: AppHandle, db: State<'_, Db>, run_id: String, action: String) -> Result<Vec<String>, String> {
    let lock = run_lock(&run_id);
    let _guard = lock.lock().await;
    let running = with(&db, |c| {
        let items = team::list_items(c, &run_id).map_err(e2s)?;
        let running: Vec<String> = items.iter().filter(|i| i.status == "running" && !i.task_id.is_empty()).map(|i| i.task_id.clone()).collect();
        match action.as_str() {
            "pause" => team::set_run_status(c, &run_id, "paused", "", "").map_err(e2s)?,
            "resume" => {
                team::set_run_reason(c, &run_id, "").map_err(e2s)?;
                team::set_run_status(c, &run_id, "running", "", "").map_err(e2s)?
            }
            "abort" => {
                for mut i in items.into_iter().filter(|i| matches!(i.status.as_str(), "pending" | "gated" | "running" | "waiting")) {
                    i.status = "cancelled".into();
                    team::update_item(c, &i).map_err(e2s)?;
                }
                team::set_run_status(c, &run_id, "aborted", "", "").map_err(e2s)?;
                crate::runner::cancel_run(&run_id);
            }
            other => {
                if let Some(id) = other.strip_prefix("retry:") {
                    if let Some(mut i) = team::get_item(c, id).map_err(e2s)? {
                        if matches!(i.status.as_str(), "error" | "cancelled" | "skipped") {
                            i.status = "pending".into();
                            i.attempts = 0;
                            team::update_item(c, &i).map_err(e2s)?;
                        }
                    }
                } else if let Some(id) = other.strip_prefix("skip:") {
                    if let Some(mut i) = team::get_item(c, id).map_err(e2s)? {
                        if matches!(i.status.as_str(), "pending" | "gated" | "error" | "waiting") {
                            i.status = "skipped".into();
                            team::update_item(c, &i).map_err(e2s)?;
                        }
                    }
                }
            }
        }
        Ok(running)
    })?;
    if action != "abort" && action != "pause" {
        advance(&db, &run_id).await?;
    }
    if action == "abort" {
        // A cancelled run leaves nothing behind but work: clean worktrees and empty branches go.
        let _ = tidy_run(&db, &run_id).await;
    }
    changed(&app, &run_id);
    Ok(running)
}

/// Removes a run's worktrees (only clean ones — `git worktree remove` without force) and then every
/// run branch whose commits are all in the target branch already: the item branches and, unless the
/// run leaves it for you (`integrate: branch`), the integration branch. A branch holding work that
/// never reached the target — a cancelled member's commits, a dirty worktree's branch — stays.
async fn tidy_run(db: &Db, run_id: &str) -> Result<(), String> {
    let (run, repos, items) = with(db, |c| {
        let run = team::get_run(c, run_id).map_err(e2s)?;
        Ok((run, team::list_repos(c, run_id).map_err(e2s)?, team::list_items(c, run_id).map_err(e2s)?))
    })?;
    let keep_integration = run.as_ref().is_some_and(|r| r.policy.integrate == "branch");
    for repo in repos {
        let mine: Vec<&Item> = items.iter().filter(|i| i.project_id == repo.project_id).collect();
        let mut paths: Vec<String> = mine.iter().map(|i| i.worktree_path.clone()).filter(|p| !p.is_empty()).collect();
        paths.push(repo.integration_path.clone());
        paths.sort();
        paths.dedup();
        let mut branches: Vec<String> = mine.iter().map(|i| i.branch.clone()).filter(|b| !b.is_empty()).collect();
        branches.sort();
        branches.dedup();
        let (r, target, integration) = (repo.local_path.clone(), repo.target_branch.clone(), repo.integration_branch.clone());
        let _ = blocking(move || {
            let _git = crate::git::write_lock();
            for p in &paths {
                gitops::remove_worktree(&r, p);
            }
            // Item branches into the integration branch they were merged into, when that one stays.
            let into = if keep_integration { &integration } else { &target };
            for b in &branches {
                gitops::delete_branch_if_contained(&r, b, into);
            }
            if !keep_integration {
                gitops::delete_branch_if_contained(&r, &integration, &target);
            }
        })
        .await;
    }
    Ok(())
}

fn set_run_policy(conn: &Connection, run_id: &str, policy: &Policy) -> Result<(), String> {
    let policy = policy.clone().sane();
    conn.execute(
        "UPDATE agent_team_runs SET policy = ?2, updated_at = ?3 WHERE id = ?1",
        rusqlite::params![run_id, serde_json::to_string(&policy).map_err(e2s)?, queries::now()],
    )
    .map_err(e2s)?;
    Ok(())
}

/// Edits a running run's own copy of the policy — a budget raised, the parallelism or the
/// communication rules changed from the live view — without touching the team.
#[tauri::command]
pub async fn team_run_policy(app: AppHandle, db: State<'_, Db>, run_id: String, policy: Policy) -> Result<RunState, String> {
    {
        let lock = run_lock(&run_id);
        let _guard = lock.lock().await;
        with(&db, |c| set_run_policy(c, &run_id, &policy))?;
    }
    changed(&app, &run_id);
    state_of(&db, &run_id)
}

/// The artifacts a run's members published, newest first — the record the run's views draw.
#[tauri::command]
pub fn team_run_artifacts(db: State<'_, Db>, run_id: String) -> Result<Vec<crate::chat_refs::artifacts::ArtifactSummary>, String> {
    with(&db, |c| {
        let run = team::get_run(c, &run_id).map_err(e2s)?.ok_or("La corrida ya no existe.")?;
        let items = team::list_items(c, &run_id).map_err(e2s)?;
        let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        let mut out = crate::chat_refs::artifacts::list(c, &run.workspace_id, Some(&format!("team:{run_id}"))).map_err(e2s)?;
        for task_id in items.iter().map(|i| i.task_id.as_str()).filter(|t| !t.is_empty()).collect::<std::collections::BTreeSet<_>>() {
            if let Some(task) = queries::get_agent_task(c, task_id).map_err(e2s)? {
                for a in crate::chat_refs::artifacts::list(c, &run.workspace_id, Some(&task.conversation_id)).map_err(e2s)? {
                    if !out.iter().any(|x| x.name == a.name && x.version == a.version) {
                        out.push(a);
                    }
                }
            }
        }
        out.retain(|a| a.surface != "team" || ids.contains(&a.message_id.as_str()));
        out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(out)
    })
}

/// Spend per member, who talks to whom, and the alerts the live view shows.
#[tauri::command]
pub fn team_run_metrics(db: State<'_, Db>, run_id: String) -> Result<team::metrics::RunMetrics, String> {
    with(&db, |c| {
        let run = team::get_run(c, &run_id).map_err(e2s)?.ok_or("La corrida ya no existe.")?;
        let items = team::list_items(c, &run_id).map_err(e2s)?;
        let messages = team::list_messages(c, &run_id).map_err(e2s)?;
        let spend = team::metrics::spend(c, &run_id).map_err(e2s)?;
        Ok(team::metrics::compute(&run, &items, &messages, &spend, chrono::Utc::now()))
    })
}

/// Records the terminal session an item runs in (so the view can open it).
#[tauri::command]
pub fn team_item_terminal(db: State<'_, Db>, item_id: String, session_id: String) -> Result<(), String> {
    with(&db, |c| {
        c.execute("UPDATE agent_team_items SET terminal_session = ?2 WHERE id = ?1", rusqlite::params![item_id, session_id]).map_err(e2s)?;
        Ok(())
    })
}

/// Deletes a run with its tasks, its clean worktrees and the branches with nothing of their own.
#[tauri::command]
pub async fn team_delete_run(db: State<'_, Db>, run_id: String) -> Result<(), String> {
    crate::runner::cancel_run(&run_id);
    team::artifacts::forget(&run_id, &[]);
    tidy_run(&db, &run_id).await?;
    with(&db, |c| {
        crate::crew::delete_decisions_for_run(c, &run_id).map_err(e2s)?;
        team::delete_run(c, &run_id).map_err(e2s)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_run_will_not_deliver_to_a_locked_branch() {
        let (_serial, _dir, db, ws, project, [lead, dev, _qa]) = fixture();
        let repo = with(&db, |c| Ok(queries::get_project(c, &project).unwrap().unwrap().local_path)).unwrap();
        sh(&repo, &["config", "branch.main.codeflowLocked", "true"]);
        let member = |id: &str, agent: &str| team::Member { id: id.into(), agent_id: agent.into(), name: id.into(), edits: true, ..Default::default() };
        let tm = with(&db, |c| {
            team::save_team(c, team::Team { workspace_id: ws.clone(), name: "Equipo".into(), lead: "l".into(), members: vec![member("l", &lead), member("d", &dev)], ..Default::default() })
        })
        .unwrap();
        let err = start_run(&db, ws.clone(), tm.id.clone(), "x".into(), None, vec![RepoPick { project_id: project.clone(), target_branch: "main".into() }], None, None).await.unwrap_err();
        assert!(err.contains("bloqueada"), "{err}");
    }

    #[test]
    fn session_use_counts_from_the_start_and_across_a_rollover() {
        assert_eq!(session_used((40.0, "100"), (55.0, "100")), 15.0);
        assert_eq!(session_used((40.0, "100"), (30.0, "100")), 0.0);
        // The window rolled over: the 60 points left of the old one, plus 10 of the new.
        assert_eq!(session_used((40.0, "100"), (10.0, "18100")), 70.0);
        // A reset instant that jitters between reads is the same window, not a rollover.
        assert_eq!(session_used((40.0, "2026-11-04T20:00:00+00:00"), (41.0, "2026-11-04T20:00:07+00:00")), 1.0);
        assert_eq!(session_used((40.0, "2026-11-04T20:00:00+00:00"), (40.0, "2026-11-04T20:00:03+00:00")), 0.0);
    }
    use std::path::Path;

    fn sh(dir: &str, args: &[&str]) {
        let out = crate::git::cli::run_in(dir, args, &[]).unwrap();
        assert!(out.success, "git {args:?}: {}", out.detail());
    }

    struct Dir(std::path::PathBuf);
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// The worktree root is process-wide: tests that set it take turns.
    static SERIAL: Mutex<()> = Mutex::new(());

    fn fixture() -> (std::sync::MutexGuard<'static, ()>, Dir, Db, String, String, [String; 3]) {
        let serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let dir = Dir(std::env::temp_dir().join(format!("cf-teamrun-{}", uuid::Uuid::new_v4())));
        let repo = dir.0.join("repo").to_string_lossy().into_owned();
        std::fs::create_dir_all(&repo).unwrap();
        sh(&repo, &["init", "-q", "-b", "main"]);
        sh(&repo, &["config", "user.email", "t@example.com"]);
        sh(&repo, &["config", "user.name", "T"]);
        std::fs::write(Path::new(&repo).join("README.md"), "hola\n").unwrap();
        sh(&repo, &["add", "-A"]);
        sh(&repo, &["commit", "-q", "-m", "init"]);
        // `main` is locked by the app's default rules; these runs deliver to it on purpose.
        // Pinned in the repo's own config rather than through `set_branch_locked`, which writes
        // nothing when the shared rule list (other tests change it) happens to agree.
        sh(&repo, &["config", "branch.main.codeflowLocked", "false"]);
        *WORKTREE_ROOT.lock().unwrap() = Some(dir.0.join("worktrees"));

        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        let ws = queries::create_workspace(&conn, "ws", "folder", "#fff").unwrap();
        let project: crate::db::models::NewProject = serde_json::from_value(serde_json::json!({
            "workspace_id": ws.id, "name": "web", "local_path": repo, "remote_url": null, "color": "#fff", "icon": "folder"
        }))
        .unwrap();
        let project = queries::create_project(&conn, project).unwrap();
        let lead = queries::upsert_workspace_agent(&conn, None, &ws.id, "Líder", "lidera", "claude", "sonnet", "", true, None).unwrap();
        let dev = queries::upsert_workspace_agent(&conn, None, &ws.id, "Dev", "programa", "claude", "sonnet", "", true, None).unwrap();
        let qa = queries::upsert_workspace_agent(&conn, None, &ws.id, "QA", "revisa", "claude", "haiku", "", true, None).unwrap();
        let ids = [lead.id, dev.id, qa.id];
        (serial, dir, Db::new(conn), ws.id, project.id, ids)
    }

    fn item_of<'a>(state: &'a RunState, key: &str) -> &'a Item {
        state.items.iter().find(|i| i.key == key).unwrap_or_else(|| panic!("no item {key}: {:?}", state.items.iter().map(|i| &i.key).collect::<Vec<_>>()))
    }

    #[tokio::test]
    async fn a_small_request_skips_the_advisor_and_the_lead_s_last_look() {
        let (_serial, _dir, db, ws, project, [lead, dev, adv]) = fixture();
        let member = |id: &str, agent: &str, name: &str, edits: bool, advisor: bool| team::Member {
            id: id.into(),
            agent_id: agent.into(),
            name: name.into(),
            edits,
            advisor,
            max_parallel: 1,
            ..Default::default()
        };
        let mut policy = Policy::default();
        policy.approve_plan = false;
        policy.approve_merge = false;
        let tm = with(&db, |c| {
            team::save_team(
                c,
                team::Team {
                    workspace_id: ws.clone(),
                    name: "Equipo".into(),
                    lead: "l".into(),
                    policy,
                    members: vec![member("l", &lead, "Líder", false, false), member("d", &dev, "Dev", true, false), member("a", &adv, "Asesor", false, true)],
                    ..Default::default()
                },
            )
        })
        .unwrap();
        let state = start_run(&db, ws.clone(), tm.id.clone(), "Cambia el color del botón".into(), None, vec![RepoPick { project_id: project.clone(), target_branch: String::new() }], None, None)
            .await
            .unwrap();
        let run_id = state.run.id.clone();
        let d = claim(&db, &run_id).await.unwrap();
        assert!(d[0].message.contains("\"chico\""), "the lead is told it can say so");
        let plan = "Es chico.\n```equipo\n{\"items\":[{\"id\":\"color\",\"miembro\":\"dev\",\"tarea\":\"cambia el color\"}],\"chico\":true}\n```";
        settle_core(&db, &d[0].item.id, "ok", plan, "").await.unwrap();

        // Straight to the dev: no advisor reading the plan.
        let d = claim(&db, &run_id).await.unwrap();
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].item.key, "color");
        std::fs::write(Path::new(&d[0].cwd).join("boton.css"), "button { color: red }\n").unwrap();
        let state = settle_core(&db, &d[0].item.id, "ok", "Listo.", "").await.unwrap();

        // Delivered, merged and landed: no last look of the lead's, no advisor before finishing.
        assert_eq!(state.run.status, "done", "{}", state.run.last_reason);
        assert!(state.items.iter().all(|i| i.kind != "advise" && i.kind != "final"), "{:?}", state.items.iter().map(|i| &i.kind).collect::<Vec<_>>());
        assert!(claim(&db, &run_id).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_plan_called_small_that_spreads_work_runs_as_a_normal_one() {
        let plan_of = |members: &[&str], repos: &[&str]| -> Vec<Item> {
            members.iter().zip(repos).map(|(m, r)| Item { member_id: m.to_string(), project_id: r.to_string(), kind: "work".into(), ..Default::default() }).collect()
        };
        assert!(is_small(&plan_of(&["d"], &["p1"])));
        assert!(is_small(&plan_of(&["d", "d"], &["p1", "p2"])), "one task in each repository that changes");
        assert!(!is_small(&plan_of(&["d", "q"], &["p1", "p2"])), "two members");
        assert!(!is_small(&plan_of(&["d", "d"], &["p1", "p1"])), "two tasks in one repository");
        assert!(!is_small(&[]));
    }

    #[tokio::test]
    async fn a_led_team_plans_works_in_parallel_reviews_and_lands_on_main() {
        let (_serial, _dir, db, ws, project, [lead, dev, qa]) = fixture();
        let member = |id: &str, agent: &str, name: &str, edits: bool| team::Member {
            id: id.into(),
            agent_id: agent.into(),
            name: name.into(),
            edits,
            max_parallel: 2,
            ..Default::default()
        };
        let mut policy = Policy::default();
        policy.review = team::ReviewPolicy { enabled: true, reviewer: "q".into(), ..Default::default() };
        let tm = with(&db, |c| {
            team::save_team(
                c,
                team::Team {
                    workspace_id: ws.clone(),
                    name: "Equipo".into(),
                    lead: "l".into(),
                    policy,
                    members: vec![member("l", &lead, "Líder", false), member("d", &dev, "Dev", true), member("q", &qa, "QA", false)],
                    ..Default::default()
                },
            )
        })
        .unwrap();

        let state = start_run(&db, ws.clone(), tm.id.clone(), "Crea a, b y c".into(), None, vec![RepoPick { project_id: project.clone(), target_branch: String::new() }], None, None)
            .await
            .unwrap();
        assert_eq!(state.repos[0].target_branch, "main");
        let integ = state.repos[0].integration_path.clone();
        assert!(Path::new(&integ).join("README.md").exists());

        // The lead plans: a and b in parallel, c after both.
        let run_id = state.run.id.clone();
        let d = claim(&db, &run_id).await.unwrap();
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].item.kind, "plan");
        assert_eq!(d[0].cwd, integ);
        assert!(d[0].message.contains("**Dev**"));
        let plan = "Reparto.\n```equipo\n{\"mensaje\":\"a y b a la vez\",\"items\":[\
            {\"id\":\"a\",\"miembro\":\"dev\",\"tarea\":\"crea a.txt\"},\
            {\"id\":\"b\",\"miembro\":\"Dev\",\"tarea\":\"crea b.txt\"},\
            {\"id\":\"c\",\"miembro\":\"dev\",\"tarea\":\"crea c.txt\",\"depende_de\":[\"a\",\"b\"]}]}\n```";
        let state = settle_core(&db, &d[0].item.id, "ok", plan, "").await.unwrap();
        assert_eq!(state.run.status, "gated");
        assert_eq!(state.run.gate, "plan");
        assert!(claim(&db, &run_id).await.unwrap().is_empty(), "nothing starts before the plan is approved");
        decide(&db, &run_id, true, "").await.unwrap();

        // a and b at once, each in its own worktree.
        let d = claim(&db, &run_id).await.unwrap();
        let keys: Vec<&str> = d.iter().map(|x| x.item.key.as_str()).collect();
        assert_eq!(keys, vec!["a", "b"]);
        assert_ne!(d[0].cwd, d[1].cwd);
        for x in &d {
            std::fs::write(Path::new(&x.cwd).join(format!("{}.txt", x.item.key)), "x\n").unwrap();
        }
        settle_core(&db, &d[0].item.id, "ok", "Hecho a.\n```equipo\n{\"para\":\"qa\",\"texto\":\"mira a.txt\"}\n```", "").await.unwrap();
        let state = settle_core(&db, &d[1].item.id, "ok", "Hecho b.", "").await.unwrap();
        assert!(!item_of(&state, "a").commit_sha.is_empty());
        assert!(state.messages.iter().any(|m| m.kind == "note" && m.to_name == "QA"));

        // QA reviews both, read only; one is sent back once.
        let d = claim(&db, &run_id).await.unwrap();
        assert_eq!(d.len(), 2);
        assert!(d.iter().all(|x| x.item.kind == "review"));
        assert!(d.iter().any(|x| x.message.contains("mira a.txt")), "the note reaches the reviewer");
        let rev_a = d.iter().find(|x| x.item.key == "a-rev").unwrap();
        let rev_b = d.iter().find(|x| x.item.key == "b-rev").unwrap();
        settle_core(&db, &rev_a.item.id, "ok", "VERDICT: FIX\nFINDINGS:\n- [must] a.txt:1 — vacío — escribe algo", "").await.unwrap();
        let state = settle_core(&db, &rev_b.item.id, "ok", "VERDICT: OK", "").await.unwrap();
        assert!(item_of(&state, "b").merged);
        assert!(!item_of(&state, "a").merged);

        // The fix continues a's task in a's worktree, then passes review.
        let d = claim(&db, &run_id).await.unwrap();
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].item.key, "a-fix");
        assert_eq!(d[0].cwd, item_of(&state, "a").worktree_path);
        assert_eq!(d[0].task.as_ref().map(|t| t.id.clone()), Some(item_of(&state, "a").task_id.clone()));
        std::fs::write(Path::new(&d[0].cwd).join("a.txt"), "algo\n").unwrap();
        settle_core(&db, &d[0].item.id, "ok", "Arreglado.", "").await.unwrap();
        let d = claim(&db, &run_id).await.unwrap();
        assert_eq!(d[0].item.kind, "review");
        let state = settle_core(&db, &d[0].item.id, "ok", "VERDICT: OK", "").await.unwrap();
        assert!(item_of(&state, "a").merged);

        // c starts from the integrated work.
        let d = claim(&db, &run_id).await.unwrap();
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].item.key, "c");
        assert!(Path::new(&d[0].cwd).join("a.txt").exists() && Path::new(&d[0].cwd).join("b.txt").exists());
        assert!(d[0].message.contains("Hecho a."), "c receives both handoffs");
        std::fs::write(Path::new(&d[0].cwd).join("c.txt"), "c\n").unwrap();
        settle_core(&db, &d[0].item.id, "ok", "Hecho c.", "").await.unwrap();
        let d = claim(&db, &run_id).await.unwrap();
        settle_core(&db, &d[0].item.id, "ok", "VERDICT: OK", "").await.unwrap();

        // The lead's last look, then the merge gate.
        let d = claim(&db, &run_id).await.unwrap();
        assert_eq!(d[0].item.kind, "final");
        let state = settle_core(&db, &d[0].item.id, "ok", "Completo.\n```equipo\n{\"terminar\":true}\n```", "").await.unwrap();
        assert_eq!(state.run.gate, "merge");
        let repo = state.repos[0].local_path.clone();
        assert!(!Path::new(&repo).join("a.txt").exists());
        let state = decide(&db, &run_id, true, "").await.unwrap();
        assert_eq!(state.run.status, "done", "{:?}", state.run.gate_note);
        for f in ["a.txt", "b.txt", "c.txt"] {
            assert!(Path::new(&repo).join(f).exists(), "{f} landed on main");
        }
        assert_eq!(std::fs::read_to_string(Path::new(&repo).join("a.txt")).unwrap(), "algo\n");
        assert!(!Path::new(&integ).exists(), "worktrees cleaned up");
        let left = crate::git::cli::run_in(&repo, &["branch", "--list", "codeflow/*"], &[]).unwrap().stdout;
        assert!(left.trim().is_empty(), "the run's branches are gone once their work is in main: {left}");
    }

    #[tokio::test]
    async fn a_sub_lead_plans_its_branch_and_hands_the_summary_up() {
        let (_serial, _dir, db, ws, project, [lead, dev, qa]) = fixture();
        let member = |id: &str, agent: &str, name: &str, edits: bool, reports_to: &str, leads: bool| team::Member {
            id: id.into(),
            agent_id: agent.into(),
            name: name.into(),
            edits,
            reports_to: reports_to.into(),
            leads,
            ..Default::default()
        };
        let mut policy = Policy::default();
        policy.approve_plan = false;
        policy.comms = "tree".into();
        let tm = with(&db, |c| {
            team::save_team(
                c,
                team::Team {
                    workspace_id: ws.clone(),
                    name: "Equipo".into(),
                    lead: "l".into(),
                    policy,
                    members: vec![
                        member("l", &lead, "Líder", false, "", false),
                        member("s", &qa, "Sub", false, "l", true),
                        member("d", &dev, "Dev", true, "s", false),
                    ],
                    ..Default::default()
                },
            )
        })
        .unwrap();
        // A cycle is refused before anything runs.
        let cyclic = with(&db, |c| {
            team::save_team(
                c,
                team::Team {
                    workspace_id: ws.clone(),
                    name: "Ciclo".into(),
                    lead: "l".into(),
                    members: vec![member("l", &lead, "Líder", false, "", false), member("a", &dev, "A", true, "b", false), member("b", &qa, "B", true, "a", false)],
                    ..Default::default()
                },
            )
        });
        assert!(cyclic.unwrap_err().contains("ciclo"));

        let state = start_run(&db, ws.clone(), tm.id.clone(), "Crea d.txt".into(), None, vec![RepoPick { project_id: project.clone(), target_branch: String::new() }], None, None)
            .await
            .unwrap();
        let run_id = state.run.id.clone();

        // The lead hands the whole branch to the sub-lead: that becomes a delegate, not work.
        let d = claim(&db, &run_id).await.unwrap();
        assert_eq!(d[0].item.kind, "plan");
        settle_core(&db, &d[0].item.id, "ok", "```equipo\n{\"items\":[{\"id\":\"rama\",\"miembro\":\"Sub\",\"tarea\":\"organiza: crea d.txt\"}]}\n```", "").await.unwrap();
        let d = claim(&db, &run_id).await.unwrap();
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].item.kind, "delegate");
        assert!(d[0].message.contains("Planificas tu propia rama"));
        assert!(d[0].message.contains("**Dev**") && !d[0].message.contains("**Líder**"), "a sub-lead sees only its branch");

        // The sub-lead plans for its report; the branch stays open while that runs.
        let delegate_id = d[0].item.id.clone();
        let state = settle_core(&db, &delegate_id, "ok", "```equipo\n{\"items\":[{\"id\":\"d\",\"miembro\":\"Dev\",\"tarea\":\"crea d.txt\"}]}\n```", "").await.unwrap();
        assert_eq!(item_of(&state, "rama").status, "delegated");
        assert_eq!(item_of(&state, "d").parent, delegate_id);

        // The member reports «to the lead»: with tree comms that is its sub-lead.
        let d = claim(&db, &run_id).await.unwrap();
        assert_eq!(d[0].item.key, "d");
        std::fs::write(Path::new(&d[0].cwd).join("d.txt"), "d\n").unwrap();
        let state = settle_core(&db, &d[0].item.id, "ok", "Hecho.\n```equipo\n{\"para\":\"líder\",\"texto\":\"listo d\"}\n```", "").await.unwrap();
        assert!(state.messages.iter().any(|m| m.kind == "note" && m.to_name == "Sub" && m.body.contains("listo d")));
        assert!(item_of(&state, "d").merged);

        // With its work closed, the branch closes and hands its summary up.
        let rama = item_of(&state, "rama");
        assert_eq!(rama.status, "done", "{rama:?}");
        assert!(rama.output_text.contains("`d`"));

        // The lead's last look and the merge.
        let d = claim(&db, &run_id).await.unwrap();
        assert_eq!(d[0].item.kind, "final");
        let state = settle_core(&db, &d[0].item.id, "ok", "```equipo\n{\"terminar\":true}\n```", "").await.unwrap();
        assert_eq!(state.run.gate, "merge");
        let state = decide(&db, &run_id, true, "").await.unwrap();
        assert_eq!(state.run.status, "done", "{:?}", state.run.gate_note);
    }

    #[tokio::test]
    async fn the_lead_sees_its_areas_and_a_small_change_through_a_sub_lead_skips_the_ceremony() {
        let (_serial, _dir, db, ws, project, [lead, dev, qa]) = fixture();
        let member = |id: &str, agent: &str, name: &str, edits: bool, boss: &str, leads: bool| team::Member {
            id: id.into(),
            agent_id: agent.into(),
            name: name.into(),
            edits,
            reports_to: boss.into(),
            leads,
            ..Default::default()
        };
        let mut policy = Policy::default();
        policy.approve_plan = false;
        policy.approve_merge = false;
        let tm = with(&db, |c| {
            team::save_team(
                c,
                team::Team {
                    workspace_id: ws.clone(),
                    name: "Equipo".into(),
                    lead: "l".into(),
                    policy,
                    members: vec![
                        member("l", &lead, "Tech lead", false, "", false),
                        member("s", &qa, "Líder backend", false, "l", true),
                        member("d", &dev, "Dev backend", true, "s", false),
                    ],
                    ..Default::default()
                },
            )
        })
        .unwrap();
        let state = start_run(&db, ws.clone(), tm.id.clone(), "Cambia el timeout de la API".into(), None, vec![RepoPick { project_id: project.clone(), target_branch: String::new() }], None, None)
            .await
            .unwrap();
        let run_id = state.run.id.clone();
        let d = claim(&db, &run_id).await.unwrap();
        assert!(d[0].message.contains("**sub-líder**") && d[0].message.contains("entre Dev backend"), "{}", d[0].message);
        assert!(d[0].message.contains("en el área de Líder backend"), "{}", d[0].message);
        assert!(d[0].message.contains("Áreas con sub-líder"));

        // The lead hands it to the backend's sub-lead and calls it small.
        let plan = "```equipo\n{\"items\":[{\"id\":\"api\",\"miembro\":\"Líder backend\",\"tarea\":\"sube el timeout\"}],\"chico\":true}\n```";
        settle_core(&db, &d[0].item.id, "ok", plan, "").await.unwrap();
        let d = claim(&db, &run_id).await.unwrap();
        assert_eq!(d[0].item.kind, "delegate");
        settle_core(&db, &d[0].item.id, "ok", "```equipo\n{\"items\":[{\"id\":\"t\",\"miembro\":\"Dev backend\",\"tarea\":\"sube el timeout a 30 s\"}]}\n```", "").await.unwrap();
        let d = claim(&db, &run_id).await.unwrap();
        assert_eq!(d[0].item.member_name, "Dev backend");
        std::fs::write(Path::new(&d[0].cwd).join("timeout.txt"), "30\n").unwrap();
        let state = settle_core(&db, &d[0].item.id, "ok", "Listo.", "").await.unwrap();
        assert_eq!(state.run.status, "done", "{}", state.run.last_reason);
        assert!(state.items.iter().all(|i| i.kind != "final" && i.kind != "advise"));
    }

    #[tokio::test]
    async fn a_run_over_its_budget_waits_and_approval_grows_it() {
        let (_serial, _dir, db, ws, project, [lead, dev, _qa]) = fixture();
        let mut policy = Policy::default();
        policy.approve_plan = false;
        policy.budget_usd = 0.5;
        let tm = with(&db, |c| {
            team::save_team(
                c,
                team::Team {
                    workspace_id: ws.clone(),
                    name: "Equipo".into(),
                    lead: "l".into(),
                    policy,
                    members: vec![
                        team::Member { id: "l".into(), agent_id: lead.clone(), name: "Líder".into(), edits: false, ..Default::default() },
                        team::Member { id: "d".into(), agent_id: dev.clone(), name: "Dev".into(), ..Default::default() },
                    ],
                    ..Default::default()
                },
            )
        })
        .unwrap();
        let state = start_run(&db, ws.clone(), tm.id.clone(), "Crea x".into(), None, vec![RepoPick { project_id: project.clone(), target_branch: String::new() }], None, None)
            .await
            .unwrap();
        let run_id = state.run.id.clone();
        let d = claim(&db, &run_id).await.unwrap();
        // The plan turn cost more than the budget.
        with(&db, |c| {
            c.execute("UPDATE agent_tasks SET cost_usd = 0.75 WHERE id = ?1", rusqlite::params![d[0].item.task_id]).map_err(e2s)?;
            Ok(())
        })
        .unwrap();
        settle_core(&db, &d[0].item.id, "ok", "```equipo\n{\"items\":[{\"id\":\"x\",\"miembro\":\"Dev\",\"tarea\":\"crea x\"}]}\n```", "").await.unwrap();
        assert!(claim(&db, &run_id).await.unwrap().is_empty());
        let state = state_of(&db, &run_id).unwrap();
        assert_eq!(state.run.gate, "budget");
        let state = decide(&db, &run_id, true, "").await.unwrap();
        assert_eq!(state.run.status, "running");
        assert!((state.run.policy.budget_usd - 0.75).abs() < 1e-9);
        assert!(!claim(&db, &run_id).await.unwrap().is_empty() || state_of(&db, &run_id).unwrap().run.gate == "budget");
    }

    #[tokio::test]
    async fn the_advisor_reads_the_plan_before_it_runs() {
        let (_serial, _dir, db, ws, project, [lead, dev, qa]) = fixture();
        with(&db, |c| {
            queries::set_setting(c, crate::decide::SETTING_KEY, r#"{"engine":"off"}"#).map_err(e2s)?;
            Ok(())
        })
        .unwrap();
        let tm = with(&db, |c| {
            team::save_team(
                c,
                team::Team {
                    workspace_id: ws.clone(),
                    name: "Equipo".into(),
                    lead: "l".into(),
                    members: vec![
                        team::Member { id: "l".into(), agent_id: lead.clone(), name: "Líder".into(), edits: false, ..Default::default() },
                        team::Member { id: "d".into(), agent_id: dev.clone(), name: "Dev".into(), ..Default::default() },
                        team::Member { id: "a".into(), agent_id: qa.clone(), name: "Asesor".into(), edits: false, advisor: true, ..Default::default() },
                    ],
                    ..Default::default()
                },
            )
        })
        .unwrap();
        let state = start_run(&db, ws.clone(), tm.id.clone(), "Crea y.txt".into(), None, vec![RepoPick { project_id: project.clone(), target_branch: String::new() }], None, None)
            .await
            .unwrap();
        let run_id = state.run.id.clone();
        let d = claim(&db, &run_id).await.unwrap();
        assert!(!d[0].message.contains("**Asesor**"), "the advisor is never offered as a worker");
        let state = settle_core(&db, &d[0].item.id, "ok", "```equipo\n{\"items\":[{\"id\":\"y\",\"miembro\":\"Dev\",\"tarea\":\"crea y.txt\"}]}\n```", "").await.unwrap();
        // No gate yet: the advisor reads first, and the work waits for it.
        assert_eq!(state.run.status, "running");
        let d = claim(&db, &run_id).await.unwrap();
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].item.kind, "advise");
        assert!(d[0].message.contains("El líder propone este plan"));
        let state = settle_core(&db, &d[0].item.id, "ok", "Falta un test para y.txt.", "").await.unwrap();
        assert_eq!(state.run.gate, "plan");
        assert!(state.run.gate_note.contains("Falta un test"));
        assert!(state.messages.iter().any(|m| m.kind == "advice"));
        decide(&db, &run_id, true, "").await.unwrap();
        let d = claim(&db, &run_id).await.unwrap();
        assert_eq!(d[0].item.key, "y");
    }

    #[tokio::test]
    async fn questions_wait_for_the_user_and_failures_escalate() {
        let (_serial, _dir, db, ws, project, [lead, dev, qa]) = fixture();
        let tm = with(&db, |c| {
            team::save_team(
                c,
                team::Team {
                    workspace_id: ws.clone(),
                    name: "Fijo".into(),
                    lead: String::new(),
                    policy: Policy { approve_merge: false, commit: "squash".into(), max_attempts: 1, ..Default::default() },
                    plan: vec![team::PlanStep { key: "uno".into(), member: "d".into(), instruction: "haz uno".into(), ..Default::default() }],
                    members: vec![
                        team::Member { id: "d".into(), agent_id: dev.clone(), name: "Dev".into(), escalate_to: "s".into(), ..Default::default() },
                        team::Member { id: "s".into(), agent_id: lead.clone(), name: "Senior".into(), ..Default::default() },
                        team::Member { id: "q".into(), agent_id: qa.clone(), name: "QA".into(), ..Default::default() },
                    ],
                    ..Default::default()
                },
            )
        })
        .unwrap();
        let state = start_run(&db, ws, tm.id, "una cosa".into(), None, vec![RepoPick { project_id: project, target_branch: "main".into() }], None, None).await.unwrap();
        let run_id = state.run.id.clone();
        let d = claim(&db, &run_id).await.unwrap();
        // A question to the user parks the item.
        let state = settle_core(&db, &d[0].item.id, "ok", "```equipo\n{\"para\":\"usuario\",\"tipo\":\"pregunta\",\"texto\":\"¿rojo o azul?\",\"opciones\":[\"rojo\",\"azul\"]}\n```", "").await.unwrap();
        assert_eq!(item_of(&state, "uno").status, "waiting");
        let q = state.messages.iter().find(|m| m.kind == "question").unwrap().id.clone();
        answer_question(&db, &q, "azul").await.unwrap();
        let d = claim(&db, &run_id).await.unwrap();
        assert!(d[0].message.contains("¿rojo o azul? → azul"));
        // It fails (one attempt) and goes to the senior.
        let state = settle_core(&db, &d[0].item.id, "error", "", "se rompió").await.unwrap();
        assert_eq!(item_of(&state, "uno").status, "error");
        let esc = item_of(&state, "uno-esc");
        assert_eq!(esc.member_name, "Senior");
        let d = claim(&db, &run_id).await.unwrap();
        std::fs::write(Path::new(&d[0].cwd).join("uno.txt"), "1\n").unwrap();
        let state = settle_core(&db, &d[0].item.id, "ok", "listo", "").await.unwrap();
        // No lead, no merge approval: it lands as one squashed commit.
        assert_eq!(state.run.status, "done", "{}", state.run.gate_note);
        let repo = &state.repos[0].local_path;
        assert!(Path::new(repo).join("uno.txt").exists());
        let log = crate::git::cli::run_in(repo, &["log", "--oneline"], &[]).unwrap().stdout;
        assert_eq!(log.lines().count(), 2, "{log}");
    }
}
