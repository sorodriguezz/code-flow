use super::*;
use crate::team::lab::{self, Entry, Eval, Score};

fn git(repo: &str, args: &[&str]) -> Result<String, String> {
    let out = crate::git::cli::run_in(repo, args, &[])?;
    if out.success { Ok(out.stdout.trim().to_string()) } else { Err(out.detail()) }
}

/// The policy a team runs a comparison with: its own, except that nothing waits for a person and
/// nothing lands — the result stays on the run's branch, where it is scored.
fn lab_policy(mut policy: Policy) -> Policy {
    policy.approve_plan = false;
    policy.approve_merge = false;
    policy.approve_code = "never".into();
    policy.integrate = "branch".into();
    policy.cleanup = false;
    policy
}

/// Starts a comparison: pins `target_branch`'s commit and gives `goal` to each of `team_ids` from
/// it. A team that cannot start is kept in the comparison with why; the others go on.
#[allow(clippy::too_many_arguments)]
pub async fn eval_start(db: &Db, workspace_id: &str, title: &str, goal: &str, project_id: &str, target_branch: &str, team_ids: &[String], checks: &[String]) -> Result<Eval, String> {
    let goal = goal.trim();
    if goal.is_empty() {
        return Err("Di qué tarea van a hacer los equipos.".into());
    }
    let mut picked: Vec<String> = Vec::new();
    for id in team_ids {
        if !picked.contains(id) {
            picked.push(id.clone());
        }
    }
    if picked.len() < 2 {
        return Err("Una comparación necesita al menos dos equipos.".into());
    }
    if picked.len() > lab::MAX_TEAMS {
        return Err(format!("Una comparación admite como máximo {} equipos.", lab::MAX_TEAMS));
    }
    let (project, teams) = with(db, |c| {
        let project = queries::get_project(c, project_id).map_err(e2s)?.ok_or("El repositorio ya no existe.")?;
        let mut teams = Vec::new();
        for id in &picked {
            teams.push(team::get_team(c, id).map_err(e2s)?.ok_or("Uno de los equipos ya no existe.")?);
        }
        Ok((project, teams))
    })?;
    let id = uuid::Uuid::new_v4().to_string();
    let pin = format!("codeflow/eval-{}", short(&id));
    let (repo, branch, pin_branch) = (project.local_path.clone(), target_branch.trim().to_string(), pin.clone());
    let (base_branch, base_sha) = blocking(move || {
        let branch = if branch.is_empty() { gitops::current_branch(&repo).ok_or("El repositorio no está en ninguna rama: elige la rama de partida.")? } else { branch };
        let sha = git(&repo, &["rev-parse", "--verify", &format!("{branch}^{{commit}}")]).map_err(|_| format!("La rama «{branch}» no existe."))?;
        git(&repo, &["branch", &pin_branch, &sha])?;
        Ok::<_, String>((branch, sha))
    })
    .await??;

    // The same checks for everyone: the ones asked for, or the repository's own.
    let mut commands: Vec<String> = checks.iter().map(|c| c.trim().to_string()).filter(|c| !c.is_empty()).collect();
    if commands.is_empty() {
        commands = intelligence::detect_suites(std::path::Path::new(&project.local_path)).into_iter().filter(|c| c.when != "agent").map(|c| c.command).collect();
    }
    commands.dedup();

    let title = if title.trim().is_empty() { first_line(goal, 64) } else { title.trim().to_string() };
    let mut entries = Vec::new();
    for tm in &teams {
        let started = start_run(
            db,
            workspace_id.to_string(),
            tm.id.clone(),
            goal.to_string(),
            Some(format!("{title} · {}", tm.name)),
            vec![RepoPick { project_id: project.id.clone(), target_branch: pin.clone() }],
            Some(lab_policy(tm.policy.clone())),
            None,
        )
        .await;
        entries.push(match started {
            Ok(state) => Entry { team_id: tm.id.clone(), team_name: tm.name.clone(), run_id: state.run.id, ..Default::default() },
            Err(error) => Entry { team_id: tm.id.clone(), team_name: tm.name.clone(), error, ..Default::default() },
        });
    }
    if entries.iter().all(|e| e.run_id.is_empty()) {
        let (repo, pin) = (project.local_path.clone(), pin.clone());
        let _ = blocking(move || git(&repo, &["branch", "-D", &pin])).await;
        return Err(format!("Ningún equipo pudo empezar: {}", entries.iter().map(|e| format!("{}: {}", e.team_name, e.error)).collect::<Vec<_>>().join(" · ")));
    }
    let stamp = queries::now();
    let eval = Eval {
        id,
        workspace_id: workspace_id.to_string(),
        title,
        goal: goal.to_string(),
        project_id: project.id.clone(),
        project_name: project.name.clone(),
        base_branch,
        base_sha,
        pin_branch: pin,
        checks: commands,
        entries,
        created_at: stamp.clone(),
        updated_at: stamp,
    };
    with(db, |c| lab::save(c, &eval).map_err(e2s))?;
    Ok(eval)
}

