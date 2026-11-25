use super::*;

pub(crate) async fn on_ok(db: &Db, run: &Run, mut item: Item, text: &str) -> Result<(), String> {
    item.output_text = text.to_string();
    item.intelligence.evidence = intelligence::reported_evidence(&item.intelligence.criteria, text);
    if !item.intelligence.used_contracts.is_empty() {
        let items = with(db, |c| team::list_items(c, &run.id).map_err(e2s))?;
        let latest = coordination::latest_contracts(&items);
        let outdated = coordination::outdated_contracts(&item, &latest);
        if !outdated.is_empty() {
            let changed = outdated.join(", ");
            item.status = "pending".into();
            item.feedback = format!("Cambió el contrato {changed} mientras trabajabas. Adapta lo ya hecho y repite las pruebas afectadas con la nueva versión.");
            return with(db, |c| {
                team::update_item(c, &item).map_err(e2s)?;
                team::post(c, &run.id, &item.id, ("system", "CodeFlow"), ("all", "Equipo"), "finding", &item.feedback, &[]).map(|_| ()).map_err(e2s)
            });
        }
    }
    match gate_impact(db, run, &mut item).await {
        Ok(true) => return Ok(()),
        Ok(false) => {}
        Err(reason) => return on_failure(db, run, item, &reason, "impacto").await,
    }
    // What the answer carried as artifacts becomes files the next members open (`team::artifacts`).
    let filed = with(db, |c| Ok(team::artifacts::file_item(c, run, &item, text)))?;
    if !filed.is_empty() {
        with(db, |c| {
            let names: Vec<String> = filed.iter().map(|f| format!("`{f}`")).collect();
            team::post(c, &run.id, &item.id, (&item.member_id, &item.member_name), ("all", "Equipo"), "note", &format!("publicó {}", names.join(", ")), &[])
                .map(|_| ())
                .map_err(e2s)
        })?;
    }
    if item.is_lead() {
        return on_lead(db, run, item, text);
    }
    // Notes first: whatever the member asked or told, it said it.
    let waiting = with(db, |c| post_notes(c, run, &item, text))?;
    if waiting {
        item.status = "waiting".into();
        with(db, |c| team::update_item(c, &item).map_err(e2s))?;
        return Ok(());
    }
    // Definition of done, first clause: every criterion the task carries is accounted for. A member
    // saying «listo» with no evidence for a criterion has not shown it is.
    if matches!(item.kind.as_str(), "work" | "investigate") && run.policy.dod != "off" {
        let missing: Vec<String> = intelligence::unreported(&item.intelligence.evidence).iter().map(|label| format!("- {label}")).collect();
        if !missing.is_empty() {
            if run.policy.dod == "block" {
                let reason = format!("No reportaste evidencia de estos criterios de aceptación:\n{}\nComprueba cada uno y decláralo en el bloque `verificacion`, o di por qué no se puede cumplir.", missing.join("\n"));
                return on_failure(db, run, item, &reason, "criterios").await;
            }
            with(db, |c| {
                team::post(c, &run.id, &item.id, ("system", "CodeFlow"), ("all", "Equipo"), "finding",
                    &format!("«{}» se entregó sin evidencia de {} criterio(s):\n{}", item.title, missing.len(), missing.join("\n")), &[]).map(|_| ()).map_err(e2s)
            })?;
        }
    }
    if item.kind == "advise" {
        return with(db, |c| on_advice(c, run, item, text));
    }
    let repo = with(db, |c| team::list_repos(c, &run.id).map_err(e2s))?.into_iter().find(|r| r.project_id == item.project_id);
    if item.kind != "work" {
        if let Err(reason) = load_contracts(&mut item, repo.as_ref()).await {
            return on_failure(db, run, item, &reason, "contrato").await;
        }
    }
    match item.kind.as_str() {
        "review" => on_review(db, run, item, text).await,
        "integrate" => {
            let files: Vec<String> = item.feedback.lines().filter_map(|l| l.strip_prefix("- ")).map(str::to_string).collect();
            let path = item.worktree_path.clone();
            let message = format!("Merge: integrar «{}»", item.title);
            match blocking(move || gitops::finish_resolution(&path, &files, &message)).await? {
                Err(e) => on_failure(db, run, item, &e, "conflicto").await,
                Ok(_) => {
                    item.status = "done".into();
                    item.finished_at = queries::now();
                    with(db, |c| {
                        team::update_item(c, &item).map_err(e2s)?;
                        team::post(c, &run.id, &item.id, (&item.member_id, &item.member_name), ("all", "Equipo"), "merge", "resolvió los conflictos", &[]).map_err(e2s)?;
                        Ok(())
                    })?;
                    if let Some(target) = with(db, |c| team::get_item(c, &item.ref_item).map_err(e2s))? {
                        integrate(db, run, target).await?;
                    }
                    Ok(())
                }
            }
        }
        "work" => {
            // Checks the policy runs after each piece of work, in its own folder: the ones set up for
            // the repository, or the ones detected in it.
            let checks: Vec<String> = suites_for(run, &item.project_id, &item.worktree_path)
                .into_iter()
                .filter(|c| c.when == "item")
                .map(|c| c.command)
                .collect();
            let at = CheckAt { run, project_id: &item.project_id, slot: &item.task_id };
            for command in checks {
                let evidence = match verify_check(db, &at, &command, &item.worktree_path, repo.as_ref(), &item.intelligence.base_sha).await {
                    Ok(evidence) => evidence,
                    // Not a failure of the work: nothing goes back to the member, and nothing
                    // runs on the host until the user says so.
                    Err(reason) => return hold_for_sandbox(db, run, &mut item, &reason),
                };
                let failed = !check_passes(&run.policy, &evidence.result);
                let fix = if evidence.result == "preexisting" { "\nYa fallaba antes de tu cambio; el equipo pide arreglarlo también." } else { "" };
                let reason = failed.then(|| format!("`{command}` · {}{fix}\n{}", check_description(&evidence.result), evidence.detail));
                item.intelligence.evidence.push(evidence);
                if let Some(reason) = reason {
                    return on_failure(db, run, item, &reason, "check").await;
                }
            }
            if gate_tests(db, run, &mut item).await? {
                return Ok(());
            }
            match gate_impact(db, run, &mut item).await {
                Ok(true) => return Ok(()),
                Ok(false) => {}
                Err(reason) => return on_failure(db, run, item, &reason, "impacto").await,
            }
            if let Err(reason) = load_contracts(&mut item, repo.as_ref()).await {
                return on_failure(db, run, item, &reason, "contrato").await;
            }
            let path = item.worktree_path.clone();
            let message = gitops::commit_message(&run.policy.commit_style, &item.key, &item.title);
            let sha = match blocking(move || gitops::commit_all(&path, &message)).await? {
                Ok(sha) => sha,
                Err(e) => return on_failure(db, run, item, &e, "commit").await,
            };
            // A fix commits on the same branch as the work it fixes; what is reviewed and merged is
            // the branch, so the original's sha follows.
            // Work done on another machine (a shared run's seat) arrives already committed: the
            // worktree's head moved past where the item started, and that is its commit.
            let sha = match sha {
                None if item.run_in == crate::collab::team::RUN_IN_REMOTE => {
                    let path = item.worktree_path.clone();
                    let head = blocking(move || gitops::head_sha(&path)).await?.ok();
                    head.filter(|h| !h.is_empty() && *h != item.intelligence.base_sha)
                }
                other => other,
            };
            // Definition of done, second clause: a task that was to change code and changed none is
            // only done if it says why — it was already so, or nothing had to change. Silence is
            // not a delivery, and «no pude» is a failure by its own account.
            if sha.is_none() && item.ref_item.is_empty() {
                let declared = intelligence::declared_no_change(text);
                item.intelligence.no_change = declared.unwrap_or("undeclared").into();
                if declared == Some("unable") {
                    return on_failure(db, run, item, "Declaraste que no pudiste hacer la tarea. Di qué te lo impidió o resuélvelo.", "sin-cambios").await;
                }
                if declared.is_none() && run.policy.dod == "block" {
                    return on_failure(db, run, item, "No cambiaste ningún archivo y no dijiste por qué. Haz el cambio, o declara `{\"sin_cambios\": \"ya_estaba\"}` o `{\"sin_cambios\": \"no_hacia_falta\"}` en un bloque equipo con la evidencia.", "sin-cambios").await;
                }
                if declared.is_none() && run.policy.dod == "warn" {
                    with(db, |c| {
                        team::post(c, &run.id, &item.id, ("system", "CodeFlow"), ("all", "Equipo"), "finding",
                            &format!("«{}» terminó sin cambiar ningún archivo y sin decir por qué.", item.title), &[]).map(|_| ()).map_err(e2s)
                    })?;
                }
            } else {
                item.intelligence.no_change.clear();
            }
            if let Some(sha) = &sha {
                item.commit_sha = sha.clone();
                // What the app checked is evidence of this commit, and of no other.
                for evidence in item.intelligence.evidence.iter_mut().filter(|e| e.source == "check") {
                    evidence.sha = sha.clone();
                }
            } else if !item.ref_item.is_empty() {
                if let Some(original) = with(db, |c| team::get_item(c, &item.ref_item).map_err(e2s))? {
                    item.commit_sha = original.commit_sha.clone();
                }
            }
            item.status = "done".into();
            item.feedback.clear();
            item.finished_at = queries::now();
            with(db, |c| {
                team::update_item(c, &item).map_err(e2s)?;
                handoff(c, run, &item)
            })?;
            if item.commit_sha.is_empty() {
                return Ok(());
            }
            if needs_review(run, &item) {
                with(db, |c| new_review(c, run, &item))?;
                return Ok(());
            }
            integrate(db, run, item).await
        }
        _ => {
            item.status = "done".into();
            item.feedback.clear();
            item.finished_at = queries::now();
            with(db, |c| {
                team::update_item(c, &item).map_err(e2s)?;
                handoff(c, run, &item)
            })?;
            let _ = repo;
            Ok(())
        }
    }
}

