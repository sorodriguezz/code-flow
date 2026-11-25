use super::*;

/// The advisor answered: its advice goes to the lead and to you, and into whatever it was asked
/// about — the plan's gate, the final look, or the next attempt of a failing item.
pub(crate) fn on_advice(conn: &Connection, run: &Run, mut item: Item, text: &str) -> Result<(), String> {
    let advice = protocol::prose(text);
    item.status = "done".into();
    item.finished_at = queries::now();
    team::update_item(conn, &item).map_err(e2s)?;
    let from = (item.member_id.as_str(), item.member_name.as_str());
    let lead = if run.lead.is_empty() { ("user".to_string(), "Tú".to_string()) } else { ("lead".to_string(), lead_name(run)) };
    team::post(conn, &run.id, &item.id, from, (&lead.0, &lead.1), "advice", &trim_chars(&advice, 2000), &[]).map_err(e2s)?;
    match item.ref_item.as_str() {
        "plan" => {
            if run.policy.approve_plan {
                team::set_run_status(conn, &run.id, "gated", "plan", &format!("Revisa el plan del líder. El asesor dice: {}", first_line(&advice, 300))).map_err(e2s)?;
            }
        }
        "final" => {}
        target => {
            if let Some(mut failing) = team::get_item(conn, target).map_err(e2s)? {
                failing.feedback = format!("{}\n\nEl asesor sugiere:\n{}", failing.feedback, trim_chars(&advice, 2000)).trim().to_string();
                team::update_item(conn, &failing).map_err(e2s)?;
            }
        }
    }
    Ok(())
}

pub(crate) fn handoff(conn: &Connection, run: &Run, item: &Item) -> Result<(), String> {
    let summary = first_line(&protocol::prose(&item.output_text), 400);
    let dependents: Vec<Item> = team::list_items(conn, &run.id).map_err(e2s)?.into_iter().filter(|i| i.depends_on.contains(&item.id)).collect();
    if dependents.is_empty() {
        team::post(conn, &run.id, &item.id, (&item.member_id, &item.member_name), ("all", "Equipo"), "handoff", &format!("terminó «{}»: {summary}", item.title), &[])
            .map_err(e2s)?;
    } else {
        for d in dependents {
            team::post(conn, &run.id, &item.id, (&item.member_id, &item.member_name), (&d.member_id, &d.member_name), "handoff", &format!("«{}» listo para «{}»: {summary}", item.title, d.title), &[])
                .map_err(e2s)?;
        }
    }
    Ok(())
}

