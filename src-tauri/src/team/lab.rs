//! The lab: the same task given to several teams from the same commit, and what each made of it.
//!
//! «Which team should do this kind of work» has only ever been answered by feel. A comparison pins
//! a commit, starts one run per team from it — each on a branch of its own that never lands — and,
//! when they close, runs the *same* checks on every result. What is compared is what already
//! exists for any run (what it cost, how long it took, how many attempts it needed) plus those
//! checks and the size of the change; nothing here judges the code by reading it.
//!
//! A comparison is a row (`agent_team_evals`) holding its entries; the runs are ordinary runs and
//! stay in the list of runs when the comparison goes.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::{Item, Run};

/// How many teams one comparison takes: enough to choose between, few enough to pay for.
pub const MAX_TEAMS: usize = 4;

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_team_evals (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            goal TEXT NOT NULL,
            project_id TEXT NOT NULL,
            project_name TEXT NOT NULL DEFAULT '',
            base_branch TEXT NOT NULL,
            base_sha TEXT NOT NULL,
            pin_branch TEXT NOT NULL,
            checks TEXT NOT NULL DEFAULT '[]',
            entries TEXT NOT NULL DEFAULT '[]',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_team_evals_ws ON agent_team_evals(workspace_id, created_at);",
    )
}

/// One check's verdict on one team's result.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Score {
    pub command: String,
    /// `passed`, `failed`, or `unavailable` (it had to run isolated and could not).
    pub result: String,
    pub detail: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Entry {
    pub team_id: String,
    pub team_name: String,
    /// Empty when the run could not start; `error` says why.
    pub run_id: String,
    pub error: String,
    pub scores: Vec<Score>,
    /// The commit the scores are about: a result that moved is scored again.
    pub scored_sha: String,
    pub files: i64,
    pub insertions: i64,
    pub deletions: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Eval {
    pub id: String,
    pub workspace_id: String,
    pub title: String,
    pub goal: String,
    pub project_id: String,
    pub project_name: String,
    pub base_branch: String,
    pub base_sha: String,
    /// The branch that holds the pinned commit and that every run takes as its target.
    pub pin_branch: String,
    pub checks: Vec<String>,
    pub entries: Vec<Entry>,
    pub created_at: String,
    pub updated_at: String,
}

const COLUMNS: &str = "id, workspace_id, title, goal, project_id, project_name, base_branch, base_sha, pin_branch, checks, entries, created_at, updated_at";

fn map(row: &rusqlite::Row) -> rusqlite::Result<Eval> {
    let json = |index: usize| -> rusqlite::Result<String> { row.get(index) };
    Ok(Eval {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        title: row.get(2)?,
        goal: row.get(3)?,
        project_id: row.get(4)?,
        project_name: row.get(5)?,
        base_branch: row.get(6)?,
        base_sha: row.get(7)?,
        pin_branch: row.get(8)?,
        checks: serde_json::from_str(&json(9)?).unwrap_or_default(),
        entries: serde_json::from_str(&json(10)?).unwrap_or_default(),
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}

pub fn save(conn: &Connection, eval: &Eval) -> rusqlite::Result<()> {
    conn.execute(
        &format!(
            "INSERT INTO agent_team_evals ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
             ON CONFLICT(id) DO UPDATE SET title = excluded.title, checks = excluded.checks, entries = excluded.entries, updated_at = excluded.updated_at"
        ),
        params![
            eval.id,
            eval.workspace_id,
            eval.title,
            eval.goal,
            eval.project_id,
            eval.project_name,
            eval.base_branch,
            eval.base_sha,
            eval.pin_branch,
            serde_json::to_string(&eval.checks).unwrap_or_else(|_| "[]".into()),
            serde_json::to_string(&eval.entries).unwrap_or_else(|_| "[]".into()),
            eval.created_at,
            eval.updated_at,
        ],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> rusqlite::Result<Option<Eval>> {
    conn.query_row(&format!("SELECT {COLUMNS} FROM agent_team_evals WHERE id = ?1"), params![id], map).optional()
}

pub fn list(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<Eval>> {
    let mut stmt = conn.prepare(&format!("SELECT {COLUMNS} FROM agent_team_evals WHERE workspace_id = ?1 ORDER BY created_at DESC"))?;
    let rows = stmt.query_map(params![workspace_id], map)?;
    rows.collect()
}

pub fn delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM agent_team_evals WHERE id = ?1", params![id])?;
    Ok(())
}

// ------------------------------------------------------------------------------------ the view

/// One team's result as the lab shows it: what the entry keeps, and what its run says now.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EntryView {
    pub team_id: String,
    pub team_name: String,
    pub run_id: String,
    pub error: String,
    /// The run's own status (`running`, `gated`, `paused`, `done`, `aborted`), `failed` when it
    /// never started, `gone` when the run was deleted.
    pub status: String,
    pub gate: String,
    /// Closed, one way or another: nothing more will come of it.
    pub finished: bool,
    pub scored: bool,
    pub scores: Vec<Score>,
    pub passed: usize,
    pub usd: f64,
    pub tokens: i64,
    pub minutes: f64,
    pub tasks_done: usize,
    pub tasks_total: usize,
    /// Attempts beyond the first, over every task: how much of the work had to be redone.
    pub retries: i64,
    pub files: i64,
    pub insertions: i64,
    pub deletions: i64,
    /// 1 is the best; 0 while the comparison is not decided.
    pub rank: usize,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EvalView {
    pub id: String,
    pub title: String,
    pub goal: String,
    pub project_id: String,
    pub project_name: String,
    pub base_branch: String,
    pub base_sha: String,
    pub checks: Vec<String>,
    pub created_at: String,
    pub entries: Vec<EntryView>,
    /// `running` while a team is still at it, `scoring` when all closed and some result has no
    /// verdict yet, `decided` once every result has one.
    pub state: String,
    /// The run that came first, once decided — empty when nobody delivered anything.
    pub winner: String,
}

/// What a run's tasks say about how it went.
pub fn tally(items: &[Item]) -> (usize, usize, i64) {
    let work: Vec<&Item> = items.iter().filter(|i| i.kind == "work" && i.ref_item.is_empty()).collect();
    let done = work.iter().filter(|i| i.status == "done").count();
    let retries = items.iter().filter(|i| !i.is_lead()).map(|i| (i.attempts - 1).max(0)).sum();
    (done, work.len(), retries)
}

/// Orders the results best first: the one that passed more of the checks; then the one that
/// delivered more of its tasks; then the cheaper; then the quicker. A team that delivered nothing
/// is never first.
pub fn rank(entries: &mut [EntryView]) {
    let mut order: Vec<usize> = (0..entries.len()).filter(|i| entries[*i].finished && entries[*i].status == "done").collect();
    order.sort_by(|a, b| {
        let (a, b) = (&entries[*a], &entries[*b]);
        let share = |e: &EntryView| if e.tasks_total == 0 { 0.0 } else { e.tasks_done as f64 / e.tasks_total as f64 };
        b.passed
            .cmp(&a.passed)
            .then_with(|| share(b).partial_cmp(&share(a)).unwrap_or(std::cmp::Ordering::Equal))
            .then_with(|| a.usd.partial_cmp(&b.usd).unwrap_or(std::cmp::Ordering::Equal))
            .then_with(|| a.minutes.partial_cmp(&b.minutes).unwrap_or(std::cmp::Ordering::Equal))
    });
    for (place, index) in order.into_iter().enumerate() {
        entries[index].rank = place + 1;
    }
}

pub fn view(conn: &Connection, eval: &Eval) -> rusqlite::Result<EvalView> {
    let mut entries = Vec::new();
    for entry in &eval.entries {
        let mut shown = EntryView {
            team_id: entry.team_id.clone(),
            team_name: entry.team_name.clone(),
            run_id: entry.run_id.clone(),
            error: entry.error.clone(),
            scores: entry.scores.clone(),
            passed: entry.scores.iter().filter(|s| s.result == "passed").count(),
            files: entry.files,
            insertions: entry.insertions,
            deletions: entry.deletions,
            ..Default::default()
        };
        let run: Option<Run> = if entry.run_id.is_empty() { None } else { super::get_run(conn, &entry.run_id)? };
        match run {
            None => {
                shown.status = if entry.run_id.is_empty() { "failed" } else { "gone" }.into();
                shown.finished = true;
                shown.scored = true;
            }
            Some(run) => {
                let items = super::list_items(conn, &run.id)?;
                let spend = super::metrics::spend(conn, &run.id)?;
                let (done, total, retries) = tally(&items);
                shown.status = run.status.clone();
                shown.gate = run.gate.clone();
                shown.finished = matches!(run.status.as_str(), "done" | "aborted");
                // An aborted run has nothing to score; a done one is scored once its checks ran.
                shown.scored = run.status == "aborted" || (run.status == "done" && (!entry.scored_sha.is_empty() || eval.checks.is_empty()));
                shown.usd = spend.values().map(|(usd, _)| usd).sum();
                shown.tokens = spend.values().map(|(_, tokens)| tokens).sum();
                shown.minutes = super::metrics::agent_minutes(&items, chrono::Utc::now());
                shown.tasks_done = done;
                shown.tasks_total = total;
                shown.retries = retries;
            }
        }
        entries.push(shown);
    }
    let state = if entries.iter().any(|e| !e.finished) {
        "running"
    } else if entries.iter().any(|e| !e.scored) {
        "scoring"
    } else {
        "decided"
    };
    let mut winner = String::new();
    if state == "decided" {
        rank(&mut entries);
        winner = entries.iter().find(|e| e.rank == 1).map(|e| e.run_id.clone()).unwrap_or_default();
    }
    Ok(EvalView {
        id: eval.id.clone(),
        title: eval.title.clone(),
        goal: eval.goal.clone(),
        project_id: eval.project_id.clone(),
        project_name: eval.project_name.clone(),
        base_branch: eval.base_branch.clone(),
        base_sha: eval.base_sha.clone(),
        checks: eval.checks.clone(),
        created_at: eval.created_at.clone(),
        entries,
        state: state.into(),
        winner,
    })
}

/// `3 files changed, 40 insertions(+), 2 deletions(-)` → `(3, 40, 2)`.
pub fn parse_shortstat(text: &str) -> (i64, i64, i64) {
    let number_before = |word: &str| {
        text.split(',').find(|part| part.contains(word)).and_then(|part| part.split_whitespace().next()).and_then(|n| n.parse::<i64>().ok()).unwrap_or(0)
    };
    (number_before("file"), number_before("insertion"), number_before("deletion"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn done(name: &str, passed: usize, tasks: (usize, usize), usd: f64, minutes: f64) -> EntryView {
        EntryView { team_name: name.into(), run_id: name.into(), status: "done".into(), finished: true, scored: true, passed, tasks_done: tasks.0, tasks_total: tasks.1, usd, minutes, ..Default::default() }
    }

    #[test]
    fn the_checks_decide_then_what_was_delivered_then_the_cost() {
        let mut entries = vec![
            done("barato", 1, (2, 2), 0.10, 3.0),
            done("completo", 2, (2, 2), 0.90, 9.0),
            done("a-medias", 2, (1, 2), 0.05, 1.0),
            done("igual-pero-caro", 2, (2, 2), 1.50, 2.0),
            EntryView { team_name: "abortado".into(), status: "aborted".into(), finished: true, scored: true, passed: 9, ..Default::default() },
        ];
        rank(&mut entries);
        let place = |name: &str| entries.iter().find(|e| e.team_name == name).unwrap().rank;
        assert_eq!(place("completo"), 1, "passed every check and delivered everything, for less");
        assert_eq!(place("igual-pero-caro"), 2);
        assert_eq!(place("a-medias"), 3, "the same checks with half the tasks comes after");
        assert_eq!(place("barato"), 4, "cheap does not make up for a check that fails");
        assert_eq!(place("abortado"), 0, "a team that delivered nothing has no place");
    }

    #[test]
    fn retries_count_what_had_to_be_done_again() {
        let item = |kind: &str, status: &str, attempts: i64| Item { kind: kind.into(), status: status.into(), attempts, ..Default::default() };
        let mut fix = item("work", "done", 1);
        fix.ref_item = "x".into();
        let items = vec![item("work", "done", 3), item("work", "error", 2), item("review", "done", 1), fix, item("plan", "done", 2)];
        assert_eq!(tally(&items), (1, 2, 3), "two tasks, one delivered; three attempts beyond the first, the lead's rounds aside");
    }

    #[test]
    fn a_comparison_is_kept_and_read_back_with_what_its_runs_say() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        let ws = crate::db::queries::create_workspace(&conn, "ws", "folder", "#fff").unwrap();
        let eval = Eval {
            id: "e1".into(),
            workspace_id: ws.id.clone(),
            title: "Timeout".into(),
            goal: "sube el timeout".into(),
            project_id: "p".into(),
            base_branch: "main".into(),
            base_sha: "abc".into(),
            pin_branch: "codeflow/eval-e1".into(),
            checks: vec!["npm test".into()],
            entries: vec![
                Entry { team_id: "t1".into(), team_name: "Uno".into(), run_id: "gone-run".into(), ..Default::default() },
                Entry { team_id: "t2".into(), team_name: "Dos".into(), error: "sin modelo".into(), ..Default::default() },
            ],
            created_at: "2026-11-25T10:00:00Z".into(),
            updated_at: "2026-11-25T10:00:00Z".into(),
            ..Default::default()
        };
        save(&conn, &eval).unwrap();
        assert_eq!(list(&conn, &ws.id).unwrap(), vec![eval.clone()]);
        let shown = view(&conn, &eval).unwrap();
        assert_eq!(shown.entries.iter().map(|e| e.status.as_str()).collect::<Vec<_>>(), vec!["gone", "failed"]);
        assert_eq!((shown.state.as_str(), shown.winner.as_str()), ("decided", ""), "nobody delivered: decided, with no winner");
        delete(&conn, "e1").unwrap();
        assert!(get(&conn, "e1").unwrap().is_none());
    }

    #[test]
    fn the_size_of_a_change_is_read_from_git() {
        assert_eq!(parse_shortstat(" 3 files changed, 40 insertions(+), 2 deletions(-)\n"), (3, 40, 2));
        assert_eq!(parse_shortstat(" 1 file changed, 1 insertion(+)\n"), (1, 1, 0));
        assert_eq!(parse_shortstat(""), (0, 0, 0));
    }
}