/// Whether the work's checks went green by weakening its tests (deleted, skipped or focused
/// tests, silenced lint, a rewritten check script, a runner config changed): then the item waits
/// for the user with what was found. It never goes back to the member as a failure — the task may
/// have been to remove those tests, and a member sent to restore them would spend every attempt it
/// has; a person tells the two apart in one look. Only for repositories with checks: without them
/// there is nothing to game. A diff git cannot read is no reason to stop the work.
pub(crate) async fn gate_tests(db: &Db, run: &Run, item: &mut Item) -> Result<bool, String> {
    if !item.writes() || item.worktree_path.is_empty() || item.intelligence.base_sha.is_empty() {
        return Ok(false);
    }
    let suites = suites_for(run, &item.project_id, &item.worktree_path);
    if suites.is_empty() {
        return Ok(false);
    }
    let lint = suites.iter().any(|c| c.kind == "lint");
    let commands: Vec<String> = suites.into_iter().map(|c| c.command).collect();
    let (path, base) = (item.worktree_path.clone(), item.intelligence.base_sha.clone());
    let Ok(Ok(found)) = blocking(move || gitops::inspect_tests(&path, &base, &commands, lint)).await else { return Ok(false) };
    let Some(found) = found.filter(|f| f.version != item.intelligence.approved_tests) else { return Ok(false) };
    let listing = found.reasons.iter().map(|r| format!("- {r}")).collect::<Vec<_>>().join("\n");
    item.intelligence.impact = Some(found);
    item.status = "gated".into();
    with(db, |c| {
        team::update_item(c, item).map_err(e2s)?;
        team::post(c, &run.id, &item.id, ("system", "CodeFlow"), ("user", "Tú"), "error", &format!("«{}» pasa sus verificaciones, pero debilita las pruebas:\n{listing}", item.title), &[])
            .map(|_| ())
            .map_err(e2s)
    })?;
    Ok(true)
}

