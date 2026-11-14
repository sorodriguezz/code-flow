//! Shared «Equipo» runs: a run that stays on its owner's machine, with some members played by agents
//! of other people, on their machines, with their accounts.
//!
//! Phase 2 of `.claude/plans/multiplayer-chat.md`, on the same base as shared chats: the owner's own
//! Supabase project, a nick per person, single-use invitations, a key per installation.
//!
//! **The owner's machine is the run.** It plans, schedules, reviews, merges and lands; nothing about
//! that changes. Some members are **seats** (`collab_run_seats`): when the runner claims an item of a
//! seat someone took, the item does not run here. Like a terminal member's, it stays `running` and is
//! handed off — to the session, as an **offer** (`cf_collab_tasks`): the message its agent starts
//! from, composed here as for any member, and where in the history it starts, as a git bundle
//! ([`super::bundle`]). The seat's person accepts it on their machine, their agent works in a worktree
//! of their clone, and the answer comes back with their commit, which this machine fast-forwards the
//! item's own worktree onto before settling the item as if it had run here.
//!
//! **What stays home.** Agents are named by their name and engine, never by their account or their
//! instructions: the seat's agent runs with its person's prompt and account, and the owner's members
//! keep theirs. The picture of the run the others see ([`SharedRun`]) is built field by field, so
//! nothing else from a run can leak into it.
//!
//! **What comes from elsewhere is data.** Notes from people and from other machines' agents enter the
//! channel marked «externo», and `compose` tells the owner's agents what that means.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use super::bundle::{self, Pack};
use super::remote::{Offer, Person, Remote, RemoteTask, Seat};
use super::{manifest, store, sync};
use crate::db::queries;
use crate::db::Db;
use crate::team;

/// `Item.run_in` of an item handed to another machine.
pub const RUN_IN_REMOTE: &str = "remote";

/// What a bundle may weigh: the same cap as any shared file.
const MAX_BUNDLE: usize = super::exclude::MAX_FILE_BYTES as usize;

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS collab_runs (
            session_id  TEXT PRIMARY KEY,
            run_id      TEXT NOT NULL DEFAULT '',
            title       TEXT NOT NULL DEFAULT '',
            published   TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_collab_runs_run ON collab_runs(run_id);
        CREATE TABLE IF NOT EXISTS collab_run_seats (
            session_id      TEXT NOT NULL,
            member_id       TEXT NOT NULL,
            name            TEXT NOT NULL DEFAULT '',
            role            TEXT NOT NULL DEFAULT '',
            person_id       TEXT NOT NULL DEFAULT '',
            nick            TEXT NOT NULL DEFAULT '',
            agent           TEXT NOT NULL DEFAULT '',
            engine          TEXT NOT NULL DEFAULT '',
            local_agent_id  TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (session_id, member_id)
        );
        CREATE TABLE IF NOT EXISTS collab_run_jobs (
            session_id  TEXT NOT NULL,
            item_id     TEXT NOT NULL,
            side        TEXT NOT NULL,
            attempt     INTEGER NOT NULL DEFAULT 1,
            state       TEXT NOT NULL,
            payload     TEXT NOT NULL DEFAULT '{}',
            error       TEXT NOT NULL DEFAULT '',
            updated_at  TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (session_id, item_id, side)
        );",
    )
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn e2s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn with<T>(db: &Db, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
    let conn = db.0.lock().map_err(e2s)?;
    f(&conn)
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(e2s)?
}

// ---------------------------------------------------------------------------
// Local records
// ---------------------------------------------------------------------------

/// The shared session of a run, if it is shared and still on.
pub fn session_of_run(conn: &Connection, run_id: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "SELECT r.session_id FROM collab_runs r JOIN collab_sessions s ON s.id = r.session_id
         WHERE r.run_id = ?1 AND s.status = 'active' ORDER BY s.created_at DESC LIMIT 1",
        [run_id],
        |row| row.get(0),
    )
    .optional()
}

/// The run of a session (`''` on a guest's machine, which has none) and its title.
pub fn run_of_session(conn: &Connection, session_id: &str) -> rusqlite::Result<Option<(String, String)>> {
    conn.query_row("SELECT run_id, title FROM collab_runs WHERE session_id = ?1", [session_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()
}

pub fn is_run_session(conn: &Connection, session_id: &str) -> bool {
    run_of_session(conn, session_id).ok().flatten().is_some()
}

fn insert_run(conn: &Connection, session_id: &str, run_id: &str, title: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO collab_runs (session_id, run_id, title, published) VALUES (?1, ?2, ?3, '')",
        params![session_id, run_id, title],
    )?;
    Ok(())
}

/// A seat as this machine knows it.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalSeat {
    pub member_id: String,
    pub name: String,
    pub role: String,
    /// `''` while free.
    pub person_id: String,
    pub nick: String,
    pub agent: String,
    pub engine: String,
    /// On a guest's machine: the agent of their roster in the seat.
    pub local_agent_id: String,
}

pub fn seats(conn: &Connection, session_id: &str) -> rusqlite::Result<Vec<LocalSeat>> {
    let mut stmt = conn.prepare(
        "SELECT member_id, name, role, person_id, nick, agent, engine, local_agent_id FROM collab_run_seats
         WHERE session_id = ?1 ORDER BY name",
    )?;
    let rows = stmt.query_map([session_id], |row| {
        Ok(LocalSeat {
            member_id: row.get(0)?,
            name: row.get(1)?,
            role: row.get(2)?,
            person_id: row.get(3)?,
            nick: row.get(4)?,
            agent: row.get(5)?,
            engine: row.get(6)?,
            local_agent_id: row.get(7)?,
        })
    })?;
    rows.collect()
}

/// Takes in the session's seats. Returns whether anyone sat down or got up, which is what the owner's
/// runner must hear about (an item may run now, or must come back home).
fn save_seats(conn: &Connection, session_id: &str, theirs: &[Seat], people: &[Person]) -> rusqlite::Result<bool> {
    let before: HashMap<String, LocalSeat> = seats(conn, session_id)?.into_iter().map(|s| (s.member_id.clone(), s)).collect();
    let nick_of = |id: &str| people.iter().find(|p| p.id == id).map(|p| p.nick.clone()).unwrap_or_default();
    let mut moved = before.len() != theirs.len();
    for seat in theirs {
        let person = seat.person_id.clone().unwrap_or_default();
        let old = before.get(&seat.member_id);
        moved |= old.map(|o| o.person_id != person).unwrap_or(true);
        conn.execute(
            "INSERT INTO collab_run_seats (session_id, member_id, name, role, person_id, nick, agent, engine, local_agent_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, '')
             ON CONFLICT (session_id, member_id) DO UPDATE SET
               name = excluded.name, role = excluded.role, person_id = excluded.person_id, nick = excluded.nick,
               agent = excluded.agent, engine = excluded.engine,
               local_agent_id = CASE WHEN collab_run_seats.person_id = excluded.person_id THEN collab_run_seats.local_agent_id ELSE '' END",
            params![session_id, seat.member_id, seat.name, seat.role, person, nick_of(&person), seat.agent, seat.engine],
        )?;
    }
    let keep: HashSet<&str> = theirs.iter().map(|s| s.member_id.as_str()).collect();
    for gone in before.keys().filter(|id| !keep.contains(id.as_str())) {
        conn.execute("DELETE FROM collab_run_seats WHERE session_id = ?1 AND member_id = ?2", params![session_id, gone])?;
    }
    Ok(moved)
}

