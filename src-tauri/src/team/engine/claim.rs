use super::*;

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
    pub account_id: Option<String>,
    pub title: String,
}

/// [`claim_limited`] under the run's lock, taking at most `limit` items — what the runner calls with the
/// governor's free slots, so an item is only marked running when it can start.
pub async fn claim_run(db: &Db, run_id: &str, limit: Option<usize>) -> Result<Vec<Dispatch>, String> {
    let lock = run_lock(run_id);
    let _guard = lock.lock().await;
    claim_limited(db, run_id, limit).await
}

/// Where a run keeps the plan windows it started from, per account key.
pub(crate) fn session_base_key(run_id: &str) -> String {
    format!("team_session_base:{run_id}")
}

/// The shortest plan window of every engine account the run's members use that publishes one —
/// Claude, Codex, Gemini, opencode: `(account key, used %, resets at)`.
///
/// Claude's comes from what its own runs report (no keychain read — the members are running it
/// anyway); the others through `ai_quota`'s cache, which reads at most once a minute (Gemini's CLI
/// once per half hour, behind the answer). An engine with no window is left to [`unmetered_over`].
pub(crate) async fn plan_windows(db: &Db, run_id: &str) -> Vec<(String, f64, String)> {
    let engines = with(db, |c| {
        let Some(run) = team::get_run(c, run_id).map_err(e2s)? else { return Ok(Vec::new()) };
        if run.policy.max_session_pct <= 0 {
            return Ok(Vec::new());
        }
        let mut seen: Vec<String> = Vec::new();
        let mut out = Vec::new();
        for m in &run.members {
            if !crate::ai_quota::QUOTA_PROVIDERS.contains(&m.provider.as_str()) {
                continue;
            }
            let account = crate::ai_accounts::resolve(c, &m.provider, Some("chat"), Some(&run.workspace_id),
                crate::ai_accounts::Choice::parse(m.account_id.as_deref()));
            let key = account.key();
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
            let account = account.account_id.is_some().then_some(account);
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
pub(crate) fn unmetered_over(run: &Run, items: &[Item]) -> Option<String> {
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
pub(crate) fn session_used(base: (f64, &str), now: (f64, &str)) -> f64 {
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
pub(crate) fn session_over(c: &Connection, run: &Run, windows: &[(String, f64, String)]) -> Result<Option<String>, String> {
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

pub(crate) fn engine_name(provider: &str) -> &str {
    match provider {
        "claude" => "Claude",
        "codex" => "Codex",
        "gemini" => "Gemini",
        "opencode" => "opencode",
        other => other,
    }
}

pub(crate) struct Picked {
    item: Item,
    repo: RunRepo,
}

#[cfg(test)]
pub async fn claim(db: &Db, run_id: &str) -> Result<Vec<Dispatch>, String> {
    claim_limited(db, run_id, None).await
}

pub(crate) async fn claim_limited(db: &Db, run_id: &str, limit: Option<usize>) -> Result<Vec<Dispatch>, String> {
    // The plan windows, read before the lock: the fallback reads a setting through the same handle.
    let windows = plan_windows(db, run_id).await;
    // 1. Decide, under the database lock.
    let (run, picked) = with(db, |c| {
        let Some(run) = team::get_run(c, run_id).map_err(e2s)? else { return Ok((None, Vec::new())) };
        if run.status != "running" {
            return Ok((Some(run), Vec::new()));
        }
        let mut items = team::list_items(c, run_id).map_err(e2s)?;
        let now = chrono::Utc::now().timestamp();
        for item in &mut items {
            if item.status == "waiting" && item.intelligence.recovery.as_ref().and_then(|r| r.resume_at).is_some_and(|at| at <= now) {
                item.status = "pending".into();
                item.intelligence.recovery = None;
                team::update_item(c, item).map_err(e2s)?;
            }
        }
        let blocked: Vec<_> = items.iter().filter(|i| i.status == "waiting" && i.intelligence.recovery.is_some()).cloned().collect();
        for item in items.iter_mut().filter(|i| i.status == "pending") {
            if let Some(waiting) = blocked.iter().find(|other| other.intelligence.recovery.as_ref().is_some_and(|recovery| intelligence::blocked_by(c, &run, item, recovery))) {
                item.status = "waiting".into();
                item.intelligence.recovery = waiting.intelligence.recovery.clone();
                item.last_error.clone_from(&waiting.last_error);
                team::update_item(c, item).map_err(e2s)?;
            }
        }
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
        // A budget checked only against what is already spent lets every turn in flight spend past
        // it: with $1.80 of $2.00 gone, four more turns start and the run ends at $3.40. So what is
        // in flight is reserved at what a turn of this run has cost so far, and a turn starts only
        // while there is room for it too. Before anything settles there is nothing to estimate
        // from, and the first wave starts on the run's parallel cap alone.
        let in_flight = items.iter().filter(|i| i.status == "running").count();
        let reserve = team::metrics::Reserve::of(&spend);
        for mut item in ready {
            if let Some(note) = reserve.short(&run, usd, tokens, in_flight + picked.len() + 1) {
                // Nothing running that could free room: it is the user's call, with the numbers.
                if in_flight == 0 && picked.is_empty() {
                    team::set_run_status(c, run_id, "gated", "budget", &note).map_err(e2s)?;
                }
                break;
            }
            // A shared run (`collab::team`): a seat someone took runs on their machine; a free seat
            // waits for someone (or for the owner to take it back); anything else runs here.
            match crate::collab::team::route(c, run_id, &item.member_id, &item.kind) {
                crate::collab::team::Route::Wait => continue,
                crate::collab::team::Route::Remote => item.run_in = crate::collab::team::RUN_IN_REMOTE.into(),
                crate::collab::team::Route::Local if item.run_in == crate::collab::team::RUN_IN_REMOTE => {
                    item.run_in = member(&run, &item.member_id).map(|m| m.member.run_in.clone()).filter(|r| !r.is_empty()).unwrap_or_else(|| "headless".into());
                }
                crate::collab::team::Route::Local => {}
            }
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
            // This dispatch, and no other, may settle the item (`settle_dispatch`). A headless turn
            // waits for a slot of the governor first: it is `queued` until its turn really starts.
            item.intelligence.dispatch_id = uuid::Uuid::new_v4().to_string();
            item.intelligence.phase = if item.run_in == "headless" { "queued" } else { "running" }.into();
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
            match blocking(move || {
                gitops::add_worktree(&r, &t, &b, &s)?;
                Ok::<_, String>(gitops::head_sha(&t).unwrap_or_default())
            }).await? {
                Ok(base_sha) => {
                    p.item.worktree_path = path;
                    p.item.branch = branch;
                    p.item.intelligence.base_sha = base_sha;
                    p.item.intelligence.infra_failures = 0;
                }
                Err(e) => {
                    with(db, |c| infra_failure(c, &run, &mut p.item, &format!("no se pudo crear su carpeta: {e}")))?;
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
        let memories = intelligence::memories(c, &run).map_err(e2s)?;
        let contracts = coordination::latest_contracts(&items);
        let recommendations = if ready.iter().any(|picked| picked.item.is_lead()) {
            coordination::recommendations(c, &run, &repos).unwrap_or_default()
        } else {
            Vec::new()
        };
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
            let (mut message, delivered) = compose(&run, &repos, &items, &messages, &item, &m, &cwd);
            item.intelligence.used_contracts.clear();
            for name in &item.intelligence.requires_contracts {
                let Some((_, contract)) = contracts.get(name.as_str()) else { continue };
                let reference = match team::artifacts::mirror_contract(run_id, &cwd, contract) {
                    Ok(path) => format!("Léelo completo en `{path}`."),
                    Err(_) => format!("Contenido exacto del contrato:\n{}", contract.text),
                };
                message.push_str(&format!("\n\nContrato «{}» · versión {}. {reference}\n", name, contract.version));
                item.intelligence.used_contracts.insert(name.clone(), contract.version.clone());
            }
            if item.is_lead() && !recommendations.is_empty() {
                message.push_str("\n\n## Experiencia del equipo en estos repositorios\nUsa estas muestras al elegir miembros disponibles. Mantén los permisos y el modelo configurado de cada agente.\n");
                for row in recommendations.iter().take(6) {
                    let repo = repos.iter().find(|repo| repo.project_id == row.project_id).map(|repo| repo.name.as_str()).unwrap_or("");
                    message.push_str(&format!("- {repo} · {} · {} / {} / {} · {}/{} al primer intento; mediana {} s.\n",
                        row.role, row.route.provider, row.route.model, row.route.effort, row.first_pass, row.attempted, row.median_seconds));
                }
            }
            let applicable: Vec<_> = memories.iter().rev()
                .filter(|memory| memory.run_id != run.id && (memory.project_id == item.project_id
                    || (item.is_lead() && repos.iter().any(|repo| repo.project_id == memory.project_id)
                        && (m.member.repos.is_empty() || m.member.repos.contains(&memory.project_id)))))
                .take(8).collect();
            if !applicable.is_empty() {
                message.push_str("\n\n## Acuerdos aprobados de corridas anteriores\nÚsalos como contexto del repositorio. El encargo actual tiene prioridad.\n");
                for memory in applicable {
                    let repo = repos.iter().find(|repo| repo.project_id == memory.project_id).map(|repo| repo.name.as_str()).unwrap_or("");
                    message.push_str(&format!("\n- {repo} · corrida {} · {}\n", memory.run_id, memory.body));
                }
            }
            // Delivered is what a turn that finished read, not what one that may never start was
            // going to be told: they are marked when the turn settles well (`settle_inner`).
            item.intelligence.inbox = delivered;
            let task = if item.run_in == "terminal" || item.run_in == crate::collab::team::RUN_IN_REMOTE {
                None
            } else {
                Some(task_for(c, &run, &mut item, &items, &m, &cwd)?)
            };
            let execution = intelligence::executor(&run, &item).unwrap_or(&m);
            let route = coordination::Execution {
                provider: execution.provider.clone(), model: intelligence::model(execution, &item).to_string(), effort: execution.effort.clone(),
            };
            item.intelligence.execution = Some(route.clone());
            team::update_item(c, &item).map_err(e2s)?;
            team::post(c, run_id, &item.id, (&m.member.id, &m.member.name), ("all", "Equipo"), "status", &format!("empezó «{}»", item.title), &[])
                .map_err(e2s)?;
            out.push(Dispatch {
                title: format!("{} · {}", m.member.name, item.title),
                provider: route.provider,
                model: route.model,
                effort: route.effort,
                account_id: execution.account_id.clone(),
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
pub(crate) fn cwd_of(item: &Item, items: &[Item], repo: &RunRepo) -> String {
    match item.kind.as_str() {
        "work" | "integrate" if !item.worktree_path.is_empty() => item.worktree_path.clone(),
        "review" => items.iter().find(|i| i.id == item.ref_item).map(|i| i.worktree_path.clone()).filter(|p| !p.is_empty()).unwrap_or_else(|| repo.integration_path.clone()),
        _ => repo.integration_path.clone(),
    }
}

/// The task an item runs as: the work it continues (a fix after review), the lead's single
/// conversation, or a new one in the item's folder.
pub(crate) fn task_for(conn: &Connection, run: &Run, item: &mut Item, items: &[Item], m: &MemberSnap, cwd: &str) -> Result<AgentTask, String> {
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