/// Gives a verdict to every result that closed and has none yet (or moved since it got one): the
/// comparison's checks, run in the run's own integration tree, and the size of its change.
pub async fn eval_score(db: &Db, eval_id: &str) -> Result<Eval, String> {
    let mut eval = with(db, |c| lab::get(c, eval_id).map_err(e2s)?.ok_or_else(|| "La comparación ya no existe.".to_string()))?;
    let mut changed = false;
    for index in 0..eval.entries.len() {
        let entry = eval.entries[index].clone();
        if entry.run_id.is_empty() {
            continue;
        }
        let Some((run, repo)) = with(db, |c| {
            let Some(run) = team::get_run(c, &entry.run_id).map_err(e2s)? else { return Ok(None) };
            let repo = team::list_repos(c, &run.id).map_err(e2s)?.into_iter().find(|r| r.project_id == eval.project_id);
            Ok(repo.map(|repo| (run, repo)))
        })?
        else {
            continue;
        };
        if run.status != "done" {
            continue;
        }
        let (root, branch) = (repo.local_path.clone(), repo.integration_branch.clone());
        let Ok(Ok(head)) = blocking(move || git(&root, &["rev-parse", "--verify", &format!("{branch}^{{commit}}")])).await else { continue };
        if head == entry.scored_sha {
            continue;
        }
        let at = CheckAt { run: &run, project_id: &repo.project_id, slot: "integration" };
        let tree_there = std::path::Path::new(&repo.integration_path).is_dir();
        let mut scores = Vec::new();
        for command in &eval.checks {
            let score = if !tree_there {
                Score { command: command.clone(), result: "unavailable".into(), detail: "La carpeta de integración de la corrida ya no está.".into() }
            } else {
                match verify_check(db, &at, command, &repo.integration_path, None, "").await {
                    Ok(evidence) => Score { command: command.clone(), result: if evidence.result == "passed" { "passed" } else { "failed" }.into(), detail: trim_chars(&evidence.detail, 2000) },
                    Err(reason) => Score { command: command.clone(), result: "unavailable".into(), detail: reason },
                }
            };
            scores.push(score);
        }
        let (root, base, branch) = (repo.local_path.clone(), eval.base_sha.clone(), repo.integration_branch.clone());
        let stat = blocking(move || git(&root, &["diff", "--shortstat", &format!("{base}..{branch}")])).await.ok().and_then(Result::ok).unwrap_or_default();
        let (files, insertions, deletions) = lab::parse_shortstat(&stat);
        let slot = &mut eval.entries[index];
        slot.scores = scores;
        slot.scored_sha = head;
        slot.files = files;
        slot.insertions = insertions;
        slot.deletions = deletions;
        changed = true;
    }
    if changed {
        eval.updated_at = queries::now();
        with(db, |c| lab::save(c, &eval).map_err(e2s))?;
    }
    Ok(eval)
}

/// Removes a comparison and the branch that pinned its commit. Its runs are ordinary runs and stay;
/// one that is still going keeps the comparison until it is stopped.
pub async fn eval_delete(db: &Db, eval_id: &str) -> Result<(), String> {
    let Some(eval) = with(db, |c| lab::get(c, eval_id).map_err(e2s))? else { return Ok(()) };
    let (active, repo) = with(db, |c| {
        let mut active = Vec::new();
        for entry in eval.entries.iter().filter(|e| !e.run_id.is_empty()) {
            if team::get_run(c, &entry.run_id).map_err(e2s)?.is_some_and(|run| matches!(run.status.as_str(), "running" | "gated" | "paused")) {
                active.push(entry.team_name.clone());
            }
        }
        Ok((active, queries::get_project(c, &eval.project_id).map_err(e2s)?.map(|p| p.local_path)))
    })?;
    if !active.is_empty() {
        return Err(format!("Todavía trabajan en ella: {}. Detén esas corridas antes de quitar la comparación.", active.join(", ")));
    }
    if let Some(repo) = repo {
        let pin = eval.pin_branch.clone();
        // The pin only ever pointed at a commit that was already there: nothing is lost with it.
        let _ = blocking(move || git(&repo, &["branch", "-D", &pin])).await;
    }
    with(db, |c| lab::delete(c, eval_id).map_err(e2s))
}