/// The notes in a member's answer, posted. `true` when one of them is a question that has to be
/// answered before the member can go on.
pub(crate) fn post_notes(conn: &Connection, run: &Run, item: &Item, text: &str) -> Result<bool, String> {
    let roster = roster(run);
    let (notes, errors) = protocol::member_notes(text, &roster);
    let from = (item.member_id.as_str(), item.member_name.as_str());
    let members = members_of(run);
    let boss = manager_of(run, &item.member_id).cloned();
    let mut waiting = false;
    let cap = run.policy.max_notes_per_item;
    for (index, note) in notes.into_iter().enumerate() {
        if cap > 0 && index as i64 >= cap {
            team::post(conn, &run.id, &item.id, ("system", "CodeFlow"), from, "error", &format!("se descartaron las notas pasadas las {cap} de esta tarea"), &[]).map_err(e2s)?;
            break;
        }
        let (mut to_id, mut to_name) = match &note.to {
            protocol::Recipient::User => ("user".to_string(), "Tú".to_string()),
            // «El líder» is whoever this member answers to: its sub-lead, or the lead.
            protocol::Recipient::Lead => match &boss {
                Some(b) if b.member.id != run.lead => (b.member.id.clone(), b.member.name.clone()),
                _ if !run.lead.is_empty() => ("lead".to_string(), lead_name(run)),
                _ => ("user".to_string(), "Tú".to_string()),
            },
            protocol::Recipient::All => ("all".to_string(), "Equipo".to_string()),
            protocol::Recipient::Member(id) => (id.clone(), member(run, id).map(|m| m.member.name.clone()).unwrap_or_default()),
        };
        let mut body = note.text.clone();
        // A note the hierarchy does not allow goes through the sender's manager, said so.
        if !hierarchy::may_message(&members, &run.lead, &run.policy.comms, &item.member_id, &to_id) {
            if let Some(b) = &boss {
                body = format!("Para {to_name}: {body}");
                team::post(conn, &run.id, &item.id, ("system", "CodeFlow"), from, "note", &format!("tu nota para {to_name} pasa por {}", b.member.name), &[]).map_err(e2s)?;
                to_id = if b.member.id == run.lead { "lead".into() } else { b.member.id.clone() };
                to_name = b.member.name.clone();
            }
        }
        // With questions escalating, the user is asked only by the lead: a member asks up.
        if note.question && to_id == "user" && run.policy.escalate_questions {
            if let Some(b) = &boss {
                to_id = if b.member.id == run.lead { "lead".into() } else { b.member.id.clone() };
                to_name = b.member.name.clone();
            }
        }
        let note = protocol::Note { text: body, ..note };
        let to_planner = to_id == "lead" || (to_id != "user" && to_id != "all" && boss.as_ref().is_some_and(|b| b.member.id == to_id));
        if note.question && to_planner && to_id != "lead" {
            let asked = team::post(conn, &run.id, &item.id, from, (&to_id, &to_name), "question", &note.text, &note.options).map_err(e2s)?;
            let instruction = format!("{} te pregunta, desde «{}»: {}\nRespóndele en tu texto (lo recibe tal cual). Si no lo sabes, pregúntale a quien te lidera.", item.member_name, item.title, note.text);
            if let Some(answer_item) = new_planner_item(conn, run, &to_id, "answer", &instruction, "", "")? {
                conn.execute("UPDATE agent_team_items SET ref_item = ?2 WHERE id = ?1", rusqlite::params![answer_item.id, asked.id]).map_err(e2s)?;
                waiting = true;
            }
            continue;
        }
        if note.question && to_id == "user" {
            if run.policy.members_may_ask() {
                team::post(conn, &run.id, &item.id, from, ("user", "Tú"), "question", &note.text, &note.options).map_err(e2s)?;
                waiting = true;
            } else {
                team::post(conn, &run.id, &item.id, from, ("user", "Tú"), "note", &format!("(no puede preguntar, decidió solo) {}", note.text), &[]).map_err(e2s)?;
            }
        } else if note.question && to_id == "lead" {
            let asked = team::post(conn, &run.id, &item.id, from, ("lead", &to_name), "question", &note.text, &note.options).map_err(e2s)?;
            let instruction = format!("{} pregunta, desde «{}»: {}\nRespóndele en tu texto (lo recibe tal cual).", item.member_name, item.title, note.text);
            if let Some(mut lead_item) = new_lead_item(conn, run, "answer", &instruction, "")? {
                lead_item.ref_item = asked.id.clone();
                conn.execute("UPDATE agent_team_items SET ref_item = ?2 WHERE id = ?1", rusqlite::params![lead_item.id, asked.id]).map_err(e2s)?;
                waiting = true;
            }
        } else {
            team::post(conn, &run.id, &item.id, from, (&to_id, &to_name), if note.question { "question" } else { "note" }, &note.text, &note.options).map_err(e2s)?;
        }
    }
    for e in errors {
        team::post(conn, &run.id, &item.id, ("system", "CodeFlow"), from, "error", &format!("una nota no se pudo leer: {e}"), &[]).map_err(e2s)?;
    }
    Ok(waiting)
}

pub(crate) fn needs_review(run: &Run, item: &Item) -> bool {
    let review = &run.policy.review;
    review.enabled
        && !review.reviewer.is_empty()
        && review.reviewer != item.member_id
        && member(run, &review.reviewer).is_some()
        && (review.of.is_empty() || review.of.contains(&item.member_id))
}

pub(crate) fn new_review(conn: &Connection, run: &Run, work: &Item) -> Result<(), String> {
    let Some(reviewer) = member(run, &run.policy.review.reviewer) else { return Ok(()) };
    let items = team::list_items(conn, &run.id).map_err(e2s)?;
    let lap = items.iter().filter(|i| i.kind == "review" && items.iter().any(|w| w.id == i.ref_item && w.branch == work.branch)).count() as i64 + 1;
    let mut review = team::new_item(run, &team::free_key(&items, &format!("{}-rev", work.key)), Some(reviewer), &work.project_id, "review", &format!("Revisar «{}»", work.title), &work.instruction);
    review.ref_item = work.id.clone();
    review.intelligence.requires_contracts.clone_from(&work.intelligence.requires_contracts);
    review.lap = lap;
    review.run_in = "headless".into();
    team::insert_item(conn, &review).map_err(e2s)?;
    team::post(conn, &run.id, &review.id, (&work.member_id, &work.member_name), (&reviewer.member.id, &reviewer.member.name), "handoff", &format!("«{}» listo para revisar (vuelta {lap})", work.title), &[])
        .map_err(e2s)?;
    Ok(())
}