pub(crate) async fn gate_impact(db: &Db, run: &Run, item: &mut Item) -> Result<bool, String> {
    if !item.writes() || !run.policy.impact_approval || item.worktree_path.is_empty() {
        return Ok(false);
    }
    let (path, base, rules) = (item.worktree_path.clone(), item.intelligence.base_sha.clone(), run.policy.impact_paths.clone());
    let impact = blocking(move || gitops::inspect_impact(&path, &base, &rules)).await??
        .filter(|impact| impact.version != item.intelligence.approved_impact);
    item.intelligence.impact = impact;
    if item.intelligence.impact.is_some() {
        item.status = "gated".into();
        with(db, |c| team::update_item(c, item).map_err(e2s))?;
        return Ok(true);
    }
    Ok(false)
}

pub(crate) async fn load_contracts(item: &mut Item, repo: Option<&RunRepo>) -> Result<(), String> {
    if item.intelligence.contract_specs.is_empty() {
        return Ok(());
    }
    let root = if item.worktree_path.is_empty() {
        repo.map(|repo| repo.integration_path.clone()).unwrap_or_default()
    } else {
        item.worktree_path.clone()
    };
    let specs = item.intelligence.contract_specs.clone();
    item.intelligence.published_contracts = blocking(move || coordination::publish_contracts(&root, &specs)).await??;
    Ok(())
}

