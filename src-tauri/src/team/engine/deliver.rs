use super::*;

/// The run's last step, by the policy: a pull request per repository, or the work landed on the
/// target branch.
pub(crate) async fn deliver(db: &Db, run: &Run) -> Result<(), String> {
    if run.policy.integrate == "pr" {
        open_prs(db, run).await
    } else {
        land_all(db, run).await
    }
}

/// Opens a pull request per repository with work (`integrate: pr`). The target's latest tip is
/// merged into the integration branch, the branch is published on `origin`, and the pull request
/// goes from it into the target on whichever host the repository is linked to, with the tokens the
/// user already set up. The app opens it, not an agent: no tokens spent, no `gh` needed.
///
/// A repository that cannot get one (not linked, no token, the push refused) stops the run at the
/// integration question with the reason; its branch is kept. Approving retries it, rejecting
/// leaves the branch. Repositories whose pull request already opened are not touched again.
pub(crate) async fn open_prs(db: &Db, run: &Run) -> Result<(), String> {
    let state = state_of(db, &run.id)?;
    for repo in state.repos.iter().filter(|r| r.status == "ready" || r.status == "failed") {
        let (root, target, path, branch) = (repo.local_path.clone(), repo.target_branch.clone(), repo.integration_path.clone(), repo.integration_branch.clone());
        let prepared = blocking(move || {
            let _git = crate::git::write_lock(&root);
            let ready = gitops::prepare_pr(&root, &target, &path, &branch)?;
            if matches!(ready, gitops::PrReady::Ready { .. }) {
                gitops::publish_branch(&root, &branch)?;
            }
            Ok::<_, String>(ready)
        })
        .await?;
        let base = match prepared {
            Ok(gitops::PrReady::Ready { base }) => base,
            Ok(gitops::PrReady::Empty) => {
                with(db, |c| {
                    team::set_repo_status(c, &run.id, &repo.project_id, "left", "").map_err(e2s)?;
                    team::post(c, &run.id, "", ("system", "CodeFlow"), ("user", "Tú"), "merge", &format!("{}: no hay cambios respecto de {}; no se abrió un PR.", repo.name, repo.target_branch), &[])
                        .map(|_| ())
                        .map_err(e2s)
                })?;
                continue;
            }
            Ok(gitops::PrReady::Conflict(files)) => return target_conflict(db, run, repo, &files),
            Err(e) => return pr_failed(db, run, repo, &e),
        };
        let (root, source) = (repo.local_path.clone(), repo.integration_branch.clone());
        let commits = blocking(move || gitops::commits_between(&root, &base, &source)).await?.unwrap_or_default();
        let draft = pr_draft(&state, repo, &commits, true);
        let title = gitops::commit_message(&run.policy.commit_style, "", &draft.title);
        let body = pr_body(&state, repo, &draft.body);
        let project = match with(db, |c| queries::get_project(c, &repo.project_id).map_err(e2s)) {
            Ok(Some(project)) => project,
            Ok(None) => return pr_failed(db, run, repo, "el repositorio ya no está en la app"),
            Err(e) => return pr_failed(db, run, repo, &e),
        };
        match crate::commands::ado_cmd::create_pull_request_for(&project, &title, &body, &repo.integration_branch, &repo.target_branch, run.policy.pr_draft, Vec::new()).await {
            Ok(pr) => with(db, |c| {
                team::set_repo_pr(c, &run.id, &repo.project_id, &pr.url).map_err(e2s)?;
                let kind = if run.policy.pr_draft { "PR en borrador" } else { "PR" };
                team::post(c, &run.id, "", ("system", "CodeFlow"), ("user", "Tú"), "merge", &format!("{}: {kind} abierto, `{}` → `{}` — {}", repo.name, repo.integration_branch, repo.target_branch, pr.url), &[])
                    .map(|_| ())
                    .map_err(e2s)
            })?,
            Err(e) => return pr_failed(db, run, repo, &e),
        }
    }
    if run.policy.cleanup {
        tidy_run(db, &run.id).await?;
    }
    with(db, |c| team::set_run_status(c, &run.id, "done", "", "").map_err(e2s))
}

/// The draft's body plus what only a run-opened pull request needs: the other repositories of the
/// same run, so a reviewer knows the change has parts elsewhere.
pub(crate) fn pr_body(state: &RunState, repo: &RunRepo, body: &str) -> String {
    let mut out = body.trim_end().to_string();
    let others: Vec<&RunRepo> = state.repos.iter().filter(|r| r.project_id != repo.project_id).collect();
    if !others.is_empty() {
        out.push_str("\n\n## Otros repositorios de esta corrida\n");
        for other in others {
            out.push_str(&format!("- {} · `{}`\n", other.name, other.integration_branch));
        }
    }
    out.push_str(&format!("\n---\nAbierto por el equipo «{}» de CodeFlow.\n", state.run.team_name));
    out
}

