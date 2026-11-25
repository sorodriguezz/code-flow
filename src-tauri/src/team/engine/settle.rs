use super::*;

/// The turn of a headless dispatch is about to start, after its wait for a slot: `false` when it
/// must not — the run stopped moving meanwhile, or the item is another dispatch's now. On `true`
/// the item is `running` for real and its clock starts here, not when it was claimed.
pub fn turn_started(db: &Db, item_id: &str, dispatch_id: &str) -> bool {
    with(db, |c| {
        let Some(mut item) = team::get_item(c, item_id).map_err(e2s)? else { return Ok(false) };
        if item.status != "running" || item.intelligence.dispatch_id != dispatch_id {
            return Ok(false);
        }
        if !team::get_run(c, &item.run_id).map_err(e2s)?.is_some_and(|run| run.status == "running") {
            return Ok(false);
        }
        item.intelligence.phase = "running".into();
        item.started_at = queries::now();
        team::update_item(c, &item).map_err(e2s)?;
        Ok(true)
    })
    .unwrap_or(false)
}

/// Something of the app's own broke while moving a run — a claim that failed, a result that could
/// not be recorded. The run stops where the user sees it, with the reason in the channel, instead
/// of a line in a console nobody reads and an item left «running» with no one on it.
pub fn engine_failure(db: &Db, run_id: &str, item_id: &str, note: &str) {
    let _ = with(db, |c| {
        let Some(run) = team::get_run(c, run_id).map_err(e2s)? else { return Ok(()) };
        if !matches!(run.status.as_str(), "running" | "gated" | "paused") {
            return Ok(());
        }
        if let Some(mut item) = team::get_item(c, item_id).map_err(e2s)?.filter(|item| item.status == "running") {
            item.status = "error".into();
            item.last_error = note.to_string();
            item.finished_at = queries::now();
            team::update_item(c, &item).map_err(e2s)?;
        }
        team::post(c, run_id, item_id, ("system", "CodeFlow"), ("user", "Tú"), "error", &format!("CodeFlow tuvo un problema interno: {note}"), &[]).map_err(e2s)?;
        team::set_run_status(c, run_id, "gated", &format!("stuck:{item_id}"), &format!("CodeFlow tuvo un problema interno y la corrida se detuvo: {note}")).map_err(e2s)
    });
}

/// The app could not prepare an item's ground (its worktree). That is not the member's failure:
/// the attempt and the dispatch go back, and the item tries again after a short wait — a few
/// times, then it stops for the user with the reason, rather than being left pending with nothing
/// to wake it.
pub(crate) fn infra_failure(conn: &Connection, run: &Run, item: &mut Item, reason: &str) -> Result<(), String> {
    item.attempts = (item.attempts - 1).max(0);
    item.intelligence.infra_failures += 1;
    item.last_error = reason.to_string();
    conn.execute("UPDATE agent_team_runs SET dispatches = MAX(0, dispatches - 1) WHERE id = ?1", [&run.id]).map_err(e2s)?;
    if item.intelligence.infra_failures >= intelligence::MAX_INFRA_FAILURES {
        item.status = "error".into();
        item.finished_at = queries::now();
        team::update_item(conn, item).map_err(e2s)?;
        team::post(conn, &run.id, &item.id, ("system", "CodeFlow"), ("user", "Tú"), "error",
            &format!("«{}» no pudo empezar: {reason}. No se gastó ningún intento del agente.", item.title), &[]).map_err(e2s)?;
        return team::set_run_status(conn, &run.id, "gated", &format!("stuck:{}", item.id),
            &format!("CodeFlow no pudo preparar la carpeta de «{}»: {}", item.title, first_line(reason, 300))).map_err(e2s);
    }
    let wait = 10 * item.intelligence.infra_failures;
    item.status = "waiting".into();
    item.intelligence.recovery = Some(intelligence::Recovery {
        kind: crate::ai::AiFailureKind::Other,
        provider: intelligence::INFRA_PROVIDER.into(),
        model: String::new(),
        resume_at: Some(chrono::Utc::now().timestamp() + wait),
        account_key: String::new(),
        shared_quota: false,
    });
    team::update_item(conn, item).map_err(e2s)?;
    team::post(conn, &run.id, &item.id, ("system", "CodeFlow"), ("all", "Equipo"), "status",
        &format!("«{}» espera {wait} s: {reason}", item.title), &[]).map(|_| ()).map_err(e2s)
}

