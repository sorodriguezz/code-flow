//! The hybrid task's rows: one `hybrid_runs` row per chain (its frozen configuration and the plan's
//! summary) and one `hybrid_items` row per task of the plan. See `crate::hybrid`.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::queries::now;
use crate::hybrid::plan::{ContextRef, Plan, PlanCheck, PlanTask, Region, RepoRef};

/// A run's configuration, frozen when the chain was created.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HybridRun {
    pub chain_id: String,
    /// `bundled` | `ollama` | `openai`.
    pub backend: String,
    pub base_url: String,
    pub model: String,
    pub ctx: i64,
    pub budget_input: i64,
    pub budget_output: i64,
    /// `easy` | `medium` | `all`.
    pub delegate: String,
    /// `review` | `skip`.
    pub on_fail: String,
    /// `fix` | `report`.
    pub review_mode: String,
    pub unload: bool,
    pub thinking: bool,
    pub plan_summary: String,
    pub plan_risks: Vec<String>,
    /// What the planner proposed, plus what a template brought along. `repo` is a project id.
    pub checks: Vec<PlanCheck>,
    /// What runs: ticked at the gate, brought by a template, or — without a gate — proposed and
    /// already trusted in that repository. The only commands that ever run.
    pub approved_checks: Vec<PlanCheck>,
    /// What was typed at the gate (a phone approval's note, or the desktop's), for the executor and
    /// the review.
    pub gate_note: String,
    pub baseline_commit: String,
    /// What the subscription spent, as its CLI reported it: the plan's turns and the review's.
    pub plan_input_tokens: i64,
    pub plan_output_tokens: i64,
    pub review_input_tokens: i64,
    pub review_output_tokens: i64,
    /// A task small enough to skip the plan: the local model writes it straight from the objective,
    /// and the review only runs if somebody asks for it.
    pub direct: bool,
    /// How many rounds of local corrections the review has handed back so far.
    pub fix_round: i64,
    /// Why the review step was skipped, if it was: `direct` (a direct run) or `small` (a plan of a
    /// couple of easy tasks, all done locally, whose checks passed). Empty otherwise.
    pub review_skip: String,
    pub created_at: String,
    pub updated_at: String,
}

/// One task of the plan.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HybridItem {
    pub id: String,
    pub chain_id: String,
    pub ord: i64,
    /// The planner's own id for the task (`t1`), which `depends_on` refers to.
    pub task_key: String,
    pub title: String,
    pub file: String,
    /// `create` | `modify` | `delete`.
    pub action: String,
    pub regions: Vec<Region>,
    pub instruction: String,
    pub context: Vec<ContextRef>,
    pub acceptance: Vec<String>,
    pub depends_on: Vec<String>,
    /// `easy` | `medium` | `hard`.
    pub difficulty: String,
    /// `local` | `sub`.
    pub assignee: String,
    pub enabled: bool,
    /// `pending` | `running` | `done` | `failed` | `skipped` | `escalated`.
    pub status: String,
    pub attempts: i64,
    /// The English sentence the review model reads in the report.
    pub error: String,
    /// What kind of failure `error` is, so the panel can say it in the reader's language — see
    /// `hybrid::execute::why`. Empty when there is none.
    pub error_code: String,
    pub tokens_in: i64,
    pub tokens_out: i64,
    pub ms: i64,
    pub lines_added: i64,
    pub lines_removed: i64,
    pub hash_before: String,
    pub hash_after: String,
    pub updated_at: String,
    /// The repository it writes in. Empty: the chain's first.
    pub project_id: String,
    /// 0 for the plan's tasks; n for the corrections the review handed back in round n.
    pub round: i64,
}

/// A hybrid task kept as a template of its workspace: what the dialog opens with and what a run made
/// from it takes instead of Settings. Stored as JSON in `workspace_chain_templates.config`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct HybridTemplateConfig {
    /// The roster agent that plans and reviews, by id — resolved against the roster when used, like
    /// a chain template's steps.
    #[serde(default)]
    pub planner_agent_id: String,
    /// The objective the dialog opens with.
    #[serde(default)]
    pub goal: String,
    #[serde(default = "yes")]
    pub gate: bool,
    /// `local` | `fix` | `report`; empty: Settings decide.
    #[serde(default)]
    pub review_mode: String,
    /// `easy` | `medium` | `all`; empty: Settings decide.
    #[serde(default)]
    pub delegate: String,
    /// Commands run on every run from this template, in its first repository. Typed by the user,
    /// so approved by them.
    #[serde(default)]
    pub checks: Vec<String>,
}

