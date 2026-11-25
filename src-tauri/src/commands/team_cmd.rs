//! Tauri commands for «Equipo». The engine they drive lives in [`crate::team::engine`]; what is
//! here is what a window can ask for: every command takes the request, hands it to the engine and
//! tells the windows what changed.

use tauri::{AppHandle, Emitter, State};

use crate::db::{queries, Db};
use crate::team::{self, coordination, gitops, intelligence, protocol, Policy, Run, RunState};

pub(crate) use crate::team::engine::*;

/// Moves a run from any window: the runner claims what is ready. What `teamStore.pump` calls now.
#[tauri::command]
pub fn team_pump(app: AppHandle, run_id: String) {
    crate::runner::kick(&app, &run_id);
}

// ---------------------------------------------------------------- teams

#[tauri::command]
pub fn team_list(db: State<'_, Db>, workspace_id: String) -> Result<Vec<team::Team>, String> {
    with(&db, |c| team::list_teams(c, &workspace_id).map_err(e2s))
}

/// Saves a team's whole record as the editor does, with its member, agent and repository ids — to make a team from a chat use the team_create tool instead, which takes names, checks everything and makes the agents it needs.
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
    // «It is gone» and «the query failed» are different answers: a window drops the first from
    // its list and keeps showing what it had on the second.
    with(&db, |c| team::state(c, &run_id).map_err(e2s)?.ok_or_else(|| RUN_GONE.to_string()))
}

/// The flows that put this workspace's agents and teams to work — see [`team::routines`].
#[tauri::command]
pub fn team_list_routines(db: State<'_, Db>, workspace_id: String) -> Result<Vec<team::routines::Routine>, String> {
    with(&db, |c| team::routines::list(c, &workspace_id).map_err(e2s))
}