/// A pull request that could not open: the repository is marked with the reason and the run waits
/// at the integration question, the team's branch untouched.
pub(crate) fn pr_failed(db: &Db, run: &Run, repo: &RunRepo, error: &str) -> Result<(), String> {
    with(db, |c| {
        team::set_repo_status(c, &run.id, &repo.project_id, "failed", error).map_err(e2s)?;
        team::set_run_status(
            c,
            &run.id,
            "gated",
            "merge",
            &format!("{}: no se pudo abrir el PR — {error}. La rama `{}` queda intacta: corrígelo y aprueba para reintentar, o rechaza para dejar la rama.", repo.name, repo.integration_branch),
        )
        .map_err(e2s)
    })
}

/// The target moved and conflicts with the team's work: a member resolves it in the integration
/// tree (or the user, by the policy), then the delivery runs again.
pub(crate) fn target_conflict(db: &Db, run: &Run, repo: &RunRepo, files: &[String]) -> Result<(), String> {
    let resolver = match run.policy.conflicts.as_str() {
        "user" | "author" | "" => None,
        id => member(run, id).cloned(),
    }
    .or_else(|| run.members.iter().find(|m| m.member.edits && m.member.id != run.lead).cloned());
    with(db, |c| match resolver.filter(|_| run.policy.conflicts != "user") {
        Some(resolver) => {
            let items = team::list_items(c, &run.id).map_err(e2s)?;
            let mut fix = team::new_item(
                run,
                &team::free_key(&items, "merge-destino"),
                Some(&resolver),
                &repo.project_id,
                "integrate",
                &format!("Resolver conflictos con {}", repo.target_branch),
                &format!("{} cambió mientras el equipo trabajaba y choca con el trabajo integrado. El merge está a medias en esta carpeta: resuelve los conflictos conservando ambos lados y quita las marcas (no hagas commit).", repo.target_branch),
            );
            fix.worktree_path = repo.integration_path.clone();
            fix.approved = true;
            fix.feedback = files.iter().map(|f| format!("- {f}")).collect::<Vec<_>>().join("\n");
            team::insert_item(c, &fix).map_err(e2s)?;
            Ok(())
        }
        None => team::set_run_status(c, &run.id, "gated", "stuck:", &format!("{} choca con {} en: {}. Resuélvelo en {} y aprueba.", repo.target_branch, repo.integration_branch, files.join(", "), repo.integration_path))
            .map_err(e2s),
    })
}

