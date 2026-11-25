use super::*;

/// How long an abort waits for the run's turns to stop before giving up on removing its folders.
pub(crate) const ABORT_GRACE: std::time::Duration = std::time::Duration::from_secs(25);

/// Lets an item go on without the dependencies no task of the run answers to. `true` when it had any.
pub(crate) fn clear_dangling(item: &mut Item, conn: &Connection, run_id: &str) -> Result<bool, String> {
    let items = team::list_items(conn, run_id).map_err(e2s)?;
    let before = (item.depends_on.len(), item.intelligence.missing_deps.len());
    item.depends_on.retain(|dep| items.iter().any(|i| i.id == *dep));
    item.intelligence.missing_deps.clear();
    Ok(before != (item.depends_on.len(), 0))
}

/// Removes a run's worktrees (only clean ones — `git worktree remove` without force) and then every
/// run branch whose commits are all in the target branch already: the item branches and, unless the
/// run leaves it for you (`integrate: branch`), the integration branch. A branch holding work that
/// never reached the target — a cancelled member's commits, a dirty worktree's branch — stays.
pub(crate) async fn tidy_run(db: &Db, run_id: &str) -> Result<(), String> {
    let (run, repos, items) = with(db, |c| {
        let run = team::get_run(c, run_id).map_err(e2s)?;
        Ok((run, team::list_repos(c, run_id).map_err(e2s)?, team::list_items(c, run_id).map_err(e2s)?))
    })?;
    // What its isolated checks left in the container engine goes with it; the engine is asked off
    // to the side, so a run closes as fast with one as without.
    if run.as_ref().is_some_and(|r| r.policy.sandbox == "checks") || items.iter().any(|i| i.intelligence.evidence.iter().any(|e| !e.sandbox.is_empty())) {
        let id = run_id.to_string();
        tauri::async_runtime::spawn(async move { team::sandbox::forget_run(&id).await });
    }
    // A pull request's source branch stays too: it is what the pull request shows.
    let keep_integration = run.as_ref().is_some_and(|r| matches!(r.policy.integrate.as_str(), "branch" | "pr"));
    for repo in repos {
        let mine: Vec<&Item> = items.iter().filter(|i| i.project_id == repo.project_id).collect();
        let mut paths: Vec<String> = mine.iter().map(|i| i.worktree_path.clone()).filter(|p| !p.is_empty()).collect();
        paths.push(repo.integration_path.clone());
        paths.sort();
        paths.dedup();
        let mut branches: Vec<String> = mine.iter().map(|i| i.branch.clone()).filter(|b| !b.is_empty()).collect();
        branches.sort();
        branches.dedup();
        let (r, target, integration) = (repo.local_path.clone(), repo.target_branch.clone(), repo.integration_branch.clone());
        let _ = blocking(move || {
            let _git = crate::git::write_lock(&r);
            for p in &paths {
                gitops::remove_worktree(&r, p);
            }
            // Item branches into the integration branch they were merged into, when that one stays.
            let into = if keep_integration { &integration } else { &target };
            for b in &branches {
                gitops::delete_branch_if_contained(&r, b, into);
            }
            if !keep_integration {
                gitops::delete_branch_if_contained(&r, &integration, &target);
            }
        })
        .await;
    }
    Ok(())
}

pub(crate) fn set_run_policy(conn: &Connection, run_id: &str, policy: &Policy) -> Result<(), String> {
    let policy = policy.clone().sane();
    conn.execute(
        "UPDATE agent_team_runs SET policy = ?2, updated_at = ?3 WHERE id = ?1",
        rusqlite::params![run_id, serde_json::to_string(&policy).map_err(e2s)?, queries::now()],
    )
    .map_err(e2s)?;
    Ok(())
}

