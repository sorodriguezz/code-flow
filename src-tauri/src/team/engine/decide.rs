use super::*;

pub async fn answer_question(db: &Db, message_id: &str, answer: &str) -> Result<RunState, String> {
    let message_id = message_id.to_string();
    let answer = answer.to_string();
    let message = with(db, |c| team::get_message(c, &message_id).map_err(e2s)?.ok_or_else(|| "La pregunta ya no existe.".to_string()))?;
    let lock = run_lock(&message.run_id);
    let _guard = lock.lock().await;
    with(db, |c| {
        team::answer_message(c, &message_id, answer.trim()).map_err(e2s)?;
        let messages = team::list_messages(c, &message.run_id).map_err(e2s)?;
        let asked: Vec<&team::Message> = messages.iter().filter(|m| m.item_id == message.item_id && m.kind == "question" && m.to_id == "user").collect();
        if asked.iter().all(|m| !m.answer.is_empty() || m.id == message_id) {
            if let Some(mut item) = team::get_item(c, &message.item_id).map_err(e2s)? {
                if item.status == "waiting" {
                    let answers = asked
                        .iter()
                        .map(|m| format!("- {} → {}", m.body, if m.id == message_id { answer.trim().to_string() } else { m.answer.clone() }))
                        .collect::<Vec<_>>()
                        .join("\n");
                    item.status = "pending".into();
                    item.attempts = (item.attempts - 1).max(0);
                    item.feedback = format!("El usuario respondió:\n{answers}");
                    team::update_item(c, &item).map_err(e2s)?;
                }
            }
        }
        Ok(())
    })?;
    advance(db, &message.run_id).await?;
    state_of(db, &message.run_id)
}

pub(crate) async fn request_amendment(db: &Db, run_id: &str, body: &str) -> Result<(), String> {
    let body = trim_chars(body.trim(), 6000);
    if body.is_empty() {
        return Err("Describe qué quieres cambiar del encargo.".into());
    }
    let lock = run_lock(run_id);
    let _guard = lock.lock().await;
    with(db, |c| {
        let run = team::get_run(c, run_id).map_err(e2s)?.ok_or("La corrida ya no existe.")?;
        let lead = member(&run, &run.lead).ok_or("Una corrida con plan fijo necesita un líder para replantear el trabajo.")?;
        if run.status != "running" && !(run.status == "gated" && run.gate == "merge") {
            return Err("El ajuste está disponible durante el trabajo o antes de integrar.".into());
        }
        let items = team::list_items(c, run_id).map_err(e2s)?;
        if items.iter().any(|item| item.kind == "amend" && matches!(item.status.as_str(), "pending" | "running" | "waiting" | "gated")) {
            return Err("Ya hay un ajuste del plan en curso.".into());
        }
        if !items.iter().any(|item| item.kind == "plan" && item.status == "done") {
            return Err("Espera a que el líder termine el primer plan.".into());
        }
        let repo = team::list_repos(c, run_id).map_err(e2s)?.into_iter().next().ok_or("La corrida ya no tiene repositorios.")?;
        let tx = c.unchecked_transaction().map_err(e2s)?;
        let mut item = team::new_item(&run, &team::free_key(&items, "ajuste"), Some(lead), &repo.project_id, "amend", "Ajustar el plan", &body);
        item.run_in = "headless".into();
        team::insert_item(&tx, &item).map_err(e2s)?;
        team::post(&tx, run_id, &item.id, ("user", "Tú"), ("lead", &lead.member.name), "plan", &body, &[]).map_err(e2s)?;
        team::set_run_status(&tx, run_id, "running", "", "").map_err(e2s)?;
        tx.commit().map_err(e2s)
    })
}