fn yes() -> bool {
    true
}

/// An edit made at the gate.
#[derive(Debug, Clone, Deserialize)]
pub struct ItemEdit {
    pub id: String,
    pub instruction: String,
    pub assignee: String,
    pub enabled: bool,
}

fn json<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "[]".to_string())
}

fn parse<T: for<'de> Deserialize<'de> + Default>(raw: &str) -> T {
    serde_json::from_str(raw).unwrap_or_default()
}

const RUN_COLUMNS: &str = "chain_id, backend, base_url, model, ctx, budget_input, budget_output, delegate, \
     on_fail, review_mode, unload, thinking, plan_summary, plan_risks, checks_json, approved_checks, gate_note, \
     baseline_commit, created_at, updated_at, plan_input_tokens, plan_output_tokens, review_input_tokens, \
     review_output_tokens, direct, fix_round, review_skip";

fn map_run(row: &rusqlite::Row) -> rusqlite::Result<HybridRun> {
    Ok(HybridRun {
        chain_id: row.get(0)?,
        backend: row.get(1)?,
        base_url: row.get(2)?,
        model: row.get(3)?,
        ctx: row.get(4)?,
        budget_input: row.get(5)?,
        budget_output: row.get(6)?,
        delegate: row.get(7)?,
        on_fail: row.get(8)?,
        review_mode: row.get(9)?,
        unload: row.get(10)?,
        thinking: row.get(11)?,
        plan_summary: row.get(12)?,
        plan_risks: parse(&row.get::<_, String>(13)?),
        checks: parse(&row.get::<_, String>(14)?),
        approved_checks: parse(&row.get::<_, String>(15)?),
        gate_note: row.get(16)?,
        baseline_commit: row.get(17)?,
        created_at: row.get(18)?,
        updated_at: row.get(19)?,
        plan_input_tokens: row.get(20)?,
        plan_output_tokens: row.get(21)?,
        review_input_tokens: row.get(22)?,
        review_output_tokens: row.get(23)?,
        direct: row.get(24)?,
        fix_round: row.get(25)?,
        review_skip: row.get(26)?,
    })
}

const ITEM_COLUMNS: &str = "id, chain_id, ord, task_key, title, file, action, regions_json, instruction, \
     context_json, acceptance_json, depends_on_json, difficulty, assignee, enabled, status, attempts, error, \
     tokens_in, tokens_out, ms, lines_added, lines_removed, hash_before, hash_after, updated_at, error_code, \
     project_id, round";

fn map_item(row: &rusqlite::Row) -> rusqlite::Result<HybridItem> {
    Ok(HybridItem {
        id: row.get(0)?,
        chain_id: row.get(1)?,
        ord: row.get(2)?,
        task_key: row.get(3)?,
        title: row.get(4)?,
        file: row.get(5)?,
        action: row.get(6)?,
        regions: parse(&row.get::<_, String>(7)?),
        instruction: row.get(8)?,
        context: parse(&row.get::<_, String>(9)?),
        acceptance: parse(&row.get::<_, String>(10)?),
        depends_on: parse(&row.get::<_, String>(11)?),
        difficulty: row.get(12)?,
        assignee: row.get(13)?,
        enabled: row.get(14)?,
        status: row.get(15)?,
        attempts: row.get(16)?,
        error: row.get(17)?,
        tokens_in: row.get(18)?,
        tokens_out: row.get(19)?,
        ms: row.get(20)?,
        lines_added: row.get(21)?,
        lines_removed: row.get(22)?,
        hash_before: row.get(23)?,
        hash_after: row.get(24)?,
        updated_at: row.get(25)?,
        error_code: row.get(26)?,
        project_id: row.get(27)?,
        round: row.get(28)?,
    })
}

pub fn insert_run(conn: &Connection, run: &HybridRun) -> rusqlite::Result<()> {
    conn.execute(
        &format!(
            "INSERT INTO hybrid_runs ({RUN_COLUMNS})
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
                     0, 0, 0, 0, ?21, 0, ?22)"
        ),
        params![
            run.chain_id,
            run.backend,
            run.base_url,
            run.model,
            run.ctx,
            run.budget_input,
            run.budget_output,
            run.delegate,
            run.on_fail,
            run.review_mode,
            run.unload,
            run.thinking,
            run.plan_summary,
            json(&run.plan_risks),
            json(&run.checks),
            json(&run.approved_checks),
            run.gate_note,
            run.baseline_commit,
            run.created_at,
            run.updated_at,
            run.direct,
            run.review_skip,
        ],
    )?;
    Ok(())
}

