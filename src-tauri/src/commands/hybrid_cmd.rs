//! The hybrid task, as the Agents view drives it: decide whether it needs a plan at all, create one,
//! read its plan, approve it as edited, see what it changed and undo it, and keep one as a template.
//! Running it needs no command of its own — it is a chain, pumped like every other one, and its
//! execute step runs inside `send_chat_message`.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::db::hybrid_queries::{self, HybridItem, HybridRun, HybridTemplateConfig, ItemEdit};
use crate::db::models::{AgentChain, ChainDetail, ChainTemplate};
use crate::db::{queries, Db};
use crate::hybrid::config::{self, OnFail, ReviewMode};
use crate::hybrid::local_llm::BackendKind;
use crate::hybrid::plan::PlanCheck;
use crate::hybrid::runtime;
use crate::hybrid::triage::{self, Triage};

/// What a run created from a template takes from it instead of from Settings.
#[derive(Debug, Default, Deserialize)]
pub struct RunOverrides {
    /// `local` | `fix` | `report`; empty: Settings decide.
    #[serde(default)]
    pub review_mode: String,
    /// `easy` | `medium` | `all`; empty: Settings (or the model's suggestion) decide.
    #[serde(default)]
    pub delegate: String,
    /// Commands the template's author typed: approved for every run made from it.
    #[serde(default)]
    pub checks: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct NewHybridTask {
    /// The run's repositories, first one first. Several make one plan across all of them, which
    /// needs a planner whose CLI can be given more than one directory.
    pub project_ids: Vec<String>,
    pub title: String,
    pub goal: String,
    /// The roster agent that plans — and, unless `reviewer_agent_id` names another, reviews.
    pub planner_agent_id: String,
    #[serde(default)]
    pub reviewer_agent_id: String,
    #[serde(default)]
    pub agent_project_id: String,
    /// Stop for the user's approval between the plan and the execution.
    pub gate: bool,
    /// The files a direct run changes — what `hybrid_triage` found. Checked again here; a task that
    /// no longer qualifies is planned instead.
    #[serde(default)]
    pub direct_files: Option<Vec<String>>,
    #[serde(default)]
    pub overrides: Option<RunOverrides>,
}

/// What `create_hybrid_task` answers when the local model cannot run. A translation key, the same
/// convention as `queries::GATE_MOVED`: the language is the reader's, not the writer's. The reason
/// itself is on screen already — in the dialog and in Settings.
pub const NOT_READY: &str = "localexec.notReady";

/// What it answers when several repositories are asked of a planner whose CLI sees only one.
pub const MULTI_REPO_UNSUPPORTED: &str = "chain.multiRepoUnsupported";

/// Whether a roster agent's engine can be handed more than one working copy.
fn planner_spans_repos(conn: &rusqlite::Connection, agent_id: &str) -> bool {
    conn.query_row("SELECT provider FROM workspace_agents WHERE id = ?1", [agent_id], |row| row.get::<_, String>(0))
        .map(|provider| crate::ai::engine_for(&provider).supports_extra_dirs())
        .unwrap_or(false)
}

/// Whether the objective names a small enough change for the local model to write it straight —
/// no plan, no review. Read before anything is spent; the dialog asks as the objective is typed.
#[tauri::command]
pub async fn hybrid_triage(db: State<'_, Db>, project_ids: Vec<String>, goal: String) -> Result<Triage, String> {
    if project_ids.len() != 1 {
        return Ok(Triage::no("multi-repo"));
    }
    let (settings, repo) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let repo: Option<String> = conn
            .query_row("SELECT local_path FROM projects WHERE id = ?1", [&project_ids[0]], |row| row.get(0))
            .ok();
        (config::read(&conn)?, repo)
    };
    let Some(repo) = repo.filter(|path| !path.trim().is_empty()) else { return Ok(Triage::no("not-found")) };
    // Asked as the objective is typed: a server's answer from a moment ago is as good as a new one.
    let resolved = runtime::resolve(&settings, runtime::Freshness::Recent).await;
    if !resolved.reachable || resolved.model.is_none() {
        return Ok(Triage::no("not-ready"));
    }
    let budget = resolved.budget;
    tokio::task::spawn_blocking(move || triage::triage(std::path::Path::new(&repo), &goal, &budget))
        .await
        .map_err(|e| e.to_string())
}