pub(crate) fn check_description(result: &str) -> &'static str {
    match result {
        "passed" => "pasó",
        "regression" => "falló después del cambio; la base pasó",
        "preexisting" => "repitió el mismo fallo de la base",
        _ => "falló; sin comparación concluyente con la base",
    }
}

/// Whether a check's result lets the work through: it passed, or it failed exactly as it did before
/// the change and the team leaves such failures alone (`baseline_failures: ignore`).
pub(crate) fn check_passes(policy: &Policy, result: &str) -> bool {
    result == "passed" || (result == "preexisting" && policy.baseline_failures != "fix")
}

/// Whether `project_id`'s suites are the detected ones: `auto_checks` on and none set up for it.
pub(crate) fn detected_only(run: &Run, project_id: &str) -> bool {
    run.policy.auto_checks && !run.policy.checks.iter().any(|c| c.repo == "*" || c.repo == project_id)
}

/// The test suites for a member working in `project_id`: what it is told, and what the app runs
/// after each task (`item`) or once at the end (`final`). The ones the team set up for that
/// repository (or for every one), or — with `auto_checks` and none set up — every suite the app
/// detects in `root`. Detected suites run unattended, so only the fast ones run after each task
/// (unit, lint); integration and e2e, which usually need a database, a browser or a service, are
/// only told to the member.
pub(crate) fn suites_for(run: &Run, project_id: &str, root: &str) -> Vec<team::Check> {
    if !detected_only(run, project_id) {
        return run.policy.checks.iter().filter(|c| c.repo == "*" || c.repo == project_id).cloned().collect();
    }
    let mut suites = intelligence::detect_suites(std::path::Path::new(root));
    for suite in &mut suites {
        suite.repo = project_id.into();
        if suite.when == "final" {
            suite.when = "agent".into();
        }
    }
    suites
}

/// Where one check runs: which run and repository it belongs to, and which copy of it — the same
/// `slot` is the same copy when the checks run isolated.
pub(crate) struct CheckAt<'a> {
    pub run: &'a Run,
    pub project_id: &'a str,
    pub slot: &'a str,
}