pub fn get_run(conn: &Connection, chain_id: &str) -> rusqlite::Result<Option<HybridRun>> {
    conn.query_row(&format!("SELECT {RUN_COLUMNS} FROM hybrid_runs WHERE chain_id = ?1"), params![chain_id], map_run)
        .optional()
}

pub fn list_items(conn: &Connection, chain_id: &str) -> rusqlite::Result<Vec<HybridItem>> {
    let mut stmt = conn.prepare(&format!("SELECT {ITEM_COLUMNS} FROM hybrid_items WHERE chain_id = ?1 ORDER BY ord"))?;
    let rows = stmt.query_map(params![chain_id], map_item)?;
    rows.collect()
}

pub fn get_item(conn: &Connection, id: &str) -> rusqlite::Result<Option<HybridItem>> {
    conn.query_row(&format!("SELECT {ITEM_COLUMNS} FROM hybrid_items WHERE id = ?1"), params![id], map_item).optional()
}

/// Replaces the chain's plan with `plan`: a re-plan starts from nothing, it does not merge. Tasks
/// the delegation admits go to the local model; the rest to the subscription.
pub fn store_plan(
    conn: &Connection,
    chain_id: &str,
    plan: &Plan,
    delegate: crate::hybrid::budget::Delegate,
) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM hybrid_items WHERE chain_id = ?1", params![chain_id])?;
    insert_tasks(&tx, chain_id, &plan.tasks, 0, 0, "", delegate)?;
    // A template's own checks stay listed beside whatever the planner proposes — they were typed by
    // the user, so they are not the planner's to drop by re-planning.
    let mut checks: Vec<PlanCheck> = get_run(&tx, chain_id)?
        .map(|run| run.approved_checks.into_iter().filter(|check| run.checks.contains(check)).collect())
        .unwrap_or_default();
    for check in &plan.checks {
        if !checks.contains(check) {
            checks.push(check.clone());
        }
    }
    tx.execute(
        "UPDATE hybrid_runs SET plan_summary = ?2, plan_risks = ?3, checks_json = ?4, updated_at = ?5 WHERE chain_id = ?1",
        params![chain_id, plan.summary, json(&plan.risks), json(&checks), now()],
    )?;
    tx.commit()
}

/// Inserts `tasks` as items of `round`, numbered from `first_ord`. Task keys are prefixed in a
/// correction round (`r1.f1`), and dependencies with them, so a fix can never be mistaken for the
/// plan task that happened to share its id.
fn insert_tasks(
    conn: &Connection,
    chain_id: &str,
    tasks: &[PlanTask],
    round: i64,
    first_ord: i64,
    key_prefix: &str,
    delegate: crate::hybrid::budget::Delegate,
) -> rusqlite::Result<()> {
    let stamp = now();
    for (at, task) in tasks.iter().enumerate() {
        // A deletion needs no model, so it is never the subscription's to do.
        let assignee = if task.action == "delete" || delegate.admits(&task.difficulty) { "local" } else { "sub" };
        let depends: Vec<String> = task.depends_on.iter().map(|id| format!("{key_prefix}{id}")).collect();
        conn.execute(
            &format!(
                "INSERT INTO hybrid_items ({ITEM_COLUMNS})
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 1, 'pending', 0, '',
                         0, 0, 0, 0, 0, '', '', ?15, '', ?16, ?17)"
            ),
            params![
                Uuid::new_v4().to_string(),
                chain_id,
                first_ord + at as i64,
                format!("{key_prefix}{}", task.id),
                task.title,
                task.file,
                task.action,
                json(&task.regions),
                task.instruction,
                json(&task.context),
                json(&task.acceptance),
                json(&depends),
                task.difficulty,
                assignee,
                stamp,
                task.repo,
                round,
            ],
        )?;
    }
    Ok(())
}