pub(crate) async fn on_review(db: &Db, run: &Run, mut item: Item, text: &str) -> Result<(), String> {
    let Some(review) = crate::chain_review::parse(text) else {
        return on_failure(db, run, item, "la revisión no tiene una línea `VERDICT: OK | FIX`", "revisión").await;
    };
    let target = with(db, |c| team::get_item(c, &item.ref_item).map_err(e2s))?;
    let Some(target) = target else {
        item.status = "done".into();
        with(db, |c| team::update_item(c, &item).map_err(e2s))?;
        return Ok(());
    };
    let roots = vec![target.worktree_path.clone()];
    let grounded = crate::chain_review::ground(review.findings.clone(), &roots, &|p: &std::path::Path| p.exists());
    let blocking_findings = crate::chain_review::blocking(&grounded, crate::chain_review::Exigence::parse(&run.policy.review.exigence));
    item.status = "done".into();
    item.finished_at = queries::now();
    with(db, |c| team::update_item(c, &item).map_err(e2s))?;
    let from = (item.member_id.clone(), item.member_name.clone());
    if blocking_findings.is_empty() {
        with(db, |c| {
            team::post(c, &run.id, &item.id, (&from.0, &from.1), (&target.member_id, &target.member_name), "finding", &format!("aprobó «{}»", target.title), &[])
                .map(|_| ())
                .map_err(e2s)
        })?;
        return integrate(db, run, target).await;
    }
    let listing = blocking_findings
        .iter()
        .map(|f| format!("[{:?}] {}{} — {}", f.severity, f.file, f.line.map(|l| format!(":{l}")).unwrap_or_default(), f.problem).to_lowercase())
        .collect::<Vec<_>>()
        .join("\n");
    with(db, |c| {
        team::post(c, &run.id, &item.id, (&from.0, &from.1), (&target.member_id, &target.member_name), "finding", &format!("devuelve «{}»:\n{listing}", target.title), &[])
            .map_err(e2s)?;
        if item.lap >= run.policy.review.laps {
            return team::set_run_status(
                c,
                &run.id,
                "gated",
                &format!("review:{}", target.id),
                &format!("«{}» sigue sin aprobarse tras {} vueltas. Aprueba para integrarlo igual, o rechaza para descartarlo.", target.title, item.lap),
            )
            .map_err(e2s);
        }
        // The fix continues the same task in the same worktree: the author remembers what it did.
        let items = team::list_items(c, &run.id).map_err(e2s)?;
        let author = member(run, &target.member_id).cloned();
        let mut fix = team::new_item(run, &team::free_key(&items, &format!("{}-fix", target.key)), author.as_ref(), &target.project_id, "work", &format!("Corregir «{}»", target.title), &target.instruction);
        fix.ref_item = target.id.clone();
        fix.task_id = target.task_id.clone();
        fix.worktree_path = target.worktree_path.clone();
        fix.branch = target.branch.clone();
        fix.intelligence.criteria.clone_from(&target.intelligence.criteria);
        fix.intelligence.paths.clone_from(&target.intelligence.paths);
        fix.intelligence.contract_specs.clone_from(&target.intelligence.contract_specs);
        fix.intelligence.requires_contracts.clone_from(&target.intelligence.requires_contracts);
        fix.intelligence.base_sha.clone_from(&target.intelligence.base_sha);
        fix.intelligence.substitute.clone_from(&target.intelligence.substitute);
        fix.run_in = target.run_in.clone();
        fix.approved = true;
        fix.lap = item.lap;
        fix.feedback = crate::chain_review::note_for_worker(&blocking_findings, &[], item.lap);
        team::insert_item(c, &fix).map_err(e2s)?;
        // Whatever waits on the original keeps waiting: it is merged when the fix is approved.
        Ok(())
    })
}
