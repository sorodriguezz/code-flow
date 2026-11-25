use super::*;

/// Starts a new run from where another one was: from just before one of its tasks, or from what
/// it has integrated so far. The fork works on branches of its own (`codeflow/fork-…`) and lands
/// there, never on the original's target — the original run is not touched, and neither is what
/// it delivered.
///
/// `goal` is what the fork is for; empty takes the original's. `team_id` picks another team for
/// it; empty keeps the same.
pub async fn fork_run(db: &Db, run_id: &str, item_id: &str, goal: &str, team_id: &str) -> Result<RunState, String> {
    let state = state_of(db, run_id)?;
    let run = &state.run;
    let from = if item_id.trim().is_empty() {
        None
    } else {
        Some(state.items.iter().find(|i| i.id == item_id).ok_or("La tarea desde la que bifurcar ya no existe.")?)
    };
    if let Some(item) = from {
        if item.intelligence.base_sha.is_empty() {
            return Err(format!("«{}» todavía no empezó: no hay un punto del código desde el que bifurcar.", item.title));
        }
    }
    let team_id = if team_id.trim().is_empty() { run.team_id.clone() } else { team_id.trim().to_string() };
    let same_team = team_id == run.team_id;

    // Where each repository of the fork starts: the task's own base in its repository, and what
    // the run has integrated so far in the others.
    let stamp = short(&uuid::Uuid::new_v4().to_string());
    let branch = format!("codeflow/fork-{}-{stamp}", slug(&run.title, 24));
    let mut picks = Vec::new();
    let mut made: Vec<(String, String)> = Vec::new();
    for repo in &state.repos {
        let start = match from.filter(|item| item.project_id == repo.project_id) {
            Some(item) => item.intelligence.base_sha.clone(),
            None => repo.integration_branch.clone(),
        };
        let (root, name, target) = (repo.local_path.clone(), branch.clone(), repo.target_branch.clone());
        let created = blocking(move || {
            let run = |args: &[&str]| crate::git::cli::run_in(&root, args, &[]).map(|out| (out.success, out.detail()));
            // The run's own branch may be gone once it landed: what it delivered is in its target.
            let (ok, detail) = run(&["branch", &name, &start])?;
            if ok {
                return Ok(());
            }
            let (ok, _) = run(&["branch", &name, &target])?;
            if ok { Ok(()) } else { Err(detail) }
        })
        .await?;
        if let Err(error) = created {
            for (root, name) in made {
                let _ = blocking(move || crate::git::cli::run_in(&root, &["branch", "-D", &name], &[])).await;
            }
            return Err(format!("{}: no se pudo crear la rama de la bifurcación — {error}", repo.name));
        }
        made.push((repo.local_path.clone(), branch.clone()));
        picks.push(RepoPick { project_id: repo.project_id.clone(), target_branch: branch.clone() });
    }

    // What was already done at that point is in the code the fork starts from: the new plan is
    // told, so it does not do it again.
    let before: Vec<&Item> = state
        .items
        .iter()
        .filter(|i| i.kind == "work" && i.status == "done" && i.merged)
        .filter(|i| from.is_none_or(|item| !i.finished_at.is_empty() && i.finished_at.as_str() <= item.started_at.as_str()))
        .collect();
    let mut brief = if goal.trim().is_empty() { run.goal.clone() } else { goal.trim().to_string() };
    brief.push_str(&format!("\n\n## De dónde parte esta corrida\nEs una bifurcación de «{}»", run.title));
    match from {
        Some(item) => brief.push_str(&format!(", desde justo antes de la tarea «{}» ({}).", item.title, first_line(&item.instruction, 200))),
        None => brief.push_str(", desde lo que llevaba integrado."),
    }
    if !goal.trim().is_empty() {
        brief.push_str(&format!("\nEl objetivo original era: {}", first_line(&run.goal, 400)));
    }
    if before.is_empty() {
        brief.push_str("\nNada del trabajo original está en el código de partida.");
    } else {
        brief.push_str("\nEsto ya está hecho y en el código de partida; no lo rehagas, planifica solo lo que falta:");
        for item in before.iter().take(30) {
            brief.push_str(&format!("\n- `{}` {} — {}", item.key, item.title, first_line(&protocol::prose(&item.output_text), 160)));
        }
    }

    let started = start_run(
        db,
        run.workspace_id.clone(),
        team_id,
        brief,
        Some(format!("↳ {}", run.title)),
        picks,
        // The same team keeps the rules the original ran with; another team brings its own.
        same_team.then(|| run.policy.clone()),
        Some(run.agent_project_id.clone()).filter(|id| !id.is_empty()),
    )
    .await;
    let new = match started {
        Ok(new) => new,
        Err(error) => {
            for (root, name) in made {
                let _ = blocking(move || crate::git::cli::run_in(&root, &["branch", "-D", &name], &[])).await;
            }
            return Err(error);
        }
    };
    let point = from.map(|item| format!("desde antes de «{}»", item.title)).unwrap_or_else(|| "desde lo integrado".into());
    with(db, |c| {
        team::post(c, &run.id, item_id.trim(), ("user", "Tú"), ("all", "Equipo"), "status", &format!("bifurcó esta corrida {point} → «{}» (rama `{branch}`)", new.run.title), &[]).map_err(e2s)?;
        team::post(c, &new.run.id, "", ("system", "CodeFlow"), ("all", "Equipo"), "status",
            &format!("Bifurcada de «{}» {point}. Trabaja y entrega en la rama `{branch}`; la corrida original no se toca.", run.title), &[]).map(|_| ()).map_err(e2s)
    })?;
    state_of(db, &new.run.id)
}