pub(crate) fn settle_amendment(conn: &Connection, run: &Run, id: &str, approve: bool, comment: &str) -> Result<(), String> {
    let mut item = team::get_item(conn, id).map_err(e2s)?
        .filter(|item| item.run_id == run.id && item.kind == "amend").ok_or("El ajuste ya no existe.")?;
    let tx = conn.unchecked_transaction().map_err(e2s)?;
    if approve {
        if let Some(amendment) = item.intelligence.amendment.as_ref() {
            let current = team::list_items(&tx, &run.id).map_err(e2s)?;
            let mut projected = current.clone();
            let mut fresh = planned_items(run, &current, &item, &amendment.items);
            coordination::amendment_changes(&mut projected, &amendment.items, &mut fresh, &amendment.cancel)?;
            for (_, updated) in current.iter().zip(&projected).filter(|(old, updated)| old.status != updated.status || old.depends_on != updated.depends_on) {
                team::update_item(&tx, updated).map_err(e2s)?;
            }
            for new in fresh {
                team::insert_item(&tx, &new).map_err(e2s)?;
            }
            let goal = format!("{}\n\n## Ajuste aprobado\n{}", run.goal, item.instruction);
            tx.execute("UPDATE agent_team_runs SET goal = ?2, lead_done = 0 WHERE id = ?1", rusqlite::params![run.id, goal]).map_err(e2s)?;
            item.status = "done".into();
            item.finished_at = queries::now();
            team::post(&tx, &run.id, &item.id, ("system", "CodeFlow"), ("all", "Equipo"), "decision", "Se aplicó el ajuste a esta corrida.", &[]).map_err(e2s)?;
        } else {
            item.status = "pending".into();
            item.attempts = 0;
            item.intelligence.failure_fingerprint.clear();
            if !comment.is_empty() {
                item.feedback = comment.to_string();
            }
        }
    } else {
        item.status = "skipped".into();
        team::post(&tx, &run.id, &item.id, ("system", "CodeFlow"), ("all", "Equipo"), "status", "Se descartó el ajuste y sigue el plan anterior.", &[]).map_err(e2s)?;
    }
    team::update_item(&tx, &item).map_err(e2s)?;
    team::set_run_status(&tx, &run.id, "running", "", "").map_err(e2s)?;
    tx.commit().map_err(e2s)
}

pub async fn decide(db: &Db, run_id: &str, approve: bool, comment: &str) -> Result<RunState, String> {
    decide_for_gate(db, run_id, approve, comment, None).await
}

