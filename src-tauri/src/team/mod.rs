//! «Equipo»: a configurable team of roster agents that takes one goal, splits it, works in parallel —
//! each member in a worktree of its own — and leaves the result on the branch the user picked, in one
//! repository or several.
//!
//! # The shape
//!
//! - A **team** is a template: members (roster agents + a role + what each may do), a lead (a member,
//!   or none for a fixed plan the user wrote) and a **policy** (when to ask the user, how to commit,
//!   how to integrate, checks, review, budgets). See `.claude/plans/agent-team.md`.
//! - A **run** is one goal handed to a team: its repositories, each with a target branch and an
//!   integration branch in a worktree of its own (the user's checkout is never touched), a copy of the
//!   policy and of the roster as they were, and a graph of **items**.
//! - An **item** is one piece of work for one member in one repository, with dependencies. Items run
//!   as ordinary agent tasks (`agent_tasks`, `batch_id = team:<run>`), so history, cost, accounts and
//!   recovery are the tasks' own. The scheduler hands out *every* ready item up to the parallel caps.
//! - A **message** is every interaction between members, the lead and the user — what the run view
//!   draws as the team's channel.
//!
//! The backend decides, the frontend drives: [`claim_ready`] marks items running and the main window
//! runs them (headless turn or a CLI in a terminal), then reports each one back to `team_cmd`.

pub mod gitops;
pub mod protocol;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::db::queries::now;

/// The `agent_tasks.batch_id` prefix that marks a task as an item of a team run.
pub const TASK_BATCH_PREFIX: &str = "team:";

/// Hard ceilings, whatever a policy says.
pub const MAX_PARALLEL_CAP: i64 = 8;
pub const MAX_DISPATCHES_CAP: i64 = 256;
pub const MAX_LEAD_ROUNDS_CAP: i64 = 20;
pub const MAX_REPOS: usize = 16;
pub const MAX_MEMBERS: usize = 16;
/// How much of one dependency's handoff reaches the item that needs it.
pub const HANDOFF_PER_DEP: usize = 24_000;

// ---------------------------------------------------------------- policy

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Check {
    /// A project id, or `"*"` for every repository of the run.
    pub repo: String,
    pub command: String,
    /// `item` after each piece of work, `final` once everything is integrated.
    pub when: String,
}

impl Default for Check {
    fn default() -> Self {
        Self { repo: "*".into(), command: String::new(), when: "final".into() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ReviewPolicy {
    pub enabled: bool,
    /// The reviewing member's id.
    pub reviewer: String,
    /// Members whose work is reviewed; empty is every member that edits (but the reviewer).
    pub of: Vec<String>,
    /// `correct` or `polished` — see `chain_review::Exigence`.
    pub exigence: String,
    pub laps: i64,
}

impl Default for ReviewPolicy {
    fn default() -> Self {
        Self { enabled: false, reviewer: String::new(), of: Vec::new(), exigence: "correct".into(), laps: crate::chain_review::DEFAULT_MAX_LAPS }
    }
}

/// Everything about how a team behaves that is not who is in it. One JSON column, versioned by its
/// defaults: a field added later reads as its default on every team saved before it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Policy {
    /// The lead's first plan waits for the user.
    pub approve_plan: bool,
    /// `never`, `first` (the first item that writes) or `each` (every item that writes).
    pub approve_code: String,
    /// Integrating into the target branch waits for the user.
    pub approve_merge: bool,
    /// `allow` (lead and members may ask the user), `plan` (only the lead, while planning), `never`.
    pub questions: String,
    /// `item` (one commit per item, kept), `squash` (one commit per repository at the end), `none`
    /// (the target branch gets the changes uncommitted).
    pub commit: String,
    /// `conventional` or `free`.
    pub commit_style: String,
    /// `merge` (into the target branch) or `branch` (leave the integration branch for the user).
    pub integrate: String,
    pub push: bool,
    /// Member id that resolves merge conflicts, `author` (the item's own member) or `user`.
    pub conflicts: String,
    pub checks: Vec<Check>,
    pub review: ReviewPolicy,
    pub max_parallel: i64,
    pub max_attempts: i64,
    pub max_dispatches: i64,
    pub lead_rounds: i64,
    /// Once everything is done the lead gets a last look before integration.
    pub lead_final_check: bool,
    /// Remove the item worktrees once the run is integrated.
    pub cleanup: bool,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            approve_plan: true,
            approve_code: "never".into(),
            approve_merge: true,
            questions: "allow".into(),
            commit: "item".into(),
            commit_style: "conventional".into(),
            integrate: "merge".into(),
            push: false,
            conflicts: "author".into(),
            checks: Vec::new(),
            review: ReviewPolicy::default(),
            max_parallel: 3,
            max_attempts: 3,
            max_dispatches: 64,
            lead_rounds: 6,
            lead_final_check: true,
            cleanup: true,
        }
    }
}