/// Where an item of a shared run runs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// Here, as always: not a seat, or a kind that only the owner's machine can run.
    Local,
    /// On the machine of whoever took the seat.
    Remote,
    /// The seat is free: the item waits for someone to take it (or for the owner to take it back).
    Wait,
}

/// The kinds a seat's machine can run: work in a worktree of its own, and reviews. Planning,
/// answering, integrating and conflict resolution need the owner's run and stay here.
pub fn remote_kind(kind: &str) -> bool {
    matches!(kind, "work" | "review")
}

/// What [`team_cmd::claim_limited`](crate::commands::team_cmd) asks for each ready item.
pub fn route(conn: &Connection, run_id: &str, member_id: &str, kind: &str) -> Route {
    if !remote_kind(kind) {
        return Route::Local;
    }
    let person: Option<String> = conn
        .query_row(
            "SELECT s.person_id FROM collab_run_seats s
             JOIN collab_runs r ON r.session_id = s.session_id
             JOIN collab_sessions cs ON cs.id = r.session_id
             WHERE r.run_id = ?1 AND s.member_id = ?2 AND cs.status = 'active' AND cs.role = 'owner'",
            params![run_id, member_id],
            |row| row.get(0),
        )
        .optional()
        .ok()
        .flatten();
    match person {
        None => Route::Local,
        Some(p) if p.is_empty() => Route::Wait,
        Some(_) => Route::Remote,
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub item_id: String,
    pub attempt: i64,
    /// Owner: `queued` → `offered` → `settled`. Guest: `offered` → `running` → `reported`, or
    /// `declined` / `withdrawn`.
    pub state: String,
    pub title: String,
    pub error: String,
    pub updated_at: String,
    #[serde(skip)]
    pub payload: Value,
}

fn jobs(conn: &Connection, session_id: &str, side: &str) -> rusqlite::Result<Vec<Job>> {
    let mut stmt = conn.prepare(
        "SELECT item_id, attempt, state, payload, error, updated_at FROM collab_run_jobs
         WHERE session_id = ?1 AND side = ?2 ORDER BY updated_at",
    )?;
    let rows = stmt.query_map(params![session_id, side], |row| {
        let payload: Value = serde_json::from_str(&row.get::<_, String>(3)?).unwrap_or(Value::Null);
        Ok(Job {
            item_id: row.get(0)?,
            attempt: row.get(1)?,
            state: row.get(2)?,
            title: payload.get("title").and_then(Value::as_str).unwrap_or_default().to_string(),
            error: row.get(4)?,
            updated_at: row.get(5)?,
            payload,
        })
    })?;
    rows.collect()
}

fn put_job(conn: &Connection, session_id: &str, side: &str, item_id: &str, attempt: i64, state: &str, payload: &Value) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO collab_run_jobs (session_id, item_id, side, attempt, state, payload, error, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', ?7)
         ON CONFLICT (session_id, item_id, side) DO UPDATE SET attempt = excluded.attempt, state = excluded.state,
           payload = excluded.payload, error = '', updated_at = excluded.updated_at",
        params![session_id, item_id, side, attempt, state, payload.to_string(), now()],
    )?;
    Ok(())
}

