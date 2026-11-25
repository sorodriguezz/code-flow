use super::*;

// ---------------------------------------------------------------- advance & finish

/// After any change: if nothing is moving any more, decide what happens next — a blocked graph goes
/// back to the lead (or to the user), and a finished one is checked and landed.
pub(crate) async fn advance(db: &Db, run_id: &str) -> Result<(), String> {
    let (run, items, repos) = with(db, |c| {
        let run = team::get_run(c, run_id).map_err(e2s)?.ok_or("La corrida ya no existe.")?;
        Ok((run, team::list_items(c, run_id).map_err(e2s)?, team::list_repos(c, run_id).map_err(e2s)?))
    })?;
    if run.status != "running" {
        return Ok(());
    }
    if !items.iter().any(|item| item.status == "running") {
        if let Some((item, impact)) = items.iter().filter(|item| item.status == "gated")
            .find_map(|item| item.intelligence.impact.as_ref().map(|impact| (item, impact)))
        {
            let note = if impact.is_tests() {
                format!("«{}» pasa sus verificaciones, pero debilita las pruebas. Apruébalo si la tarea lo pedía; recházalo si no.", item.title)
            } else {
                "Revisa los cambios de impacto antes de integrarlos.".to_string()
            };
            return with(db, |c| team::set_run_status(c, run_id, "gated", &format!("impact:{}:{}", item.id, impact.version), &note).map_err(e2s));
        }
        // Checks that could not run isolated: the user brings the engine back, or lets them run
        // on this computer.
        if let Some(item) = items.iter().find(|item| item.status == "gated" && !item.intelligence.sandbox_hold.is_empty()) {
            let note = format!("Las verificaciones de «{}» deben correr aisladas y no pudieron: {}", item.title, item.intelligence.sandbox_hold);
            return with(db, |c| team::set_run_status(c, run_id, "gated", &format!("sandbox:{}", item.id), &note).map_err(e2s));
        }
    }
    // A sub-lead's branch whose work has all closed hands its summary up, and stops being open.
    let closed_branches = with(db, |c| {
        let mut closed = 0;
        for mut d in items.iter().filter(|i| i.status == "delegated").cloned() {
            let children: Vec<&Item> = items.iter().filter(|i| i.parent == d.id).collect();
            if children.iter().all(|i| matches!(i.status.as_str(), "done" | "skipped" | "cancelled" | "error")) {
                let lines: Vec<String> = children
                    .iter()
                    .map(|i| format!("- `{}` {} · {}: {}", i.key, i.member_name, i.status, first_line(&protocol::prose(&i.output_text), 200)))
                    .collect();
                // A branch is not done because its tasks stopped: it is done when they got done.
                let good = children.iter().filter(|i| matches!(i.status.as_str(), "done" | "skipped")).count();
                let failed = children.iter().filter(|i| i.status == "error").count();
                let outcome = if good == children.len() {
                    "completed"
                } else if good > 0 {
                    "partial"
                } else if failed > 0 {
                    "failed"
                } else {
                    "cancelled"
                };
                let verdict = match outcome {
                    "completed" => String::new(),
                    "partial" => format!("**La rama cerró incompleta:** {} de {} tareas no terminaron.\n\n", children.len() - good, children.len()),
                    "failed" => "**La rama falló:** ninguna de sus tareas terminó.\n\n".to_string(),
                    _ => "**La rama se canceló** antes de entregar nada.\n\n".to_string(),
                };
                d.output_text = format!("{verdict}{}\n\nLo que hizo la rama de {}:\n{}", protocol::prose(&d.output_text), d.member_name, lines.join("\n"));
                d.intelligence.outcome = outcome.into();
                d.finished_at = queries::now();
                match outcome {
                    "completed" | "partial" => {
                        d.status = "done".into();
                        team::update_item(c, &d).map_err(e2s)?;
                        handoff(c, &run, &d)?;
                        if outcome == "partial" {
                            team::post(c, &run.id, &d.id, ("system", "CodeFlow"), ("all", "Equipo"), "finding",
                                &format!("La rama de {} cerró incompleta: {} de {} tareas no terminaron. Lo que depende de ella sigue con lo que hay.", d.member_name, children.len() - good, children.len()), &[]).map_err(e2s)?;
                        }
                    }
                    // Nothing to hand up: whatever waited on the branch waits on a failure, and the
                    // run says so instead of going on as if the area had been delivered.
                    _ => {
                        d.status = if outcome == "failed" { "error" } else { "cancelled" }.into();
                        d.last_error = if outcome == "failed" { "Ninguna tarea de la rama terminó." } else { "La rama se canceló." }.into();
                        team::update_item(c, &d).map_err(e2s)?;
                        team::post(c, &run.id, &d.id, ("system", "CodeFlow"), ("all", "Equipo"), "error",
                            &format!("La rama de {} no entregó nada: {}", d.member_name, d.last_error), &[]).map_err(e2s)?;
                    }
                }
                closed += 1;
            }
        }
        Ok(closed)
    })?;
    let items = if closed_branches > 0 { with(db, |c| team::list_items(c, run_id).map_err(e2s))? } else { items };
    let moving = items.iter().filter(|i| matches!(i.status.as_str(), "running" | "waiting" | "gated" | "delegated")).count();
    if moving > 0 {
        return Ok(());
    }
    let pending: Vec<&Item> = items.iter().filter(|i| i.status == "pending").collect();
    if !pending.is_empty() {
        if !team::ready_items(&run, &items).is_empty() {
            return Ok(());
        }
        // Blocked on a dependency that is in no plan: nothing the team does will ever satisfy it.
        if let Some((item, missing)) = pending.iter().find_map(|i| Some((i, team::dangling_deps(i, &items))).filter(|(_, missing)| !missing.is_empty())) {
            let note = format!("«{}» depende de {}, que no existe en el plan. Aprueba para que siga sin esa dependencia, o rechaza para omitir la tarea.",
                item.title, missing.iter().map(|m| format!("«{m}»")).collect::<Vec<_>>().join(", "));
            return with(db, |c| team::set_run_status(c, run_id, "gated", &format!("deps:{}", item.id), &note).map_err(e2s));
        }
        // Blocked: everything left waits on something that failed or was skipped.
        let blocked = pending.iter().map(|i| format!("`{}` {}", i.key, i.title)).collect::<Vec<_>>().join(", ");
        return with(db, |c| {
            if !run.lead.is_empty() {
                let instruction = format!("El trabajo está bloqueado: estas tareas esperan a otras que fallaron o se cancelaron: {blocked}. Reasigna, cancela o termina.");
                if new_lead_round(c, &run, "plan", &instruction)?.is_some() {
                    return Ok(());
                }
                return Ok(());
            }
            team::set_run_status(c, run_id, "gated", "stuck:", &format!("Hay tareas bloqueadas: {blocked}.")).map_err(e2s)
        });
    }
    let unmerged: Vec<Item> = team::unmerged_work(&items).into_iter().cloned().collect();
    if !unmerged.is_empty() {
        for work in unmerged {
            integrate(db, &run, work).await?;
        }
        return Box::pin(advance(db, run_id)).await;
    }
    // The lead's last look.
    if !run.lead.is_empty() && !run.lead_done && run.policy.lead_final_check {
        let made = with(db, |c| {
            let made = new_lead_round(c, &run, "final", "Todo lo asignado está hecho. Revisa las entregas: si falta algo, asígnalo; si está completo, responde `\"terminar\": true`.")?;
            if let Some(mut final_item) = made.clone() {
                if let Some(advice) = new_advice(c, &run, "final", "El equipo cree que terminó. ¿Hay algo que se le escapó antes de integrar?")? {
                    final_item.depends_on.push(advice.id.clone());
                    team::update_item(c, &final_item).map_err(e2s)?;
                }
            }
            Ok(made)
        })?;
        if made.is_some() {
            return Ok(());
        }
        return Ok(());
    }
    // Final checks, in each integration tree.
    for repo in repos.iter().filter(|r| r.status == "ready") {
        for check in run.policy.checks.iter().filter(|c| c.when == "final" && (c.repo == "*" || c.repo == repo.project_id)) {
            let base = items.iter().find(|item| item.project_id == repo.project_id && !item.intelligence.base_sha.is_empty())
                .map(|item| item.intelligence.base_sha.as_str()).unwrap_or_default();
            let at = CheckAt { run: &run, project_id: &repo.project_id, slot: "integration" };
            let evidence = match verify_check(db, &at, &check.command, &repo.integration_path, Some(repo), base).await {
                Ok(evidence) => evidence,
                Err(reason) => {
                    let note = format!("La verificación final `{}` en {} debe correr aislada y no pudo: {reason}", check.command, repo.name);
                    return with(db, |c| team::set_run_status(c, run_id, "gated", "sandbox:", &note).map_err(e2s));
                }
            };
            let passed = check_passes(&run.policy, &evidence.result);
            let description = check_description(&evidence.result);
            with(db, |c| {
                team::post(c, run_id, "", ("system", "CodeFlow"), ("all", "Equipo"), if passed { "status" } else { "error" }, &format!("{} · `{}` {description}", repo.name, check.command), &[])
                    .map(|_| ())
                    .map_err(e2s)
            })?;
            if !passed {
                return with(db, |c| {
                    if !run.lead.is_empty() {
                        team::set_lead_done(c, run_id, false).map_err(e2s)?;
                        let instruction = format!("En {} la verificación `{}` {description} con todo integrado:\n{}\nDecide cómo tratar el fallo.", repo.name, check.command, evidence.detail);
                        if new_lead_round(c, &run, "plan", &instruction)?.is_some() {
                            return Ok(());
                        }
                        return Ok(());
                    }
                    team::set_run_status(c, run_id, "gated", "stuck:", &format!("`{}` en {} {description}:\n{}", check.command, repo.name, trim_chars(&evidence.detail, 2000))).map_err(e2s)
                });
            }
        }
    }
    if run.policy.integrate == "branch" {
        return with(db, |c| {
            for r in &repos {
                team::set_repo_status(c, run_id, &r.project_id, "left", "").map_err(e2s)?;
            }
            let names = repos.iter().map(|r| format!("{} → `{}`", r.name, r.integration_branch)).collect::<Vec<_>>().join(", ");
            team::post(c, run_id, "", ("system", "CodeFlow"), ("user", "Tú"), "merge", &format!("Trabajo listo en: {names}"), &[]).map_err(e2s)?;
            team::set_run_status(c, run_id, "done", "", "").map_err(e2s)
        });
    }
    if run.policy.approve_merge {
        let names = repos.iter().map(|r| format!("{} → {}", r.name, r.target_branch)).collect::<Vec<_>>().join(", ");
        let produced = items.iter().any(|i| i.kind == "work" && i.status == "done" && !i.commit_sha.is_empty());
        let question = if !produced {
            format!("El equipo terminó sin cambios en el código de {names}. Revisa el canal antes de cerrar.")
        } else if run.policy.integrate == "pr" { format!("Todo está hecho. ¿Abrir un PR en {names}?") } else { format!("Todo está hecho. ¿Integrar en {names}?") };
        return with(db, |c| team::set_run_status(c, run_id, "gated", "merge", &question).map_err(e2s));
    }
    deliver(db, &run).await
}