/// Adds the corrections a review handed back as round `round`'s items, after everything already
/// there, and records the round. The plan's own items are history and stay as they are.
pub fn add_fix_items(
    conn: &Connection,
    chain_id: &str,
    round: i64,
    fixes: &[PlanTask],
    delegate: crate::hybrid::budget::Delegate,
) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    let next: i64 =
        tx.query_row("SELECT COALESCE(MAX(ord), -1) + 1 FROM hybrid_items WHERE chain_id = ?1", params![chain_id], |row| row.get(0))?;
    insert_tasks(&tx, chain_id, fixes, round, next, &format!("r{round}."), delegate)?;
    tx.execute(
        "UPDATE hybrid_runs SET fix_round = ?2, updated_at = ?3 WHERE chain_id = ?1",
        params![chain_id, round, now()],
    )?;
    tx.commit()
}

/// The tasks of a direct run: one per file the objective named, each carrying the objective itself
/// as its instruction — there is no planner to write a better one, which is exactly why a run is
/// only direct when the change is small.
pub fn insert_direct_items(conn: &Connection, chain_id: &str, project_id: &str, files: &[String], goal: &str) -> rusqlite::Result<()> {
    let tasks: Vec<PlanTask> = files
        .iter()
        .enumerate()
        .map(|(at, file)| {
            let others: Vec<&String> = files.iter().filter(|other| *other != file).collect();
            let mut instruction = goal.trim().to_string();
            if !others.is_empty() {
                instruction.push_str(&format!(
                    "\n\nThis task changes only {file}. The same change also touches {}, which is handled separately.",
                    others.iter().map(|f| f.as_str()).collect::<Vec<_>>().join(", ")
                ));
            }
            PlanTask {
                id: format!("t{}", at + 1),
                title: file.clone(),
                repo: project_id.to_string(),
                file: file.clone(),
                action: "modify".to_string(),
                regions: Vec::new(),
                instruction,
                context: Vec::new(),
                acceptance: Vec::new(),
                depends_on: Vec::new(),
                difficulty: "easy".to_string(),
            }
        })
        .collect();
    insert_tasks(conn, chain_id, &tasks, 0, 0, "", crate::hybrid::budget::Delegate::All)
}

/// Takes a run's review step out of the plan, saying why (`direct`, `small`). Only a review that has
/// not run yet: one that has an answer is history. "Pedir revisión" is `rerun_chain_from` on it.
pub fn skip_review_step(conn: &Connection, chain_id: &str, reason: &str) -> rusqlite::Result<()> {
    let changed = conn.execute(
        "UPDATE agent_chain_steps SET status = 'skipped', updated_at = ?2
         WHERE chain_id = ?1 AND phase = 'review' AND status = 'pending'",
        params![chain_id, now()],
    )?;
    if changed > 0 {
        set_review_skip(conn, chain_id, reason)?;
    }
    Ok(())
}

pub fn set_review_skip(conn: &Connection, chain_id: &str, reason: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE hybrid_runs SET review_skip = ?2, updated_at = ?3 WHERE chain_id = ?1",
        params![chain_id, reason, now()],
    )?;
    Ok(())
}

/// The tasks a review took over — the subscription's own, and the local model's failures — are
/// `reviewed` once it has answered, so the next round's report does not hand them over again.
pub fn mark_reviewed(conn: &Connection, ids: &[String]) -> rusqlite::Result<()> {
    for id in ids {
        conn.execute(
            "UPDATE hybrid_items SET status = 'reviewed', updated_at = ?2 WHERE id = ?1",
            params![id, now()],
        )?;
    }
    Ok(())
}

fn trusted_key(project_id: &str) -> String {
    format!("hybrid_checks:{project_id}")
}

/// The check commands the user has approved in a repository before — pre-ticked at the next gate,
/// and what a run without a gate (or a direct one) may run there without asking again.
pub fn trusted_checks(conn: &Connection, project_id: &str) -> Vec<String> {
    super::queries::get_setting(conn, &trusted_key(project_id))
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<Vec<String>>(&raw).ok())
        .unwrap_or_default()
}

/// Adds `checks` to what each of their repositories trusts.
pub fn remember_trusted(conn: &Connection, checks: &[PlanCheck]) -> rusqlite::Result<()> {
    let mut by_repo: std::collections::BTreeMap<&str, Vec<&str>> = std::collections::BTreeMap::new();
    for check in checks {
        by_repo.entry(check.repo.as_str()).or_default().push(check.command.as_str());
    }
    for (project_id, commands) in by_repo {
        if project_id.is_empty() {
            continue;
        }
        let mut trusted = trusted_checks(conn, project_id);
        for command in commands {
            if !trusted.iter().any(|known| known == command) {
                trusted.push(command.to_string());
            }
        }
        super::queries::set_setting(conn, &trusted_key(project_id), &json(&trusted))?;
    }
    Ok(())
}