/// Creates a hybrid run, frozen with the local model as Settings resolve it right now. Refused
/// while that model cannot run — a plan written against a model that is not there would be a budget
/// for nothing.
#[tauri::command]
pub async fn create_hybrid_task(db: State<'_, Db>, task: NewHybridTask) -> Result<ChainDetail, String> {
    if task.goal.trim().is_empty() {
        return Err("chain.noGoal".to_string());
    }
    let Some(primary) = task.project_ids.first().cloned() else {
        return Err("chain.noRepo".to_string());
    };
    let (settings, primary_path) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        if task.project_ids.len() > 1 && !planner_spans_repos(&conn, &task.planner_agent_id) {
            return Err(MULTI_REPO_UNSUPPORTED.to_string());
        }
        let path: String = conn
            .query_row("SELECT local_path FROM projects WHERE id = ?1", [&primary], |row| row.get(0))
            .map_err(|_| "chain.projectGone".to_string())?;
        (config::read(&conn)?, path)
    };
    let resolved = runtime::resolve(&settings, runtime::Freshness::Now).await;
    let Some(model) = resolved.model.clone().filter(|_| resolved.reachable) else {
        return Err(NOT_READY.to_string());
    };
    let overrides = task.overrides.unwrap_or_default();

    // A direct run is only what the files still allow: checked again against the budget it will be
    // frozen with, since Settings may have moved since the dialog asked.
    let direct_files: Option<Vec<String>> = match (&task.direct_files, task.project_ids.len()) {
        (Some(files), 1) if !files.is_empty() => {
            let budget = resolved.budget;
            let goal = task.goal.clone();
            let root = primary_path.clone();
            let verdict = tokio::task::spawn_blocking(move || triage::triage(std::path::Path::new(&root), &goal, &budget))
                .await
                .map_err(|e| e.to_string())?;
            let found: Vec<String> = verdict.files.iter().map(|file| file.path.clone()).collect();
            (verdict.direct && files.iter().all(|file| found.contains(file))).then_some(found)
        }
        _ => None,
    };

    let template_checks: Vec<PlanCheck> = overrides
        .checks
        .iter()
        .map(|command| command.trim())
        .filter(|command| !command.is_empty() && !command.contains('\n'))
        .map(|command| PlanCheck { repo: primary.clone(), command: command.to_string() })
        .collect();
    let review_mode = ReviewMode::from_setting(&overrides.review_mode).unwrap_or(settings.review_mode);
    let delegate = crate::hybrid::budget::Delegate::from_setting(&overrides.delegate).unwrap_or(resolved.delegate);
    let stamp = queries::now();
    let run = HybridRun {
        chain_id: String::new(),
        backend: resolved.kind.as_str().to_string(),
        base_url: if resolved.kind == BackendKind::Bundled { String::new() } else { resolved.url.clone() },
        model,
        ctx: resolved.ctx as i64,
        budget_input: resolved.budget.input as i64,
        budget_output: resolved.budget.output as i64,
        delegate: delegate.as_str().to_string(),
        on_fail: match settings.on_fail {
            OnFail::Review => "review",
            OnFail::Skip => "skip",
        }
        .to_string(),
        review_mode: review_mode.as_str().to_string(),
        unload: settings.unload,
        thinking: resolved.details.thinking,
        plan_summary: String::new(),
        plan_risks: Vec::new(),
        checks: template_checks.clone(),
        approved_checks: template_checks,
        gate_note: String::new(),
        baseline_commit: String::new(),
        plan_input_tokens: 0,
        plan_output_tokens: 0,
        review_input_tokens: 0,
        review_output_tokens: 0,
        direct: false,
        fix_round: 0,
        review_skip: String::new(),
        created_at: stamp.clone(),
        updated_at: stamp,
    };
    let reviewer = if task.reviewer_agent_id.trim().is_empty() { &task.planner_agent_id } else { &task.reviewer_agent_id };
    let title = if task.title.trim().is_empty() {
        task.goal.trim().chars().take(64).collect::<String>()
    } else {
        task.title.trim().to_string()
    };
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::create_hybrid_chain(
        &conn,
        &task.project_ids,
        &title,
        task.goal.trim(),
        &task.planner_agent_id,
        reviewer,
        &task.agent_project_id,
        task.gate,
        &run,
        direct_files.as_deref(),
    )
    .map_err(|e| e.to_string())
}

/// One of a run's repositories, for the panes.
#[derive(Debug, Serialize)]
pub struct RepoView {
    pub project_id: String,
    pub name: String,
}

/// A run's configuration and its plan's tasks.
#[derive(Debug, Serialize)]
pub struct HybridView {
    pub run: HybridRun,
    pub items: Vec<HybridItem>,
    /// The run's repositories, first one first. More than one: every path is labelled with its own.
    pub repos: Vec<RepoView>,
    /// Checks the user approved before in these repositories — pre-ticked at the gate.
    pub trusted_checks: Vec<PlanCheck>,
    /// How many correction rounds the local fix loop gets.
    pub max_fix_rounds: i64,
}