fn set_job(conn: &Connection, session_id: &str, side: &str, item_id: &str, state: &str, error: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE collab_run_jobs SET state = ?4, error = ?5, updated_at = ?6 WHERE session_id = ?1 AND item_id = ?2 AND side = ?3",
        params![session_id, item_id, side, state, error, now()],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// The owner: handing items off
// ---------------------------------------------------------------------------

/// The runner claimed an item whose seat someone took: it goes out with the next round, here
/// recorded with what the offer needs. Called from `runner::pump_once`.
pub fn queue_offer(db: &Db, run_id: &str, dispatch: &crate::commands::team_cmd::Dispatch) -> Result<(), String> {
    with(db, |c| {
        let session = session_of_run(c, run_id).map_err(e2s)?.ok_or("la corrida dejó de estar compartida")?;
        let item = &dispatch.item;
        let repo = team::list_repos(c, run_id).map_err(e2s)?.into_iter().find(|r| r.project_id == item.project_id).ok_or("su repositorio ya no está en la corrida")?;
        let repo_key = store::repos(c, &session).map_err(e2s)?.into_iter().find(|r| r.project_id == item.project_id).map(|r| r.repo_key).ok_or("su repositorio no está en la sesión")?;
        let payload = json!({
            "member_id": item.member_id,
            "kind": item.kind,
            "title": dispatch.title,
            "message": dispatch.message,
            "cwd": dispatch.cwd,
            "repo_key": repo_key,
            "local_path": repo.local_path,
            "target": repo.target_branch,
            "writes": item.kind == "work",
        });
        put_job(c, &session, "owner", &item.id, item.attempts, "queued", &payload).map_err(e2s)
    })
}

/// Marks what a seat's agent said as coming from elsewhere: its notes, posted when the item settled.
fn mark_external(conn: &Connection, item_id: &str, member_id: &str, nick: &str) {
    let suffix = format!(" · {nick} (externo)");
    let _ = conn.execute(
        "UPDATE agent_team_messages SET from_name = from_name || ?3
         WHERE item_id = ?1 AND from_id = ?2 AND from_name NOT LIKE '%(externo)%'",
        params![item_id, member_id, suffix],
    );
}

/// The picture of a run that the others see. Built field by field on purpose: a member's account,
/// instructions and routing never travel, and nothing added to a run later starts travelling by
/// accident.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SharedRun {
    pub title: String,
    pub goal: String,
    pub status: String,
    pub gate: String,
    pub gate_note: String,
    pub lead: String,
    pub members: Vec<SharedMember>,
    pub repos: Vec<SharedRepo>,
    pub items: Vec<SharedItem>,
    pub messages: Vec<SharedNote>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SharedMember {
    pub id: String,
    pub name: String,
    pub role: String,
    /// The engine only ("claude"): which account it runs as stays on its machine.
    pub engine: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SharedRepo {
    pub name: String,
    pub target_branch: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SharedItem {
    pub id: String,
    pub key: String,
    pub member_id: String,
    pub kind: String,
    pub title: String,
    pub status: String,
    pub remote: bool,
    pub merged: bool,
    pub last_error: String,
    pub started_at: String,
    pub finished_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SharedNote {
    pub id: String,
    pub from_id: String,
    pub from_name: String,
    pub to_id: String,
    pub to_name: String,
    pub kind: String,
    pub body: String,
    pub created_at: String,
}

/// How many messages the picture carries: the newest.
const SHARED_MESSAGES: usize = 200;
const SHARED_BODY: usize = 4000;

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

pub fn shared_run(state: &team::RunState) -> SharedRun {
    let run = &state.run;
    let skip = state.messages.len().saturating_sub(SHARED_MESSAGES);
    SharedRun {
        title: run.title.clone(),
        goal: clip(&run.goal, SHARED_BODY),
        status: run.status.clone(),
        gate: run.gate.clone(),
        gate_note: run.gate_note.clone(),
        lead: run.lead.clone(),
        members: run
            .members
            .iter()
            .map(|m| SharedMember { id: m.member.id.clone(), name: m.member.name.clone(), role: m.member.role.clone(), engine: m.provider.clone() })
            .collect(),
        repos: state.repos.iter().map(|r| SharedRepo { name: r.name.clone(), target_branch: r.target_branch.clone() }).collect(),
        items: state
            .items
            .iter()
            .map(|i| SharedItem {
                id: i.id.clone(),
                key: i.key.clone(),
                member_id: i.member_id.clone(),
                kind: i.kind.clone(),
                title: i.title.clone(),
                status: i.status.clone(),
                remote: i.run_in == RUN_IN_REMOTE,
                merged: i.merged,
                last_error: clip(&i.last_error, 400),
                started_at: i.started_at.clone(),
                finished_at: i.finished_at.clone(),
            })
            .collect(),
        messages: state
            .messages
            .iter()
            .skip(skip)
            .map(|m| SharedNote {
                id: m.id.clone(),
                from_id: m.from_id.clone(),
                from_name: m.from_name.clone(),
                to_id: m.to_id.clone(),
                to_name: m.to_name.clone(),
                kind: m.kind.clone(),
                body: clip(&m.body, SHARED_BODY),
                created_at: m.created_at.clone(),
            })
            .collect(),
    }
}

/// One round of a shared run, on either side.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunTick {
    pub session_id: String,
    pub owner: bool,
    pub ended: bool,
    pub people: Vec<Person>,
    pub seats: Vec<LocalSeat>,
    /// The owner's picture of the run (what a guest draws).
    pub run: Option<Value>,
    /// Guest: what was offered to them and waits for their answer.
    pub offers: Vec<RemoteTask>,
    /// This machine's side of every task.
    pub jobs: Vec<Job>,
    pub errors: Vec<String>,
}

/// The owner's round: seats, offers out, answers in, notes in, the picture out.
pub async fn owner_tick(app: &AppHandle, db: &Db, session_id: &str) -> Result<RunTick, String> {
    let (session, _) = sync::load(db, session_id)?;
    let remote = sync::remote_for(&session)?;
    let secret = store::owner_secret(session_id)?;
    let (run_id, _) = with(db, |c| run_of_session(c, session_id).map_err(e2s)?.ok_or_else(|| "no es una corrida compartida".to_string()))?;
    let mut report = RunTick { session_id: session_id.into(), owner: true, ..Default::default() };

    let _ = remote.heartbeat(session_id).await;
    report.people = remote.people(session_id).await.unwrap_or_default();

    // Seats: someone sat down or got up, and the runner hears about it.
    let theirs = remote.seats(session_id).await?;
    if with(db, |c| save_seats(c, session_id, &theirs, &report.people).map_err(e2s))? {
        crate::runner::kick(app, &run_id);
    }

    // Offers out.
    for job in with(db, |c| jobs(c, session_id, "owner").map_err(e2s))?.into_iter().filter(|j| j.state == "queued") {
        match offer(&remote, session_id, &secret, &job).await {
            Ok(()) => with(db, |c| set_job(c, session_id, "owner", &job.item_id, "offered", "").map_err(e2s))?,
            Err(e) => {
                with(db, |c| set_job(c, session_id, "owner", &job.item_id, "settled", &e).map_err(e2s))?;
                let _ = crate::commands::team_cmd::settle_item(app, db, &job.item_id, "error", "", &format!("no se pudo entregar al puesto: {e}")).await;
            }
        }
    }

    // Answers in.
    let tasks = remote.tasks(session_id, None).await?;
    for job in with(db, |c| jobs(c, session_id, "owner").map_err(e2s))?.into_iter().filter(|j| j.state == "offered") {
        // The run moved on without it (aborted, skipped, retried from here): the offer goes.
        let still = with(db, |c| team::get_item(c, &job.item_id).map_err(e2s))?.is_some_and(|i| i.status == "running" && i.attempts == job.attempt);
        if !still {
            let _ = remote.withdraw(session_id, &secret, &job.item_id).await;
            with(db, |c| set_job(c, session_id, "owner", &job.item_id, "settled", "retirada").map_err(e2s))?;
            continue;
        }
        let Some(task) = tasks.iter().find(|t| t.item_id == job.item_id && t.attempt == job.attempt) else { continue };
        let nick = report.people.iter().find(|p| p.id == task.person_id).map(|p| p.nick.clone()).unwrap_or_else(|| "otra persona".into());
        let (outcome, text, error) = match task.status.as_str() {
            "done" => match take_result(&remote, session_id, &job, task).await {
                Ok(()) => ("ok", task.result_text.clone().unwrap_or_default(), String::new()),
                Err(e) => ("error", String::new(), format!("el resultado de {nick} no se pudo aplicar: {e}")),
            },
            "failed" => ("error", task.result_text.clone().unwrap_or_default(), format!("{nick}: {}", task.error.clone().unwrap_or_default())),
            "declined" => ("error", String::new(), format!("{nick} no aceptó la tarea{}", task.error.as_deref().filter(|e| !e.is_empty()).map(|e| format!(": {e}")).unwrap_or_default())),
            "withdrawn" => ("error", String::new(), "el puesto quedó libre antes de terminar".to_string()),
            _ => continue,
        };
        with(db, |c| set_job(c, session_id, "owner", &job.item_id, "settled", &error).map_err(e2s))?;
        let _ = crate::commands::team_cmd::settle_item(app, db, &job.item_id, outcome, &text, &error).await;
        with(db, |c| {
            mark_external(c, &job.item_id, &task.member_id, &nick);
            Ok(())
        })?;
    }

    // Notes in: people write into the run's channel, as data.
    let messages = remote.messages_after(session_id, session.last_seq).await.unwrap_or_default();
    let mut noted = false;
    with(db, |c| {
        for m in &messages {
            if m.kind != "team_note" || m.person_id.as_deref() == Some(session.person_id.as_str()) {
                continue;
            }
            let text = m.body.get("text").and_then(Value::as_str).unwrap_or_default().trim();
            if text.is_empty() {
                continue;
            }
            let nick = m.body.get("nick").and_then(Value::as_str).unwrap_or("alguien");
            let (to_id, to_name) = note_recipient(c, &run_id, m.body.get("to").and_then(Value::as_str).unwrap_or("all"));
            let from = format!("person:{}", m.person_id.clone().unwrap_or_default());
            let _ = team::post(c, &run_id, "", (&from, &format!("{nick} (externo)")), (&to_id, &to_name), "note", &clip(text, SHARED_BODY), &[]);
            noted = true;
        }
        if let Some(last) = messages.last() {
            let _ = store::set_last_seq(c, session_id, last.seq);
        }
        Ok(())
    })?;
    if noted {
        let _ = app.emit("team:changed", json!({ "runId": run_id }));
        crate::runner::kick(app, &run_id);
    }

    // The picture out, when it changed.
    let picture = with(db, |c| {
        let state = team::state(c, &run_id).map_err(e2s)?.ok_or("la corrida ya no existe")?;
        let published: String = c.query_row("SELECT published FROM collab_runs WHERE session_id = ?1", [session_id], |r| r.get(0)).unwrap_or_default();
        let value = serde_json::to_value(shared_run(&state)).map_err(e2s)?;
        let hash = manifest::hash_bytes(value.to_string().as_bytes());
        Ok(if hash == published { (value, None) } else { (value, Some(hash)) })
    })?;
    if let (value, Some(hash)) = &picture {
        match remote.publish_run(session_id, &secret, value).await {
            Ok(()) => with(db, |c| c.execute("UPDATE collab_runs SET published = ?2 WHERE session_id = ?1", params![session_id, hash]).map(|_| ()).map_err(e2s))?,
            Err(e) => report.errors.push(e),
        }
    }
    report.run = Some(picture.0);
    report.seats = with(db, |c| seats(c, session_id).map_err(e2s))?;
    report.jobs = with(db, |c| jobs(c, session_id, "owner").map_err(e2s))?;
    Ok(report)
}

/// `to` of a note as people write it (`all`, `lead`, a member's id or name) as the channel stores it.
fn note_recipient(conn: &Connection, run_id: &str, to: &str) -> (String, String) {
    let run = team::get_run(conn, run_id).ok().flatten();
    match to {
        "" | "all" | "todos" => ("all".into(), "Equipo".into()),
        "lead" | "lider" | "líder" => ("lead".into(), "Líder".into()),
        other => run
            .and_then(|r| r.members.into_iter().find(|m| m.member.id == other || m.member.name.eq_ignore_ascii_case(other)))
            .map(|m| (m.member.id, m.member.name))
            .unwrap_or_else(|| ("all".into(), "Equipo".into())),
    }
}

/// Publishes one queued offer: where the task starts, packed for a machine that has the run's target
/// branch as the remote has it.
async fn offer(remote: &Remote, session_id: &str, secret: &str, job: &Job) -> Result<(), String> {
    let p = &job.payload;
    let get = |k: &str| p.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    let (cwd, local_path, target) = (get("cwd"), get("local_path"), get("target"));
    let (start, pack) = blocking(move || {
        let start = crate::team::gitops::head_sha(&cwd)?;
        let basis = bundle::basis(&local_path, &start, &target)?;
        Ok((start.clone(), bundle::create(&local_path, &start, &basis)?))
    })
    .await?;
    let start_bundle = match pack {
        Pack::Nothing => None,
        Pack::Bundle(bytes) => {
            if bytes.len() > MAX_BUNDLE {
                return Err("los cambios de la corrida pesan demasiado para mandarlos".into());
            }
            let sha = manifest::hash_bytes(&bytes);
            remote.put_blob(session_id, &sha, &bytes).await?;
            Some(sha)
        }
    };
    let (member, repo_key, kind, title, message, target) = (get("member_id"), get("repo_key"), get("kind"), get("title"), get("message"), get("target"));
    remote
        .offer(
            session_id,
            secret,
            &Offer {
                item_id: &job.item_id,
                attempt: job.attempt,
                member_id: &member,
                repo_key: &repo_key,
                kind: &kind,
                title: &title,
                message: &message,
                writes: p.get("writes").and_then(Value::as_bool).unwrap_or(true),
                target: &target,
                start_sha: &start,
                start_bundle: start_bundle.as_deref(),
            },
        )
        .await
}

/// Brings a finished task's commit into the item's worktree here.
async fn take_result(remote: &Remote, session_id: &str, job: &Job, task: &RemoteTask) -> Result<(), String> {
    if !task.writes {
        return Ok(());
    }
    let (Some(sha), Some(blob)) = (task.result_sha.clone().filter(|s| !s.is_empty()), task.result_bundle.clone().filter(|s| !s.is_empty())) else {
        // Nothing changed on their side: the worktree is already where it should be.
        return Ok(());
    };
    let bytes = remote.blob(session_id, &blob).await?;
    if manifest::hash_bytes(&bytes) != blob {
        return Err("el paquete llegó dañado".into());
    }
    let local_path = job.payload.get("local_path").and_then(Value::as_str).unwrap_or_default().to_string();
    let cwd = job.payload.get("cwd").and_then(Value::as_str).unwrap_or_default().to_string();
    let name = format!("{}-result", job.item_id);
    blocking(move || {
        let got = bundle::receive(&local_path, &bytes, &name, Some(&sha))?;
        let moved = bundle::fast_forward(&cwd, &got);
        bundle::forget(&local_path, &name);
        moved
    })
    .await
}

// ---------------------------------------------------------------------------
// The guest: answering offers
// ---------------------------------------------------------------------------

/// Tasks running on this machine right now, by session and item.
fn running() -> &'static Mutex<HashSet<(String, String)>> {
    static RUNNING: std::sync::OnceLock<Mutex<HashSet<(String, String)>>> = std::sync::OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(HashSet::new()))
}

fn is_running(session_id: &str, item_id: &str) -> bool {
    running().lock().map(|s| s.contains(&(session_id.to_string(), item_id.to_string()))).unwrap_or(false)
}

/// A guest's round: the picture, the seats, and what was offered to them.
pub async fn guest_tick(db: &Db, session_id: &str) -> Result<RunTick, String> {
    let (session, _) = sync::load(db, session_id)?;
    let remote = sync::remote_for(&session)?;
    let mut report = RunTick { session_id: session_id.into(), owner: false, ..Default::default() };
    let _ = remote.heartbeat(session_id).await;
    let watermark = remote.watermark(session_id).await?;
    report.ended = watermark.ended.is_some();
    report.people = remote.people(session_id).await.unwrap_or_default();
    let theirs = remote.seats(session_id).await?;
    with(db, |c| save_seats(c, session_id, &theirs, &report.people).map(|_| ()).map_err(e2s))?;
    report.run = remote.run_state(session_id).await.unwrap_or(None);

    let mine = remote.tasks(session_id, Some(&session.person_id)).await?;
    for task in &mine {
        let known = with(db, |c| jobs(c, session_id, "guest").map_err(e2s))?.into_iter().find(|j| j.item_id == task.item_id);
        let fresh = known.as_ref().map(|j| j.attempt < task.attempt).unwrap_or(true);
        if fresh && task.status == "offered" {
            with(db, |c| put_job(c, session_id, "guest", &task.item_id, task.attempt, "offered", &json!({ "title": task.title })).map_err(e2s))?;
            continue;
        }
        let Some(job) = known else { continue };
        if job.attempt != task.attempt {
            continue;
        }
        if task.status == "withdrawn" && matches!(job.state.as_str(), "offered" | "running") {
            with(db, |c| set_job(c, session_id, "guest", &task.item_id, "withdrawn", "").map_err(e2s))?;
        }
        // Accepted here and then interrupted (the app closed mid-task): tell the owner, whose run retries.
        if task.status == "accepted" && job.state == "running" && !is_running(session_id, &task.item_id) {
            let _ = remote.report(session_id, &task.item_id, task.attempt, "failed", "", "se interrumpió en la máquina de su puesto", "", "").await;
            with(db, |c| set_job(c, session_id, "guest", &task.item_id, "reported", "se interrumpió").map_err(e2s))?;
        }
    }
    report.offers = mine.into_iter().filter(|t| t.status == "offered").collect();
    report.seats = with(db, |c| seats(c, session_id).map_err(e2s))?;
    report.jobs = with(db, |c| jobs(c, session_id, "guest").map_err(e2s))?;
    Ok(report)
}

/// Sits one of this person's agents in a free seat.
pub async fn take_seat(db: &Db, session_id: &str, member_id: &str, agent_id: &str) -> Result<(), String> {
    let (session, _) = sync::load(db, session_id)?;
    let agent = with(db, |c| {
        queries::list_workspace_agents(c, &session.workspace_id).map_err(e2s)?.into_iter().find(|a| a.id == agent_id).ok_or_else(|| "ese agente ya no está en tu roster".to_string())
    })?;
    if agent.provider.trim().is_empty() || agent.model.trim().is_empty() {
        return Err(format!("«{}» no tiene proveedor y modelo: complétalo en Agentes.", agent.name));
    }
    let remote = sync::remote_for(&session)?;
    remote.take_seat(session_id, member_id, &agent.name, &agent.provider).await?;
    with(db, |c| {
        c.execute(
            "INSERT INTO collab_run_seats (session_id, member_id, person_id, nick, agent, engine, local_agent_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT (session_id, member_id) DO UPDATE SET person_id = excluded.person_id, nick = excluded.nick,
               agent = excluded.agent, engine = excluded.engine, local_agent_id = excluded.local_agent_id",
            params![session_id, member_id, session.person_id, session.nick, agent.name, agent.provider, agent.id],
        )
        .map(|_| ())
        .map_err(e2s)
    })
}

pub async fn free_seat(db: &Db, session_id: &str, member_id: &str) -> Result<(), String> {
    let (session, _) = sync::load(db, session_id)?;
    let remote = sync::remote_for(&session)?;
    let secret = if session.role == "owner" { store::owner_secret(session_id).ok() } else { None };
    remote.free_seat(session_id, member_id, secret.as_deref()).await?;
    with(db, |c| {
        c.execute(
            "UPDATE collab_run_seats SET person_id = '', nick = '', agent = '', engine = '', local_agent_id = '' WHERE session_id = ?1 AND member_id = ?2",
            params![session_id, member_id],
        )
        .map(|_| ())
        .map_err(e2s)
    })
}

/// Says no to an offer.
pub async fn decline(db: &Db, session_id: &str, item_id: &str, reason: &str) -> Result<(), String> {
    let (session, _) = sync::load(db, session_id)?;
    let remote = sync::remote_for(&session)?;
    let task = remote.tasks(session_id, Some(&session.person_id)).await?.into_iter().find(|t| t.item_id == item_id).ok_or("esa tarea ya no está")?;
    remote.report(session_id, item_id, task.attempt, "declined", "", reason, "", "").await?;
    with(db, |c| set_job(c, session_id, "guest", item_id, "declined", reason).map_err(e2s))
}

/// Says yes to an offer: it starts on this machine, with the seat's agent, in the background.
pub async fn accept(app: &AppHandle, session_id: &str, item_id: &str) -> Result<(), String> {
    let db = app.state::<Db>();
    let (session, _) = sync::load(db.inner(), session_id)?;
    let remote = sync::remote_for(&session)?;
    let task = remote
        .tasks(session_id, Some(&session.person_id))
        .await?
        .into_iter()
        .find(|t| t.item_id == item_id && t.status == "offered")
        .ok_or("esa tarea ya no te espera")?;
    let seat = with(db.inner(), |c| seats(c, session_id).map_err(e2s))?.into_iter().find(|s| s.member_id == task.member_id);
    if seat.as_ref().map(|s| s.local_agent_id.is_empty()).unwrap_or(true) {
        return Err("elige primero qué agente de tu roster ocupa este puesto".into());
    }
    remote.report(session_id, item_id, task.attempt, "accepted", "", "", "", "").await?;
    with(db.inner(), |c| set_job(c, session_id, "guest", item_id, "running", "").map_err(e2s))?;
    if let Ok(mut set) = running().lock() {
        set.insert((session_id.to_string(), item_id.to_string()));
    }
    let app = app.clone();
    let session_id = session_id.to_string();
    tauri::async_runtime::spawn(async move {
        let db = app.state::<Db>();
        let outcome = work(&app, db.inner(), &session_id, &task).await;
        let (status, text, error, sha, blob) = match outcome {
            Ok(done) => ("done", done.text, String::new(), done.sha, done.bundle),
            Err(e) => ("failed", String::new(), e, String::new(), String::new()),
        };
        let reported = match sync::load(db.inner(), &session_id).and_then(|(s, _)| sync::remote_for(&s)) {
            Ok(remote) => remote.report(&session_id, &task.item_id, task.attempt, status, &text, &error, &sha, &blob).await,
            Err(e) => Err(e),
        };
        let note = reported.err().unwrap_or(error);
        let _ = with(db.inner(), |c| set_job(c, &session_id, "guest", &task.item_id, "reported", &note).map_err(e2s));
        if let Ok(mut set) = running().lock() {
            set.remove(&(session_id.clone(), task.item_id.clone()));
        }
        let _ = app.emit("collab:run-changed", json!({ "sessionId": session_id }));
    });
    Ok(())
}

struct Done {
    text: String,
    sha: String,
    bundle: String,
}

/// Runs one accepted task: the start brought in, a worktree on it, the seat's agent in it, and the
/// commit packed for the owner.
async fn work(app: &AppHandle, db: &Db, session_id: &str, task: &RemoteTask) -> Result<Done, String> {
    let (session, repos) = sync::load(db, session_id)?;
    let remote = sync::remote_for(&session)?;
    let repo = repos.into_iter().find(|r| r.repo_key == task.repo_key).ok_or("el repositorio de esta tarea no está en tu workspace")?;
    let seat = with(db, |c| seats(c, session_id).map_err(e2s))?.into_iter().find(|s| s.member_id == task.member_id).ok_or("el puesto ya no es tuyo")?;
    let agent = with(db, |c| {
        queries::list_workspace_agents(c, &session.workspace_id).map_err(e2s)?.into_iter().find(|a| a.id == seat.local_agent_id).ok_or_else(|| "el agente del puesto ya no está en tu roster".to_string())
    })?;

    // Where the task starts.
    let start_bytes = match task.start_bundle.as_deref().filter(|s| !s.is_empty()) {
        Some(sha) => {
            let bytes = remote.blob(session_id, sha).await?;
            if manifest::hash_bytes(&bytes) != sha {
                return Err("el punto de partida llegó dañado".into());
            }
            Some(bytes)
        }
        None => None,
    };
    let short = |s: &str| s.chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect::<String>();
    let slug = format!("equipo-{}-{}", short(session_id), short(&task.item_id));
    let path = crate::paths::agent_worktree_dir(&repo.name, &slug).to_string_lossy().into_owned();
    let branch = if task.writes { format!("codeflow/{slug}") } else { String::new() };
    {
        let (checkout, target, start, name, path, branch) = (repo.checkout_path.clone(), task.target.clone(), task.start_sha.clone(), task.item_id.clone(), path.clone(), branch.clone());
        blocking(move || prepare_start(&checkout, &target, &start, start_bytes.as_deref(), &name, &path, &branch)).await?;
    }

    // The seat's agent, with its own prompt and account.
    let task_id = uuid::Uuid::new_v4().to_string();
    let agent_task = with(db, |c| {
        queries::create_agent_task_with_id(
            c,
            &task_id,
            &session.workspace_id,
            &repo.project_id,
            &agent.id,
            &agent.name,
            &agent.provider,
            &agent.model,
            &agent.prompt,
            &task.title,
            &format!("{} · {}", session.name, task.title),
            &repo.project_id,
            agent.account_id.as_deref(),
            (&path, &branch),
            &format!("collab-run:{session_id}"),
        )
        .map_err(e2s)
    })?;
    let turn_id = format!("collab-run-{}", uuid::Uuid::new_v4());
    let reply = crate::commands::claude_cmd::send_chat_message(
        app.clone(),
        app.state::<Db>(),
        agent_task.project_id.clone(),
        task.message.clone(),
        None,
        Some(agent_task.conversation_id.clone()),
        Some(turn_id),
        Some(agent.provider.clone()),
        Some(agent.model.clone()),
        Some(agent.prompt.clone()),
        agent.account_id.clone(),
        None,
        None,
        None,
        Some(agent.effort.clone()).filter(|e| !e.is_empty()),
        Some(false),
        None,
        None,
    )
    .await;
    let text = match reply {
        Ok(reply) => reply.text,
        Err(e) => {
            cleanup(&repo.checkout_path, &path, &task.item_id).await;
            return Err(e);
        }
    };

    // The commit, packed for a machine that has the start.
    let mut done = Done { text, sha: String::new(), bundle: String::new() };
    if task.writes {
        let (wt, checkout, start, title) = (path.clone(), repo.checkout_path.clone(), task.start_sha.clone(), task.title.clone());
        let packed = blocking(move || pack_result(&wt, &checkout, &start, &title)).await;
        match packed {
            Ok((head, Pack::Bundle(bytes))) => {
                if bytes.len() > MAX_BUNDLE {
                    cleanup(&repo.checkout_path, &path, &task.item_id).await;
                    return Err("los cambios pesan demasiado para mandarlos".into());
                }
                let sha = manifest::hash_bytes(&bytes);
                remote.put_blob(session_id, &sha, &bytes).await?;
                done.sha = head;
                done.bundle = sha;
            }
            Ok((head, Pack::Nothing)) => done.sha = head,
            Err(e) => {
                cleanup(&repo.checkout_path, &path, &task.item_id).await;
                return Err(e);
            }
        }
    }
    cleanup(&repo.checkout_path, &path, &task.item_id).await;
    Ok(done)
}

/// Brings a task's start into this person's clone and makes the worktree it runs in: on a branch
/// of its own for work, detached for a review. `bytes` is the owner's bundle, `None` when the start
/// is the shared basis itself.
fn prepare_start(checkout: &str, target: &str, start: &str, bytes: Option<&[u8]>, name: &str, path: &str, branch: &str) -> Result<(), String> {
    let remote_name = crate::git::remotes::default_remote(checkout).unwrap_or_else(|_| "origin".to_string());
    let _ = crate::git::cli::run_in(checkout, &["fetch", "--quiet", &remote_name, target], &[]);
    if let Some(bytes) = bytes {
        bundle::receive(checkout, bytes, name, Some(start))?;
    }
    let have = crate::git::cli::run_in(checkout, &["cat-file", "-e", &format!("{start}^{{commit}}")], &[]).map(|o| o.success).unwrap_or(false);
    if !have {
        return Err("tu clon no tiene el punto de partida: haz fetch de la rama destino".to_string());
    }
    if std::path::Path::new(path).exists() {
        crate::team::gitops::remove_worktree(checkout, path);
    }
    if branch.is_empty() {
        crate::team::gitops::add_detached(checkout, path, start)
    } else {
        // A branch left by an earlier attempt of this item goes: the attempt starts again from where
        // the owner says (`add_worktree` makes the branch itself, and refuses one that exists).
        let _ = crate::git::cli::run_in(checkout, &["branch", "-D", branch], &[]);
        crate::team::gitops::add_worktree(checkout, path, branch, start)
    }
}

/// Commits what the agent left in the worktree and packs it for a machine that has `start`.
fn pack_result(worktree: &str, checkout: &str, start: &str, title: &str) -> Result<(String, Pack), String> {
    crate::team::gitops::commit_all(worktree, &format!("Equipo: {title}"))?;
    let head = crate::team::gitops::head_sha(worktree)?;
    let pack = bundle::create(checkout, &head, start)?;
    Ok((head, pack))
}

/// The worktree goes (its branch stays, for whoever wants to look); the incoming ref too.
async fn cleanup(checkout: &str, path: &str, item_id: &str) {
    let (checkout, path, item) = (checkout.to_string(), path.to_string(), item_id.to_string());
    let _ = blocking(move || {
        crate::team::gitops::remove_worktree(&checkout, &path);
        bundle::forget(&checkout, &item);
        Ok(())
    })
    .await;
}

/// A note from this person into the run's channel. `to` is `all`, `lead`, or a member.
pub async fn note(db: &Db, session_id: &str, to: &str, text: &str) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("Escribe la nota.".into());
    }
    let (session, _) = sync::load(db, session_id)?;
    let remote = sync::remote_for(&session)?;
    let id = uuid::Uuid::new_v4().to_string();
    remote
        .post(session_id, &session.person_id, &id, "team_note", &json!({ "nick": session.nick, "text": clip(text, SHARED_BODY), "to": to }))
        .await
}