/// The run's repositories, first one first: what a plan names them by and where they are.
pub fn chain_repo_refs(conn: &Connection, chain_id: &str) -> rusqlite::Result<Vec<RepoRef>> {
    let mut stmt = conn.prepare(
        "SELECT r.project_id, COALESCE(p.name, ''), COALESCE(p.local_path, '')
           FROM agent_chain_repos r LEFT JOIN projects p ON p.id = r.project_id
          WHERE r.chain_id = ?1 ORDER BY r.position",
    )?;
    let rows = stmt.query_map(params![chain_id], |row| {
        Ok(RepoRef { project_id: row.get(0)?, name: row.get(1)?, path: row.get(2)? })
    })?;
    rows.collect()
}

/// Applies the gate's edits. Only to items still `pending`: an item that has run is history.
pub fn apply_edits(conn: &Connection, chain_id: &str, edits: &[ItemEdit]) -> rusqlite::Result<()> {
    let stamp = now();
    for edit in edits {
        let assignee = if edit.assignee == "sub" { "sub" } else { "local" };
        conn.execute(
            "UPDATE hybrid_items SET instruction = CASE WHEN ?3 <> '' THEN ?3 ELSE instruction END,
                assignee = ?4, enabled = ?5, updated_at = ?6
             WHERE id = ?1 AND chain_id = ?2 AND status = 'pending'",
            params![edit.id, chain_id, edit.instruction.trim(), assignee, edit.enabled, stamp],
        )?;
    }
    Ok(())
}

pub fn set_approved_checks(conn: &Connection, chain_id: &str, checks: &[PlanCheck]) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE hybrid_runs SET approved_checks = ?2, updated_at = ?3 WHERE chain_id = ?1",
        params![chain_id, json(&checks), now()],
    )?;
    Ok(())
}

pub fn set_gate_note(conn: &Connection, chain_id: &str, note: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE hybrid_runs SET gate_note = ?2, updated_at = ?3 WHERE chain_id = ?1",
        params![chain_id, note.trim(), now()],
    )?;
    Ok(())
}

/// Adds a subscription turn's tokens to the run's tally, under its phase.
pub fn add_step_usage(conn: &Connection, chain_id: &str, phase: &str, input: i64, output: i64) -> rusqlite::Result<()> {
    let sql = match phase {
        "plan" => "UPDATE hybrid_runs SET plan_input_tokens = plan_input_tokens + ?2,
                      plan_output_tokens = plan_output_tokens + ?3 WHERE chain_id = ?1",
        "review" => "UPDATE hybrid_runs SET review_input_tokens = review_input_tokens + ?2,
                        review_output_tokens = review_output_tokens + ?3 WHERE chain_id = ?1",
        _ => return Ok(()),
    };
    conn.execute(sql, params![chain_id, input, output])?;
    Ok(())
}

pub fn set_baseline(conn: &Connection, chain_id: &str, commit: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE hybrid_runs SET baseline_commit = ?2, updated_at = ?3 WHERE chain_id = ?1",
        params![chain_id, commit, now()],
    )?;
    Ok(())
}

/// What one task ended as.
#[derive(Debug, Clone, Default)]
pub struct ItemOutcome {
    pub status: String,
    pub error: String,
    pub error_code: String,
    pub tokens_in: i64,
    pub tokens_out: i64,
    pub ms: i64,
    pub lines_added: i64,
    pub lines_removed: i64,
    pub hash_before: String,
    pub hash_after: String,
}

pub fn mark_item_running(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE hybrid_items SET status = 'running', attempts = attempts + 1, error = '', error_code = '', updated_at = ?2 WHERE id = ?1",
        params![id, now()],
    )?;
    Ok(())
}

pub fn finish_item(conn: &Connection, id: &str, outcome: &ItemOutcome) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE hybrid_items SET status = ?2, error = ?3, tokens_in = tokens_in + ?4, tokens_out = tokens_out + ?5,
            ms = ms + ?6, lines_added = ?7, lines_removed = ?8, hash_before = ?9, hash_after = ?10, updated_at = ?11,
            error_code = ?12
         WHERE id = ?1",
        params![
            id,
            outcome.status,
            outcome.error,
            outcome.tokens_in,
            outcome.tokens_out,
            outcome.ms,
            outcome.lines_added,
            outcome.lines_removed,
            outcome.hash_before,
            outcome.hash_after,
            now(),
            outcome.error_code
        ],
    )?;
    Ok(())
}