/// Lands every ready repository on its target branch, by the policy.
pub(crate) async fn land_all(db: &Db, run: &Run) -> Result<(), String> {
    let repos = with(db, |c| team::list_repos(c, &run.id).map_err(e2s))?;
    // Git has no transaction across repositories, so the one thing that can be known beforehand is
    // found out beforehand: each target is merged into its integration branch — where a conflict
    // is a member's to resolve, and nothing of the user's has moved — and only when every
    // repository is clean does the first one land. A conflict in the third no longer leaves the
    // first two delivered and the feature half-shipped.
    for repo in repos.iter().filter(|r| r.status == "ready") {
        let (r, t, p) = (repo.local_path.clone(), repo.target_branch.clone(), repo.integration_path.clone());
        let synced = blocking(move || {
            let _git = crate::git::write_lock(&r);
            gitops::sync_target(&r, &t, &p)
        })
        .await?;
        match synced {
            Ok(files) if files.is_empty() => {}
            Ok(files) => return target_conflict(db, run, repo, &files),
            Err(e) => {
                return with(db, |c| {
                    team::set_repo_status(c, &run.id, &repo.project_id, "failed", &e).map_err(e2s)?;
                    team::set_run_status(c, &run.id, "gated", "merge", &format!("{}: no se pudo integrar — {e}. Ningún repositorio se entregó todavía.", repo.name)).map_err(e2s)
                });
            }
        }
    }
    for repo in repos.iter().filter(|r| matches!(r.status.as_str(), "ready" | "landing")) {
        // A landing the app did not live to record: if the target already holds the work, it is
        // recorded now rather than done a second time.
        if repo.status == "landing" {
            let (r, t, b) = (repo.local_path.clone(), repo.target_branch.clone(), repo.integration_branch.clone());
            if blocking(move || gitops::already_landed(&r, &t, &b)).await? {
                with(db, |c| {
                    team::set_repo_status(c, &run.id, &repo.project_id, "merged", "").map_err(e2s)?;
                    team::post(c, &run.id, "", ("system", "CodeFlow"), ("user", "Tú"), "merge", &format!("{}: ya estaba integrado en {}", repo.name, repo.target_branch), &[]).map(|_| ()).map_err(e2s)
                })?;
                continue;
            }
        }
        with(db, |c| team::set_repo_status(c, &run.id, &repo.project_id, "landing", "").map_err(e2s))?;
        let (r, t, p, b, mode, push) = (
            repo.local_path.clone(),
            repo.target_branch.clone(),
            repo.integration_path.clone(),
            repo.integration_branch.clone(),
            run.policy.commit.clone(),
            run.policy.push,
        );
        let message = gitops::commit_message(&run.policy.commit_style, "", &run.title);
        let landed = blocking(move || {
            let _git = crate::git::write_lock(&r);
            gitops::land(&r, &t, &p, &b, &mode, &message, push)
        })
        .await?;
        match landed {
            Ok(gitops::Landed::Done(summary)) => with(db, |c| {
                team::set_repo_status(c, &run.id, &repo.project_id, "merged", "").map_err(e2s)?;
                team::post(c, &run.id, "", ("system", "CodeFlow"), ("user", "Tú"), "merge", &format!("{}: {summary}", repo.name), &[]).map(|_| ()).map_err(e2s)
            })?,
            Ok(gitops::Landed::Conflict(files)) => {
                with(db, |c| team::set_repo_status(c, &run.id, &repo.project_id, "ready", "").map_err(e2s))?;
                return target_conflict(db, run, repo, &files);
            }
            Err(e) => {
                // What landed before this one stays landed, and the channel says exactly which.
                let landed: Vec<String> = with(db, |c| team::list_repos(c, &run.id).map_err(e2s))?.into_iter().filter(|r| r.status == "merged").map(|r| r.name).collect();
                let partial = if landed.is_empty() { String::new() } else { format!(" Ya quedaron integrados: {}.", landed.join(", ")) };
                return with(db, |c| {
                    team::set_repo_status(c, &run.id, &repo.project_id, "failed", &e).map_err(e2s)?;
                    team::set_run_status(c, &run.id, "gated", "merge", &format!("{}: no se pudo integrar — {e}.{partial}", repo.name)).map_err(e2s)
                });
            }
        }
    }
    // Everything landed: tidy up — the worktrees, and the branches whose work is now in the target.
    if run.policy.cleanup {
        tidy_run(db, &run.id).await?;
    }
    with(db, |c| team::set_run_status(c, &run.id, "done", "", "").map_err(e2s))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrDraft {
    pub title: String,
    pub body: String,
    pub source: String,
    pub target: String,
}

pub(crate) fn pr_draft(state: &RunState, repo: &RunRepo, commits: &str, spanish: bool) -> PrDraft {
    let label = |es: &'static str, en: &'static str| if spanish { es } else { en };
    let goal = state.run.goal.split("\n\n## Contexto del chat").next().unwrap_or_default();
    let goal = goal.split("\n\nArchivos adjuntos a este mensaje").next().unwrap_or_default();
    let goal = intelligence::portable_text(goal, &[&repo.local_path, &repo.integration_path]);
    let mut body = format!("## {}\n{}\n\n## Commits\n", label("Objetivo", "Goal"), trim_chars(&goal, 2000));
    for commit in commits.lines() {
        body.push_str(&format!("- {commit}\n"));
    }
    body.push_str(&format!("\n## {}\n", label("Verificación y pendientes", "Verification and open items")));
    let latest = coordination::latest_contracts(&state.items);
    for item in state.items.iter().filter(|item| item.project_id == repo.project_id && !item.is_lead()) {
        let checked = item.status == "done" && coordination::outdated_contracts(item, &latest).is_empty()
            && item.intelligence.evidence.iter().all(|evidence| matches!(evidence.result.as_str(), "reported" | "passed"));
        body.push_str(&format!("- [{}] {}\n", if checked { "x" } else { " " }, item.title));
        for evidence in &item.intelligence.evidence {
            let status = match evidence.result.as_str() {
                "passed" => label("pasó", "passed"),
                "reported" => label("reportado por el agente", "reported by the agent"),
                "unverified" => label("sin evidencia", "no evidence"),
                "preexisting" => label("fallo de base", "baseline failure"),
                "regression" => label("regresión", "regression"),
                _ => label("falló", "failed"),
            };
            body.push_str(&format!("  - {} · {status}\n", evidence.label));
        }
        let outdated = coordination::outdated_contracts(item, &latest);
        if !outdated.is_empty() {
            body.push_str(&format!("  - {} · {}\n", label("Revalidar contratos", "Revalidate contracts"), outdated.join(", ")));
        }
    }
    let prefix = format!("{} · `", repo.name);
    for check in state.messages.iter().filter(|message| message.item_id.is_empty() && message.from_id == "system" && message.body.starts_with(&prefix)).take(20) {
        body.push_str(&format!("- {}\n", check.body));
    }
    PrDraft { title: state.run.title.clone(), body, source: repo.integration_branch.clone(), target: repo.target_branch.clone() }
}