/// [`team_settle`] for callers without a `State` — `cf done` from a member's terminal.
pub async fn settle_from_terminal(app: &AppHandle, item_id: &str, text: &str) -> Result<(), String> {
    let db = app.state::<Db>();
    settle_item(app, db.inner(), item_id, "ok", text, "").await.map(|_| ())
}

pub async fn settle_item(app: &AppHandle, db: &Db, item_id: &str, outcome: &str, text: &str, error: &str) -> Result<RunState, String> {
    settle_dispatch(app, db, item_id, None, outcome, text, error).await
}

/// [`settle_item`] for whoever knows which dispatch it ran (`ItemIntelligence::dispatch_id`): an
/// answer from a dispatch that is no longer the item's is dropped. `None` is a caller that settles
/// whatever runs — `cf done` from the member's own terminal.
pub async fn settle_dispatch(app: &AppHandle, db: &Db, item_id: &str, dispatch_id: Option<&str>, outcome: &str, text: &str, error: &str) -> Result<RunState, String> {
    let verifying = |run_id: &str| {
        // The checks may take minutes: the windows hear that the turn is over and what runs now.
        // Not `changed`: nothing became ready, and a kick here would only claim under the lock.
        let _ = app.emit("team:changed", serde_json::json!({ "runId": run_id }));
    };
    let state = settle_inner(db, item_id, dispatch_id, outcome, text, error, Some(&verifying)).await?;
    changed(app, &state.run.id);
    Ok(state)
}

pub async fn settle_core(db: &Db, item_id: &str, outcome: &str, text: &str, error: &str) -> Result<RunState, String> {
    settle_inner(db, item_id, None, outcome, text, error, None).await
}

/// One item's turn is over — `ok`, `error`, `busy` (the conversation or the repository was taken),
/// `cancelled` (the user stopped it) or `unstarted` (it was called off while it waited for a slot).
pub(crate) async fn settle_inner(db: &Db, item_id: &str, dispatch_id: Option<&str>, outcome: &str, text: &str, error: &str, verifying: Option<&(dyn Fn(&str) + Sync)>) -> Result<RunState, String> {
    let item = with(db, |c| team::get_item(c, item_id).map_err(e2s)?.ok_or_else(|| "El ítem ya no existe.".to_string()))?;
    let run_id = item.run_id.clone();
    let lock = run_lock(&run_id);
    let _guard = lock.lock().await;
    let (run, mut item) = with(db, |c| {
        let run = team::get_run(c, &run_id).map_err(e2s)?.ok_or("La corrida ya no existe.")?;
        let item = team::get_item(c, item_id).map_err(e2s)?.ok_or("El ítem ya no existe.")?;
        Ok((run, item))
    })?;
    if item.status != "running" {
        return state_of(db, &run_id);
    }
    // An answer from an attempt that is no longer the one running: the item was stopped and
    // claimed again, and this is the old turn arriving late. It closes nothing.
    if dispatch_id.is_some_and(|id| !id.is_empty() && !item.intelligence.dispatch_id.is_empty() && id != item.intelligence.dispatch_id) {
        return state_of(db, &run_id);
    }
    item.terminal_session.clear();
    // What the turn was told is delivered only if it ended well; otherwise the next attempt hears
    // it again.
    let inbox = std::mem::take(&mut item.intelligence.inbox);
    if outcome == "ok" && !inbox.is_empty() {
        with(db, |c| team::mark_delivered(c, &inbox).map_err(e2s))?;
    }
    if outcome == "ok" && item.kind == "work" {
        item.intelligence.phase = "verifying".into();
        with(db, |c| team::update_item(c, &item).map_err(e2s))?;
        if let Some(tell) = verifying {
            tell(&run_id);
        }
    }
    match outcome {
        "busy" => {
            item.status = "pending".into();
            item.attempts = (item.attempts - 1).max(0);
            with(db, |c| team::update_item(c, &item).map_err(e2s))?;
        }
        "unstarted" => {
            // It never ran: the attempt and the dispatch it was counted as go back, and the item
            // waits where it was — for the run to be resumed, or for the next free slot.
            item.status = "pending".into();
            item.attempts = (item.attempts - 1).max(0);
            with(db, |c| {
                team::update_item(c, &item).map_err(e2s)?;
                c.execute("UPDATE agent_team_runs SET dispatches = MAX(0, dispatches - 1) WHERE id = ?1", [&run_id]).map(|_| ()).map_err(e2s)
            })?;
        }
        "cancelled" => {
            item.status = "pending".into();
            item.attempts = (item.attempts - 1).max(0);
            item.last_error = "team.stopped".into();
            with(db, |c| {
                team::update_item(c, &item).map_err(e2s)?;
                if team::get_run(c, &run_id).map_err(e2s)?.is_some_and(|r| r.status == "running") {
                    team::set_run_status(c, &run_id, "paused", "", "").map_err(e2s)?;
                    team::set_run_reason(c, &run_id, "team.stopped").map_err(e2s)?;
                }
                Ok(())
            })?;
        }
        "ok" => on_ok(db, &run, item, text).await?,
        _ => {
            use crate::ai::AiFailureKind;
            let failure = crate::ai::classify_failure(error);
            let external = matches!(failure.kind, AiFailureKind::Quota | AiFailureKind::AuthRequired | AiFailureKind::CliMissing);
            let transient = matches!(failure.kind, AiFailureKind::CliBusy | AiFailureKind::Overloaded) && item.attempts < run.policy.max_attempts;
            if item.run_in == "headless" && (external || transient) {
                with(db, |c| park_provider_error(c, &run, item, failure))?;
            } else {
                on_failure(db, &run, item, if error.is_empty() { "falló sin decir por qué" } else { error }, "error").await?;
            }
        }
    }
    advance(db, &run_id).await?;
    state_of(db, &run_id)
}