/// Puts a task that was mid-request back in the queue — after a Stop, a crash, or a restart.
pub fn requeue_running_items(conn: &Connection, chain_id: Option<&str>) -> rusqlite::Result<()> {
    match chain_id {
        Some(chain_id) => conn.execute(
            "UPDATE hybrid_items SET status = 'pending', updated_at = ?2 WHERE chain_id = ?1 AND status = 'running'",
            params![chain_id, now()],
        )?,
        None => conn.execute(
            "UPDATE hybrid_items SET status = 'pending', updated_at = ?1 WHERE status = 'running'",
            params![now()],
        )?,
    };
    Ok(())
}

/// The chain step a run id is bound to, while it runs: what `send_chat_message` asks to decide how a
/// turn behaves (read-only, a schema, the local executor, a resumed session).
#[derive(Debug, Clone, PartialEq)]
pub struct RunningStep {
    pub chain_id: String,
    pub step_id: String,
    pub kind: String,
    pub phase: String,
}

pub fn running_step(conn: &Connection, run_id: &str) -> rusqlite::Result<Option<RunningStep>> {
    if run_id.trim().is_empty() {
        return Ok(None);
    }
    conn.query_row(
        "SELECT s.chain_id, s.id, c.kind, s.phase FROM agent_chain_steps s JOIN agent_chains c ON c.id = s.chain_id
         WHERE s.run_id = ?1 AND s.status = 'running' LIMIT 1",
        params![run_id],
        |row| Ok(RunningStep { chain_id: row.get(0)?, step_id: row.get(1)?, kind: row.get(2)?, phase: row.get(3)? }),
    )
    .optional()
}