// ---------------------------------------------------------------------------
// Sharing, joining, leaving
// ---------------------------------------------------------------------------

/// The members of a run that may be seats: everyone but its lead and the sub-leads, who plan and
/// therefore stay with the run.
pub fn seatable(run: &team::Run) -> Vec<&team::MemberSnap> {
    run.members.iter().filter(|m| m.member.id != run.lead && !m.member.leads).collect()
}

/// Records, on the owner's machine, a run session just opened in Supabase.
pub fn record_share(conn: &Connection, session_id: &str, run: &team::Run, seats_picked: &[String]) -> Result<(), String> {
    insert_run(conn, session_id, &run.id, &run.title).map_err(e2s)?;
    for m in seatable(run).into_iter().filter(|m| seats_picked.contains(&m.member.id)) {
        conn.execute(
            "INSERT OR REPLACE INTO collab_run_seats (session_id, member_id, name, role) VALUES (?1, ?2, ?3, ?4)",
            params![session_id, m.member.id, m.member.name, m.member.role],
        )
        .map_err(e2s)?;
    }
    Ok(())
}

pub fn record_join(conn: &Connection, session_id: &str, title: &str) -> Result<(), String> {
    insert_run(conn, session_id, "", title).map_err(e2s)
}

/// The owner stops sharing: every item out on another machine comes back to be retried here, and
/// the seats are forgotten (their members run here again).
pub async fn stop_sharing(app: &AppHandle, db: &Db, session_id: &str) -> Result<(), String> {
    let (run_id, pending) = with(db, |c| {
        let run_id = run_of_session(c, session_id).map_err(e2s)?.map(|(r, _)| r).unwrap_or_default();
        let pending: Vec<String> = jobs(c, session_id, "owner").map_err(e2s)?.into_iter().filter(|j| j.state != "settled").map(|j| j.item_id).collect();
        c.execute("DELETE FROM collab_run_seats WHERE session_id = ?1", [session_id]).map_err(e2s)?;
        c.execute("UPDATE collab_run_jobs SET state = 'settled' WHERE session_id = ?1 AND side = 'owner'", [session_id]).map_err(e2s)?;
        Ok((run_id, pending))
    })?;
    for item in pending {
        let _ = crate::commands::team_cmd::settle_item(app, db, &item, "error", "", "se dejó de compartir la corrida").await;
    }
    if !run_id.is_empty() {
        crate::runner::kick(app, &run_id);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        store::migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        conn
    }

    fn session(conn: &Connection, id: &str, role: &str, status: &str) {
        store::insert_session(
            conn,
            &store::Session {
                id: id.into(),
                project_url: "https://x.supabase.co".into(),
                name: "Run".into(),
                role: role.into(),
                nick: "Ana".into(),
                person_id: "pa".into(),
                workspace_id: "w".into(),
                chat_id: String::new(),
                status: status.into(),
                last_seq: 0,
                created_at: String::new(),
            },
        )
        .unwrap();
    }

    fn seat(member: &str, person: Option<&str>) -> Seat {
        Seat { member_id: member.into(), name: member.into(), role: String::new(), person_id: person.map(Into::into), agent: "Claude QA".into(), engine: "claude".into() }
    }

    #[test]
    fn items_go_where_their_seat_is() {
        let c = conn();
        session(&c, "s1", "owner", "active");
        insert_run(&c, "s1", "run1", "Run").unwrap();
        save_seats(&c, "s1", &[seat("tests", None), seat("rev", Some("pb"))], &[]).unwrap();

        assert_eq!(route(&c, "run1", "tests", "work"), Route::Wait, "a free seat waits");
        assert_eq!(route(&c, "run1", "rev", "review"), Route::Remote);
        assert_eq!(route(&c, "run1", "back", "work"), Route::Local, "not a seat");
        assert_eq!(route(&c, "run1", "rev", "integrate"), Route::Local, "only the owner integrates");
        assert_eq!(route(&c, "run2", "rev", "work"), Route::Local, "another run");

        store::set_status(&c, "s1", "ended").unwrap();
        assert_eq!(route(&c, "run1", "rev", "work"), Route::Local, "a run no longer shared is all local");
    }

    #[test]
    fn a_guest_machine_never_routes() {
        let c = conn();
        session(&c, "s2", "editor", "active");
        insert_run(&c, "s2", "run1", "Run").unwrap();
        save_seats(&c, "s2", &[seat("rev", Some("pb"))], &[]).unwrap();
        assert_eq!(route(&c, "run1", "rev", "work"), Route::Local);
    }

    #[test]
    fn seats_report_who_sat_down_and_keep_the_local_agent_of_the_same_person() {
        let c = conn();
        session(&c, "s1", "editor", "active");
        let people = vec![Person { id: "pb".into(), nick: "Beto".into(), role: "editor".into(), last_seen: String::new() }];
        assert!(save_seats(&c, "s1", &[seat("rev", None)], &people).unwrap());
        assert!(!save_seats(&c, "s1", &[seat("rev", None)], &people).unwrap(), "nothing moved");
        assert!(save_seats(&c, "s1", &[seat("rev", Some("pb"))], &people).unwrap());
        c.execute("UPDATE collab_run_seats SET local_agent_id = 'agent-1' WHERE member_id = 'rev'", []).unwrap();
        save_seats(&c, "s1", &[seat("rev", Some("pb"))], &people).unwrap();
        let s = &seats(&c, "s1").unwrap()[0];
        assert_eq!((s.nick.as_str(), s.local_agent_id.as_str()), ("Beto", "agent-1"));
        save_seats(&c, "s1", &[seat("rev", Some("pc"))], &people).unwrap();
        assert_eq!(seats(&c, "s1").unwrap()[0].local_agent_id, "", "someone else's seat is not my agent's");
        assert!(save_seats(&c, "s1", &[], &people).unwrap());
        assert!(seats(&c, "s1").unwrap().is_empty());
    }

    #[test]
    fn jobs_start_over_on_a_new_attempt() {
        let c = conn();
        put_job(&c, "s1", "owner", "i1", 1, "queued", &json!({ "title": "T" })).unwrap();
        set_job(&c, "s1", "owner", "i1", "offered", "").unwrap();
        put_job(&c, "s1", "owner", "i1", 2, "queued", &json!({ "title": "T" })).unwrap();
        let all = jobs(&c, "s1", "owner").unwrap();
        assert_eq!((all.len(), all[0].attempt, all[0].state.as_str(), all[0].title.as_str()), (1, 2, "queued", "T"));
    }

    #[test]
    fn the_picture_carries_no_account_and_no_instructions() {
        let mut state = team::RunState::default();
        state.run.title = "Idempotencia".into();
        state.run.members.push(team::MemberSnap {
            member: team::Member { id: "m1".into(), name: "Backend".into(), role: "dev".into(), ..Default::default() },
            provider: "codex".into(),
            model: "gpt-x".into(),
            effort: "high".into(),
            prompt: "SECRET INSTRUCTIONS".into(),
            account_id: Some("acct-42".into()),
        });
        state.items.push(team::Item { id: "i1".into(), member_id: "m1".into(), kind: "work".into(), run_in: RUN_IN_REMOTE.into(), output_text: "x".repeat(10), ..Default::default() });
        let json = serde_json::to_string(&shared_run(&state)).unwrap();
        assert!(!json.contains("SECRET INSTRUCTIONS"));
        assert!(!json.contains("acct-42"));
        assert!(!json.contains("gpt-x"));
        assert!(json.contains("\"engine\":\"codex\""));
        assert!(json.contains("\"remote\":true"));
    }

    fn git(dir: &std::path::Path, args: &[&str]) -> String {
        let out = crate::git::cli::run_in(&dir.to_string_lossy(), args, &[]).unwrap();
        assert!(out.success, "git {args:?}: {}", out.detail());
        out.stdout.trim().to_string()
    }

    /// The whole trip of a seat's task through git, without the network or an engine: the owner packs
    /// where it starts (ahead of anything pushed), the guest's worktree starts there, their commit
    /// comes back and the owner's item worktree moves onto it.
    #[test]
    fn a_task_starts_on_the_guest_and_its_commit_lands_on_the_owner() {
        let root = std::env::temp_dir().join(format!("cf-run-trip-{}", uuid::Uuid::new_v4()));
        let (remote, owner, guest) = (root.join("remote.git"), root.join("owner"), root.join("guest"));
        std::fs::create_dir_all(&owner).unwrap();
        git(&owner, &["init", "-q", "-b", "main"]);
        git(&owner, &["config", "core.autocrlf", "false"]);
        git(&owner, &["config", "user.name", "Ana"]);
        git(&owner, &["config", "user.email", "a@e"]);
        std::fs::write(owner.join("README.md"), "hola\n").unwrap();
        git(&owner, &["add", "-A"]);
        git(&owner, &["commit", "-q", "-m", "base"]);
        git(&root, &["clone", "-q", "--bare", &owner.to_string_lossy(), &remote.to_string_lossy()]);
        git(&owner, &["remote", "add", "origin", &remote.to_string_lossy()]);
        git(&owner, &["fetch", "-q", "origin"]);
        git(&root, &["clone", "-q", "-c", "core.autocrlf=false", &remote.to_string_lossy(), &guest.to_string_lossy()]);
        git(&guest, &["config", "user.name", "Beto"]);
        git(&guest, &["config", "user.email", "b@e"]);

        // The owner's run: an item worktree on the integration branch, which the lead already moved on.
        git(&owner, &["checkout", "-q", "-b", "codeflow/team-x"]);
        std::fs::write(owner.join("contract.md"), "v2\n").unwrap();
        git(&owner, &["add", "-A"]);
        git(&owner, &["commit", "-q", "-m", "contrato"]);
        let item_wt = root.join("owner-item");
        crate::team::gitops::add_worktree(&owner.to_string_lossy(), &item_wt.to_string_lossy(), "codeflow/team-x-a", "codeflow/team-x").unwrap();
        let start = crate::team::gitops::head_sha(&item_wt.to_string_lossy()).unwrap();
        let o = owner.to_string_lossy().to_string();
        let basis = bundle::basis(&o, &start, "main").unwrap();
        let Pack::Bundle(out) = bundle::create(&o, &start, &basis).unwrap() else { panic!("the start is ahead of the basis") };

        // The guest: the start arrives, their agent works, the commit is packed.
        let g = guest.to_string_lossy().to_string();
        let path = root.join("guest-item").to_string_lossy().to_string();
        prepare_start(&g, "main", &start, Some(&out), "i1", &path, "codeflow/equipo-x").unwrap();
        assert_eq!(std::fs::read_to_string(std::path::Path::new(&path).join("contract.md")).unwrap(), "v2\n", "the guest starts from the owner's unpushed work");
        std::fs::write(std::path::Path::new(&path).join("tests.md"), "de Beto\n").unwrap();
        let (head, pack) = pack_result(&path, &g, &start, "Pruebas").unwrap();
        let Pack::Bundle(back) = pack else { panic!("the guest committed something") };

        // A retry of the same item starts over on the same branch name.
        crate::team::gitops::remove_worktree(&g, &path);
        prepare_start(&g, "main", &start, Some(&out), "i1", &path, "codeflow/equipo-x").unwrap();
        assert!(!std::path::Path::new(&path).join("tests.md").exists(), "a retry starts from the owner's start, not the last attempt");
        crate::team::gitops::remove_worktree(&g, &path);

        // A review only reads: detached, no branch.
        prepare_start(&g, "main", &start, None, "i2", &path, "").unwrap();
        assert!(crate::team::gitops::current_branch(&path).is_none());
        crate::team::gitops::remove_worktree(&g, &path);

        // The owner takes the commit into the item's worktree.
        let got = bundle::receive(&o, &back, "i1-result", Some(&head)).unwrap();
        bundle::fast_forward(&item_wt.to_string_lossy(), &got).unwrap();
        assert_eq!(std::fs::read_to_string(item_wt.join("tests.md")).unwrap(), "de Beto\n");
        let author = git(&item_wt, &["log", "-1", "--format=%an"]);
        assert_eq!(author, "Beto", "the commit is the guest's own");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_lead_and_sub_leads_are_never_seats() {
        let mut run = team::Run { lead: "lead".into(), ..Default::default() };
        for (id, leads) in [("lead", false), ("sub", true), ("dev", false)] {
            run.members.push(team::MemberSnap { member: team::Member { id: id.into(), leads, ..Default::default() }, ..Default::default() });
        }
        let ids: Vec<&str> = seatable(&run).into_iter().map(|m| m.member.id.as_str()).collect();
        assert_eq!(ids, vec!["dev"]);
    }
}
