use super::*;

pub(crate) fn planned_items(run: &Run, existing: &[Item], planner: &Item, plans: &[protocol::PlannedItem]) -> Vec<Item> {
    let mut key_to_id: HashMap<_, _> = existing.iter().map(|item| (item.key.clone(), item.id.clone())).collect();
    let mut fresh = Vec::with_capacity(plans.len());
    for plan in plans {
        let member = member(run, &plan.member_id);
        let kind = if delegates(run, &plan.member_id, &planner.member_id) { "delegate" } else { &plan.kind };
        let mut item = team::new_item(run, &plan.key, member, &plan.project_id, kind, &plan.title, &plan.instruction);
        item.intelligence.criteria.clone_from(&plan.criteria);
        item.intelligence.paths.clone_from(&plan.paths);
        item.intelligence.contract_specs.clone_from(&plan.publishes);
        item.intelligence.requires_contracts.clone_from(&plan.requires);
        item.round = planner.round;
        if kind == "delegate" {
            item.run_in = "headless".into();
        }
        if planner.member_id != run.lead && !run.lead.is_empty() {
            item.parent = planner.id.clone();
        }
        key_to_id.insert(plan.key.clone(), item.id.clone());
        fresh.push(item);
    }
    for (item, plan) in fresh.iter_mut().zip(plans) {
        item.depends_on = plan.depends_on.iter().filter_map(|key| key_to_id.get(key).cloned()).collect();
        item.intelligence.missing_deps.clone_from(&plan.missing_deps);
    }
    fresh
}