impl Policy {
    /// The policy with every number inside its ceiling and every enum one of its values, so nothing
    /// downstream has to defend against a hand-edited row.
    pub fn sane(mut self) -> Self {
        self.max_parallel = self.max_parallel.clamp(1, MAX_PARALLEL_CAP);
        self.max_attempts = self.max_attempts.clamp(1, 6);
        self.max_dispatches = self.max_dispatches.clamp(1, MAX_DISPATCHES_CAP);
        self.lead_rounds = self.lead_rounds.clamp(1, MAX_LEAD_ROUNDS_CAP);
        self.review.laps = self.review.laps.clamp(1, crate::chain_review::MAX_LAPS_CAP);
        let pick = |v: &str, allowed: &[&str], default: &str| if allowed.contains(&v) { v.to_string() } else { default.to_string() };
        self.approve_code = pick(&self.approve_code, &["never", "first", "each"], "never");
        self.questions = pick(&self.questions, &["allow", "plan", "never"], "allow");
        self.commit = pick(&self.commit, &["item", "squash", "none"], "item");
        self.commit_style = pick(&self.commit_style, &["conventional", "free"], "conventional");
        self.integrate = pick(&self.integrate, &["merge", "branch"], "merge");
        self.checks.retain(|c| !c.command.trim().is_empty());
        for c in &mut self.checks {
            c.when = pick(&c.when, &["item", "final"], "final");
            if c.repo.trim().is_empty() {
                c.repo = "*".into();
            }
        }
        self
    }

    pub fn members_may_ask(&self) -> bool {
        self.questions == "allow"
    }
}

// ---------------------------------------------------------------- team

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Member {
    pub id: String,
    /// The roster agent it runs as: provider, model, effort, account and prompt are the agent's.
    pub agent_id: String,
    /// Shown name; the agent's when empty.
    pub name: String,
    /// Free text: what this member is for. The lead reads it to route work.
    pub role: String,
    /// May write. A member that does not runs read-only and only gets `investigate`/`review`.
    pub edits: bool,
    pub max_parallel: i64,
    /// `headless` (a background turn) or `terminal` (its CLI in a terminal you can watch).
    pub run_in: String,
    /// Project ids it may work in; empty is all.
    pub repos: Vec<String>,
    /// Member that takes an item over once this one has failed it `max_attempts` times; `""` none.
    pub escalate_to: String,
}

impl Default for Member {
    fn default() -> Self {
        Self {
            id: String::new(),
            agent_id: String::new(),
            name: String::new(),
            role: String::new(),
            edits: true,
            max_parallel: 1,
            run_in: "headless".into(),
            repos: Vec::new(),
            escalate_to: String::new(),
        }
    }
}

/// One step of a fixed plan (a team with no lead).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default)]
pub struct PlanStep {
    pub key: String,
    pub member: String,
    /// `"*"` one item per repository, `""` the first repository, else a project id.
    pub repo: String,
    pub kind: String,
    pub title: String,
    pub instruction: String,
    pub depends_on: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Team {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub description: String,
    /// The lead's member id, or `""` for a fixed plan.
    pub lead: String,
    pub policy: Policy,
    pub plan: Vec<PlanStep>,
    pub members: Vec<Member>,
    pub created_at: String,
    pub updated_at: String,
}

/// A member as a run sees it: the team's member plus the agent's routing as it was at the start.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct MemberSnap {
    #[serde(flatten)]
    pub member: Member,
    pub provider: String,
    pub model: String,
    pub effort: String,
    pub prompt: String,
    pub account_id: Option<String>,
}