pub(crate) fn park_provider_error(conn: &Connection, run: &Run, mut item: Item, failure: crate::ai::AiFailure) -> Result<(), String> {
    use crate::ai::AiFailureKind;
    let active = intelligence::executor(run, &item).ok_or("El miembro de la tarea ya no existe.")?;
    let route_model = intelligence::model(active, &item).to_string();
    let now = chrono::Utc::now().timestamp();
    let account_key = intelligence::account_key(conn, run, active);
    let (reset, shared_quota) = if failure.kind == AiFailureKind::Quota {
        intelligence::quota_reset(&account_key, &active.provider, &route_model, now)
    } else {
        (None, false)
    };
    let transient = matches!(failure.kind, AiFailureKind::CliBusy | AiFailureKind::Overloaded);
    let resume_at = if transient {
        let delay = if failure.kind == AiFailureKind::CliBusy { 15 } else { 30 };
        Some(now + delay * item.attempts.clamp(1, 6))
    } else {
        intelligence::stated_reset(&failure, now).max(reset).map(|at| at.saturating_add(5))
    };
    let recovery = intelligence::Recovery { kind: failure.kind, provider: active.provider.clone(), model: route_model, resume_at, account_key, shared_quota };
    if failure.kind == AiFailureKind::Quota && item.intelligence.quota_events.len() < 32 {
        item.intelligence.quota_events.push(coordination::Execution {
            provider: active.provider.clone(), model: recovery.model.clone(), effort: active.effort.clone(),
        });
    }
    item.last_error = trim_chars(&failure.message, 2000);
    if !transient {
        item.attempts = (item.attempts - 1).max(0);
    }
    let fallback = if transient { None } else { intelligence::substitute(conn, run, &item, &recovery) };
    let note = if let Some(next) = fallback {
        item.status = "pending".into();
        item.intelligence.substitute = Some(next.member.id.clone());
        item.model.clear();
        item.feedback = format!("Retoma el trabajo existente desde la misma carpeta. El motor anterior se detuvo: {}. Inspecciona el diff y los archivos pendientes antes de editar.", item.last_error);
        format!("«{}» sigue con {} · {} · {}{}.", item.title, next.member.name, next.provider, next.model,
            if next.effort.is_empty() { String::new() } else { format!(" · {}", next.effort) })
    } else {
        item.status = "waiting".into();
        item.intelligence.recovery = Some(recovery);
        let reason = match failure.kind {
            AiFailureKind::Quota => "cuota agotada",
            AiFailureKind::AuthRequired => "sesión por renovar",
            AiFailureKind::Overloaded => "proveedor saturado",
            AiFailureKind::CliBusy => "motor ocupado",
            _ => "motor por instalar",
        };
        format!("«{}» espera a {} ({reason}). {}", item.title, active.provider, item.last_error)
    };
    let tx = conn.unchecked_transaction().map_err(e2s)?;
    team::update_item(&tx, &item).map_err(e2s)?;
    // A provider refusal is not a completed agent turn and should not spend the team's retry budget.
    if !transient {
        tx.execute("UPDATE agent_team_runs SET dispatches = MAX(0, dispatches - 1) WHERE id = ?1", [&run.id]).map_err(e2s)?;
    }
    team::post(&tx, &run.id, &item.id, ("system", "CodeFlow"), ("all", "Equipo"), "status", &note, &[]).map_err(e2s)?;
    tx.commit().map_err(e2s)
}