/// A lead's turn: its plan, its questions, its decisions.
pub(crate) fn on_lead(db: &Db, run: &Run, mut item: Item, text: &str) -> Result<(), String> {
    with(db, |c| {
        let items = team::list_items(c, &run.id).map_err(e2s)?;
        let repos = team::list_repos(c, &run.id).map_err(e2s)?;
        let planner = item.member_id.clone();
        let sub_lead = !run.lead.is_empty() && planner != run.lead;
        let roster: Vec<protocol::RosterEntry> = planner_roster(run, &planner);
        let repo_entries: Vec<protocol::RepoEntry> = repos.iter().map(|r| protocol::RepoEntry { project_id: r.project_id.clone(), name: r.name.clone() }).collect();
        let keys: Vec<String> = items.iter().map(|i| i.key.clone()).collect();
        let reply = protocol::lead_reply(text, &roster, &repo_entries, &keys);
        let lead = if sub_lead { (planner.clone(), item.member_name.clone()) } else { (run.lead.clone(), lead_name(run)) };
        let from = (lead.0.as_str(), lead.1.as_str());

        // An answer to a member's question: the lead's text is the answer.
        if item.kind == "answer" {
            if let Some(asked) = team::get_message(c, &item.ref_item).map_err(e2s)? {
                let answer = if reply.message.is_empty() { protocol::prose(text) } else { reply.message.clone() };
                team::answer_message(c, &asked.id, &answer).map_err(e2s)?;
                if let Some(mut waiting) = team::get_item(c, &asked.item_id).map_err(e2s)? {
                    if waiting.status == "waiting" {
                        waiting.status = "pending".into();
                        waiting.attempts = (waiting.attempts - 1).max(0);
                        waiting.feedback = format!("Le preguntaste a {}: {}\nTe responde: {answer}", item.member_name, asked.body);
                        team::update_item(c, &waiting).map_err(e2s)?;
                    }
                }
            }
        } else if !reply.message.is_empty() {
            let kind = if item.kind == "amend" { "plan" } else { "decision" };
            team::post(c, &run.id, &item.id, from, ("all", "Equipo"), kind, &reply.message, &[]).map_err(e2s)?;
        }
        if !reply.rejected.is_empty() {
            team::post(c, &run.id, &item.id, ("system", "CodeFlow"), ("lead", &lead.1), "error", &format!("se descartó parte del plan:\n- {}", reply.rejected.join("\n- ")), &[])
                .map_err(e2s)?;
        }

        // Questions for the user stop the lead until they are answered.
        let may_ask = match run.policy.questions.as_str() {
            "allow" => true,
            "plan" => item.kind == "plan",
            _ => false,
        };
        // A sub-lead asks up its chain of command, never the user directly.
        if sub_lead && !reply.questions.is_empty() {
            let boss = manager_of(run, &planner).map(|b| b.member.id.clone()).unwrap_or_else(|| run.lead.clone());
            let boss_name = member(run, &boss).map(|b| b.member.name.clone()).unwrap_or_else(|| lead_name(run));
            let mut asked_any = false;
            for q in &reply.questions {
                let asked = team::post(c, &run.id, &item.id, from, (&boss, &boss_name), "question", &q.text, &q.options).map_err(e2s)?;
                let instruction = format!("{} te pregunta, mientras planifica su rama: {}\nRespóndele en tu texto.", item.member_name, q.text);
                if let Some(answer_item) = new_planner_item(c, run, &boss, "answer", &instruction, "", "")? {
                    c.execute("UPDATE agent_team_items SET ref_item = ?2 WHERE id = ?1", rusqlite::params![answer_item.id, asked.id]).map_err(e2s)?;
                    asked_any = true;
                }
            }
            if asked_any {
                item.status = "waiting".into();
                team::update_item(c, &item).map_err(e2s)?;
                return Ok(());
            }
        }
        if !reply.questions.is_empty() && !sub_lead {
            if may_ask {
                for q in &reply.questions {
                    team::post(c, &run.id, &item.id, from, ("user", "Tú"), "question", &q.text, &q.options).map_err(e2s)?;
                }
                item.status = "waiting".into();
                team::update_item(c, &item).map_err(e2s)?;
                return Ok(());
            }
            if reply.items.is_empty() && !reply.finish && item.attempts < run.policy.max_attempts {
                item.status = "pending".into();
                item.feedback = "No puedes preguntarle al usuario. Decide con lo que hay, anota lo que supones y planifica.".into();
                team::update_item(c, &item).map_err(e2s)?;
                return Ok(());
            }
        }

        let mut fresh = planned_items(run, &items, &item, &reply.items);
        // A plan that names dependencies no task has is not a plan to start: the lead corrects it
        // while it has tries left. Out of them, the tasks are kept — nothing is lost to a typo —
        // but they wait, flagged, for the user to say whether they go on without it.
        let dangling: Vec<String> = fresh.iter().filter(|i| !i.intelligence.missing_deps.is_empty())
            .map(|i| format!("`{}` depende de {}, que no existe", i.key, i.intelligence.missing_deps.iter().map(|d| format!("`{d}`")).collect::<Vec<_>>().join(", ")))
            .collect();
        if !dangling.is_empty() && item.kind != "amend" && item.attempts < run.policy.max_attempts {
            item.status = "pending".into();
            item.feedback = format!("Tu plan nombra dependencias que no existen:\n- {}\nUsa en `depende_de` solo claves de tareas de este plan o del estado del trabajo, o agrega la tarea que falta. Repite el plan completo.", dangling.join("\n- "));
            team::update_item(c, &item).map_err(e2s)?;
            return Ok(());
        }
        if item.kind == "amend" {
            let mut projected = items.clone();
            let valid = if reply.rejected.is_empty() && (!reply.message.is_empty() || !reply.items.is_empty() || !reply.cancel.is_empty()) {
                coordination::amendment_changes(&mut projected, &reply.items, &mut fresh, &reply.cancel)
            } else {
                Err(if reply.rejected.is_empty() { "Falta una propuesta concreta.".into() } else { reply.rejected.join("\n") })
            };
            if let Err(reason) = valid {
                return retry_plan(c, run, item, &reason);
            }
            item.intelligence.amendment = Some(coordination::Amendment { summary: reply.message, cancel: reply.cancel, items: reply.items });
            item.status = "gated".into();
            team::update_item(c, &item).map_err(e2s)?;
            return team::set_run_status(c, &run.id, "gated", &format!("amend:{}", item.id), "Revisa el ajuste antes de aplicarlo.").map_err(e2s);
        }
        let canceled: std::collections::HashSet<_> = reply.cancel.iter().map(|key| protocol::key_slug(key)).collect();
        let mut active = items.clone();
        for retired in active.iter_mut().filter(|old| canceled.contains(&old.key) && matches!(old.status.as_str(), "pending" | "gated")) {
            retired.status = "skipped".into();
        }
        if let Err(reason) = coordination::wire_contracts(&active, &mut fresh) {
            return retry_plan(c, run, item, &reason);
        }
        for (old, updated) in items.iter().zip(&active).filter(|(old, updated)| old.status != updated.status) {
            team::update_item(c, updated).map_err(e2s)?;
            team::post(c, &run.id, &old.id, from, (&old.member_id, &old.member_name), "decision", &format!("canceló «{}»", old.title), &[]).map_err(e2s)?;
        }
        let added = fresh.len();
        // The first plan of the lead is read by the advisor before anything in it starts.
        let first_plan_now = !sub_lead && item.kind == "plan" && added > 0 && !items.iter().any(|i| i.kind == "plan" && i.id != item.id && i.status == "done");
        // A small request — one member, at most one piece of work per repository — skips the
        // ceremony: no advisor on the plan, and no last look of the lead's (nor the advisor's) once
        // it is delivered. Checks and integration still run.
        let small = first_plan_now && reply.small && is_small(&fresh);
        if first_plan_now && reply.small && !small {
            team::post(c, &run.id, "", ("system", "CodeFlow"), ("all", "Equipo"), "status", "el líder lo marcó como chico, pero su plan tiene más de una tarea por repositorio o tareas de investigar: sigue como tarea normal", &[]).map_err(e2s)?;
        }
        if small && run.policy.review.enabled {
            // Small skips the review laps too: a reviewer that answers FIX three times over a color
            // change is the loop «chico» exists to avoid.
            let mut policy = run.policy.clone();
            policy.review.enabled = false;
            set_run_policy(c, &run.id, &policy)?;
        }
        let advice = if first_plan_now && !small && !run.policy.single_pass {
            let plan_text: Vec<String> = reply.items.iter().map(|p| format!("- `{}` {} → {}", p.key, p.title, member(run, &p.member_id).map(|m| m.member.name.clone()).unwrap_or_default())).collect();
            new_advice(c, run, "plan", &format!("El líder propone este plan:\n{}\n¿Falta algo, sobra algo, o hay un riesgo que no vio?", plan_text.join("\n")))?
        } else {
            None
        };
        for mut new in fresh {
            if let Some(a) = &advice {
                new.depends_on.push(a.id.clone());
            }
            team::insert_item(c, &new).map_err(e2s)?;
            team::post(c, &run.id, &new.id, from, (&new.member_id, &new.member_name), "plan", &format!("asignó «{}»", new.title), &[]).map_err(e2s)?;
        }
        if !sub_lead {
            if reply.finish || small {
                if small {
                    team::post(c, &run.id, "", ("system", "CodeFlow"), ("all", "Equipo"), "status", "tarea chica: se integra al entregarse, sin revisión final", &[]).map_err(e2s)?;
                }
                team::set_lead_done(c, &run.id, true).map_err(e2s)?;
            } else if added > 0 {
                team::set_lead_done(c, &run.id, false).map_err(e2s)?;
            }
        }

        // A plan that decided nothing at all is retried once with that said.
        let open = team::open_items(&team::list_items(c, &run.id).map_err(e2s)?.into_iter().filter(|i| i.id != item.id).collect::<Vec<_>>());
        if added == 0 && !reply.finish && open == 0 && item.kind != "answer" && item.attempts < run.policy.max_attempts {
            item.status = "pending".into();
            item.feedback = if reply.rejected.is_empty() {
                "No asignaste ninguna tarea ni terminaste. Responde con el bloque ```equipo``` que se te pidió.".into()
            } else {
                format!("Nada de tu plan se pudo usar:\n- {}\nCorrígelo.", reply.rejected.join("\n- "))
            };
            team::update_item(c, &item).map_err(e2s)?;
            return Ok(());
        }
        // Out of attempts and still nothing: that is a failure, not a finished plan. Marking it done
        // let a run with no work at all reach «Todo está hecho» (with `single_pass`, one bad answer
        // was enough). It waits for the user instead; «Seguir» gives the lead one more try.
        if added == 0 && !reply.finish && open == 0 && !sub_lead && matches!(item.kind.as_str(), "plan" | "final") {
            item.status = "error".into();
            item.last_error = "El líder no asignó ninguna tarea usable ni dio el trabajo por terminado.".into();
            item.finished_at = queries::now();
            team::update_item(c, &item).map_err(e2s)?;
            let why = if reply.rejected.is_empty() { String::new() } else { format!("\n- {}", reply.rejected.join("\n- ")) };
            return team::set_run_status(c, &run.id, "gated", &format!("stuck:{}", item.id), &format!("El líder no asignó ninguna tarea usable.{why}"))
                .map_err(e2s);
        }
        // A sub-lead's branch stays open until what it handed out closes (see `advance`).
        item.status = if item.kind == "delegate" && added > 0 && !reply.finish { "delegated".into() } else { "done".into() };
        item.feedback.clear();
        if item.status == "done" {
            item.finished_at = queries::now();
        }
        team::update_item(c, &item).map_err(e2s)?;
        if item.kind == "delegate" && item.status == "done" {
            handoff(c, run, &item)?;
        }

        // The first plan waits for the user when the policy says so.
        let first_plan = !sub_lead && item.kind == "plan" && !items.iter().any(|i| i.kind == "plan" && i.id != item.id && i.status == "done");
        // With an advisor reading the plan, the gate waits for its advice (`on_advice`).
        if first_plan && run.policy.approve_plan && added > 0 && advice.is_none() {
            team::set_run_status(c, &run.id, "gated", "plan", "Revisa el plan del líder antes de que el equipo empiece.").map_err(e2s)?;
        }
        Ok(())
    })
}

pub(crate) fn retry_plan(conn: &Connection, run: &Run, mut item: Item, reason: &str) -> Result<(), String> {
    item.last_error = reason.to_string();
    item.feedback = format!("Corrige la propuesta. {reason}");
    if item.attempts < run.policy.max_attempts {
        item.status = "pending".into();
        return team::update_item(conn, &item).map_err(e2s);
    }
    item.status = "error".into();
    team::update_item(conn, &item).map_err(e2s)?;
    let gate = if item.kind == "amend" { "amend_failed" } else { "stuck" };
    team::set_run_status(conn, &run.id, "gated", &format!("{gate}:{}", item.id), reason).map_err(e2s)
}