// ---------------------------------------------------------------- run

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Run {
    pub id: String,
    pub workspace_id: String,
    pub team_id: String,
    pub team_name: String,
    pub title: String,
    pub goal: String,
    /// `running | gated | paused | done | failed | aborted`.
    pub status: String,
    /// What a `gated` run waits for: `plan`, `item:<id>`, `merge`, `stuck:<id or "">`.
    pub gate: String,
    pub gate_note: String,
    pub lead: String,
    pub lead_rounds_used: i64,
    pub lead_done: bool,
    pub dispatches: i64,
    pub last_reason: String,
    pub agent_project_id: String,
    pub pinned: bool,
    pub created_at: String,
    pub updated_at: String,
    pub policy: Policy,
    pub members: Vec<MemberSnap>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RunRepo {
    pub run_id: String,
    pub project_id: String,
    pub name: String,
    pub local_path: String,
    pub target_branch: String,
    pub integration_branch: String,
    pub integration_path: String,
    /// `ready | merged | left | failed`.
    pub status: String,
    pub last_error: String,
    pub position: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Item {
    pub id: String,
    pub run_id: String,
    pub key: String,
    pub member_id: String,
    pub member_name: String,
    pub project_id: String,
    /// `plan | final | answer | work | investigate | review | integrate`.
    pub kind: String,
    pub title: String,
    pub instruction: String,
    pub depends_on: Vec<String>,
    /// `pending | gated | running | waiting | done | error | cancelled | skipped`.
    pub status: String,
    pub approved: bool,
    pub task_id: String,
    pub worktree_path: String,
    pub branch: String,
    pub commit_sha: String,
    pub merged: bool,
    pub output_text: String,
    pub attempts: i64,
    pub last_error: String,
    pub feedback: String,
    pub round: i64,
    pub lap: i64,
    /// The work item this one continues (a fix after review), reviews, or integrates.
    pub ref_item: String,
    pub run_in: String,
    pub terminal_session: String,
    pub created_at: String,
    pub updated_at: String,
    pub started_at: String,
    pub finished_at: String,
}

impl Item {
    pub fn writes(&self) -> bool {
        matches!(self.kind.as_str(), "work" | "integrate")
    }
    pub fn is_lead(&self) -> bool {
        matches!(self.kind.as_str(), "plan" | "final" | "answer")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Message {
    pub id: String,
    pub run_id: String,
    pub item_id: String,
    pub from_id: String,
    pub from_name: String,
    pub to_id: String,
    pub to_name: String,
    /// `plan | decision | handoff | question | answer | note | finding | status | merge | error`.
    pub kind: String,
    pub body: String,
    pub options: Vec<String>,
    pub answer: String,
    pub answered_at: String,
    pub delivered: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct RunState {
    pub run: Run,
    pub repos: Vec<RunRepo>,
    pub items: Vec<Item>,
    pub messages: Vec<Message>,
}

// ---------------------------------------------------------------- schema

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_teams (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            lead TEXT NOT NULL DEFAULT '',
            policy TEXT NOT NULL DEFAULT '{}',
            plan TEXT NOT NULL DEFAULT '[]',
            members TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_agent_teams_ws ON agent_teams(workspace_id);
         CREATE TABLE IF NOT EXISTS agent_team_runs (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            team_id TEXT NOT NULL DEFAULT '',
            team_name TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL DEFAULT '',
            goal TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'running',
            gate TEXT NOT NULL DEFAULT '',
            gate_note TEXT NOT NULL DEFAULT '',
            lead TEXT NOT NULL DEFAULT '',
            lead_rounds_used INTEGER NOT NULL DEFAULT 0,
            lead_done INTEGER NOT NULL DEFAULT 0,
            dispatches INTEGER NOT NULL DEFAULT 0,
            last_reason TEXT NOT NULL DEFAULT '',
            agent_project_id TEXT NOT NULL DEFAULT '',
            pinned INTEGER NOT NULL DEFAULT 0,
            policy TEXT NOT NULL DEFAULT '{}',
            members TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_agent_team_runs_ws ON agent_team_runs(workspace_id);
         CREATE TABLE IF NOT EXISTS agent_team_repos (
            run_id TEXT NOT NULL REFERENCES agent_team_runs(id) ON DELETE CASCADE,
            project_id TEXT NOT NULL,
            name TEXT NOT NULL DEFAULT '',
            local_path TEXT NOT NULL DEFAULT '',
            target_branch TEXT NOT NULL DEFAULT '',
            integration_branch TEXT NOT NULL DEFAULT '',
            integration_path TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'ready',
            last_error TEXT NOT NULL DEFAULT '',
            position INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (run_id, project_id)
         );
         CREATE TABLE IF NOT EXISTS agent_team_items (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES agent_team_runs(id) ON DELETE CASCADE,
            key TEXT NOT NULL,
            member_id TEXT NOT NULL DEFAULT '',
            member_name TEXT NOT NULL DEFAULT '',
            project_id TEXT NOT NULL DEFAULT '',
            kind TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            instruction TEXT NOT NULL DEFAULT '',
            depends_on TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'pending',
            approved INTEGER NOT NULL DEFAULT 0,
            task_id TEXT NOT NULL DEFAULT '',
            worktree_path TEXT NOT NULL DEFAULT '',
            branch TEXT NOT NULL DEFAULT '',
            commit_sha TEXT NOT NULL DEFAULT '',
            merged INTEGER NOT NULL DEFAULT 0,
            output_text TEXT NOT NULL DEFAULT '',
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT NOT NULL DEFAULT '',
            feedback TEXT NOT NULL DEFAULT '',
            round INTEGER NOT NULL DEFAULT 0,
            lap INTEGER NOT NULL DEFAULT 0,
            ref_item TEXT NOT NULL DEFAULT '',
            run_in TEXT NOT NULL DEFAULT 'headless',
            terminal_session TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            started_at TEXT NOT NULL DEFAULT '',
            finished_at TEXT NOT NULL DEFAULT ''
         );
         CREATE INDEX IF NOT EXISTS idx_agent_team_items_run ON agent_team_items(run_id);
         CREATE TABLE IF NOT EXISTS agent_team_messages (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES agent_team_runs(id) ON DELETE CASCADE,
            item_id TEXT NOT NULL DEFAULT '',
            from_id TEXT NOT NULL DEFAULT '',
            from_name TEXT NOT NULL DEFAULT '',
            to_id TEXT NOT NULL DEFAULT '',
            to_name TEXT NOT NULL DEFAULT '',
            kind TEXT NOT NULL,
            body TEXT NOT NULL DEFAULT '',
            options TEXT NOT NULL DEFAULT '[]',
            answer TEXT NOT NULL DEFAULT '',
            answered_at TEXT NOT NULL DEFAULT '',
            delivered INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_agent_team_messages_run ON agent_team_messages(run_id);",
    )
}

fn json<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".into())
}

fn parse<T: for<'de> Deserialize<'de> + Default>(text: &str) -> T {
    serde_json::from_str(text).unwrap_or_default()
}

// ---------------------------------------------------------------- teams

const TEAM_COLUMNS: &str = "id, workspace_id, name, description, lead, policy, plan, members, created_at, updated_at";

fn map_team(row: &rusqlite::Row) -> rusqlite::Result<Team> {
    Ok(Team {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        name: row.get(2)?,
        description: row.get(3)?,
        lead: row.get(4)?,
        policy: parse::<Policy>(&row.get::<_, String>(5)?).sane(),
        plan: parse(&row.get::<_, String>(6)?),
        members: parse(&row.get::<_, String>(7)?),
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

pub fn list_teams(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<Team>> {
    let mut stmt = conn.prepare(&format!("SELECT {TEAM_COLUMNS} FROM agent_teams WHERE workspace_id = ?1 ORDER BY name COLLATE NOCASE"))?;
    let rows = stmt.query_map(params![workspace_id], map_team)?;
    rows.collect()
}

pub fn get_team(conn: &Connection, id: &str) -> rusqlite::Result<Option<Team>> {
    conn.query_row(&format!("SELECT {TEAM_COLUMNS} FROM agent_teams WHERE id = ?1"), params![id], map_team).optional()
}

/// Saves a team as a whole. Member ids are kept when given (the lead and the plan point at them)
/// and minted otherwise; a lead or plan step naming a member that is gone is cleared.
pub fn save_team(conn: &Connection, mut team: Team) -> Result<Team, String> {
    if team.name.trim().is_empty() {
        return Err("El equipo necesita un nombre.".into());
    }
    if team.members.is_empty() {
        return Err("El equipo necesita al menos un miembro.".into());
    }
    if team.members.len() > MAX_MEMBERS {
        return Err(format!("Un equipo tiene como máximo {MAX_MEMBERS} miembros."));
    }
    for member in &mut team.members {
        if member.id.trim().is_empty() {
            member.id = Uuid::new_v4().to_string();
        }
        member.max_parallel = member.max_parallel.clamp(1, MAX_PARALLEL_CAP);
        if member.run_in != "terminal" {
            member.run_in = "headless".into();
        }
        if member.agent_id.trim().is_empty() {
            return Err("Cada miembro tiene que ser un agente del roster.".into());
        }
    }
    let ids: Vec<String> = team.members.iter().map(|m| m.id.clone()).collect();
    if !ids.contains(&team.lead) {
        team.lead.clear();
    }
    for member in &mut team.members {
        if !ids.contains(&member.escalate_to) || member.escalate_to == member.id {
            member.escalate_to.clear();
        }
    }
    team.plan.retain(|s| ids.contains(&s.member) && !s.instruction.trim().is_empty());
    if team.lead.is_empty() && team.plan.is_empty() {
        return Err("Sin líder, el equipo necesita un plan con al menos un paso.".into());
    }
    team.policy = team.policy.sane();
    if team.policy.review.enabled && !ids.contains(&team.policy.review.reviewer) {
        team.policy.review.enabled = false;
    }
    let stamp = now();
    if team.id.trim().is_empty() {
        team.id = Uuid::new_v4().to_string();
        team.created_at = stamp.clone();
    } else if team.created_at.is_empty() {
        team.created_at = conn
            .query_row("SELECT created_at FROM agent_teams WHERE id = ?1", params![team.id], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| stamp.clone());
    }
    team.updated_at = stamp;
    conn.execute(
        "INSERT INTO agent_teams (id, workspace_id, name, description, lead, policy, plan, members, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, lead = excluded.lead,
            policy = excluded.policy, plan = excluded.plan, members = excluded.members, updated_at = excluded.updated_at",
        params![
            team.id, team.workspace_id, team.name.trim(), team.description, team.lead,
            json(&team.policy), json(&team.plan), json(&team.members), team.created_at, team.updated_at
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(team)
}

pub fn delete_team(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM agent_teams WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------------------------------------------------------------- runs

const RUN_COLUMNS: &str = "id, workspace_id, team_id, team_name, title, goal, status, gate, gate_note, lead, lead_rounds_used, \
    lead_done, dispatches, last_reason, agent_project_id, pinned, created_at, updated_at, policy, members";

fn map_run(row: &rusqlite::Row) -> rusqlite::Result<Run> {
    Ok(Run {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        team_id: row.get(2)?,
        team_name: row.get(3)?,
        title: row.get(4)?,
        goal: row.get(5)?,
        status: row.get(6)?,
        gate: row.get(7)?,
        gate_note: row.get(8)?,
        lead: row.get(9)?,
        lead_rounds_used: row.get(10)?,
        lead_done: row.get(11)?,
        dispatches: row.get(12)?,
        last_reason: row.get(13)?,
        agent_project_id: row.get(14)?,
        pinned: row.get(15)?,
        created_at: row.get(16)?,
        updated_at: row.get(17)?,
        policy: parse::<Policy>(&row.get::<_, String>(18)?).sane(),
        members: parse(&row.get::<_, String>(19)?),
    })
}

pub fn list_runs(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<Run>> {
    let mut stmt = conn.prepare(&format!("SELECT {RUN_COLUMNS} FROM agent_team_runs WHERE workspace_id = ?1 ORDER BY updated_at DESC"))?;
    let rows = stmt.query_map(params![workspace_id], map_run)?;
    rows.collect()
}

pub fn get_run(conn: &Connection, id: &str) -> rusqlite::Result<Option<Run>> {
    conn.query_row(&format!("SELECT {RUN_COLUMNS} FROM agent_team_runs WHERE id = ?1"), params![id], map_run).optional()
}

pub fn insert_run(conn: &Connection, run: &Run) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO agent_team_runs (id, workspace_id, team_id, team_name, title, goal, status, gate, gate_note, lead,
            lead_rounds_used, lead_done, dispatches, last_reason, agent_project_id, pinned, created_at, updated_at, policy, members)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
        params![
            run.id, run.workspace_id, run.team_id, run.team_name, run.title, run.goal, run.status, run.gate, run.gate_note,
            run.lead, run.lead_rounds_used, run.lead_done, run.dispatches, run.last_reason, run.agent_project_id, run.pinned,
            run.created_at, run.updated_at, json(&run.policy), json(&run.members)
        ],
    )?;
    Ok(())
}

pub fn set_run_status(conn: &Connection, id: &str, status: &str, gate: &str, note: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE agent_team_runs SET status = ?2, gate = ?3, gate_note = ?4, updated_at = ?5 WHERE id = ?1",
        params![id, status, gate, note, now()],
    )?;
    Ok(())
}

pub fn set_run_reason(conn: &Connection, id: &str, reason: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE agent_team_runs SET last_reason = ?2, updated_at = ?3 WHERE id = ?1", params![id, reason, now()])?;
    Ok(())
}

pub fn bump_lead_round(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE agent_team_runs SET lead_rounds_used = lead_rounds_used + 1 WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn set_lead_done(conn: &Connection, id: &str, done: bool) -> rusqlite::Result<()> {
    conn.execute("UPDATE agent_team_runs SET lead_done = ?2 WHERE id = ?1", params![id, done])?;
    Ok(())
}

pub fn set_run_meta(conn: &Connection, id: &str, title: Option<&str>, pinned: Option<bool>, agent_project_id: Option<&str>) -> rusqlite::Result<()> {
    if let Some(t) = title {
        conn.execute("UPDATE agent_team_runs SET title = ?2 WHERE id = ?1", params![id, t.trim()])?;
    }
    if let Some(p) = pinned {
        conn.execute("UPDATE agent_team_runs SET pinned = ?2 WHERE id = ?1", params![id, p])?;
    }
    if let Some(g) = agent_project_id {
        conn.execute("UPDATE agent_team_runs SET agent_project_id = ?2 WHERE id = ?1", params![id, g])?;
    }
    Ok(())
}

pub fn delete_run(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM agent_tasks WHERE batch_id = ?1", params![format!("{TASK_BATCH_PREFIX}{id}")])?;
    conn.execute("DELETE FROM agent_team_runs WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------------------------------------------------------------- repos

const REPO_COLUMNS: &str =
    "run_id, project_id, name, local_path, target_branch, integration_branch, integration_path, status, last_error, position";

fn map_repo(row: &rusqlite::Row) -> rusqlite::Result<RunRepo> {
    Ok(RunRepo {
        run_id: row.get(0)?,
        project_id: row.get(1)?,
        name: row.get(2)?,
        local_path: row.get(3)?,
        target_branch: row.get(4)?,
        integration_branch: row.get(5)?,
        integration_path: row.get(6)?,
        status: row.get(7)?,
        last_error: row.get(8)?,
        position: row.get(9)?,
    })
}

pub fn list_repos(conn: &Connection, run_id: &str) -> rusqlite::Result<Vec<RunRepo>> {
    let mut stmt = conn.prepare(&format!("SELECT {REPO_COLUMNS} FROM agent_team_repos WHERE run_id = ?1 ORDER BY position"))?;
    let rows = stmt.query_map(params![run_id], map_repo)?;
    rows.collect()
}

pub fn insert_repo(conn: &Connection, repo: &RunRepo) -> rusqlite::Result<()> {
    conn.execute(
        &format!("INSERT INTO agent_team_repos ({REPO_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"),
        params![
            repo.run_id, repo.project_id, repo.name, repo.local_path, repo.target_branch, repo.integration_branch,
            repo.integration_path, repo.status, repo.last_error, repo.position
        ],
    )?;
    Ok(())
}

pub fn set_repo_status(conn: &Connection, run_id: &str, project_id: &str, status: &str, error: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE agent_team_repos SET status = ?3, last_error = ?4 WHERE run_id = ?1 AND project_id = ?2",
        params![run_id, project_id, status, error],
    )?;
    Ok(())
}

// ---------------------------------------------------------------- items

const ITEM_COLUMNS: &str = "id, run_id, key, member_id, member_name, project_id, kind, title, instruction, depends_on, status, \
    approved, task_id, worktree_path, branch, commit_sha, merged, output_text, attempts, last_error, feedback, round, lap, \
    ref_item, run_in, terminal_session, created_at, updated_at, started_at, finished_at";

fn map_item(row: &rusqlite::Row) -> rusqlite::Result<Item> {
    Ok(Item {
        id: row.get(0)?,
        run_id: row.get(1)?,
        key: row.get(2)?,
        member_id: row.get(3)?,
        member_name: row.get(4)?,
        project_id: row.get(5)?,
        kind: row.get(6)?,
        title: row.get(7)?,
        instruction: row.get(8)?,
        depends_on: parse(&row.get::<_, String>(9)?),
        status: row.get(10)?,
        approved: row.get(11)?,
        task_id: row.get(12)?,
        worktree_path: row.get(13)?,
        branch: row.get(14)?,
        commit_sha: row.get(15)?,
        merged: row.get(16)?,
        output_text: row.get(17)?,
        attempts: row.get(18)?,
        last_error: row.get(19)?,
        feedback: row.get(20)?,
        round: row.get(21)?,
        lap: row.get(22)?,
        ref_item: row.get(23)?,
        run_in: row.get(24)?,
        terminal_session: row.get(25)?,
        created_at: row.get(26)?,
        updated_at: row.get(27)?,
        started_at: row.get(28)?,
        finished_at: row.get(29)?,
    })
}

pub fn list_items(conn: &Connection, run_id: &str) -> rusqlite::Result<Vec<Item>> {
    let mut stmt = conn.prepare(&format!("SELECT {ITEM_COLUMNS} FROM agent_team_items WHERE run_id = ?1 ORDER BY created_at, rowid"))?;
    let rows = stmt.query_map(params![run_id], map_item)?;
    rows.collect()
}

pub fn get_item(conn: &Connection, id: &str) -> rusqlite::Result<Option<Item>> {
    conn.query_row(&format!("SELECT {ITEM_COLUMNS} FROM agent_team_items WHERE id = ?1"), params![id], map_item).optional()
}

pub fn insert_item(conn: &Connection, item: &Item) -> rusqlite::Result<()> {
    conn.execute(
        &format!(
            "INSERT INTO agent_team_items ({ITEM_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
             ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30)"
        ),
        params![
            item.id, item.run_id, item.key, item.member_id, item.member_name, item.project_id, item.kind, item.title,
            item.instruction, json(&item.depends_on), item.status, item.approved, item.task_id, item.worktree_path, item.branch,
            item.commit_sha, item.merged, item.output_text, item.attempts, item.last_error, item.feedback, item.round, item.lap,
            item.ref_item, item.run_in, item.terminal_session, item.created_at, item.updated_at, item.started_at, item.finished_at
        ],
    )?;
    Ok(())
}

/// Writes every mutable column of an item back.
pub fn update_item(conn: &Connection, item: &Item) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE agent_team_items SET status = ?2, approved = ?3, task_id = ?4, worktree_path = ?5, branch = ?6, commit_sha = ?7,
            merged = ?8, output_text = ?9, attempts = ?10, last_error = ?11, feedback = ?12, terminal_session = ?13,
            updated_at = ?14, started_at = ?15, finished_at = ?16, depends_on = ?17, instruction = ?18, member_id = ?19,
            member_name = ?20, run_in = ?21
         WHERE id = ?1",
        params![
            item.id, item.status, item.approved, item.task_id, item.worktree_path, item.branch, item.commit_sha, item.merged,
            item.output_text, item.attempts, item.last_error, item.feedback, item.terminal_session, now(), item.started_at,
            item.finished_at, json(&item.depends_on), item.instruction, item.member_id, item.member_name, item.run_in
        ],
    )?;
    Ok(())
}

/// A new item, stamped and pending.
pub fn new_item(run: &Run, key: &str, member: Option<&MemberSnap>, project_id: &str, kind: &str, title: &str, instruction: &str) -> Item {
    let stamp = now();
    Item {
        id: Uuid::new_v4().to_string(),
        run_id: run.id.clone(),
        key: key.to_string(),
        member_id: member.map(|m| m.member.id.clone()).unwrap_or_default(),
        member_name: member.map(member_name).unwrap_or_default(),
        project_id: project_id.to_string(),
        kind: kind.to_string(),
        title: title.to_string(),
        instruction: instruction.to_string(),
        status: "pending".into(),
        run_in: member.map(|m| m.member.run_in.clone()).unwrap_or_else(|| "headless".into()),
        created_at: stamp.clone(),
        updated_at: stamp,
        ..Default::default()
    }
}

pub fn member_name(m: &MemberSnap) -> String {
    m.member.name.clone()
}

/// A key not yet used in the run: `base`, then `base-2`, `base-3`…
pub fn free_key(items: &[Item], base: &str) -> String {
    let base = if base.is_empty() { "t".to_string() } else { base.to_string() };
    let mut key = base.clone();
    let mut n = 2;
    while items.iter().any(|i| i.key == key) {
        key = format!("{base}-{n}");
        n += 1;
    }
    key
}

// ---------------------------------------------------------------- messages

const MESSAGE_COLUMNS: &str =
    "id, run_id, item_id, from_id, from_name, to_id, to_name, kind, body, options, answer, answered_at, delivered, created_at";

fn map_message(row: &rusqlite::Row) -> rusqlite::Result<Message> {
    Ok(Message {
        id: row.get(0)?,
        run_id: row.get(1)?,
        item_id: row.get(2)?,
        from_id: row.get(3)?,
        from_name: row.get(4)?,
        to_id: row.get(5)?,
        to_name: row.get(6)?,
        kind: row.get(7)?,
        body: row.get(8)?,
        options: parse(&row.get::<_, String>(9)?),
        answer: row.get(10)?,
        answered_at: row.get(11)?,
        delivered: row.get(12)?,
        created_at: row.get(13)?,
    })
}

pub fn list_messages(conn: &Connection, run_id: &str) -> rusqlite::Result<Vec<Message>> {
    let mut stmt = conn.prepare(&format!("SELECT {MESSAGE_COLUMNS} FROM agent_team_messages WHERE run_id = ?1 ORDER BY created_at, rowid"))?;
    let rows = stmt.query_map(params![run_id], map_message)?;
    rows.collect()
}

pub fn get_message(conn: &Connection, id: &str) -> rusqlite::Result<Option<Message>> {
    conn.query_row(&format!("SELECT {MESSAGE_COLUMNS} FROM agent_team_messages WHERE id = ?1"), params![id], map_message).optional()
}

/// Adds a message to the run's channel. `to_id` is a member id, `lead`, `user`, `all` or `""`.
#[allow(clippy::too_many_arguments)]
pub fn post(
    conn: &Connection,
    run_id: &str,
    item_id: &str,
    from: (&str, &str),
    to: (&str, &str),
    kind: &str,
    body: &str,
    options: &[String],
) -> rusqlite::Result<Message> {
    let message = Message {
        id: Uuid::new_v4().to_string(),
        run_id: run_id.to_string(),
        item_id: item_id.to_string(),
        from_id: from.0.to_string(),
        from_name: from.1.to_string(),
        to_id: to.0.to_string(),
        to_name: to.1.to_string(),
        kind: kind.to_string(),
        body: body.to_string(),
        options: options.to_vec(),
        created_at: now(),
        ..Default::default()
    };
    conn.execute(
        &format!("INSERT INTO agent_team_messages ({MESSAGE_COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, '', '', 0, ?11)"),
        params![
            message.id, message.run_id, message.item_id, message.from_id, message.from_name, message.to_id, message.to_name,
            message.kind, message.body, json(&message.options), message.created_at
        ],
    )?;
    Ok(message)
}

pub fn answer_message(conn: &Connection, id: &str, answer: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE agent_team_messages SET answer = ?2, answered_at = ?3 WHERE id = ?1", params![id, answer, now()])?;
    Ok(())
}

pub fn mark_delivered(conn: &Connection, ids: &[String]) -> rusqlite::Result<()> {
    for id in ids {
        conn.execute("UPDATE agent_team_messages SET delivered = 1 WHERE id = ?1", params![id])?;
    }
    Ok(())
}

pub fn state(conn: &Connection, run_id: &str) -> rusqlite::Result<Option<RunState>> {
    let Some(run) = get_run(conn, run_id)? else { return Ok(None) };
    Ok(Some(RunState { repos: list_repos(conn, run_id)?, items: list_items(conn, run_id)?, messages: list_messages(conn, run_id)?, run }))
}

// ---------------------------------------------------------------- scheduling

/// Whether an item's dependencies are all settled the way that lets it start: done (or skipped,
/// which is the user or the lead saying it is not needed), and — for work — integrated, so the item
/// branches off a tree that already has what it depends on.
pub fn deps_ready(item: &Item, items: &[Item]) -> bool {
    item.depends_on.iter().all(|dep| match items.iter().find(|i| i.id == *dep) {
        Some(d) => d.status == "skipped" || (d.status == "done" && (!d.writes() || d.merged || d.commit_sha.is_empty())),
        None => true,
    })
}

/// The items that may start now, in creation order, within the run's and each member's parallel
/// caps. Pure: [`claim_ready`] does the writing.
pub fn ready_items<'a>(run: &Run, items: &'a [Item]) -> Vec<&'a Item> {
    let running: Vec<&Item> = items.iter().filter(|i| i.status == "running").collect();
    let mut free = (run.policy.max_parallel - running.len() as i64).max(0);
    let mut per_member: std::collections::HashMap<&str, i64> = std::collections::HashMap::new();
    for i in &running {
        *per_member.entry(i.member_id.as_str()).or_default() += 1;
    }
    // A worktree shared by a fix and its review must not have both at once.
    let busy_trees: Vec<&str> = running.iter().map(|i| i.worktree_path.as_str()).filter(|p| !p.is_empty()).collect();
    let mut out = Vec::new();
    for item in items.iter().filter(|i| i.status == "pending") {
        if free == 0 {
            break;
        }
        if !deps_ready(item, items) {
            continue;
        }
        let cap = run.members.iter().find(|m| m.member.id == item.member_id).map(|m| m.member.max_parallel).unwrap_or(1).max(1);
        let used = per_member.get(item.member_id.as_str()).copied().unwrap_or(0);
        if used >= cap {
            continue;
        }
        if !item.worktree_path.is_empty() && busy_trees.contains(&item.worktree_path.as_str()) {
            continue;
        }
        *per_member.entry(item.member_id.as_str()).or_default() += 1;
        free -= 1;
        out.push(item);
    }
    out
}

/// Whether this item has to wait for the user before it starts, by the policy's `approve_code`.
pub fn needs_code_approval(run: &Run, item: &Item, items: &[Item]) -> bool {
    if item.approved || item.kind != "work" || !item.ref_item.is_empty() {
        return false;
    }
    match run.policy.approve_code.as_str() {
        "each" => true,
        "first" => !items.iter().any(|i| i.kind == "work" && i.id != item.id && (i.approved || i.status != "pending")),
        _ => false,
    }
}

/// What is still in motion: anything a run has to wait for before it can finish.
pub fn open_items(items: &[Item]) -> usize {
    items.iter().filter(|i| matches!(i.status.as_str(), "pending" | "gated" | "running" | "waiting")).count()
}

/// The work items that are done but not yet in the integration branch.
pub fn unmerged_work(items: &[Item]) -> Vec<&Item> {
    items.iter().filter(|i| i.kind == "work" && i.status == "done" && !i.merged && !i.commit_sha.is_empty()).collect()
}

/// Whether a conversation belongs to an item of any team run.
pub fn is_team_conversation(conn: &Connection, conversation_id: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM agent_tasks t JOIN agent_team_items i ON i.task_id = t.id WHERE t.conversation_id = ?1 LIMIT 1",
        params![conversation_id],
        |_| Ok(()),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}

/// Whether a conversation is a team item that must not write (lead turns, investigations, reviews).
pub fn read_only_conversation(conn: &Connection, conversation_id: &str) -> bool {
    conn.query_row(
        "SELECT i.kind, i.member_id, r.members FROM agent_tasks t
         JOIN agent_team_items i ON i.task_id = t.id
         JOIN agent_team_runs r ON r.id = i.run_id
         WHERE t.conversation_id = ?1 AND i.status = 'running' LIMIT 1",
        params![conversation_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
    )
    .optional()
    .ok()
    .flatten()
    .is_some_and(|(kind, member_id, members)| {
        let members: Vec<MemberSnap> = parse(&members);
        let edits = members.iter().find(|m| m.member.id == member_id).is_some_and(|m| m.member.edits);
        !matches!(kind.as_str(), "work" | "integrate") || !edits
    })
}

/// The team item a terminal folder belongs to, while it is running there — what `cf done` closes.
pub fn running_item_at(conn: &Connection, folder: &str) -> Option<(String, String)> {
    let folder = folder.trim_end_matches(['/', '\\']);
    let mut stmt = conn
        .prepare("SELECT id, run_id, worktree_path FROM agent_team_items WHERE status = 'running' AND run_in = 'terminal'")
        .ok()?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)))
        .ok()?;
    let hit = rows.flatten().find(|(_, _, path)| {
        let path = path.trim_end_matches(['/', '\\']);
        !path.is_empty() && (folder == path || folder.starts_with(&format!("{path}/")) || folder.starts_with(&format!("{path}\\")))
    });
    hit.map(|(id, run, _)| (id, run))
}

/// After a restart: nothing is running any more. Items that said so go back to pending (their turn
/// died with the app), and runs that were moving park as paused until the user resumes them.
pub fn recover_after_restart(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE agent_team_items SET status = 'pending', last_error = 'team.interrupted', terminal_session = ''
         WHERE status = 'running'",
        [],
    )?;
    conn.execute(
        "UPDATE agent_team_runs SET status = 'paused', last_reason = 'team.interrupted' WHERE status = 'running'",
        [],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(max_parallel: i64) -> Run {
        let member = |id: &str, cap: i64| MemberSnap { member: Member { id: id.into(), max_parallel: cap, ..Default::default() }, ..Default::default() };
        Run { policy: Policy { max_parallel, ..Default::default() }, members: vec![member("a", 2), member("b", 1)], ..Default::default() }
    }

    fn item(id: &str, member: &str, status: &str, deps: &[&str]) -> Item {
        Item {
            id: id.into(),
            key: id.into(),
            member_id: member.into(),
            kind: "work".into(),
            status: status.into(),
            depends_on: deps.iter().map(|d| d.to_string()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn hands_out_parallel_work_within_caps() {
        let items = vec![item("1", "a", "pending", &[]), item("2", "a", "pending", &[]), item("3", "a", "pending", &[]), item("4", "b", "pending", &[])];
        let ready: Vec<&str> = ready_items(&run(3), &items).iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ready, vec!["1", "2", "4"]);
        let ready: Vec<&str> = ready_items(&run(1), &items).iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ready, vec!["1"]);
    }

    #[test]
    fn waits_for_dependencies_to_be_integrated() {
        let mut dep = item("1", "a", "done", &[]);
        dep.commit_sha = "abc".into();
        let items = vec![dep.clone(), item("2", "b", "pending", &["1"])];
        assert!(ready_items(&run(3), &items).is_empty());
        dep.merged = true;
        let items = vec![dep, item("2", "b", "pending", &["1"])];
        assert_eq!(ready_items(&run(3), &items).len(), 1);
    }

    #[test]
    fn work_with_no_changes_does_not_block() {
        let dep = item("1", "a", "done", &[]);
        let items = vec![dep, item("2", "b", "pending", &["1"])];
        assert_eq!(ready_items(&run(3), &items).len(), 1);
    }

    #[test]
    fn code_approval_first_and_each() {
        let mut r = run(3);
        r.policy.approve_code = "first".into();
        let items = vec![item("1", "a", "pending", &[]), item("2", "a", "pending", &[])];
        assert!(needs_code_approval(&r, &items[0], &items));
        let mut approved = items.clone();
        approved[0].approved = true;
        assert!(!needs_code_approval(&r, &approved[1], &approved));
        r.policy.approve_code = "each".into();
        assert!(needs_code_approval(&r, &approved[1], &approved));
    }

    #[test]
    fn policy_is_clamped() {
        let p = Policy { max_parallel: 99, commit: "weird".into(), ..Default::default() }.sane();
        assert_eq!(p.max_parallel, MAX_PARALLEL_CAP);
        assert_eq!(p.commit, "item");
    }
}

/// What a background turn in a team folder gets so `cf` works there: the app's endpoint, the item it
/// is, and the folder `cf` lives in for its `PATH`.
#[derive(Debug, Default, Clone)]
pub struct CfEnv {
    pub vars: Vec<(String, String)>,
    pub cf_dir: Option<std::path::PathBuf>,
}

/// [`CfEnv`] for a turn about to run in `cwd`, when `cwd` is the folder of a running, headless team
/// item. Empty everywhere else: every other background run stays as it was.
pub fn cf_env_for(cwd: &str) -> CfEnv {
    let cwd = cwd.trim_end_matches(['/', '\\']).to_string();
    let item = crate::ai_usage::with_conn(|conn| -> Option<String> {
        let mut stmt = conn
            .prepare(
                "SELECT i.id, i.worktree_path, r.integration_path FROM agent_team_items i
                 JOIN agent_team_repos r ON r.run_id = i.run_id AND r.project_id = i.project_id
                 WHERE i.status = 'running' AND i.run_in = 'headless'",
            )
            .ok()?;
        let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))).ok()?;
        let found = rows
            .flatten()
            .find(|(_, tree, integ)| [tree, integ].iter().any(|p| !p.is_empty() && p.trim_end_matches(['/', '\\']) == cwd))
            .map(|(id, _, _)| id);
        found
    })
    .flatten();
    let Some(item) = item else { return CfEnv::default() };
    let mut vars = crate::agentcli::shell_env();
    if vars.is_empty() {
        return CfEnv::default();
    }
    vars.push(("CODEFLOW_TEAM_ITEM".to_string(), item));
    let cf_dir = crate::ai_usage::app().and_then(crate::terminal::cf_binary).and_then(|bin| bin.parent().map(|d| d.to_path_buf()));
    CfEnv { vars, cf_dir }
}
