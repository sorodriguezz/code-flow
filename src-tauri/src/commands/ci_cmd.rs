//! The Pipelines tab's commands.
//!
//! Every one of them dispatches on the same [`linked_repo`] the pull-request commands do. That is
//! the whole reason none of them takes a provider argument: the project already knows which host
//! it belongs to, and a frontend that says it a second time is a frontend whose answer can drift
//! from the backend's — showing one host's tab while fetching from another's API.
//!
//! Nothing here caches. Runs are asked for live, exactly as `list_pull_requests` does, because the
//! interesting ones are the ones that are still moving; a cache of a running pipeline is a picture
//! of a thing that has already changed. What *is* persisted is the failure analysis, and that goes
//! into `job_history` alongside every other AI run rather than into a table of its own.

use tauri::State;

use crate::ci::{self, PipelineAvailability, PipelineRun, PipelineRunDetail};
use crate::commands::ado_cmd::{
    ado_connected_orgs, connected_hosts, github_token, gitlab_token, linked_repo, load_project,
    pat_for_org, LinkedRepo,
};
use crate::db::Db;

/// How many runs a page holds when the caller doesn't say.
///
/// Fifty is roughly a fortnight of a busy repository's history and one screen of scrolling. The
/// frontend passes its own number; this is the floor for anything that forgets to.
const DEFAULT_LIMIT: usize = 50;
/// A ceiling on what the frontend may ask for, so a bad number can't turn one click into twenty
/// requests against a rate-limited host.
const MAX_LIMIT: usize = 200;

fn clamp(limit: usize) -> usize {
    if limit == 0 { DEFAULT_LIMIT } else { limit.min(MAX_LIMIT) }
}

/// An empty branch filter arrives from the UI as `Some("")` about as often as `None` — a cleared
/// input rather than an absent one. Both mean "every branch".
fn branch_filter(branch: &Option<String>) -> Option<&str> {
    branch.as_deref().map(str::trim).filter(|b| !b.is_empty())
}

/// Whether this repository should have a Pipelines tab, and against which host.
///
/// Answers both halves of the gate in one call so the frontend never has to re-derive
/// [`linked_repo`]'s provider precedence. It also deliberately answers **without touching the
/// keychain**: connection state comes from the `*_connections` app-settings, for the reason the
/// comment above `connected_hosts` spells out — on macOS with an ad-hoc signature every keychain
/// read pops a password dialog, and this runs whenever a repository is selected.
///
/// The consequence, stated plainly because the UI has to handle it: this can say `connected: true`
/// for a token that exists but lacks the CI scope. Finding that out costs a request. The tab
/// appears, the first fetch fails, and the error names the missing permission — see
/// `ci::http::missing_scope`.
#[tauri::command]
pub async fn pipeline_availability(
    db: State<'_, Db>,
    project_id: String,
) -> Result<PipelineAvailability, String> {
    let project = load_project(&db, &project_id)?;
    let Ok(link) = linked_repo(&project) else {
        return Ok(PipelineAvailability { provider: None, connected: false, host: None });
    };

    let (provider, host, connected) = match &link {
        LinkedRepo::GitHub { host, .. } => {
            let hosts = connected_hosts(&db, "github_connections")?;
            (ci::PROVIDER_GITHUB, host.clone(), contains_ignoring_case(&hosts, host))
        }
        LinkedRepo::GitLab { host, .. } => {
            let hosts = connected_hosts(&db, "gitlab_connections")?;
            (ci::PROVIDER_GITLAB, host.clone(), contains_ignoring_case(&hosts, host))
        }
        LinkedRepo::Azure { org, .. } => {
            let orgs = ado_connected_orgs(&db)?;
            (ci::PROVIDER_AZURE, org.clone(), contains_ignoring_case(&orgs, org))
        }
    };

    Ok(PipelineAvailability {
        provider: Some(provider.to_string()),
        host: Some(host),
        connected,
    })
}

/// Neither an Enterprise hostname nor an Azure organization is case-sensitive to its own API, and
/// a hand-typed connection routinely differs in case from the one a remote URL carried.
fn contains_ignoring_case(haystack: &[String], needle: &str) -> bool {
    haystack.iter().any(|entry| entry.eq_ignore_ascii_case(needle))
}

/// The most recent runs, newest first.
#[tauri::command]
pub async fn list_pipeline_runs(
    db: State<'_, Db>,
    project_id: String,
    branch: Option<String>,
    limit: usize,
) -> Result<Vec<PipelineRun>, String> {
    let project = load_project(&db, &project_id)?;
    let branch = branch_filter(&branch);
    let limit = clamp(limit);

    match linked_repo(&project)? {
        LinkedRepo::GitHub { host, owner, repo } => {
            let token = github_token(&host)?;
            ci::github::list_runs(&host, &owner, &repo, branch, limit, &token).await
        }
        LinkedRepo::GitLab { host, project: path } => {
            let token = gitlab_token(&host)?;
            ci::gitlab::list_pipelines(&host, &path, branch, limit, &token).await
        }
        LinkedRepo::Azure { org, project: ado_project, repo_id } => {
            let pat = pat_for_org(&org)?;
            ci::azure::list_builds(&org, &ado_project, &repo_id, branch, limit, &pat).await
        }
    }
}