/// The planner's session — `(engine session id, provider, account)` of the plan step's last turn
/// that answered — which the review resumes when it runs on the same engine and account.
pub fn plan_session(conn: &Connection, chain_id: &str) -> rusqlite::Result<Option<(String, String, Option<String>)>> {
    conn.query_row(
        "SELECT a.engine_session_id, a.provider, a.account_id
           FROM agent_chain_steps s
           JOIN agent_tasks t ON t.id = s.task_id
           JOIN activity_log a ON a.project_id = t.project_id AND a.session_id = t.conversation_id
          WHERE s.chain_id = ?1 AND s.phase = 'plan' AND a.is_error = 0
            AND a.engine_session_id IS NOT NULL AND a.engine_session_id <> '' AND a.provider IS NOT NULL
          ORDER BY a.created_at DESC LIMIT 1",
        params![chain_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .optional()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hybrid::plan::PlanTask;

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = ON; CREATE TABLE agent_chains (id TEXT PRIMARY KEY);").unwrap();
        crate::db::migrations::add_hybrid_tables(&conn).unwrap();
        conn.execute("INSERT INTO agent_chains (id) VALUES ('c1')", []).unwrap();
        conn
    }

    fn run() -> HybridRun {
        HybridRun {
            chain_id: "c1".into(),
            backend: "ollama".into(),
            base_url: "http://127.0.0.1:11434".into(),
            model: "qwen2.5-coder:7b".into(),
            ctx: 16_384,
            budget_input: 11_776,
            budget_output: 4_096,
            delegate: "medium".into(),
            on_fail: "review".into(),
            review_mode: "fix".into(),
            unload: true,
            thinking: false,
            plan_summary: String::new(),
            plan_risks: vec![],
            checks: vec![],
            approved_checks: vec![],
            gate_note: String::new(),
            baseline_commit: String::new(),
            plan_input_tokens: 0,
            plan_output_tokens: 0,
            review_input_tokens: 0,
            review_output_tokens: 0,
            direct: false,
            fix_round: 0,
            review_skip: String::new(),
            created_at: now(),
            updated_at: now(),
        }
    }

    fn check(command: &str) -> PlanCheck {
        PlanCheck { repo: String::new(), command: command.into() }
    }

    fn task(id: &str, file: &str, difficulty: &str, action: &str) -> PlanTask {
        PlanTask {
            id: id.into(),
            title: file.into(),
            repo: String::new(),
            file: file.into(),
            action: action.into(),
            regions: vec![],
            instruction: "do it".into(),
            context: vec![],
            acceptance: vec!["works".into()],
            depends_on: vec![],
            difficulty: difficulty.into(),
        }
    }

    #[test]
    fn a_plan_is_stored_with_assignments_and_replaced_whole() {
        let conn = conn();
        insert_run(&conn, &run()).unwrap();
        let plan = Plan {
            summary: "s".into(),
            tasks: vec![task("t1", "a.ts", "easy", "create"), task("t2", "b.ts", "hard", "modify"), task("t3", "c.ts", "hard", "delete")],
            checks: vec![check("pnpm test")],
            risks: vec!["r".into()],
        };
        store_plan(&conn, "c1", &plan, crate::hybrid::budget::Delegate::Medium).unwrap();
        let items = list_items(&conn, "c1").unwrap();
        assert_eq!(items.iter().map(|i| i.assignee.as_str()).collect::<Vec<_>>(), ["local", "sub", "local"]);
        assert_eq!(items[0].acceptance, vec!["works"]);
        let stored = get_run(&conn, "c1").unwrap().unwrap();
        assert_eq!(stored.checks, vec![check("pnpm test")]);
        assert_eq!(stored.plan_risks, vec!["r"]);

        // A re-plan replaces rather than merges.
        store_plan(&conn, "c1", &Plan { tasks: vec![task("t1", "z.ts", "easy", "create")], ..plan }, crate::hybrid::budget::Delegate::Medium).unwrap();
        assert_eq!(list_items(&conn, "c1").unwrap().len(), 1);
    }

    #[test]
    fn gate_edits_touch_only_pending_items_and_runs_requeue() {
        let conn = conn();
        insert_run(&conn, &run()).unwrap();
        let plan = Plan { summary: String::new(), tasks: vec![task("t1", "a.ts", "easy", "create"), task("t2", "b.ts", "easy", "create")], checks: vec![], risks: vec![] };
        store_plan(&conn, "c1", &plan, crate::hybrid::budget::Delegate::Medium).unwrap();
        let items = list_items(&conn, "c1").unwrap();
        mark_item_running(&conn, &items[1].id).unwrap();
        apply_edits(
            &conn,
            "c1",
            &[
                ItemEdit { id: items[0].id.clone(), instruction: "better".into(), assignee: "sub".into(), enabled: false },
                ItemEdit { id: items[1].id.clone(), instruction: "ignored".into(), assignee: "sub".into(), enabled: false },
            ],
        )
        .unwrap();
        let after = list_items(&conn, "c1").unwrap();
        assert_eq!((after[0].instruction.as_str(), after[0].assignee.as_str(), after[0].enabled), ("better", "sub", false));
        assert_eq!(after[1].instruction, "do it", "a running item is not edited");
        requeue_running_items(&conn, Some("c1")).unwrap();
        assert_eq!(list_items(&conn, "c1").unwrap()[1].status, "pending");
    }

    #[test]
    fn an_outcome_keeps_its_failure_kind_until_the_item_runs_again() {
        let conn = conn();
        insert_run(&conn, &run()).unwrap();
        store_plan(&conn, "c1", &Plan { summary: String::new(), tasks: vec![task("t1", "a.ts", "easy", "create")], checks: vec![], risks: vec![] }, crate::hybrid::budget::Delegate::All).unwrap();
        let id = list_items(&conn, "c1").unwrap()[0].id.clone();
        let outcome = ItemOutcome {
            status: "escalated".into(),
            error: "The task needs 14000 tokens and the local model's budget is 11776.".into(),
            error_code: "too-big".into(),
            ..Default::default()
        };
        finish_item(&conn, &id, &outcome).unwrap();
        let item = get_item(&conn, &id).unwrap().unwrap();
        assert_eq!((item.status.as_str(), item.error_code.as_str()), ("escalated", "too-big"));
        mark_item_running(&conn, &id).unwrap();
        let item = get_item(&conn, &id).unwrap().unwrap();
        assert_eq!((item.error.as_str(), item.error_code.as_str()), ("", ""));
    }

    #[test]
    fn a_template_check_survives_a_plan_and_a_bare_string_check_still_reads() {
        let conn = conn();
        let mut with_template = run();
        with_template.checks = vec![check("make lint")];
        with_template.approved_checks = vec![check("make lint")];
        insert_run(&conn, &with_template).unwrap();
        let plan = Plan { summary: String::new(), tasks: vec![task("t1", "a.ts", "easy", "create")], checks: vec![check("pnpm test")], risks: vec![] };
        store_plan(&conn, "c1", &plan, crate::hybrid::budget::Delegate::All).unwrap();
        let stored = get_run(&conn, "c1").unwrap().unwrap();
        assert_eq!(stored.checks, vec![check("make lint"), check("pnpm test")], "the user's own command is not the planner's to drop");
        assert_eq!(stored.approved_checks, vec![check("make lint")]);

        // A run written before checks named their repository.
        conn.execute("UPDATE hybrid_runs SET checks_json = '[\"cargo test\"]' WHERE chain_id = 'c1'", []).unwrap();
        assert_eq!(get_run(&conn, "c1").unwrap().unwrap().checks, vec![check("cargo test")]);
    }

    #[test]
    fn a_correction_round_is_added_after_the_plan_with_its_own_keys() {
        let conn = conn();
        insert_run(&conn, &run()).unwrap();
        let mut second = task("t2", "b.ts", "easy", "modify");
        second.depends_on = vec!["t1".into()];
        let plan = Plan { summary: String::new(), tasks: vec![task("t1", "a.ts", "easy", "create"), second.clone()], checks: vec![], risks: vec![] };
        store_plan(&conn, "c1", &plan, crate::hybrid::budget::Delegate::Medium).unwrap();

        // The review's fixes reuse ids the plan already had, and depend on one another.
        let fixes = vec![task("t1", "a.ts", "easy", "modify"), second, task("t3", "c.ts", "hard", "modify")];
        add_fix_items(&conn, "c1", 1, &fixes, crate::hybrid::budget::Delegate::Medium).unwrap();
        let items = list_items(&conn, "c1").unwrap();
        assert_eq!(items.len(), 5);
        let round: Vec<&HybridItem> = items.iter().filter(|item| item.round == 1).collect();
        assert_eq!(round.iter().map(|i| i.task_key.as_str()).collect::<Vec<_>>(), ["r1.t1", "r1.t2", "r1.t3"]);
        assert_eq!(round[1].depends_on, vec!["r1.t1"], "a fix depends on a fix, never on the plan task that shared its id");
        assert_eq!(round.iter().map(|i| i.ord).collect::<Vec<_>>(), [2, 3, 4], "after everything already there");
        assert_eq!(round[2].assignee, "sub", "a hard correction is not the local model's under medium delegation");
        assert_eq!(get_run(&conn, "c1").unwrap().unwrap().fix_round, 1);

        // What the review took over is done by it, and not handed over again.
        mark_reviewed(&conn, &[round[2].id.clone()]).unwrap();
        assert_eq!(get_item(&conn, &round[2].id).unwrap().unwrap().status, "reviewed");
        let run = get_run(&conn, "c1").unwrap().unwrap();
        let items = list_items(&conn, "c1").unwrap();
        assert!(crate::hybrid::prompts::for_review(&run, &items).is_empty());
    }

    #[test]
    fn a_direct_run_has_one_task_per_file_carrying_the_objective() {
        let conn = conn();
        insert_run(&conn, &run()).unwrap();
        insert_direct_items(&conn, "c1", "p1", &["src/a.ts".into(), "src/b.ts".into()], "Rename total to sum.").unwrap();
        let items = list_items(&conn, "c1").unwrap();
        assert_eq!(items.len(), 2);
        assert!(items.iter().all(|item| item.assignee == "local" && item.project_id == "p1" && item.action == "modify"));
        assert!(items[0].instruction.starts_with("Rename total to sum."));
        assert!(items[0].instruction.contains("This task changes only src/a.ts"), "{}", items[0].instruction);
        assert!(items[0].instruction.contains("src/b.ts"));
    }

    #[test]
    fn deleting_the_chain_takes_its_rows() {
        let conn = conn();
        insert_run(&conn, &run()).unwrap();
        store_plan(&conn, "c1", &Plan { summary: String::new(), tasks: vec![task("t1", "a.ts", "easy", "create")], checks: vec![], risks: vec![] }, crate::hybrid::budget::Delegate::All).unwrap();
        conn.execute("DELETE FROM agent_chains WHERE id = 'c1'", []).unwrap();
        assert!(get_run(&conn, "c1").unwrap().is_none());
        assert!(list_items(&conn, "c1").unwrap().is_empty());
    }
}
