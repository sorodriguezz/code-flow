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

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{Emitter, State};

use crate::ci::{
    self, PipelineArtifact, PipelineAvailability, PipelineLaunchContext, PipelineRun,
    PipelineRunDetail, PipelineVariable, StartPipelineRequest, StartedPipeline,
};
use crate::commands::ado_cmd::{
    ado_connected_orgs, bitbucket_auth, bitbucket_connected_workspaces, connected_hosts, github_token,
    gitlab_token, linked_repo, load_project, pat_for_org, LinkedRepo,
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
        LinkedRepo::Bitbucket { workspace, .. } => {
            let workspaces = bitbucket_connected_workspaces(&db)?;
            (ci::PROVIDER_BITBUCKET, workspace.clone(), contains_ignoring_case(&workspaces, workspace))
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
        LinkedRepo::Bitbucket { workspace, repo } => {
            let auth = bitbucket_auth(&workspace)?;
            ci::bitbucket::list_pipelines(&workspace, &repo, branch, limit, &auth).await
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
        LinkedRepo::Bitbucket { workspace, repo } => {
            let auth = bitbucket_auth(&workspace)?;
            ci::bitbucket::pipeline_detail(&workspace, &repo, &run_id, &auth).await
        }
    }
}

/// Runs a pipeline again.
///
/// `failed_only` is honoured where the host has a verb for it and ignored where its only retry
/// verb already means that — GitLab's `retry` re-runs the failed jobs and nothing else, and Azure
/// has no re-run at all, only "queue this definition again". The frontend says which of the three
/// it is about to do rather than offering an option that silently means something different per
/// host; see `pipelineRerunKind`.
#[tauri::command]
pub async fn rerun_pipeline(
    db: State<'_, Db>,
    project_id: String,
    run_id: String,
    failed_only: bool,
) -> Result<(), String> {
    let project = load_project(&db, &project_id)?;
    match linked_repo(&project)? {
        LinkedRepo::GitHub { host, owner, repo } => {
            let token = github_token(&host)?;
            ci::github::rerun(&host, &owner, &repo, &run_id, &token, failed_only).await
        }
        LinkedRepo::GitLab { host, project: path } => {
            let token = gitlab_token(&host)?;
            ci::gitlab::retry(&host, &path, &run_id, &token).await
        }
        LinkedRepo::Azure { org, project: ado_project, .. } => {
            let pat = pat_for_org(&org)?;
            // Two calls, because Azure queues from a *definition* and a build reference does not
            // carry one. See `requeue_info`.
            let (definition, branch, commit) =
                ci::azure::requeue_info(&org, &ado_project, &run_id, &pat).await?;
            ci::azure::requeue(&org, &ado_project, definition, &branch, &commit, &pat).await
        }
        // A new pipeline on the same target: Bitbucket's API has no re-run, and no "failed steps
        // only" either, so `failed_only` has nothing to mean here.
        LinkedRepo::Bitbucket { workspace, repo } => {
            let auth = bitbucket_auth(&workspace)?;
            ci::bitbucket::rerun(&workspace, &repo, &run_id, &auth).await
        }
    }
}

/// Stops a run that is still going.
#[tauri::command]
pub async fn cancel_pipeline(
    db: State<'_, Db>,
    project_id: String,
    run_id: String,
) -> Result<(), String> {
    let project = load_project(&db, &project_id)?;
    match linked_repo(&project)? {
        LinkedRepo::GitHub { host, owner, repo } => {
            let token = github_token(&host)?;
            ci::github::cancel(&host, &owner, &repo, &run_id, &token).await
        }
        LinkedRepo::GitLab { host, project: path } => {
            let token = gitlab_token(&host)?;
            ci::gitlab::cancel(&host, &path, &run_id, &token).await
        }
        LinkedRepo::Azure { org, project: ado_project, .. } => {
            let pat = pat_for_org(&org)?;
            ci::azure::cancel(&org, &ado_project, &run_id, &pat).await
        }
        LinkedRepo::Bitbucket { workspace, repo } => {
            let auth = bitbucket_auth(&workspace)?;
            ci::bitbucket::stop(&workspace, &repo, &run_id, &auth).await
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
        LinkedRepo::Bitbucket { workspace, repo } => {
            let auth = bitbucket_auth(&workspace)?;
            ci::bitbucket::step_log(&workspace, &repo, &run_id, &job_id, &auth).await
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
        let config = crate::commands::claude_cmd::load_ai_config_in(
            &conn,
            crate::commands::claude_cmd::AiTask::Pipeline,
            Some(&project.workspace_id),
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

// ---------------------------------------------------------------------------
// Starting a run by hand
// ---------------------------------------------------------------------------

/// What the "Run pipeline" dialog needs before anything is picked: which pipelines can be started,
/// the default branch, and — for GitHub's `type: environment` inputs — the environments.
///
/// Whether a GitHub workflow actually declares `workflow_dispatch` is *not* answered here: that is
/// in the workflow file, which the frontend reads (working copy first) and parses with the same
/// `yaml` package the graph already uses for `needs:`.
#[tauri::command]
pub async fn pipeline_launch_context(
    db: State<'_, Db>,
    project_id: String,
) -> Result<PipelineLaunchContext, String> {
    let project = load_project(&db, &project_id)?;
    match linked_repo(&project)? {
        LinkedRepo::GitHub { host, owner, repo } => {
            let token = github_token(&host)?;
            ci::github::launch_context(&host, &owner, &repo, &token).await
        }
        LinkedRepo::GitLab { host, project: path } => {
            let token = gitlab_token(&host)?;
            ci::gitlab::launch_context(&host, &path, &token).await
        }
        LinkedRepo::Azure { org, project: ado_project, repo_id } => {
            let pat = pat_for_org(&org)?;
            ci::azure::launch_context(&org, &ado_project, &repo_id, &pat).await
        }
        LinkedRepo::Bitbucket { workspace, repo } => {
            let auth = bitbucket_auth(&workspace)?;
            ci::bitbucket::launch_context(&workspace, &repo, &auth).await
        }
    }
}

/// A pipeline file as the host has it at `ref_name` — the fallback for when the working copy
/// doesn't have it, or can't be trusted to have this ref's version of it.
///
/// `None` when the host has no such file there, which is an answer rather than an error.
#[tauri::command]
pub async fn pipeline_definition_file(
    db: State<'_, Db>,
    project_id: String,
    path: String,
    ref_name: Option<String>,
) -> Result<Option<String>, String> {
    let path = repo_relative(&path)?;
    let reference = ref_name.as_deref().map(str::trim).filter(|value| !value.is_empty());
    if let Some(reference) = reference {
        valid_ref(reference)?;
    }
    let project = load_project(&db, &project_id)?;
    match linked_repo(&project)? {
        LinkedRepo::GitHub { host, owner, repo } => {
            let token = github_token(&host)?;
            ci::github::definition_file(&host, &owner, &repo, &path, reference, &token).await
        }
        LinkedRepo::GitLab { host, project: gitlab_path } => {
            let token = gitlab_token(&host)?;
            ci::gitlab::definition_file(&host, &gitlab_path, &path, reference, &token).await
        }
        LinkedRepo::Azure { org, project: ado_project, repo_id } => {
            let pat = pat_for_org(&org)?;
            ci::azure::definition_file(&org, &ado_project, &repo_id, &path, reference, &pat).await
        }
        LinkedRepo::Bitbucket { workspace, repo } => {
            let auth = bitbucket_auth(&workspace)?;
            ci::bitbucket::definition_file(&workspace, &repo, &path, reference, &auth).await
        }
    }
}

/// Starts a run: a GitHub `workflow_dispatch`, a GitLab pipeline on a ref, an Azure pipeline run.
///
/// Validated here as well as in the form, because the form is not the only thing that can call a
/// command and the three hosts' own refusals are not all readable: an Azure variable name with a
/// space in it comes back as a 400 about "the request", not about the name.
#[tauri::command]
pub async fn start_pipeline(
    db: State<'_, Db>,
    project_id: String,
    request: StartPipelineRequest,
) -> Result<StartedPipeline, String> {
    let project = load_project(&db, &project_id)?;
    let link = linked_repo(&project)?;
    validate_start(&request, provider_of(&link))?;
    match link {
        LinkedRepo::GitHub { host, owner, repo } => {
            let token = github_token(&host)?;
            ci::github::dispatch(
                &host,
                &owner,
                &repo,
                &request.definition_id,
                request.ref_name.trim(),
                &request.inputs,
                &token,
            )
            .await
        }
        LinkedRepo::GitLab { host, project: path } => {
            let token = gitlab_token(&host)?;
            ci::gitlab::create_pipeline(
                &host,
                &path,
                &request.ref_name,
                &request.variables,
                &request.inputs,
                &token,
            )
            .await
        }
        LinkedRepo::Azure { org, project: ado_project, .. } => {
            let pat = pat_for_org(&org)?;
            ci::azure::run_pipeline(
                &org,
                &ado_project,
                &request.definition_id,
                &request.ref_name,
                &request.inputs,
                &request.variables,
                &pat,
            )
            .await
        }
        LinkedRepo::Bitbucket { workspace, repo } => {
            let auth = bitbucket_auth(&workspace)?;
            ci::bitbucket::run_pipeline(
                &workspace,
                &repo,
                &request.definition_id,
                request.ref_name.trim(),
                &request.variables,
                &auth,
            )
            .await
        }
    }
}

// ---------------------------------------------------------------------------
// Gates: approvals and manual jobs
// ---------------------------------------------------------------------------

/// Approves or rejects a gate of kind `approval` — see `ci::PipelineGate` for what `gate_id` is on
/// each host.
///
/// The comment is required even where the host would take none: GitHub insists on one, and an
/// approval that reaches production with nothing written against it is an approval nobody can
/// explain afterwards.
#[tauri::command]
pub async fn review_pipeline_gate(
    db: State<'_, Db>,
    project_id: String,
    run_id: String,
    gate_id: String,
    approve: bool,
    comment: String,
) -> Result<(), String> {
    let comment = comment.trim();
    if comment.is_empty() {
        return Err("Write a comment to go with the decision".to_string());
    }
    let project = load_project(&db, &project_id)?;
    match linked_repo(&project)? {
        LinkedRepo::GitHub { host, owner, repo } => {
            let token = github_token(&host)?;
            ci::github::review_deployment(
                &host, &owner, &repo, &run_id, &gate_id, approve, comment, &token,
            )
            .await
        }
        LinkedRepo::GitLab { host, project: path } => {
            let token = gitlab_token(&host)?;
            ci::gitlab::review_deployment(&host, &path, &gate_id, approve, comment, &token).await
        }
        LinkedRepo::Azure { org, project: ado_project, .. } => {
            let pat = pat_for_org(&org)?;
            ci::azure::review_approval(&org, &ado_project, &gate_id, approve, comment, &pat).await
        }
        // Its only gate is a paused pipeline's manual step, which is not an approval — and which the
        // public API has no verb for either. The gate's own link opens it on Bitbucket.
        LinkedRepo::Bitbucket { .. } => Err("Bitbucket's API can't answer a pipeline gate — open it on Bitbucket".to_string()),
    }
}

/// Starts a manual job, with job variables when the user typed any. GitLab only: it is the one host
/// with jobs that wait for a person to start them.
#[tauri::command]
pub async fn play_pipeline_job(
    db: State<'_, Db>,
    project_id: String,
    job_id: String,
    variables: Vec<PipelineVariable>,
) -> Result<(), String> {
    let project = load_project(&db, &project_id)?;
    match linked_repo(&project)? {
        LinkedRepo::GitLab { host, project: path } => {
            validate_variables(&variables, ci::PROVIDER_GITLAB)?;
            let token = gitlab_token(&host)?;
            ci::gitlab::play_job(&host, &path, &job_id, &variables, &token).await
        }
        LinkedRepo::GitHub { .. } | LinkedRepo::Azure { .. } => {
            Err("Only GitLab has manual jobs to start".to_string())
        }
        // Bitbucket has manual steps, but no public API to start one.
        LinkedRepo::Bitbucket { .. } => {
            Err("Bitbucket's API can't start a manual step — open it on Bitbucket".to_string())
        }
    }
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

/// A run's artifacts, asked for when the user opens the list rather than on every poll: it is a
/// request per open, and most runs are looked at without anyone wanting their files.
#[tauri::command]
pub async fn list_pipeline_artifacts(
    db: State<'_, Db>,
    project_id: String,
    run_id: String,
) -> Result<Vec<PipelineArtifact>, String> {
    let project = load_project(&db, &project_id)?;
    match linked_repo(&project)? {
        LinkedRepo::GitHub { host, owner, repo } => {
            let token = github_token(&host)?;
            ci::github::list_artifacts(&host, &owner, &repo, &run_id, &token).await
        }
        LinkedRepo::GitLab { host, project: path } => {
            let token = gitlab_token(&host)?;
            ci::gitlab::list_artifacts(&host, &path, &run_id, &token).await
        }
        LinkedRepo::Azure { org, project: ado_project, .. } => {
            let pat = pat_for_org(&org)?;
            ci::azure::list_artifacts(&org, &ado_project, &run_id, &pat).await
        }
        LinkedRepo::Bitbucket { .. } => Err(BITBUCKET_NO_ARTIFACTS.to_string()),
    }
}

/// Why a Bitbucket run's artifacts can't be listed: Pipelines keeps them, but its public API has no
/// endpoint that lists or serves them. Said, rather than answered with an empty list that would read
/// as "this run published nothing".
const BITBUCKET_NO_ARTIFACTS: &str = "Bitbucket's API has no endpoint for a pipeline's artifacts — download them from the run on Bitbucket";

/// How far a download has got, on `ci:artifact`. `id` is the caller's transfer id, minted before
/// the invoke for the same reason `ai_run_id` is: the events start before the command returns.
#[derive(Debug, Clone, Serialize)]
struct ArtifactProgress {
    id: String,
    done: u64,
    total: Option<u64>,
}

/// Downloads one artifact to `destination`, streaming, and reports progress on `ci:artifact`.
///
/// `destination` is what the save dialog returned. The archive is written exactly as the host
/// serves it — a zip — and never unpacked: what the user asked for is the artifact, and an
/// extraction that fails half way is a folder of half the files. Returns the bytes written.
#[tauri::command]
pub async fn download_pipeline_artifact(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    project_id: String,
    run_id: String,
    artifact_id: String,
    destination: String,
    transfer_id: String,
) -> Result<u64, String> {
    let destination = download_destination(&destination)?;
    let project = load_project(&db, &project_id)?;
    let (request, provider, expected) = match linked_repo(&project)? {
        LinkedRepo::GitHub { host, owner, repo } => {
            let token = github_token(&host)?;
            let request = ci::github::artifact_download(&host, &owner, &repo, &artifact_id, &token)?;
            (request, ci::http::Provider::GitHub, None)
        }
        LinkedRepo::GitLab { host, project: path } => {
            let token = gitlab_token(&host)?;
            let request = ci::gitlab::artifact_download(&host, &path, &artifact_id, &token)?;
            (request, ci::http::Provider::GitLab, None)
        }
        LinkedRepo::Azure { org, project: ado_project, .. } => {
            let pat = pat_for_org(&org)?;
            let (request, size) =
                ci::azure::artifact_download(&org, &ado_project, &run_id, &artifact_id, &pat).await?;
            (request, ci::http::Provider::Azure, size)
        }
        LinkedRepo::Bitbucket { .. } => return Err(BITBUCKET_NO_ARTIFACTS.to_string()),
    };

    let id = transfer_id.clone();
    ci::http::download_to_file(request, provider, &destination, &transfer_id, expected, move |done, total| {
        let _ = app.emit("ci:artifact", ArtifactProgress { id: id.clone(), done, total });
    })
    .await
}

/// Stops a download started by [`download_pipeline_artifact`]. It stops at the next chunk and
/// removes what it had written; the command then returns `ci::http::DOWNLOAD_CANCELLED`.
#[tauri::command]
pub fn cancel_pipeline_artifact_download(transfer_id: String) {
    ci::http::cancel_download(&transfer_id);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

fn provider_of(link: &LinkedRepo) -> &'static str {
    match link {
        LinkedRepo::GitHub { .. } => ci::PROVIDER_GITHUB,
        LinkedRepo::GitLab { .. } => ci::PROVIDER_GITLAB,
        LinkedRepo::Azure { .. } => ci::PROVIDER_AZURE,
        LinkedRepo::Bitbucket { .. } => ci::PROVIDER_BITBUCKET,
    }
}

/// How many inputs a GitHub dispatch takes. GitHub's own limit — the request past it is refused.
const MAX_GITHUB_INPUTS: usize = 25;

/// Whether a ref is shaped like one git would accept, by the rules of `git check-ref-format` that
/// a person can actually break by typing: no whitespace or control characters, none of `~^:?*[\`,
/// no `..`, no `@{`, not ending in `/`, `.` or `.lock`.
///
/// Checked because a bad ref is refused by each host in a different and mostly unhelpful way —
/// GitHub says "No ref found", Azure says the request is invalid — and the ref also ends up in a
/// query string.
fn valid_ref(reference: &str) -> Result<(), String> {
    let bad = reference.is_empty()
        || reference.chars().any(|c| c.is_whitespace() || c.is_control() || "~^:?*[\\".contains(c))
        || reference.contains("..")
        || reference.contains("@{")
        || reference.starts_with('/')
        || reference.ends_with('/')
        || reference.ends_with('.')
        || reference.ends_with(".lock");
    if bad {
        Err(format!("“{reference}” isn't a branch or tag name git would accept"))
    } else {
        Ok(())
    }
}

/// A variable name each host will take.
///
/// GitLab allows letters, digits and `_` and says so only after the request; Azure allows letters,
/// digits, `.` and `_` (a `-` is refused at queue time even though the UI lets you type one).
fn validate_variable_key(key: &str, provider: &str) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("Every variable needs a name".to_string());
    }
    let allowed = |c: char| match provider {
        ci::PROVIDER_GITLAB => c.is_ascii_alphanumeric() || c == '_',
        ci::PROVIDER_AZURE => c.is_ascii_alphanumeric() || c == '_' || c == '.',
        // Bitbucket takes GitLab's alphabet, and refuses a name that starts with a digit.
        ci::PROVIDER_BITBUCKET => c.is_ascii_alphanumeric() || c == '_',
        _ => !c.is_whitespace() && !c.is_control(),
    };
    let leading_digit = provider == ci::PROVIDER_BITBUCKET && key.starts_with(|c: char| c.is_ascii_digit());
    if key.chars().all(allowed) && !leading_digit {
        Ok(())
    } else {
        Err(format!("“{key}” can't be a variable name here"))
    }
}

/// Every variable's name, and no name twice — compared ignoring case, because Azure treats names
/// that way and a pair differing only in case is a typo on any host.
fn validate_variables(variables: &[PipelineVariable], provider: &str) -> Result<(), String> {
    let mut seen = std::collections::HashSet::new();
    for variable in variables {
        validate_variable_key(&variable.key, provider)?;
        if !seen.insert(variable.key.trim().to_lowercase()) {
            return Err(format!("“{}” is set twice", variable.key.trim()));
        }
    }
    Ok(())
}

fn validate_start(request: &StartPipelineRequest, provider: &str) -> Result<(), String> {
    if request.definition_id.trim().is_empty() {
        return Err("Pick a pipeline to run".to_string());
    }
    let reference = request.ref_name.trim();
    if reference.is_empty() {
        return Err("Pick a branch or tag to run on".to_string());
    }
    valid_ref(reference)?;
    if request.inputs.keys().any(|name| name.trim().is_empty()) {
        return Err("Every input needs a name".to_string());
    }
    if provider == ci::PROVIDER_GITHUB {
        // GitHub has no queue-time variables at all; sending some would be silently dropped.
        if !request.variables.is_empty() {
            return Err("GitHub workflows take inputs, not variables".to_string());
        }
        if request.inputs.len() > MAX_GITHUB_INPUTS {
            return Err(format!("GitHub takes at most {MAX_GITHUB_INPUTS} inputs per run"));
        }
    }
    // The mirror image: a Bitbucket pipeline declares variables and nothing typed, so inputs would
    // be dropped on the floor.
    if provider == ci::PROVIDER_BITBUCKET && !request.inputs.is_empty() {
        return Err("Bitbucket pipelines take variables, not inputs".to_string());
    }
    validate_variables(&request.variables, provider)
}

/// A repository-relative path, as the host APIs want it: forward slashes, no leading one, and no
/// way out of the repository.
fn repo_relative(path: &str) -> Result<String, String> {
    let trimmed = path.trim().trim_start_matches('/');
    let bad = trimmed.is_empty()
        || trimmed.contains('\\')
        || trimmed.chars().any(char::is_control)
        || trimmed.split('/').any(|segment| segment == ".." || segment == "." || segment.is_empty());
    if bad {
        Err(format!("“{path}” isn't a path inside the repository"))
    } else {
        Ok(trimmed.to_string())
    }
}

/// Where a download may be written: an absolute path whose folder already exists.
///
/// It comes from the save dialog, so both hold in practice; checked anyway, because the command
/// can be called with anything, and a relative path would land in whatever the app's working
/// directory happens to be.
fn download_destination(path: &str) -> Result<PathBuf, String> {
    let destination = PathBuf::from(path.trim());
    if !destination.is_absolute() || destination.file_name().is_none() {
        return Err(format!("“{path}” isn't a file path to save to"));
    }
    let folder = destination.parent().unwrap_or(Path::new(""));
    if !folder.is_dir() {
        return Err(format!("The folder {} doesn't exist", folder.display()));
    }
    Ok(destination)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn request(definition: &str, reference: &str) -> StartPipelineRequest {
        StartPipelineRequest {
            definition_id: definition.to_string(),
            ref_name: reference.to_string(),
            inputs: BTreeMap::new(),
            variables: Vec::new(),
        }
    }

    fn variable(key: &str) -> PipelineVariable {
        PipelineVariable { key: key.to_string(), value: "v".to_string(), masked: false }
    }

    #[test]
    fn a_page_size_is_clamped_and_zero_means_the_default() {
        assert_eq!(clamp(0), DEFAULT_LIMIT);
        assert_eq!(clamp(30), 30);
        assert_eq!(clamp(10_000), MAX_LIMIT);
    }

    #[test]
    fn a_cleared_branch_filter_means_every_branch() {
        assert_eq!(branch_filter(&None), None);
        assert_eq!(branch_filter(&Some("".to_string())), None);
        assert_eq!(branch_filter(&Some("   ".to_string())), None);
        assert_eq!(branch_filter(&Some(" main ".to_string())), Some("main"));
    }

    #[test]
    fn hosts_and_organizations_match_whatever_their_case() {
        let saved = vec!["GitHub.Example.test".to_string(), "example-org".to_string()];
        assert!(contains_ignoring_case(&saved, "github.example.test"));
        assert!(contains_ignoring_case(&saved, "Example-Org"));
        assert!(!contains_ignoring_case(&saved, "other-org"));
    }

    #[test]
    fn a_ref_is_checked_by_the_rules_a_person_can_break_by_typing() {
        for good in ["main", "release/2.0", "v1.2.0", "refs/heads/feature/x", "refs/tags/v1", "fix-123_a"] {
            assert!(valid_ref(good).is_ok(), "{good}");
        }
        for bad in ["", "has space", "a..b", "ends/", "/starts", "x.lock", "dot.", "a:b", "a~1", "a^", "q?", "s*", "b[0", "a\\b", "a@{1}", "tab\tx"] {
            assert!(valid_ref(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn variable_names_follow_each_hosts_alphabet() {
        assert!(validate_variable_key("DEPLOY_ENV", ci::PROVIDER_GITLAB).is_ok());
        assert!(validate_variable_key("deploy.env", ci::PROVIDER_GITLAB).is_err());
        assert!(validate_variable_key("deploy.env", ci::PROVIDER_AZURE).is_ok());
        assert!(validate_variable_key("deploy-env", ci::PROVIDER_AZURE).is_err());
        assert!(validate_variable_key("  ", ci::PROVIDER_AZURE).is_err());
        assert!(validate_variable_key("has space", ci::PROVIDER_GITLAB).is_err());
        assert!(validate_variable_key("DEPLOY_ENV", ci::PROVIDER_BITBUCKET).is_ok());
        assert!(validate_variable_key("deploy.env", ci::PROVIDER_BITBUCKET).is_err());
        assert!(validate_variable_key("1ST_REGION", ci::PROVIDER_BITBUCKET).is_err());
    }

    #[test]
    fn a_bitbucket_run_takes_variables_and_no_inputs() {
        let mut with_variables = request("custom:deploy", "main");
        with_variables.variables.push(variable("REGION"));
        assert!(validate_start(&with_variables, ci::PROVIDER_BITBUCKET).is_ok());

        let mut with_inputs = request("custom:deploy", "main");
        with_inputs.inputs.insert("target".to_string(), serde_json::json!("x"));
        assert_eq!(
            validate_start(&with_inputs, ci::PROVIDER_BITBUCKET).unwrap_err(),
            "Bitbucket pipelines take variables, not inputs"
        );
    }

    #[test]
    fn a_start_request_is_refused_before_it_reaches_the_host() {
        assert!(validate_start(&request("42", "main"), ci::PROVIDER_GITHUB).is_ok());
        assert_eq!(validate_start(&request("", "main"), ci::PROVIDER_AZURE).unwrap_err(), "Pick a pipeline to run");
        assert_eq!(
            validate_start(&request("42", "  "), ci::PROVIDER_AZURE).unwrap_err(),
            "Pick a branch or tag to run on"
        );
        assert!(validate_start(&request("42", "bad ref"), ci::PROVIDER_AZURE).is_err());

        // GitHub has inputs and nothing else, and at most 25 of them.
        let mut with_variables = request("42", "main");
        with_variables.variables.push(variable("X"));
        assert!(validate_start(&with_variables, ci::PROVIDER_GITHUB).is_err());
        assert!(validate_start(&with_variables, ci::PROVIDER_GITLAB).is_ok());

        let mut crowded = request("42", "main");
        for n in 0..26 {
            crowded.inputs.insert(format!("input_{n}"), serde_json::json!("x"));
        }
        assert!(validate_start(&crowded, ci::PROVIDER_GITHUB).is_err());
        assert!(validate_start(&crowded, ci::PROVIDER_AZURE).is_ok());

        // The same variable twice, differing only in case, is a typo.
        let mut twice = request(".gitlab-ci.yml", "main");
        twice.variables = vec![variable("TARGET"), variable("target")];
        assert_eq!(validate_start(&twice, ci::PROVIDER_GITLAB).unwrap_err(), "“target” is set twice");

        let mut unnamed = request("42", "main");
        unnamed.inputs.insert(" ".to_string(), serde_json::json!("x"));
        assert!(validate_start(&unnamed, ci::PROVIDER_AZURE).is_err());
    }

    #[test]
    fn a_definition_path_stays_inside_the_repository() {
        assert_eq!(repo_relative(".github/workflows/ci.yml").unwrap(), ".github/workflows/ci.yml");
        assert_eq!(repo_relative("/pipelines/build.yml").unwrap(), "pipelines/build.yml");
        for bad in ["", "../outside.yml", "a/../../b.yml", "a//b.yml", "./a.yml", "a\\b.yml"] {
            assert!(repo_relative(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_download_goes_to_an_absolute_path_in_a_folder_that_exists() {
        let folder = std::env::temp_dir();
        let inside = folder.join("artifact.zip");
        assert_eq!(download_destination(inside.to_str().unwrap()).unwrap(), inside);

        assert!(download_destination("artifact.zip").is_err(), "relative");
        let missing = folder.join("codeflow-no-such-folder-5c1d").join("artifact.zip");
        assert!(download_destination(missing.to_str().unwrap()).is_err(), "no folder");
    }
}