/// One run and its jobs.
///
/// The run comes back as well as the jobs, and that is not redundancy: for two of the three
/// providers the run's own bucket can only be settled once the jobs are known. GitHub has no
/// "succeeded with warnings" conclusion at all, and GitLab has one but doesn't put it in the list
/// response. The row in the list is corrected from what this returns.
#[tauri::command]
pub async fn pipeline_run_detail(
    db: State<'_, Db>,
    project_id: String,
    run_id: String,
) -> Result<PipelineRunDetail, String> {
    let project = load_project(&db, &project_id)?;
    match linked_repo(&project)? {
        LinkedRepo::GitHub { host, owner, repo } => {
            let token = github_token(&host)?;
            ci::github::run_detail(&host, &owner, &repo, &run_id, &token).await
        }
        LinkedRepo::GitLab { host, project: path } => {
            let token = gitlab_token(&host)?;
            ci::gitlab::pipeline_detail(&host, &path, &run_id, &token).await
        }
        LinkedRepo::Azure { org, project: ado_project, .. } => {
            let pat = pat_for_org(&org)?;
            ci::azure::build_detail(&org, &ado_project, &run_id, &pat).await
        }
    }
}

/// One job's log, as the host served it.
///
/// Two identifiers rather than one because Azure needs two: its logs hang off timeline *records*,
/// not off jobs, so `log_ref` carries the record's `log.id` (or the comma-separated ids of a job's
/// child tasks, which are concatenated). The other two providers ignore it and address the log by
/// the job's own id.
#[tauri::command]
pub async fn fetch_pipeline_job_log(
    db: State<'_, Db>,
    project_id: String,
    run_id: String,
    job_id: String,
    log_ref: Option<String>,
) -> Result<ci::JobLog, String> {
    let project = load_project(&db, &project_id)?;
    match linked_repo(&project)? {
        LinkedRepo::GitHub { host, owner, repo } => {
            let token = github_token(&host)?;
            ci::github::job_log(&host, &owner, &repo, &job_id, &token).await
        }
        LinkedRepo::GitLab { host, project: path } => {
            let token = gitlab_token(&host)?;
            ci::gitlab::job_log(&host, &path, &job_id, &token).await
        }
        LinkedRepo::Azure { org, project: ado_project, .. } => {
            let pat = pat_for_org(&org)?;
            let log_ref = log_ref.filter(|r| !r.trim().is_empty()).ok_or_else(|| {
                "That Azure build step published no log — nothing ran, or the agent never \
                 reported one"
                    .to_string()
            })?;
            ci::azure::job_log(&org, &ado_project, &run_id, &log_ref, &pat).await
        }
    }
}

// ---------------------------------------------------------------------------
// Failure analysis
// ---------------------------------------------------------------------------