/// An order about a whole run or one of its items: `pause`, `resume`, `abort`,
/// `continue-without-deps`, `retry:<item>`, `undep:<item>`, `skip:<item>`. Returns the tasks that
/// were running when it arrived.
pub async fn control<H: crate::runner::Host>(host: &H, run_id: &str, action: &str) -> Result<Vec<String>, String> {
    let db = host.db();
    let run_id = run_id.to_string();
    let lock = run_lock(&run_id);
    let _guard = lock.lock().await;
    let running = with(db, |c| {
        let items = team::list_items(c, &run_id).map_err(e2s)?;
        let running: Vec<String> = items.iter().filter(|i| i.status == "running" && !i.task_id.is_empty()).map(|i| i.task_id.clone()).collect();
        match action {
            "pause" => team::set_run_status(c, &run_id, "paused", "", "").map_err(e2s)?,
            "resume" => {
                team::set_run_reason(c, &run_id, "").map_err(e2s)?;
                team::set_run_status(c, &run_id, "running", "", "").map_err(e2s)?
            }
            "abort" => {
                for mut i in items.into_iter().filter(|i| matches!(i.status.as_str(), "pending" | "gated" | "running" | "waiting")) {
                    i.status = "cancelled".into();
                    i.intelligence.recovery = None;
                    team::update_item(c, &i).map_err(e2s)?;
                }
                team::set_run_status(c, &run_id, "aborted", "", "").map_err(e2s)?;
                crate::runner::cancel_run_on(host, &run_id);
            }
            "continue-without-deps" => {
                for mut i in items.into_iter().filter(|i| i.status == "pending") {
                    if clear_dangling(&mut i, c, &run_id)? {
                        team::update_item(c, &i).map_err(e2s)?;
                    }
                }
            }
            other => {
                if let Some(id) = other.strip_prefix("retry:") {
                    if let Some(mut i) = team::get_item(c, id).map_err(e2s)? {
                        if i.run_id == run_id && (matches!(i.status.as_str(), "error" | "cancelled" | "skipped")
                            || (i.status == "waiting" && i.intelligence.recovery.is_some())) {
                            if let Some(recovery) = i.intelligence.recovery.as_ref() {
                                if let Some(run) = team::get_run(c, &run_id).map_err(e2s)? {
                                    for mut waiting in items.iter().filter(|other| other.id != i.id && other.status == "waiting"
                                        && other.intelligence.recovery.as_ref().is_some_and(|other_recovery| other_recovery.kind == recovery.kind
                                            && intelligence::blocked_by(c, &run, other, recovery))).cloned() {
                                        waiting.status = "pending".into();
                                        waiting.intelligence.recovery = None;
                                        team::update_item(c, &waiting).map_err(e2s)?;
                                    }
                                }
                            }
                            i.status = "pending".into();
                            i.attempts = 0;
                            i.intelligence.recovery = None;
                            team::update_item(c, &i).map_err(e2s)?;
                        }
                    }
                } else if let Some(id) = other.strip_prefix("undep:") {
                    if let Some(mut i) = team::get_item(c, id).map_err(e2s)?.filter(|i| i.run_id == run_id && i.status == "pending") {
                        if clear_dangling(&mut i, c, &run_id)? {
                            team::update_item(c, &i).map_err(e2s)?;
                            team::post(c, &run_id, &i.id, ("user", "Tú"), ("all", "Equipo"), "decision", &format!("«{}» sigue sin la dependencia que no existe", i.title), &[]).map_err(e2s)?;
                        }
                    }
                } else if let Some(id) = other.strip_prefix("skip:") {
                    if let Some(mut i) = team::get_item(c, id).map_err(e2s)? {
                        if i.run_id == run_id && matches!(i.status.as_str(), "pending" | "gated" | "error" | "waiting") {
                            i.status = "skipped".into();
                            i.intelligence.recovery = None;
                            team::update_item(c, &i).map_err(e2s)?;
                        }
                    }
                }
            }
        }
        Ok(running)
    })?;
    if action != "abort" && action != "pause" {
        advance(db, &run_id).await?;
    }
    drop(_guard);
    if action == "abort" {
        // The windows hear the abort now; the folders go once nobody writes into them.
        host.emit("team:changed", serde_json::json!({ "runId": run_id }));
        // A turn told to stop takes a moment to do it, and its agent may be mid-write: the
        // worktrees are removed only once every turn of the run has landed. One that will not
        // stop keeps its folder — a leftover worktree is cheaper than an agent writing into a
        // folder that is being deleted.
        if crate::runner::wait_idle(&run_id, ABORT_GRACE).await {
            // A cancelled run leaves nothing behind but work: clean worktrees and empty branches go.
            let _ = tidy_run(db, &run_id).await;
        } else {
            let _ = with(db, |c| {
                team::post(c, &run_id, "", ("system", "CodeFlow"), ("user", "Tú"), "status",
                    "Un agente no se detuvo a tiempo: sus carpetas de trabajo quedan en disco. Puedes quitarlas desde Taller › Worktrees.", &[]).map(|_| ()).map_err(e2s)
            });
        }
    }
    host.emit("team:changed", serde_json::json!({ "runId": run_id }));
    crate::runner::kick_on(host, &run_id);
    Ok(running)
}
