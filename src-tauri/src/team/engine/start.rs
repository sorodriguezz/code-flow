use super::*;

// ---------------------------------------------------------------- start

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoPick {
    pub project_id: String,
    /// `""` is the branch the repository has checked out now.
    #[serde(default)]
    pub target_branch: String,
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

    // What each member's provider cannot be held to, before anything is made: a team that asks
    // for guarantees does not start without them.
    let policy = policy.unwrap_or_else(|| tm.policy.clone()).sane().for_run();
    let open = guarantee_gaps(&members, &policy);
    if policy.guarantees == "block" && !open.is_empty() {
        return Err(format!("El equipo exige garantías que sus proveedores no dan:\n{}\nCambia el proveedor de esos miembros, o baja la exigencia a «Avisar» en el equipo.", open.join("\n")));
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
            pr_url: String::new(),
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
        policy,
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
        if run.policy.guarantees == "warn" && !open.is_empty() {
            team::post(&tx, &run.id, "", ("system", "CodeFlow"), ("user", "Tú"), "finding",
                &format!("Esta corrida empieza con garantías abiertas:\n{}", open.join("\n")), &[]).map_err(e2s)?;
        }
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
pub(crate) fn seed_fixed_plan(conn: &Connection, run: &Run, plan: &[team::PlanStep], repos: &[RunRepo]) -> Result<(), String> {
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
pub(crate) fn new_planner_item(conn: &Connection, run: &Run, planner: &str, kind: &str, instruction: &str, feedback: &str, parent: &str) -> Result<Option<Item>, String> {
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

/// What the members have delivered so far, as one value: every finished task that left something —
/// a commit for work, the answer for research. Work that finished without changing anything is not
/// progress (a task the lead handed out again because it was already done ends exactly like that),
/// nor are the advisor, reviews or merges, which come by themselves.
pub(crate) fn progress_mark(items: &[Item]) -> String {
    let mut parts: Vec<String> = items
        .iter()
        .filter(|i| i.status == "done" && !i.is_lead() && !matches!(i.kind.as_str(), "advise" | "review" | "integrate"))
        .filter(|i| i.kind != "work" || !i.commit_sha.is_empty())
        .map(|i| format!("{}:{}", i.key, i.commit_sha))
        .collect();
    parts.sort();
    coordination::fingerprint(&parts.iter().map(String::as_str).collect::<Vec<_>>())
}

/// The lead's latest round that handed out work still standing (not skipped by a rejected plan).
pub(crate) fn last_working_round<'a>(run: &Run, items: &'a [Item]) -> Option<&'a Item> {
    items
        .iter()
        .filter(|l| l.member_id == run.lead && matches!(l.kind.as_str(), "plan" | "final"))
        .filter(|l| items.iter().any(|i| !i.is_lead() && i.kind != "advise" && i.round == l.round && i.status != "skipped"))
        .max_by_key(|l| l.round)
}

/// A lead round the app starts by itself — after a failure, a block, the last look, a failing final
/// check — but only if the last round that handed out work changed something. The round caps bound
/// how many rounds there are; this stops the ones that only repeat: when nothing is still running
/// and the members delivered nothing new since that round began, the run waits for the user instead
/// of asking the lead again. «Seguir» acknowledges it and lets one more round through. Rounds the user
/// asks for (a rejected plan, a question) go straight to [`new_lead_item`].
pub(crate) fn new_lead_round(conn: &Connection, run: &Run, kind: &str, instruction: &str) -> Result<Option<Item>, String> {
    let items = team::list_items(conn, &run.id).map_err(e2s)?;
    let open = items.iter().filter(|i| !i.is_lead() && matches!(i.status.as_str(), "pending" | "running" | "waiting" | "gated" | "delegated")).count();
    let mark = progress_mark(&items);
    if open == 0 {
        if let Some(previous) = last_working_round(run, &items).filter(|r| r.intelligence.progress == mark) {
            let mut previous = previous.clone();
            previous.intelligence.progress = format!("ack:{mark}");
            team::update_item(conn, &previous).map_err(e2s)?;
            let note = format!(
                "La «{}» del líder no dejó cambios: ninguna tarea terminó con algo nuevo desde entonces. Se detiene para no repetir el trabajo. Lo que iba a pedirle al líder:\n{}",
                previous.title,
                first_line(instruction, 400)
            );
            team::set_run_status(conn, &run.id, "gated", &format!("stuck:{}", previous.id), &note).map_err(e2s)?;
            return Ok(None);
        }
    }
    new_lead_item(conn, run, kind, instruction, "")
}

pub(crate) fn new_lead_item(conn: &Connection, run: &Run, kind: &str, instruction: &str, feedback: &str) -> Result<Option<Item>, String> {
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
    item.intelligence.progress = progress_mark(&items);
    // The lead is always a background turn: it only plans, and its answer is read by the app.
    item.run_in = "headless".into();
    team::insert_item(conn, &item).map_err(e2s)?;
    team::bump_lead_round(conn, &run.id).map_err(e2s)?;
    Ok(Some(item))
}

/// What the run's members need of their providers and do not get, one line each, in words.
pub(crate) fn guarantee_gaps(members: &[MemberSnap], policy: &Policy) -> Vec<String> {
    if policy.guarantees == "off" {
        return Vec::new();
    }
    // A run that caps its agents' minutes bounds an engine that publishes nothing.
    let bounded = policy.unmetered_minutes > 0 || policy.budget_minutes > 0;
    let mut lines = Vec::new();
    for m in members {
        let label = crate::provider_caps::caps_of(&m.provider).map(|caps| caps.label).unwrap_or_else(|| m.provider.clone());
        for gap in crate::provider_caps::gaps(&m.provider, m.member.edits, bounded) {
            lines.push(match gap {
                "read_only" => format!("- «{}» no debe escribir, pero {label} no lo impide: solo se le pide.", m.member.name),
                _ => format!("- «{}» corre en {label}, que no publica su consumo, y la corrida no pone tope de minutos.", m.member.name),
            });
        }
    }
    lines
}