#[tauri::command]
pub fn team_run_meta(db: State<'_, Db>, run_id: String, title: Option<String>, pinned: Option<bool>, agent_project_id: Option<String>) -> Result<(), String> {
    with(&db, |c| team::set_run_meta(c, &run_id, title.as_deref(), pinned, agent_project_id.as_deref()).map_err(e2s))
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

/// Marks every item that may start now as running and returns what to run. Items that need the
/// user's approval first park the run on a gate instead.
#[tauri::command]
// No `team:changed` here: the caller refreshes itself, and the event is what makes other listeners
// claim — announcing a claim would have every claim start another.
pub async fn team_claim(db: State<'_, Db>, run_id: String) -> Result<Vec<Dispatch>, String> {
    let mut out = Vec::new();
    for dispatch in claim_run(&db, &run_id, None).await? {
        // A shared run's seat is not this caller's to run: it goes out with the run's next round,
        // as the runner sends it (`collab::team`), or it would sit `running` with nobody on it.
        if dispatch.run_in == crate::collab::team::RUN_IN_REMOTE {
            if let Err(error) = crate::collab::team::queue_offer(&db, &run_id, &dispatch) {
                settle_core(&db, &dispatch.item.id, "error", "", &format!("no se pudo entregar al puesto: {error}")).await?;
            }
            continue;
        }
        out.push(dispatch);
    }
    Ok(out)
}

// ---------------------------------------------------------------- settle

/// One item's turn is over. `outcome` is `ok`, `error`, `busy` (it never ran) or `cancelled`.
#[tauri::command]
pub async fn team_settle(app: AppHandle, db: State<'_, Db>, item_id: String, outcome: String, text: Option<String>, error: Option<String>) -> Result<RunState, String> {
    settle_item(&app, &db, &item_id, &outcome, text.as_deref().unwrap_or_default(), error.as_deref().unwrap_or_default()).await
}

/// The suites a repository has, for the team's «Pruebas» tab to start from.
#[tauri::command]
pub fn team_detect_checks(db: State<'_, Db>, project_id: String) -> Result<Vec<team::Check>, String> {
    let project = with(&db, |c| queries::get_project(c, &project_id).map_err(e2s)?.ok_or_else(|| "El repositorio ya no está en la app.".to_string()))?;
    let mut suites = intelligence::detect_suites(std::path::Path::new(&project.local_path));
    for suite in &mut suites {
        suite.repo = project_id.clone();
    }
    Ok(suites)
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

#[tauri::command]
pub async fn team_amend(app: AppHandle, db: State<'_, Db>, run_id: String, body: String) -> Result<RunState, String> {
    request_amendment(&db, &run_id, &body).await?;
    changed(&app, &run_id);
    state_of(&db, &run_id)
}

#[tauri::command]
pub fn team_remember(app: AppHandle, db: State<'_, Db>, run_id: String, message_id: String, project_id: String, keep: bool) -> Result<RunState, String> {
    with(&db, |c| {
        let run = team::get_run(c, &run_id).map_err(e2s)?.ok_or("La corrida ya no existe.")?;
        let repo = team::list_repos(c, &run_id).map_err(e2s)?.into_iter().find(|repo| repo.project_id == project_id)
            .ok_or("Ese repositorio no está en la corrida.")?;
        let body = if keep {
            let message = team::get_message(c, &message_id).map_err(e2s)?
                .filter(|message| message.run_id == run.id && message.from_id != "system"
                    && (matches!(message.kind.as_str(), "decision" | "note") || message.kind == "question" && !message.answered_at.is_empty()))
                .ok_or("Elige un acuerdo o una nota de esta corrida.")?;
            let worktree = team::get_item(c, &message.item_id).map_err(e2s)?.map(|item| item.worktree_path).unwrap_or_default();
            let text = if message.answer.trim().is_empty() { message.body } else { format!("{}\nAcuerdo: {}", message.body, message.answer) };
            trim_chars(&intelligence::portable_text(&protocol::prose(&text), &[&repo.local_path, &repo.integration_path, &worktree]), 1600)
        } else {
            String::new()
        };
        intelligence::set_memory(c, &run, intelligence::Memory { message_id, run_id: run.id.clone(), project_id, body }, keep).map_err(e2s)
    })?;
    let _ = app.emit("team:changed", serde_json::json!({ "runId": run_id }));
    state_of(&db, &run_id)
}

/// Answers whatever a gated run waits for. `approve` false is "no": the plan goes back to the lead
/// (with `comment`), an item is skipped, the merge is left for later, a stuck run fails.
#[tauri::command]
pub async fn team_decide(app: AppHandle, db: State<'_, Db>, run_id: String, approve: bool, comment: Option<String>, expected_gate: Option<String>) -> Result<RunState, String> {
    let state = decide_for_gate(&db, &run_id, approve, comment.as_deref().unwrap_or_default(), expected_gate.as_deref()).await?;
    changed(&app, &run_id);
    Ok(state)
}

/// `pause`, `resume`, `abort`, or per item `retry:<id>` / `skip:<id>`. Returns the tasks that were
/// running, so the caller can stop their turns on `abort`.
#[tauri::command]
pub async fn team_control(app: AppHandle, run_id: String, action: String) -> Result<Vec<String>, String> {
    control(&crate::runner::AppHost(app), &run_id, &action).await
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

#[tauri::command]
pub fn team_recommendations(db: State<'_, Db>, run_id: String) -> Result<Vec<coordination::Recommendation>, String> {
    with(&db, |c| {
        let run = team::get_run(c, &run_id).map_err(e2s)?.ok_or("La corrida ya no existe.")?;
        let repos = team::list_repos(c, &run_id).map_err(e2s)?;
        coordination::recommendations(c, &run, &repos).map_err(e2s)
    })
}

#[tauri::command]
pub async fn team_pr_draft(db: State<'_, Db>, run_id: String, project_id: String, spanish: bool) -> Result<PrDraft, String> {
    let state = state_of(&db, &run_id)?;
    let repo = state.repos.iter().find(|repo| repo.project_id == project_id).ok_or("El repositorio no está en la corrida.")?;
    if !(state.run.status == "gated" && state.run.gate == "merge" && matches!(repo.status.as_str(), "ready" | "failed")
        || state.run.status == "done" && repo.status == "left")
    {
        return Err("El borrador requiere una entrega lista en la rama del equipo.".into());
    }
    let (root, target, source) = (repo.local_path.clone(), repo.target_branch.clone(), repo.integration_branch.clone());
    let commits = blocking(move || gitops::pr_commits(&root, &target, &source)).await??;
    if commits.is_empty() {
        return Err("La rama del equipo no tiene commits para un pull request.".into());
    }
    Ok(pr_draft(&state, repo, &commits, spanish))
}

/// Records the terminal session an item runs in (so the view can open it).
#[tauri::command]
pub fn team_item_terminal(db: State<'_, Db>, item_id: String, session_id: String) -> Result<(), String> {
    with(&db, |c| {
        c.execute("UPDATE agent_team_items SET terminal_session = ?2 WHERE id = ?1", rusqlite::params![item_id, session_id]).map_err(e2s)?;
        Ok(())
    })
}

/// Every agent of the workspace with what is on its plate — its tasks in the runs that are still
/// going, the messages it has not heard, the questions it asked, the cards assigned to it — the
/// ones something waits on first.
#[tauri::command]
pub fn team_list_inboxes(db: State<'_, Db>, workspace_id: String) -> Result<Vec<team::inbox::AgentInbox>, String> {
    with(&db, |c| team::inbox::list(c, &workspace_id).map_err(e2s))
}

/// The teams a chat designed in a turn that could not create them, waiting for the user's yes.
#[tauri::command]
pub fn team_list_proposals(workspace_id: String) -> Vec<team::designer::Proposal> {
    team::designer::proposals(&workspace_id)
}

/// The user's yes to a proposed team: it is checked again against the workspace as it is now and
/// created, with the agents it needs. Never a model's to call — it is the answer to its own proposal.
#[tauri::command]
pub async fn team_proposal_accept(id: String) -> Result<team::Team, String> {
    team::designer::accept(&id).await
}

/// Throws a proposed team away.
#[tauri::command]
pub fn team_proposal_dismiss(id: String) {
    team::designer::dismiss(&id);
}

/// The workspace's comparisons — the same task given to several teams from one commit — with what
/// each team's run says now.
#[tauri::command]
pub fn team_list_evals(db: State<'_, Db>, workspace_id: String) -> Result<Vec<team::lab::EvalView>, String> {
    with(&db, |c| {
        let mut out = Vec::new();
        for eval in team::lab::list(c, &workspace_id).map_err(e2s)? {
            out.push(team::lab::view(c, &eval).map_err(e2s)?);
        }
        Ok(out)
    })
}

/// Starts a comparison: one run per team, all from the same commit of `target_branch`, none of
/// which lands. `checks` are the commands every result is scored with; empty takes the
/// repository's own.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn team_eval_start(app: AppHandle, db: State<'_, Db>, workspace_id: String, title: String, goal: String, project_id: String, target_branch: String, team_ids: Vec<String>, checks: Vec<String>) -> Result<team::lab::EvalView, String> {
    let eval = eval_start(&db, &workspace_id, &title, &goal, &project_id, &target_branch, &team_ids, &checks).await?;
    for entry in eval.entries.iter().filter(|e| !e.run_id.is_empty()) {
        changed(&app, &entry.run_id);
    }
    with(&db, |c| team::lab::view(c, &eval).map_err(e2s))
}

/// Scores the results of a comparison that closed and have no verdict yet: its checks, run on
/// each one, and the size of each change.
#[tauri::command]
pub async fn team_eval_score(db: State<'_, Db>, eval_id: String) -> Result<team::lab::EvalView, String> {
    let eval = eval_score(&db, &eval_id).await?;
    with(&db, |c| team::lab::view(c, &eval).map_err(e2s))
}

/// Removes a comparison. Its runs stay in the list of runs.
#[tauri::command]
pub async fn team_eval_delete(db: State<'_, Db>, eval_id: String) -> Result<(), String> {
    eval_delete(&db, &eval_id).await
}

/// Starts a new run from where another was — just before one of its tasks (`item_id`), or from
/// what it has integrated — on branches of its own. `goal` and `team_id` change what it is for and
/// who does it; empty keeps the original's.
#[tauri::command]
pub async fn team_fork_run(app: AppHandle, db: State<'_, Db>, run_id: String, item_id: Option<String>, goal: Option<String>, team_id: Option<String>) -> Result<RunState, String> {
    let state = fork_run(&db, &run_id, item_id.as_deref().unwrap_or_default(), goal.as_deref().unwrap_or_default(), team_id.as_deref().unwrap_or_default()).await?;
    changed(&app, &run_id);
    changed(&app, &state.run.id);
    Ok(state)
}

/// Whether this computer can run a team's checks isolated: the container engine it would use, or
/// why there is none. `fresh` asks the engine again instead of trusting the last answer.
#[tauri::command]
pub async fn team_sandbox_status(fresh: Option<bool>) -> Result<team::sandbox::Status, String> {
    Ok(team::sandbox::status(fresh.unwrap_or(false)).await)
}

/// Deletes a run with its tasks, its clean worktrees and the branches with nothing of their own.
#[tauri::command]
pub async fn team_delete_run(db: State<'_, Db>, run_id: String) -> Result<(), String> {
    crate::runner::cancel_run(&run_id);
    // Its turns stop first: the folders they write into are about to go.
    crate::runner::wait_idle(&run_id, ABORT_GRACE).await;
    team::artifacts::forget(&run_id, &[]);
    tidy_run(&db, &run_id).await?;
    with(&db, |c| {
        crate::crew::delete_decisions_for_run(c, &run_id).map_err(e2s)?;
        team::delete_run(c, &run_id).map_err(e2s)
    })
}