pub(crate) async fn decide_for_gate(db: &Db, run_id: &str, approve: bool, comment: &str, expected_gate: Option<&str>) -> Result<RunState, String> {
    let run_id = run_id.to_string();
    let lock = run_lock(&run_id);
    let _guard = lock.lock().await;
    let comment = comment.trim().to_string();
    let run = with(db, |c| team::get_run(c, &run_id).map_err(e2s)?.ok_or_else(|| "La corrida ya no existe.".to_string()))?;
    if run.status != "gated" {
        return state_of(db, &run_id);
    }
    if expected_gate.is_some_and(|gate| gate != run.gate) {
        return Err("La decisión pendiente cambió. Revisa la corrida antes de responder.".into());
    }
    if expected_gate.is_none() && (run.gate.starts_with("amend:") || run.gate.starts_with("amend_failed:") || run.gate.starts_with("impact:")) {
        return Err("Abre la corrida para revisar el ajuste o el diff antes de decidir.".into());
    }
    if !comment.is_empty() {
        with(db, |c| team::post(c, &run_id, "", ("user", "Tú"), ("all", "Equipo"), "note", &comment, &[]).map(|_| ()).map_err(e2s))?;
    }
    let gate = run.gate.clone();
    if let Some(id) = gate.strip_prefix("amend:").or_else(|| gate.strip_prefix("amend_failed:")) {
        with(db, |c| settle_amendment(c, &run, id, approve, &comment))?;
        advance(db, &run_id).await?;
        return state_of(db, &run_id);
    }
    if let Some((id, version)) = gate.strip_prefix("impact:").and_then(|gate| gate.split_once(':')) {
        let item = with(db, |c| {
            let mut item = team::get_item(c, id).map_err(e2s)?
                .filter(|item| item.run_id == run_id && item.status == "gated").ok_or("La revisión de impacto ya no está pendiente.")?;
            let impact = item.intelligence.impact.take().filter(|impact| impact.version == version)
                .ok_or("La revisión de impacto cambió.")?;
            let tx = c.unchecked_transaction().map_err(e2s)?;
            let tests = impact.is_tests();
            if approve {
                item.status = "running".into();
                if tests {
                    item.intelligence.approved_tests = impact.version.clone();
                } else {
                    item.intelligence.approved_impact = impact.version.clone();
                }
            } else {
                item.status = "error".into();
                item.last_error = if tests { "El usuario rechazó el cambio: debilitaba las pruebas." } else { "El usuario rechazó el cambio de impacto." }.into();
                item.finished_at = queries::now();
            }
            team::update_item(&tx, &item).map_err(e2s)?;
            let decision = if approve { "aprobó" } else { "rechazó" };
            let what = if tests { "los cambios en las pruebas" } else { "los cambios de impacto" };
            team::post(&tx, &run_id, &item.id, ("user", "Tú"), ("all", "Equipo"), "decision",
                &format!("{decision} {what} de «{}» · {}", item.title, impact.files.join(", ")), &[]).map_err(e2s)?;
            team::set_run_status(&tx, &run_id, "running", "", "").map_err(e2s)?;
            tx.commit().map_err(e2s)?;
            Ok(item)
        })?;
        if approve {
            let output = item.output_text.clone();
            on_ok(db, &run, item, &output).await?;
        }
        advance(db, &run_id).await?;
        return state_of(db, &run_id);
    }
    if let Some(id) = gate.strip_prefix("sandbox:") {
        if approve {
            // The user may have just started the engine: ask it, not what it said a moment ago.
            team::sandbox::status(true).await;
        }
        // Approve is the safe answer — try again, isolated, now that the engine may be back.
        // Reject is the user letting this run's checks go on this computer, on the record.
        let (run, held) = with(db, |c| {
            let tx = c.unchecked_transaction().map_err(e2s)?;
            let mut run = run.clone();
            if !approve {
                run.policy.sandbox = "off".into();
                set_run_policy(&tx, &run_id, &run.policy)?;
                team::post(&tx, &run_id, id, ("user", "Tú"), ("all", "Equipo"), "decision",
                    "decidió que las verificaciones de esta corrida corran en este equipo, sin aislamiento", &[]).map_err(e2s)?;
            }
            let held = match team::get_item(&tx, id).map_err(e2s)?.filter(|item| !id.is_empty() && item.run_id == run_id && item.status == "gated") {
                Some(mut item) => {
                    item.status = "running".into();
                    item.intelligence.sandbox_hold.clear();
                    item.intelligence.phase = "verifying".into();
                    team::update_item(&tx, &item).map_err(e2s)?;
                    Some(item)
                }
                None => None,
            };
            team::set_run_status(&tx, &run_id, "running", "", "").map_err(e2s)?;
            tx.commit().map_err(e2s)?;
            Ok((run, held))
        })?;
        if let Some(item) = held {
            let output = item.output_text.clone();
            on_ok(db, &run, item, &output).await?;
        }
        advance(db, &run_id).await?;
        return state_of(db, &run_id);
    }
    let mut land = false;
    with(db, |c| {
        if gate == "plan" {
            if approve {
                return team::set_run_status(c, &run_id, "running", "", "").map_err(e2s);
            }
            let items = team::list_items(c, &run_id).map_err(e2s)?;
            for mut i in items.into_iter().filter(|i| i.status == "pending" && !i.is_lead()) {
                i.status = "skipped".into();
                team::update_item(c, &i).map_err(e2s)?;
            }
            team::set_run_status(c, &run_id, "running", "", "").map_err(e2s)?;
            let instruction = format!("El usuario rechazó el plan{}. Propón otro.", if comment.is_empty() { String::new() } else { format!(": «{comment}»") });
            new_lead_item(c, &run, "plan", &instruction, "")?;
            return Ok(());
        }
        if let Some(id) = gate.strip_prefix("item:") {
            if let Some(mut item) = team::get_item(c, id).map_err(e2s)? {
                if approve {
                    item.status = "pending".into();
                    item.approved = true;
                } else {
                    item.status = "skipped".into();
                }
                team::update_item(c, &item).map_err(e2s)?;
            }
            return team::set_run_status(c, &run_id, "running", "", "").map_err(e2s);
        }
        if gate == "merge" {
            if approve {
                land = true;
                return team::set_run_status(c, &run_id, "running", "", "").map_err(e2s);
            }
            let repos = team::list_repos(c, &run_id).map_err(e2s)?;
            for r in repos.iter().filter(|r| r.status == "ready" || r.status == "failed") {
                team::set_repo_status(c, &run_id, &r.project_id, "left", "").map_err(e2s)?;
            }
            team::post(c, &run_id, "", ("system", "CodeFlow"), ("user", "Tú"), "merge", "No se integró: el trabajo queda en las ramas del equipo.", &[]).map_err(e2s)?;
            return team::set_run_status(c, &run_id, "done", "", "").map_err(e2s);
        }
        if let Some(id) = gate.strip_prefix("review:") {
            if approve {
                // Integrate anyway: the advance below merges every unmerged done work item.
                team::set_run_status(c, &run_id, "running", "", "").map_err(e2s)?;
            } else {
                if let Some(mut item) = team::get_item(c, id).map_err(e2s)? {
                    item.status = "skipped".into();
                    team::update_item(c, &item).map_err(e2s)?;
                }
                team::set_run_status(c, &run_id, "running", "", "").map_err(e2s)?;
            }
            return Ok(());
        }
        if let Some(id) = gate.strip_prefix("deps:") {
            if let Some(mut item) = team::get_item(c, id).map_err(e2s)?.filter(|item| item.status == "pending") {
                if approve {
                    clear_dangling(&mut item, c, &run_id)?;
                } else {
                    item.status = "skipped".into();
                }
                team::update_item(c, &item).map_err(e2s)?;
                let what = if approve { "sigue sin la dependencia que no existe" } else { "se omite: dependía de una tarea que no existe" };
                team::post(c, &run_id, &item.id, ("user", "Tú"), ("all", "Equipo"), "decision", &format!("«{}» {what}", item.title), &[]).map_err(e2s)?;
            }
            return team::set_run_status(c, &run_id, "running", "", "").map_err(e2s);
        }
        if gate == "budget" {
            if !approve {
                return team::set_run_status(c, &run_id, "failed", "", "").map_err(e2s);
            }
            // Approving is «give it more»: every budget it ran out of grows by half.
            let mut policy = run.policy.clone();
            let spend = team::metrics::spend(c, &run_id).map_err(e2s)?;
            let (usd, tokens) = spend.values().fold((0.0, 0i64), |(u, t), (du, dt)| (u + du, t + dt));
            let minutes = team::metrics::agent_minutes(&team::list_items(c, &run_id).map_err(e2s)?, chrono::Utc::now());
            // Out of it, or with too little left for one more turn (`metrics::Reserve`).
            let reserve = team::metrics::Reserve::of(&spend);
            if policy.budget_usd > 0.0 && usd + reserve.usd >= policy.budget_usd {
                policy.budget_usd = (policy.budget_usd * 1.5 * 100.0).round() / 100.0;
            }
            if policy.budget_tokens > 0 && tokens as f64 + reserve.tokens >= policy.budget_tokens as f64 {
                policy.budget_tokens = policy.budget_tokens * 3 / 2;
            }
            if policy.budget_minutes > 0 && minutes >= policy.budget_minutes as f64 {
                policy.budget_minutes = policy.budget_minutes * 3 / 2;
            }
            // Before saving: doubled after `set_run_policy`, the new allowance was never stored and
            // the run hit the same unmetered gate again on its next claim.
            if policy.unmetered_minutes > 0 && unmetered_over(&run, &team::list_items(c, &run_id).map_err(e2s)?).is_some() {
                policy.unmetered_minutes *= 2;
            }
            set_run_policy(c, &run_id, &policy)?;
            // Past the plan cap: start counting again from here, another cap's worth.
            c.execute("DELETE FROM app_settings WHERE key = ?1", rusqlite::params![session_base_key(&run_id)]).map_err(e2s)?;
            return team::set_run_status(c, &run_id, "running", "", "").map_err(e2s);
        }
        if let Some(id) = gate.strip_prefix("stuck:") {
            if !approve {
                return team::set_run_status(c, &run_id, "failed", "", "").map_err(e2s);
            }
            if let Some(mut item) = team::get_item(c, id).map_err(e2s)? {
                if matches!(item.status.as_str(), "error" | "done") {
                    if item.status == "error" {
                        item.status = "pending".into();
                        item.attempts = 0;
                        if !comment.is_empty() {
                            item.feedback = format!("El usuario dice: {comment}");
                        }
                        team::update_item(c, &item).map_err(e2s)?;
                    }
                }
            }
            // More budget when that is what stopped it — a quarter more, never a fresh full allowance:
            // resetting to zero handed a looping team its whole budget again on every «seguir».
            let more = (run.policy.max_dispatches / 4).max(4);
            c.execute(
                "UPDATE agent_team_runs SET dispatches = MAX(0, dispatches - ?2), lead_rounds_used = MAX(0, lead_rounds_used - 1) WHERE id = ?1 AND (gate_note LIKE '%presupuesto%' OR gate_note LIKE '%rondas%')",
                rusqlite::params![run_id, more],
            )
            .map_err(e2s)?;
            return team::set_run_status(c, &run_id, "running", "", "").map_err(e2s);
        }
        team::set_run_status(c, &run_id, "running", "", "").map_err(e2s)
    })?;
    if land {
        let run = with(db, |c| team::get_run(c, &run_id).map_err(e2s)?.ok_or_else(|| "La corrida ya no existe.".to_string()))?;
        deliver(db, &run).await?;
    } else {
        advance(db, &run_id).await?;
    }
    state_of(db, &run_id)
}