#[tauri::command]
pub fn hybrid_view(db: State<Db>, chain_id: String) -> Result<Option<HybridView>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let Some(run) = hybrid_queries::get_run(&conn, &chain_id).map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let items = hybrid_queries::list_items(&conn, &chain_id).map_err(|e| e.to_string())?;
    let repos = hybrid_queries::chain_repo_refs(&conn, &chain_id).map_err(|e| e.to_string())?;
    let trusted_checks = repos
        .iter()
        .flat_map(|repo| {
            hybrid_queries::trusted_checks(&conn, &repo.project_id)
                .into_iter()
                .map(|command| PlanCheck { repo: repo.project_id.clone(), command })
        })
        .collect();
    Ok(Some(HybridView {
        run,
        items,
        repos: repos.into_iter().map(|repo| RepoView { project_id: repo.project_id, name: repo.name }).collect(),
        trusted_checks,
        max_fix_rounds: crate::hybrid::prompts::MAX_FIX_ROUNDS,
    }))
}

/// Approves the plan as edited at the gate. The checks ticked are remembered in their repositories,
/// so the next plan proposing the same command finds it already ticked.
#[tauri::command]
pub fn approve_hybrid_plan(
    db: State<Db>,
    chain_id: String,
    step_id: String,
    edits: Vec<ItemEdit>,
    checks: Vec<PlanCheck>,
    note: String,
) -> Result<Option<AgentChain>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    match queries::approve_hybrid_plan(&conn, &chain_id, &step_id, &edits, &checks, &note).map_err(|e| e.to_string())? {
        queries::GateApproval::Approved(chain) => {
            let _ = hybrid_queries::remember_trusted(&conn, &checks);
            Ok(chain)
        }
        queries::GateApproval::Moved => Err(queries::GATE_MOVED.to_string()),
    }
}

/// A file a run changed, in one of its repositories.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunFile {
    pub project_id: String,
    /// The repository's name, for the confirmation that lists them. Ignored on the way in.
    #[serde(default)]
    pub repo: String,
    pub path: String,
}

fn run_repos(db: &Db, chain_id: &str) -> Result<Vec<crate::hybrid::plan::RepoRef>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let repos = hybrid_queries::chain_repo_refs(&conn, chain_id).map_err(|e| e.to_string())?;
    if repos.is_empty() || repos.iter().any(|repo| repo.path.trim().is_empty()) {
        return Err("The repository of this run is gone.".to_string());
    }
    Ok(repos)
}

/// Files that differ from the run's baselines right now — what "Undo all" would put back.
#[tauri::command]
pub fn hybrid_changed_paths(db: State<Db>, chain_id: String) -> Result<Vec<RunFile>, String> {
    let mut out = Vec::new();
    for repo in run_repos(&db, &chain_id)? {
        for path in crate::git::checkpoint::baseline_changed_paths(&repo.path, &chain_id)? {
            out.push(RunFile { project_id: repo.project_id.clone(), repo: repo.name.clone(), path });
        }
    }
    Ok(out)
}

/// Puts files back as they were before the run's first write: all of them, or the ones named.
#[tauri::command]
pub fn hybrid_undo(db: State<Db>, chain_id: String, files: Option<Vec<RunFile>>) -> Result<Vec<RunFile>, String> {
    let mut restored = Vec::new();
    for repo in run_repos(&db, &chain_id)? {
        let only: Option<Vec<String>> = files.as_ref().map(|files| {
            files.iter().filter(|file| file.project_id == repo.project_id).map(|file| file.path.clone()).collect()
        });
        if only.as_ref().is_some_and(|only| only.is_empty()) {
            continue;
        }
        for path in crate::git::checkpoint::restore_baseline(&repo.path, &chain_id, only.as_deref())? {
            restored.push(RunFile { project_id: repo.project_id.clone(), repo: repo.name.clone(), path });
        }
    }
    Ok(restored)
}

/// Saves a hybrid task's setup as a template of the workspace, or replaces the one `id` names.
#[tauri::command]
pub fn upsert_hybrid_template(
    db: State<Db>,
    id: Option<String>,
    workspace_id: String,
    name: String,
    description: String,
    config: HybridTemplateConfig,
) -> Result<ChainTemplate, String> {
    if name.trim().is_empty() {
        return Err("agents.templateNeedsName".to_string());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::upsert_hybrid_template(&conn, id, &workspace_id, name.trim(), description.trim(), &config).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use crate::hybrid::budget::Delegate;
    use crate::hybrid::config::ReviewMode;

    #[test]
    fn delegate_spellings_round_trip() {
        for delegate in [Delegate::Easy, Delegate::Medium, Delegate::All] {
            assert_eq!(Delegate::from_setting(delegate.as_str()), Some(delegate));
        }
    }

    #[test]
    fn review_mode_spellings_round_trip() {
        for mode in [ReviewMode::Local, ReviewMode::Fix, ReviewMode::Report] {
            assert_eq!(ReviewMode::from_setting(mode.as_str()), Some(mode));
        }
        assert_eq!(ReviewMode::from_setting(""), None);
    }
}