/// Runs `command` in `cwd` and says how it went — on this computer, or in a container when the
/// run's policy asks for it. With a base to compare against, a failure is told apart: caused by the
/// change (`regression`), there before it (`preexisting`), or simply `failed`.
///
/// `Err` is never a verdict on the work: it is «the check could not run isolated», and the caller
/// stops for the user instead of trying it on the host.
pub(crate) async fn verify_check(db: &Db, at: &CheckAt<'_>, command: &str, cwd: &str, repo: Option<&RunRepo>, base: &str) -> Result<intelligence::Evidence, String> {
    let isolated = at.run.policy.sandbox == "checks";
    let job = |tree: &str, slot: &str| team::sandbox::Job {
        workspace_id: at.run.workspace_id.clone(),
        run_id: at.run.id.clone(),
        project_id: at.project_id.to_string(),
        tree: tree.to_string(),
        slot: slot.to_string(),
        command: command.to_string(),
        image: at.run.policy.sandbox_image.clone(),
        timeout: crate::commands::agents_cmd::CHECK_TIMEOUT,
    };
    let mut image = String::new();
    let (passed, mut output) = if isolated {
        let ran = team::sandbox::run(db, job(cwd, at.slot)).await.map_err(|unavailable| unavailable.0)?;
        image = ran.image;
        (ran.passed, ran.output)
    } else {
        // A fresh worktree has none of what `.gitignore` keeps out; a check that cannot find its
        // runner says nothing about the work. An install that fails is told with the check's own
        // failure.
        let install = team::deps::ensure(cwd).await.err();
        let (passed, mut output) = crate::commands::agents_cmd::run_shell_check(command, cwd).await;
        if let Some(reason) = install.filter(|_| !passed) {
            output = format!("No se pudieron instalar las dependencias antes de la verificación: {reason}\n\n{output}");
        }
        (passed, output)
    };
    let mut result = if passed { "passed" } else { "failed" };
    if let Some(repo) = repo.filter(|_| !passed && !base.is_empty()) {
        let root = repo.local_path.clone();
        let path = wt_dir(&repo.name, &format!("check-{}", uuid::Uuid::new_v4())).to_string_lossy().into_owned();
        let start = base.to_string();
        let (r, p) = (root.clone(), path.clone());
        if blocking(move || gitops::add_detached(&r, &p, &start)).await.is_ok_and(|made| made.is_ok()) {
            let (base_passed, base_output, base_root) = if isolated {
                // One copy of the base per repository, kept for the run: what it installed the
                // first time is there for every comparison after. An engine that went away between
                // the two leaves the failure as `failed` — it proves nothing either way.
                match team::sandbox::run(db, job(&path, "base")).await {
                    Ok(ran) => (ran.passed, ran.output, "/work".to_string()),
                    Err(_) => (false, String::new(), "/work".to_string()),
                }
            } else {
                // Without its dependencies the base fails for that alone, and a regression reads as
                // «both failed». A base whose install failed proves nothing: the result stays `failed`.
                let installed = team::deps::ensure(&path).await.is_ok();
                let env = team::deps::shared_build_env(std::path::Path::new(&path), std::path::Path::new(cwd));
                let (passed, output) = if installed {
                    crate::commands::agents_cmd::run_shell_check_with(command, &path, crate::commands::agents_cmd::CHECK_TIMEOUT, &env).await
                } else {
                    (false, String::new())
                };
                (passed, output, path.clone())
            };
            let cleaned = |output: &str, path: &str| output.replace(path, "<repo>").trim().to_string();
            let here = if isolated { "/work" } else { cwd };
            if base_passed {
                result = "regression";
            } else if !output.trim().is_empty() && cleaned(&output, here) == cleaned(&base_output, &base_root) {
                result = "preexisting";
            }
            // Only this fresh detached baseline is disposable, including files made by its checks.
            let _ = blocking(move || crate::git::worktree::remove(&root, &path, true)).await;
        }
    }
    if isolated {
        output = output.replace("/work/", "").replace("/work", ".");
    }
    Ok(intelligence::Evidence { label: command.into(), result: result.into(), detail: trim_chars(&output, 6000), source: "check".into(), sha: String::new(), sandbox: image })
}

/// The item's checks could not run isolated: it waits, with the reason, for the user to decide
/// ([`advance`] raises the `sandbox:` gate once nothing else of the run is moving).
pub(crate) fn hold_for_sandbox(db: &Db, run: &Run, item: &mut Item, reason: &str) -> Result<(), String> {
    item.status = "gated".into();
    item.intelligence.sandbox_hold = reason.to_string();
    with(db, |c| {
        team::update_item(c, item).map_err(e2s)?;
        team::post(c, &run.id, &item.id, ("system", "CodeFlow"), ("user", "Tú"), "error",
            &format!("Las verificaciones de «{}» no pudieron correr aisladas: {reason}", item.title), &[]).map(|_| ()).map_err(e2s)
    })
}