/// A turn that did not get its job done. Retried while attempts remain (with the reason in front of
/// it), then handed to the member's escalation, then to the lead, then to the user.
pub(crate) async fn on_failure(db: &Db, run: &Run, mut item: Item, reason: &str, kind: &str) -> Result<(), String> {
    let repeated = !item.last_error.is_empty() && first_line(&item.last_error, 200) == first_line(reason, 200);
    let progress = if item.worktree_path.is_empty() {
        Some(String::new())
    } else {
        let cwd = item.worktree_path.clone();
        let base = item.intelligence.base_sha.clone();
        blocking(move || gitops::work_fingerprint(&cwd, &base)).await?.ok()
    };
    let signature = progress.as_deref().map(|progress| coordination::fingerprint(&[kind, &first_line(reason, 400), progress])).unwrap_or_default();
    let stalled = item.attempts >= 2 && !signature.is_empty() && item.intelligence.failure_fingerprint == signature;
    item.intelligence.failure_fingerprint = signature;
    // Before paying for another attempt: is retrying it even the right call? The decision layer
    // answers when it is sure; when it is not, the policy's own order (retry, then escalate) stands.
    let escalate_to = member(run, &item.member_id).map(|m| m.member.escalate_to.clone())
        .filter(|e| !e.is_empty() && item.intelligence.substitute.as_ref() != Some(e));
    let mut options: Vec<String> = vec!["reintentar".into()];
    if escalate_to.is_some() {
        options.push("escalar".into());
    }
    if !run.lead.is_empty() && !item.is_lead() {
        options.push("replanificar".into());
    }
    let verdict = if !stalled && run.policy.decider && item.attempts < run.policy.max_attempts && options.len() > 1 {
        let context = format!(
            "Tarea `{}` de {} ({}): {}\nIntento {} de {}. Tipo de fallo: {kind}.{}\nError:\n{}",
            item.key,
            item.member_name,
            item.kind,
            item.title,
            item.attempts,
            run.policy.max_attempts,
            if repeated { " El error es el mismo que en el intento anterior." } else { "" },
            trim_chars(reason, 1500)
        );
        Some(
            crate::decide::decide(
                db,
                crate::decide::Decision {
                    kind: "retry".into(),
                    question: "¿Qué conviene hacer con esta tarea que falló?".into(),
                    options,
                    context,
                    workspace_id: run.workspace_id.clone(),
                    run_id: run.id.clone(),
                    item_id: item.id.clone(),
                },
            )
            .await,
        )
    } else {
        None
    };
    let sharp_choice = verdict.as_ref().filter(|v| v.sharp).and_then(|v| v.choice.clone());
    with(db, |c| {
        if let (Some(v), Some(choice)) = (verdict.as_ref(), sharp_choice.as_deref()) {
            team::post(c, &run.id, &item.id, ("system", "Decisor"), ("all", "Equipo"), "decision", &format!("«{}» falló: {choice} (p = {:.2}, {})", item.title, v.p, v.source), &[]).map_err(e2s)?;
        }
        if stalled {
            let change = if progress.as_deref() == Some("") { "sin cambios en los archivos" } else { "sin cambios nuevos en los archivos" };
            team::post(c, &run.id, &item.id, ("system", "CodeFlow"), ("all", "Equipo"), "finding",
                &format!("«{}» repitió el fallo {change}. {}. Cambia el enfoque o pide ayuda antes de otro intento.", item.title, first_line(reason, 400)), &[]).map_err(e2s)?;
        }
        let decided_stop = stalled || matches!(sharp_choice.as_deref(), Some("escalar") | Some("replanificar"));
        item.last_error = reason.to_string();
        if item.attempts < run.policy.max_attempts && !decided_stop {
            // The same error twice: the advisor looks before the third try, which waits for it.
            if repeated && item.attempts >= 2 {
                if let Some(advice) = new_advice(c, run, &item.id, &format!("La tarea `{}` falló dos veces con el mismo error. ¿Qué debería cambiar el próximo intento?", item.key))? {
                    if !item.depends_on.contains(&advice.id) {
                        item.depends_on.push(advice.id.clone());
                    }
                }
            }
            // A retry climbs the member's model ladder, cheapest first, one step per failure.
            if let Some(m) = intelligence::executor(run, &item) {
                let ladder = &m.member.model_ladder;
                if !ladder.is_empty() {
                    let step = ((item.attempts - 1).max(0) as usize).min(ladder.len() - 1);
                    item.model = ladder[step].clone();
                }
            }
            item.status = "pending".into();
            item.feedback = format!("El intento anterior no sirvió: {}\nCorrígelo.", trim_chars(reason, 6000));
            team::update_item(c, &item).map_err(e2s)?;
            return Ok(());
        }
        item.status = "error".into();
        item.finished_at = queries::now();
        team::update_item(c, &item).map_err(e2s)?;
        let who = (item.member_id.as_str(), item.member_name.as_str());
        team::post(c, &run.id, &item.id, who, ("all", "Equipo"), "error", &format!("«{}» falló {} veces: {}", item.title, item.attempts, first_line(reason, 400)), &[])
            .map_err(e2s)?;
        // Escalation: the same item, from scratch, for the member the policy names — unless the
        // decision layer said the plan, not the member, is what has to change.
        let escalation = if sharp_choice.as_deref() == Some("replanificar") { None } else { escalate_to.clone() };
        if let Some(next) = escalation.and_then(|e| member(run, &e).cloned()) {
            if !item.key.ends_with("-esc") && (next.member.edits || !item.writes()) {
                let items = team::list_items(c, &run.id).map_err(e2s)?;
                let mut again = team::new_item(run, &team::free_key(&items, &format!("{}-esc", item.key)), Some(&next), &item.project_id, &item.kind, &item.title, &item.instruction);
                again.depends_on = item.depends_on.clone();
                again.ref_item = item.ref_item.clone();
                again.intelligence.criteria.clone_from(&item.intelligence.criteria);
                again.intelligence.paths.clone_from(&item.intelligence.paths);
                again.intelligence.contract_specs.clone_from(&item.intelligence.contract_specs);
                again.intelligence.requires_contracts.clone_from(&item.intelligence.requires_contracts);
                again.feedback = format!("{} no pudo con esto ({}). Te toca a ti.", item.member_name, first_line(reason, 400));
                team::insert_item(c, &again).map_err(e2s)?;
                // Whatever waited on the failed item waits on its replacement.
                for mut dependent in items.into_iter().filter(|i| i.depends_on.contains(&item.id)) {
                    dependent.depends_on = dependent.depends_on.iter().map(|d| if d == &item.id { again.id.clone() } else { d.clone() }).collect();
                    team::update_item(c, &dependent).map_err(e2s)?;
                }
                team::post(c, &run.id, &again.id, ("system", "CodeFlow"), (&next.member.id, &next.member.name), "decision", &format!("«{}» pasa a {}", item.title, next.member.name), &[])
                    .map_err(e2s)?;
                return Ok(());
            }
        }
        if !item.is_lead() && !run.lead.is_empty() {
            let instruction = format!(
                "La tarea `{}` ({}, {}) falló {} veces ({kind}): {}\nDecide: reasígnala, divídela, cancela lo que dependía de ella o termina.",
                item.key, item.member_name, item.title, item.attempts, trim_chars(reason, 3000)
            );
            if new_lead_round(c, run, "plan", &instruction)?.is_some() {
                return Ok(());
            }
            return Ok(());
        }
        let gate = if item.kind == "amend" { "amend_failed" } else { "stuck" };
        team::set_run_status(c, &run.id, "gated", &format!("{gate}:{}", item.id), &format!("«{}» falló: {}", item.title, first_line(reason, 300))).map_err(e2s)
    })
}