/// Asks the AI why a job failed, with the log, the pipeline's own definition and the repository
/// in front of it.
///
/// The log is fetched here rather than taken from the frontend, and that is deliberate: the pane
/// may be showing a log that was downloaded minutes ago, and a job that was still running then has
/// more to say now. It also means the *trimming* happens on this side of the wire, where the rules
/// live — trimmed from the **end**, which is the one thing every other truncation in this codebase
/// gets the other way round, and the reason `ci::head_and_tail` exists at all.
///
/// `ai_run_id` is minted by the frontend before the invoke. That is the convention everywhere in
/// this app and it is not decoration: the engine starts emitting `ai:output-batch` events the
/// moment it spawns, and a caller that only learns the id from the return value has already missed
/// them.
#[tauri::command]
pub async fn analyze_pipeline_failure(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    project_id: String,
    run_id: String,
    job_id: String,
    log_ref: Option<String>,
    ai_run_id: String,
) -> Result<String, String> {
    let project = load_project(&db, &project_id)?;

    // Before any work at all, and before the checkpoint or the history row: this run spawns an
    // engine against the working copy and syncs skills into `<repo>/.claude/skills`, which another
    // agent turn on the same folder deletes and recreates underneath it. One engine per repository.
    let _repo_lease = crate::ai_locks::acquire(&project.local_path)
        .ok_or_else(|| format!("{}{}", crate::ai_locks::BUSY_MARKER, project.name))?;

    let (config, template) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let config = crate::commands::claude_cmd::load_ai_config(
            &conn,
            crate::commands::claude_cmd::AiTask::Pipeline,
        )?;
        // Shared with every other provider, like the rest of the templates — the prompt is about
        // reading a CI log, and nothing about that changes because the engine behind it changed.
        let template = crate::commands::claude_cmd::shared_template(&conn, "pipeline_template", "")?;
        (config, template)
    };

    let detail = pipeline_run_detail(db.clone(), project_id.clone(), run_id.clone()).await?;
    let job = detail
        .jobs
        .iter()
        .find(|candidate| candidate.id == job_id)
        .ok_or_else(|| "That job is no longer part of this run".to_string())?;

    // A job that is still going has not finished failing. Its log ends wherever the last flush
    // landed, which is routinely a few lines before the error, and an analysis of that is a
    // confident answer about a stack trace that had not been printed yet. Checked here rather than
    // only in the UI because the run could have been restarted between the click and this line.
    if ci::is_live(&job.status) {
        return Err("Espera a que ese job termine: su log todavía no está completo".to_string());
    }

    let log = fetch_pipeline_job_log(
        db.clone(),
        project_id.clone(),
        run_id.clone(),
        job_id.clone(),
        log_ref,
    )
    .await?;

    // Cleaned then trimmed, in that order: stripping the per-line timestamps and the fold markers
    // first means the budget below is spent on output rather than on 28 characters of ISO date in
    // front of every line.
    let cleaned = ci::clean_ci_markers(&log.text);
    let (trimmed, _) = ci::head_and_tail(&cleaned, ci::MAX_AI_LOG_CHARS);

    let took = ci::duration_secs(job.started_at.as_deref(), job.finished_at.as_deref());
    let facts: Vec<(String, String)> = vec![
        ("Proveedor".to_string(), detail.run.provider.clone()),
        ("Pipeline".to_string(), detail.run.name.clone()),
        ("Estado del run".to_string(), detail.run.raw_status.clone()),
        ("Rama".to_string(), detail.run.branch.clone()),
        ("Commit".to_string(), detail.run.commit_sha.clone()),
        (
            "Mensaje del commit".to_string(),
            detail.run.commit_title.clone().unwrap_or_else(|| "(desconocido)".to_string()),
        ),
        ("Job que falló".to_string(), job.name.clone()),
        ("Estado del job".to_string(), job.raw_status.clone()),
        (
            "Duración del job".to_string(),
            took.map(|s| format!("{s}s")).unwrap_or_else(|| "(sin datos)".to_string()),
        ),
        (
            "Otros jobs de la ejecución".to_string(),
            // Worth its place in the prompt: three green siblings and one red one is a very
            // different diagnosis from four red ones, and it is the first thing a person would look
            // at. Nothing else in the payload carries it.
            detail
                .jobs
                .iter()
                .map(|other| format!("{} = {}", other.name, other.status))
                .collect::<Vec<_>>()
                .join(", "),
        ),
    ];

    // The pipeline's own definition, when the host names one and the working copy still has it.
    // Best-effort by design: the file may have been renamed since the run, or the checkout may be
    // on a different commit — in which case the analysis proceeds without it rather than failing,
    // and simply has one less thing to check the log against.
    let definition = detail.run.definition_path.as_deref().and_then(|path| {
        crate::fsops::read_file_text(&project.local_path, path).ok().map(|text| (path.to_string(), text))
    });

    let result = crate::ai_runs::scoped(app, Some(ai_run_id.clone()), async {
        crate::ai::analyze_pipeline_failure(
            &*config.engine,
            &config.binary,
            &config.model,
            &facts,
            definition.as_ref().map(|(path, text)| (path.as_str(), text.as_str())),
            &trimmed,
            &config.tools,
            &project.local_path,
            &template,
        )
        .await
    })
    .await;

    // Filed alongside every other AI run rather than in a table of its own — the answer is the
    // durable part of this feature and the runs are not. A run the user stopped is not history: it
    // has no result, and recording it as an error would leave a permanent red row for something
    // they did on purpose.
    if !matches!(&result, Err(e) if e.starts_with(crate::ai_runs::CANCELLED_MARKER)) {
        let label = format!("Pipeline · {}", job.name);
        // The coordinates the Activity list needs to reopen this. `run_key` is the same
        // `${project}:${provider}:${run}` the frontend keys everything by (see `runKey` in
        // `ciStore`) — a bare run id would be ambiguous, since a build number repeats across
        // repositories and providers. Without this the row exists and clicking it does nothing.
        let meta = serde_json::json!({
            "pipelineRunKey": format!("{project_id}:{}:{}", detail.run.provider, detail.run.id),
            "pipelineJobId": job.id,
        })
        .to_string();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let _ = match &result {
            Ok(text) => crate::db::queries::add_job_history(
                &conn, &ai_run_id, &project_id, "pipeline-analyze", &label, "done", Some(text), None, &meta,
            ),
            Err(e) => crate::db::queries::add_job_history(
                &conn, &ai_run_id, &project_id, "pipeline-analyze", &label, "error", None, Some(e), &meta,
            ),
        };
    }

    result
}