/// Merges a work item's branch into its repository's integration branch, or routes the conflict.
pub(crate) async fn integrate(db: &Db, run: &Run, work: Item) -> Result<(), String> {
    let Some(repo) = with(db, |c| team::list_repos(c, &run.id).map_err(e2s))?.into_iter().find(|r| r.project_id == work.project_id) else {
        return Ok(());
    };
    let (integ, branch) = (repo.integration_path.clone(), work.branch.clone());
    let message = format!("Merge «{}» ({})", work.title, work.member_name);
    let merged = blocking(move || {
        let _git = crate::git::write_lock(&integ);
        gitops::merge_into_integration(&integ, &branch, &message)
    })
    .await?;
    match merged {
        Ok(gitops::Merge::Done(_)) | Ok(gitops::Merge::Nothing) => with(db, |c| {
            // Every done item on this branch (the work and its fixes) is in now.
            c.execute("UPDATE agent_team_items SET merged = 1 WHERE run_id = ?1 AND branch = ?2 AND status = 'done'", rusqlite::params![run.id, work.branch])
                .map_err(e2s)?;
            team::post(c, &run.id, &work.id, ("system", "CodeFlow"), ("all", "Equipo"), "merge", &format!("«{}» integrado en {}", work.title, repo.integration_branch), &[])
                .map_err(e2s)?;
            Ok(())
        }),
        Ok(gitops::Merge::Conflict(files)) => route_conflict(db, run, &repo, work, files).await,
        Err(e) => with(db, |c| {
            team::set_run_status(c, &run.id, "gated", &format!("stuck:{}", work.id), &format!("No se pudo integrar «{}»: {e}", work.title)).map_err(e2s)
        }),
    }
}

pub(crate) async fn route_conflict(db: &Db, run: &Run, repo: &RunRepo, work: Item, files: Vec<String>) -> Result<(), String> {
    let resolver = match run.policy.conflicts.as_str() {
        "user" => None,
        "author" | "" => member(run, &work.member_id).cloned(),
        id => member(run, id).cloned().or_else(|| member(run, &work.member_id).cloned()),
    }
    .filter(|m| m.member.edits);
    let Some(resolver) = resolver else {
        return with(db, |c| {
            team::set_run_status(c, &run.id, "gated", &format!("stuck:{}", work.id), &format!("«{}» choca con el trabajo ya integrado en: {}. Resuélvelo en {} y aprueba.", work.title, files.join(", "), work.worktree_path))
                .map_err(e2s)
        });
    };
    let (path, integ_branch) = (work.worktree_path.clone(), repo.integration_branch.clone());
    let conflicts = blocking(move || gitops::bring_conflicts_into(&path, &integ_branch)).await??;
    if conflicts.is_empty() {
        // It merged cleanly the other way round: try again.
        return Box::pin(integrate(db, run, work)).await;
    }
    with(db, |c| {
        let items = team::list_items(c, &run.id).map_err(e2s)?;
        let mut fix = team::new_item(
            run,
            &team::free_key(&items, &format!("{}-merge", work.key)),
            Some(&resolver),
            &work.project_id,
            "integrate",
            &format!("Resolver conflictos de «{}»", work.title),
            &format!(
                "Al integrar «{}» de {} con lo que el equipo ya integró, chocan estos archivos. El merge está a medias en esta carpeta: resuelve cada conflicto conservando lo que quiere cada lado, quita todas las marcas y deja que el equipo cierre el merge (no hagas commit).",
                work.title, work.member_name
            ),
        );
        fix.ref_item = work.id.clone();
        fix.worktree_path = work.worktree_path.clone();
        fix.branch = work.branch.clone();
        fix.approved = true;
        if resolver.member.id == work.member_id {
            fix.task_id = work.task_id.clone();
        }
        fix.feedback = conflicts.iter().map(|f| format!("- {f}")).collect::<Vec<_>>().join("\n");
        team::insert_item(c, &fix).map_err(e2s)?;
        team::post(c, &run.id, &fix.id, ("system", "CodeFlow"), (&resolver.member.id, &resolver.member.name), "merge", &format!("conflicto al integrar «{}»: {}", work.title, conflicts.join(", ")), &[])
            .map_err(e2s)?;
        Ok(())
    })
}
