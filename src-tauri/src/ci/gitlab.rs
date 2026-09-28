//! GitLab CI as one of the three pipeline providers.
//!
//! GitLab is the provider whose model fits [`super`]'s wire types most closely — a pipeline is a
//! run, a job is a job, and `job.stage` is a first-class field, so this is the one client that can
//! fill [`PipelineJob::stage`] without inferring anything. What does *not* fit cleanly is worth
//! stating up front, because the shape of this file follows from it:
//!
//! - **The listing is a strictly poorer object than the detail.** `GET /pipelines` returns no
//!   author, no `started_at` / `finished_at`, and no `detailed_status`. Those are not omitted for
//!   brevity — they are genuinely absent from the list representation, and asking for them costs
//!   one request *per row*. So the list is mapped with those fields empty and the row is corrected
//!   when the user opens it. See [`pipeline_detail`].
//! - **"Success" is not always success.** When a job marked `allow_failure` fails, the pipeline's
//!   `status` is still `success`; the only place GitLab admits otherwise is `detailed_status`,
//!   which says "passed with warnings". That field exists on the detail and not on the list, which
//!   is the concrete reason a row can change colour on open — documented again at
//!   [`bucket_status`] so nobody later "fixes" the inconsistency by making the list lie instead.
//! - **The project path is the id.** Every API URL here goes through [`encode_path`], which turns
//!   `acme/backend/auth` into `acme%2Fbackend%2Fauth`. Browser URLs must *not* — see
//!   [`web_pipeline_url`].
//!
//! Everything on the wire goes through [`super::http`] rather than `crate::gitlab`'s own
//! `get_json`: that one is built for a review — 90 s a request, JSON only — and this screen polls,
//! downloads plain-text logs and streams artifacts, each with a budget of its own.

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::gitlab::{api_root, authed, encode_path};

use super::http;
use super::{
    artifact_file_name, gate_kind, split_ref, status, JobLog, PipelineArtifact, PipelineDefinition,
    PipelineGate, PipelineJob, PipelineLaunchContext, PipelineRun, PipelineRunDetail,
    PipelineVariable, StartedPipeline, PROVIDER_GITLAB,
};

/// GitLab's default page size is 20 and its maximum is 100. Fifty is the size that keeps a typical
/// "last 30 runs" request to a single round trip without making the first paint wait on a page
/// twice as large as anything the UI shows at once.
const PER_PAGE: usize = 50;

/// A hard ceiling on the pagination loop, independent of `limit`.
///
/// The loop's real stop condition is a short page, but that condition depends on the server
/// answering sensibly. A self-managed instance behind a misconfigured proxy that keeps returning
/// the same full page would otherwise spin until the tab is closed; five hundred rows is far more
/// than this screen can display and a safe place to give up.
const MAX_PAGES: usize = 10;

// ---------------------------------------------------------------------------
// Wire types
//
// GitLab's REST API is snake_case throughout, so unlike `crate::ado` there is almost nothing to
// rename here — the one exception is `ref`, which is a Rust keyword.
// ---------------------------------------------------------------------------

/// A pipeline as the *listing* returns it.
///
/// Deliberately narrower than the JSON: `project_id` and `updated_at` are in the response and are
/// not read here. `project_id` is redundant (the caller already had to name the project to build
/// the URL), and `updated_at` is tempting as a stand-in for `finished_at` and would be wrong — a
/// running pipeline's `updated_at` moves every time a job changes state, so showing it as an end
/// time would put a finish time on a run that has not finished. Fields nothing reads are warnings,
/// not documentation.
#[derive(Deserialize)]
struct RawPipeline {
    id: i64,
    /// The per-project number — what the user sees as `#1234`. Only on GitLab 12+.
    #[serde(default)]
    iid: Option<i64>,
    #[serde(default)]
    sha: String,
    /// `ref` is a Rust keyword, hence the rename. The value is a branch or tag name.
    #[serde(rename = "ref", default)]
    ref_name: Option<String>,
    #[serde(default)]
    status: String,
    /// What triggered the pipeline: `push`, `merge_request_event`, `schedule`, `web`, `api`…
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    web_url: Option<String>,
    /// GitLab 15.7+ only. Older instances answer without it, which is why the name falls back to
    /// the ref rather than rendering an empty row.
    #[serde(default)]
    name: Option<String>,
}

/// A pipeline as the *detail* endpoint returns it: everything above plus the four things the
/// listing withholds — the user, the two timestamps, and `detailed_status`.
///
/// Spelled out rather than `#[serde(flatten)]`-ing [`RawPipeline`] into it: flattening buys six
/// lines and costs the ability to read this struct and know what the endpoint returns, which is
/// the entire reason these `Raw*` types exist.
///
/// `duration` is in the response and is not read, for the same reason the public types carry no
/// duration field: the frontend computes it from `started_at` / `finished_at` (and
/// [`super::duration_secs`] exists for the paths that need it in Rust). Two sources for one number
/// is one source too many.
#[derive(Deserialize)]
struct RawPipelineDetail {
    id: i64,
    #[serde(default)]
    iid: Option<i64>,
    #[serde(default)]
    sha: String,
    #[serde(rename = "ref", default)]
    ref_name: Option<String>,
    #[serde(default)]
    status: String,
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    started_at: Option<String>,
    #[serde(default)]
    finished_at: Option<String>,
    #[serde(default)]
    web_url: Option<String>,
    #[serde(default)]
    name: Option<String>,
    /// Absent on a pipeline triggered by a schedule or by a token whose user has since been
    /// removed, so the whole object is optional and so is every field in it.
    #[serde(default)]
    user: Option<RawUser>,
    /// The only place GitLab distinguishes "passed" from "passed with warnings".
    #[serde(default)]
    detailed_status: Option<RawDetailedStatus>,
}

#[derive(Deserialize)]
struct RawUser {
    /// Preferred over `name`: it is the handle that appears everywhere else in GitLab's UI, and it
    /// is stable where a display name is not.
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

/// GitLab's own presentation of a status. `text` is the short form (`passed`, `warning`), `label`
/// the sentence (`passed with warnings`). Both are read because which one carries the word
/// "warning" has moved between GitLab versions.
#[derive(Deserialize)]
struct RawDetailedStatus {
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    label: Option<String>,
}

/// A job inside a pipeline.
///
/// `duration` is skipped here for the same reason as on the pipeline. `allow_failure` is not
/// optional-shaped because GitLab always sends it and `false` is the correct reading if it ever
/// stopped: treating an unknown job as "allowed to fail" would silently downgrade real failures.
#[derive(Deserialize)]
struct RawJob {
    id: i64,
    #[serde(default)]
    name: String,
    /// The stage the job belongs to. This is what makes GitLab the easy provider: the stage *is*
    /// the column in the run graph, given by the API, with no `needs:` parsing and no grouping by
    /// overlapping timestamps — the two fallbacks `PipelineRun::definition_path` documents for
    /// GitHub.
    #[serde(default)]
    stage: Option<String>,
    #[serde(default)]
    status: String,
    #[serde(default)]
    started_at: Option<String>,
    #[serde(default)]
    finished_at: Option<String>,
    #[serde(default)]
    web_url: Option<String>,
    /// `true` when `.gitlab-ci.yml` marks the job `allow_failure`. A failed job with this set does
    /// not fail the pipeline — see [`bucket_status`].
    #[serde(default)]
    allow_failure: bool,
    /// The job's downloadable archive — the `artifacts:paths` it uploaded, zipped. Absent when the
    /// job kept none. The `artifacts` array next to it in the response also lists the log (`trace`)
    /// and the reports, none of which the archive endpoint serves; this is the one it does.
    #[serde(default)]
    artifacts_file: Option<RawArtifactsFile>,
    #[serde(default)]
    artifacts_expire_at: Option<String>,
}

#[derive(Deserialize)]
struct RawArtifactsFile {
    #[serde(default)]
    filename: String,
    #[serde(default)]
    size: Option<u64>,
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/// Collapses GitLab's pipeline/job vocabulary into the seven buckets in [`status`].
///
/// The mapping, in full:
///
/// | GitLab | bucket | why |
/// |---|---|---|
/// | `created`, `pending`, `scheduled`, `waiting_for_resource` | `QUEUED` | accepted, no runner yet |
/// | `preparing`, `running` | `RUNNING` | a runner has it; `preparing` is it pulling the image |
/// | `success` | `SUCCESS`, or `WARNING` when `detailed` says "warning" | see below |
/// | `failed` | `FAILED`, or `WARNING` when `allow_failure` | see below |
/// | `canceled`, `canceling` | `CANCELLED` | a human stopped it |
/// | `skipped`, `manual` | `SKIPPED` | never ran: a condition, or a gate nobody pressed |
/// | anything else | `QUEUED` | see below |
///
/// **`success` + warning.** A pipeline whose only failing job was marked `allow_failure` still
/// reports `status: "success"`; the one field that says otherwise is `detailed_status`, whose
/// `text`/`label` reads "passed with warnings". That field is on the pipeline *detail* and not on
/// the listing, so the list genuinely cannot know — a listed row shows `SUCCESS` and is corrected
/// to `WARNING` when [`pipeline_detail`] runs. The alternative, one detail request per listed row,
/// costs fifty requests to repaint a colour on the handful of runs that have one.
///
/// **`failed` + `allow_failure`.** This is not a heuristic; it is the definition of the flag. A
/// job the author declared may fail, failing, is the expected path, and painting it red trains
/// people to ignore red.
///
/// **Unknown states.** `QUEUED` is the least dishonest default. Every state GitLab has added since
/// this vocabulary settled — `preparing`, `scheduled`, `waiting_for_resource`, `canceling` — was
/// non-terminal, so an unrecognised word is most likely a new non-terminal one; and `QUEUED` is
/// the only bucket that asserts nothing about the outcome while keeping [`super::is_live`] true,
/// so the row keeps polling and repaints itself correctly the moment the run reaches a state we do
/// know. Guessing `SUCCESS` or `FAILED` would report a result the host never gave.
fn bucket_status(status: &str, allow_failure: bool, detailed: Option<&str>) -> String {
    let warned = detailed.is_some_and(|text| text.to_ascii_lowercase().contains("warning"));
    match status {
        "created" | "pending" | "scheduled" | "waiting_for_resource" => status::QUEUED,
        "preparing" | "running" => status::RUNNING,
        "success" => {
            if warned {
                status::WARNING
            } else {
                status::SUCCESS
            }
        }
        "failed" => {
            if allow_failure {
                status::WARNING
            } else {
                status::FAILED
            }
        }
        "canceled" | "canceling" => status::CANCELLED,
        "skipped" | "manual" => status::SKIPPED,
        _ => status::QUEUED,
    }
    .to_string()
}

/// Whether a pipeline is held at a gate: GitLab's `manual` **pipeline** status.
///
/// On a pipeline that word means one thing — a job with `when: manual` and `allow_failure: false`
/// is holding everything behind it (GitLab's own list draws it as "blocked"). An *optional* manual
/// job doesn't hold anything: the pipeline finishes `success` around it, play button and all. So
/// this is exactly "somebody has to act before this run can go on", which is what the flag means,
/// and not "there is a play button somewhere in it", which the run view shows either way.
///
/// It stays `SKIPPED` in [`bucket_status`] on purpose: a blocked pipeline is not moving, and a
/// live bucket would have the poll re-read it every five seconds for as long as nobody acts —
/// which, for a manual production deploy, is days.
fn is_blocked(status: &str) -> bool {
    status == "manual"
}

/// Flattens `detailed_status` into the one string [`bucket_status`] searches.
///
/// Both halves are joined rather than picking one because GitLab has moved the word "warning"
/// between `text` (`"warning"`) and `label` (`"passed with warnings"`) across versions, and
/// matching on the pair is cheaper than pinning down which version answered.
fn detailed_hint(raw: Option<&RawDetailedStatus>) -> Option<String> {
    let raw = raw?;
    let joined = format!(
        "{} {}",
        raw.text.as_deref().unwrap_or_default(),
        raw.label.as_deref().unwrap_or_default()
    );
    let joined = joined.trim().to_string();
    if joined.is_empty() {
        None
    } else {
        Some(joined)
    }
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/// Where "open in GitLab" goes for a pipeline.
///
/// The slashes in the project path stay **literal** here, which is the exact opposite of what
/// [`encode_path`] does for the API. `https://gitlab.com/acme%2Fbackend/-/pipelines/1` is not a
/// page — GitLab's web router matches namespaces as real path segments, and the percent-encoded
/// form 404s. The two encoders are one letter apart at the call site and a broken link apart in
/// the product, which is why this is a named function rather than an inline `format!`.
pub fn web_pipeline_url(host: &str, project: &str, pipeline_id: &str) -> String {
    format!("https://{host}/{}/-/pipelines/{pipeline_id}", project.trim_matches('/'))
}

/// The same rule for a job, used only when the API's own `web_url` is missing.
fn web_job_url(host: &str, project: &str, job_id: &str) -> String {
    format!("https://{host}/{}/-/jobs/{job_id}", project.trim_matches('/'))
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/// The display name for a run: GitLab 15.7+ lets a pipeline carry a `name`, and everything older
/// has nothing but the ref. An empty string is treated as absent — some instances answer `""`
/// rather than omitting the key, and a nameless row is worse than a row named after its branch.
fn run_name(name: Option<String>, branch: &str) -> String {
    name.map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| branch.to_string())
}

fn map_pipeline(host: &str, project: &str, raw: RawPipeline) -> PipelineRun {
    let id = raw.id.to_string();
    let branch = raw.ref_name.unwrap_or_default();
    PipelineRun {
        provider: PROVIDER_GITLAB.to_string(),
        gated: is_blocked(&raw.status),
        // The listing carries no `detailed_status`, so `None` here is not laziness — it is the
        // only thing the response supports. See `bucket_status`.
        status: bucket_status(&raw.status, false, None),
        raw_status: raw.status,
        name: run_name(raw.name, &branch),
        number: raw.iid,
        branch,
        commit_sha: raw.sha,
        // Neither is in the list representation; both arrive with the detail.
        commit_title: None,
        actor: None,
        event: raw.source,
        created_at: raw.created_at,
        // Likewise absent from the listing. Left `None` rather than approximated from
        // `updated_at`, which would put an end time on a run that is still going.
        started_at: None,
        finished_at: None,
        web_url: raw.web_url.unwrap_or_else(|| web_pipeline_url(host, project, &id)),
        // GitLab needs none: `job.stage` gives the graph its columns directly, which is the one
        // problem `definition_path` exists to solve for GitHub.
        definition_path: None,
        id,
    }
}

fn map_pipeline_detail(host: &str, project: &str, raw: RawPipelineDetail) -> PipelineRun {
    let id = raw.id.to_string();
    let branch = raw.ref_name.unwrap_or_default();
    let hint = detailed_hint(raw.detailed_status.as_ref());
    PipelineRun {
        provider: PROVIDER_GITLAB.to_string(),
        gated: is_blocked(&raw.status),
        status: bucket_status(&raw.status, false, hint.as_deref()),
        raw_status: raw.status,
        name: run_name(raw.name, &branch),
        number: raw.iid,
        branch,
        commit_sha: raw.sha,
        // The pipeline object has no commit message on it — only the SHA. Fetching the commit to
        // fill this in would be a third request for a subtitle, so it stays empty and the frontend
        // shows the short SHA.
        commit_title: None,
        actor: raw.user.and_then(|user| {
            user.username
                .filter(|value| !value.trim().is_empty())
                .or(user.name)
                .filter(|value| !value.trim().is_empty())
        }),
        event: raw.source,
        created_at: raw.created_at,
        started_at: raw.started_at,
        finished_at: raw.finished_at,
        web_url: raw.web_url.unwrap_or_else(|| web_pipeline_url(host, project, &id)),
        definition_path: None,
        id,
    }
}

fn map_job(host: &str, project: &str, run_id: &str, raw: RawJob) -> PipelineJob {
    let id = raw.id.to_string();
    PipelineJob {
        provider: PROVIDER_GITLAB.to_string(),
        run_id: run_id.to_string(),
        name: raw.name,
        stage: raw.stage,
        // GitLab's stage is a bare string on the job and nothing else — there is no stage
        // object to have an id. The graph groups by the name, which for GitLab *is* the
        // identity: a pipeline cannot declare two stages with the same name.
        stage_id: None,
        status: bucket_status(&raw.status, raw.allow_failure, None),
        raw_status: raw.status,
        started_at: raw.started_at,
        finished_at: raw.finished_at,
        web_url: raw.web_url.unwrap_or_else(|| web_job_url(host, project, &id)),
        // GitLab serves a job's log from the job's own id; there is no second identifier to carry,
        // unlike Azure's timeline records.
        log_ref: None,
        id,
    }
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/// The most recent pipelines for a project, newest first, optionally for one branch.
///
/// Ordered by `id` rather than by `updated_at`: ids are monotonic per project, so `id desc` is a
/// stable total order, whereas ordering by a timestamp reshuffles rows as running pipelines update
/// underneath the pagination and can hand back the same run twice.
pub async fn list_pipelines(
    host: &str,
    project: &str,
    branch: Option<&str>,
    limit: usize,
    token: &str,
) -> Result<Vec<PipelineRun>, String> {
    let mut runs: Vec<PipelineRun> = Vec::new();
    if limit == 0 {
        return Ok(runs);
    }

    let root = api_root(host);
    let encoded = encode_path(project);
    // `ref` is a query value, not a path segment, so its slashes would survive unencoded — but a
    // branch called `feature/a+b` would not, and `encode_path` is already the crate's
    // everything-outside-the-unreserved-set encoder. Trimming leading/trailing slashes, its one
    // side effect, cannot damage a branch name: git refuses to create one shaped like that.
    let filter = branch
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("&ref={}", encode_path(value)))
        .unwrap_or_default();

    // Bounded rather than driven by `X-Next-Page`: the shared `http::get_json` hands back a
    // decoded body and no headers, and adding a header-returning variant for one caller is a
    // worse trade than the stop condition below. A page shorter than `PER_PAGE` is the last page —
    // that is true of every offset-paginated GitLab endpoint.
    let pages = limit.div_ceil(PER_PAGE).min(MAX_PAGES);
    for page in 1..=pages {
        let url = format!(
            "{root}/projects/{encoded}/pipelines\
             ?per_page={PER_PAGE}&order_by=id&sort=desc&page={page}{filter}"
        );
        let raw: Vec<RawPipeline> =
            http::get_json(authed(http::client().get(&url), token), http::Provider::GitLab).await?;

        let received = raw.len();
        runs.extend(raw.into_iter().map(|pipeline| map_pipeline(host, project, pipeline)));
        if received < PER_PAGE || runs.len() >= limit {
            break;
        }
    }

    runs.truncate(limit);
    Ok(runs)
}

/// One pipeline with its jobs.
///
/// Two requests, because GitLab has no endpoint that returns both, and sequential rather than
/// concurrent: if the pipeline is gone or the token cannot read it, the first call already says so
/// and the second would only produce a second copy of the same error for the user to read.
///
/// This is also where a listed row is corrected. The detail carries `detailed_status`, so a
/// pipeline that "passed with warnings" turns from `SUCCESS` into `WARNING` here — see
/// [`bucket_status`] for why the listing cannot do it.
pub async fn pipeline_detail(
    host: &str,
    project: &str,
    pipeline_id: &str,
    token: &str,
) -> Result<PipelineRunDetail, String> {
    let root = api_root(host);
    let encoded = encode_path(project);
    // Numeric in practice, but it arrives from the frontend as a string; running it through the
    // same encoder costs nothing on digits and keeps a stray slash from re-routing the request.
    let id = encode_path(pipeline_id);

    let run_url = format!("{root}/projects/{encoded}/pipelines/{id}");
    let raw_run: RawPipelineDetail =
        http::get_json(authed(http::client().get(&run_url), token), http::Provider::GitLab).await?;

    let raw_jobs = pipeline_jobs(host, project, pipeline_id, token).await?;

    let run = map_pipeline_detail(host, project, raw_run);
    let mut gates = manual_gates(host, project, &run.id, &raw_jobs);
    // A job may be waiting for more than a play button: when it deploys to a protected environment
    // that requires approval, GitLab holds it until the approvers have spoken, and its deployment
    // reads `blocked`. Asked for only when this pipeline is blocked or has a manual job — which a
    // job held for approval makes it — rather than on every read of every pipeline, since the
    // detail is re-read on each poll while a run is live. Best-effort, because approvals are a
    // Premium feature: on any other tier the question has no answer, and the job is still a play
    // button.
    if run.gated || !gates.is_empty() {
        if let Ok(blocked) = blocked_deployments(host, project, token).await {
            gates = apply_approvals(host, project, &run.id, &raw_jobs, gates, blocked);
        }
    }

    let jobs = raw_jobs.into_iter().map(|job| map_job(host, project, &run.id, job)).collect();
    // GitLab names a job's stage and says nothing else about the stage itself — no state, no
    // start, no finish, and no endpoint that has them. The UI summarises the jobs instead, and
    // an empty vector is what tells it to.
    Ok(PipelineRunDetail { run, jobs, stages: Vec::new(), gates })
}

/// A pipeline's jobs, one page of them.
///
/// `include_retried=false` is the default and is stated anyway: with retries included the same
/// job name appears several times and the graph draws a column of ghosts alongside the attempt
/// that actually counts. 100 is GitLab's maximum page size, and a pipeline with more than a
/// hundred jobs is rare enough that a second page is not worth the round trip on every open.
async fn pipeline_jobs(
    host: &str,
    project: &str,
    pipeline_id: &str,
    token: &str,
) -> Result<Vec<RawJob>, String> {
    let url = format!(
        "{}/projects/{}/pipelines/{}/jobs?per_page=100&include_retried=false",
        api_root(host),
        encode_path(project),
        encode_path(pipeline_id)
    );
    http::get_json(authed(http::client().get(&url), token), http::Provider::GitLab).await
}

/// A job's log — GitLab calls it the trace.
///
/// The endpoint answers `text/plain` with the runner's ANSI escapes intact, which is why this goes
/// through [`http::get_log`]: every `get_json` in the crate ends in `serde_json::from_str` and
/// would report a perfectly good log as "unexpected response from GitLab". The ANSI is left in —
/// [`JobLog::text`] is what the host served, and the log pane renders the colours.
///
/// **On ids.** `crate::gitlab`'s module doc says to always use `iid` and never `id`. That rule is
/// about *merge requests*, which have both, and where the global id silently addresses a different
/// merge request in another project. Jobs have no `iid` at all — GitLab addresses them by their
/// global id everywhere, including in the `/-/jobs/{id}` browser URL — so the id taken from
/// [`PipelineJob::id`] is the only one there is, and the rule simply does not apply here.
pub async fn job_log(
    host: &str,
    project: &str,
    job_id: &str,
    token: &str,
) -> Result<JobLog, String> {
    let url = format!(
        "{}/projects/{}/jobs/{}/trace",
        api_root(host),
        encode_path(project),
        encode_path(job_id)
    );
    http::get_log(authed(http::client().get(&url), token), http::Provider::GitLab).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gitlab::GITLAB_COM;

    #[test]
    fn every_gitlab_state_lands_in_the_bucket_the_ui_can_draw() {
        for queued in ["created", "pending", "scheduled", "waiting_for_resource"] {
            assert_eq!(bucket_status(queued, false, None), status::QUEUED, "{queued}");
        }
        for running in ["preparing", "running"] {
            assert_eq!(bucket_status(running, false, None), status::RUNNING, "{running}");
        }
        assert_eq!(bucket_status("success", false, None), status::SUCCESS);
        assert_eq!(bucket_status("failed", false, None), status::FAILED);
        for cancelled in ["canceled", "canceling"] {
            assert_eq!(bucket_status(cancelled, false, None), status::CANCELLED, "{cancelled}");
        }
        // A manual job is one nobody pressed: it never ran, exactly like a skipped one.
        for skipped in ["skipped", "manual"] {
            assert_eq!(bucket_status(skipped, false, None), status::SKIPPED, "{skipped}");
        }
    }

    /// An unrecognised state must not be reported as an outcome the host never gave.
    #[test]
    fn an_unknown_state_stays_queued_rather_than_inventing_a_result() {
        assert_eq!(bucket_status("waiting_for_callback", false, None), status::QUEUED);
        assert_eq!(bucket_status("", false, None), status::QUEUED);
        // And it stays live, so the row keeps polling and corrects itself.
        assert!(super::super::is_live(&bucket_status("something_new", false, None)));
    }

    /// `allow_failure` means the author declared this job may fail. Painting it red is not a
    /// stricter reading of the pipeline, it is a wrong one.
    #[test]
    fn a_job_allowed_to_fail_is_a_warning_not_a_failure() {
        assert_eq!(bucket_status("failed", true, None), status::WARNING);
        assert_eq!(bucket_status("failed", false, None), status::FAILED);
        // The flag only touches failure — it cannot promote or demote anything else.
        assert_eq!(bucket_status("success", true, None), status::SUCCESS);
        assert_eq!(bucket_status("running", true, None), status::RUNNING);
        assert_eq!(bucket_status("canceled", true, None), status::CANCELLED);
    }

    /// The listing has no `detailed_status`, so the same pipeline buckets differently depending on
    /// which endpoint it came from. That is the intended behaviour, not a bug to be smoothed over.
    #[test]
    fn passed_with_warnings_is_only_knowable_from_the_detail() {
        assert_eq!(bucket_status("success", false, Some("passed")), status::SUCCESS);
        assert_eq!(bucket_status("success", false, Some("passed with warnings")), status::WARNING);
        // Older instances put the word in `text` instead of in `label`.
        assert_eq!(bucket_status("success", false, Some("warning")), status::WARNING);
        // Case is GitLab's to choose, not ours to depend on.
        assert_eq!(bucket_status("success", false, Some("Passed With Warnings")), status::WARNING);
        // What the listing can see: no hint, so plain success.
        assert_eq!(bucket_status("success", false, None), status::SUCCESS);
    }

    #[test]
    fn both_halves_of_detailed_status_are_searched() {
        let only_label =
            RawDetailedStatus { text: None, label: Some("passed with warnings".into()) };
        assert_eq!(detailed_hint(Some(&only_label)).as_deref(), Some("passed with warnings"));

        let only_text = RawDetailedStatus { text: Some("warning".into()), label: None };
        assert_eq!(detailed_hint(Some(&only_text)).as_deref(), Some("warning"));

        let empty = RawDetailedStatus { text: None, label: None };
        assert!(detailed_hint(Some(&empty)).is_none());
        assert!(detailed_hint(None).is_none());
    }

    /// The one encoding rule this file exists to keep straight: `%2F` for the API, real slashes
    /// for the browser. Getting it backwards produces a 404 in either direction.
    #[test]
    fn the_browser_url_keeps_its_slashes_while_the_api_path_encodes_them() {
        let project = "acme/backend/auth";

        let web = web_pipeline_url(GITLAB_COM, project, "42");
        assert_eq!(web, "https://gitlab.com/acme/backend/auth/-/pipelines/42");
        assert!(!web.contains("%2F"), "a browser URL with %2F in the namespace is not a page: {web}");

        let api = format!("{}/projects/{}/pipelines/42", api_root(GITLAB_COM), encode_path(project));
        assert_eq!(api, "https://gitlab.com/api/v4/projects/acme%2Fbackend%2Fauth/pipelines/42");
        assert!(!api.contains("/acme/backend/"), "an API path with real slashes routes to a 404: {api}");

        // Self-managed hosts follow the same two rules.
        assert_eq!(
            web_job_url("git.contoso.com", "/team/app/", "7"),
            "https://git.contoso.com/team/app/-/jobs/7"
        );
    }

    /// Guards the `ref` rename (a keyword, so a silent typo compiles) and the fields the listing
    /// genuinely cannot fill.
    #[test]
    fn a_listed_pipeline_maps_without_the_fields_only_the_detail_carries() {
        let body = r#"{
            "id": 901, "iid": 12, "project_id": 5, "sha": "abc123",
            "ref": "feature/login", "status": "running", "source": "merge_request_event",
            "created_at": "2026-08-21T17:04:11Z", "updated_at": "2026-08-21T17:05:00Z",
            "web_url": "https://gitlab.com/acme/app/-/pipelines/901"
        }"#;
        let raw: RawPipeline = serde_json::from_str(body).expect("the listing shape must parse");
        let run = map_pipeline(GITLAB_COM, "acme/app", raw);

        assert_eq!(run.provider, PROVIDER_GITLAB);
        assert_eq!(run.id, "901");
        assert_eq!(run.number, Some(12));
        assert_eq!(run.branch, "feature/login");
        // No `name` on this instance, so the ref stands in for it.
        assert_eq!(run.name, "feature/login");
        assert_eq!(run.status, status::RUNNING);
        assert_eq!(run.raw_status, "running");
        assert_eq!(run.event.as_deref(), Some("merge_request_event"));
        assert_eq!(run.web_url, "https://gitlab.com/acme/app/-/pipelines/901");
        // The four the listing does not carry.
        assert!(run.actor.is_none());
        assert!(run.commit_title.is_none());
        assert!(run.started_at.is_none());
        assert!(run.finished_at.is_none());
        // GitLab needs no workflow file: the stage comes off the job.
        assert!(run.definition_path.is_none());
    }

    #[test]
    fn the_detail_fills_in_the_author_the_times_and_the_warning() {
        let body = r#"{
            "id": 901, "iid": 12, "sha": "abc123", "ref": "main", "status": "success",
            "source": "push", "name": "Nightly build",
            "created_at": "2026-08-21T17:04:11Z",
            "started_at": "2026-08-21T17:04:20Z",
            "finished_at": "2026-08-21T17:09:00Z",
            "duration": 280,
            "user": { "username": "sorodriguezz", "name": "Sebastián" },
            "detailed_status": { "text": "warning", "label": "passed with warnings" }
        }"#;
        let raw: RawPipelineDetail = serde_json::from_str(body).expect("the detail shape must parse");
        let run = map_pipeline_detail(GITLAB_COM, "acme/app", raw);

        // The correction the whole two-endpoint dance exists for: GitLab said "success".
        assert_eq!(run.raw_status, "success");
        assert_eq!(run.status, status::WARNING);
        assert_eq!(run.name, "Nightly build");
        assert_eq!(run.actor.as_deref(), Some("sorodriguezz"));
        assert_eq!(run.started_at.as_deref(), Some("2026-08-21T17:04:20Z"));
        assert_eq!(run.finished_at.as_deref(), Some("2026-08-21T17:09:00Z"));
        // No `web_url` in this response, so it is built — and built the browser way.
        assert_eq!(run.web_url, "https://gitlab.com/acme/app/-/pipelines/901");
    }

    #[test]
    fn a_scheduled_pipeline_without_a_user_still_maps() {
        let body = r#"{ "id": 7, "ref": "main", "status": "success", "created_at": "2026-08-21T17:04:11Z" }"#;
        let raw: RawPipelineDetail = serde_json::from_str(body).unwrap();
        let run = map_pipeline_detail(GITLAB_COM, "acme/app", raw);
        assert!(run.actor.is_none());
        assert_eq!(run.status, status::SUCCESS);
        assert_eq!(run.number, None);
    }

    #[test]
    fn a_job_keeps_its_stage_and_its_allowed_failure() {
        let body = r#"[
            { "id": 51, "name": "lint", "stage": "test", "status": "failed",
              "allow_failure": true, "web_url": "https://gitlab.com/acme/app/-/jobs/51",
              "started_at": "2026-08-21T17:05:00Z", "finished_at": "2026-08-21T17:06:00Z",
              "duration": 60 },
            { "id": 52, "name": "unit", "stage": "test", "status": "failed", "allow_failure": false }
        ]"#;
        let raw: Vec<RawJob> = serde_json::from_str(body).expect("the job shape must parse");
        let jobs: Vec<PipelineJob> =
            raw.into_iter().map(|job| map_job(GITLAB_COM, "acme/app", "901", job)).collect();

        assert_eq!(jobs[0].run_id, "901");
        assert_eq!(jobs[0].id, "51");
        // The stage is what forms the columns of the graph — GitLab is the provider that gives it.
        assert_eq!(jobs[0].stage.as_deref(), Some("test"));
        assert_eq!(jobs[0].status, status::WARNING);
        assert_eq!(jobs[0].raw_status, "failed");
        // Same status, same stage, no flag: this one is a real failure.
        assert_eq!(jobs[1].status, status::FAILED);
        // No `web_url` on the second, so it is built with literal slashes.
        assert_eq!(jobs[1].web_url, "https://gitlab.com/acme/app/-/jobs/52");
        // The log hangs off the job's own id; there is no second identifier to carry.
        assert!(jobs[0].log_ref.is_none());
    }

    #[test]
    fn a_pipeline_named_by_an_empty_string_falls_back_to_its_ref() {
        assert_eq!(run_name(Some("  ".into()), "main"), "main");
        assert_eq!(run_name(None, "release/2.0"), "release/2.0");
        assert_eq!(run_name(Some("Deploy".into()), "main"), "Deploy");
    }
}

// ---------------------------------------------------------------------------
// Writes: retry and cancel
// ---------------------------------------------------------------------------

/// Retries a pipeline. GitLab's `retry` re-runs only the jobs that failed or were cancelled, which
/// is the behaviour GitHub reserves for its `rerun-failed-jobs` endpoint — so there is no
/// `failed_only` flag here to honour, and the caller's is deliberately ignored rather than faked.
pub async fn retry(host: &str, project: &str, pipeline_id: &str, token: &str) -> Result<(), String> {
    let root = api_root(host);
    let encoded = encode_path(project);
    let id = encode_path(pipeline_id);
    let url = format!("{root}/projects/{encoded}/pipelines/{id}/retry");
    http::send_write(authed(http::client().post(&url), token), http::Provider::GitLab).await
}

pub async fn cancel(host: &str, project: &str, pipeline_id: &str, token: &str) -> Result<(), String> {
    let root = api_root(host);
    let encoded = encode_path(project);
    let id = encode_path(pipeline_id);
    let url = format!("{root}/projects/{encoded}/pipelines/{id}/cancel");
    http::send_write(authed(http::client().post(&url), token), http::Provider::GitLab).await
}

/// An id that is about to be put in a URL, checked rather than encoded: GitLab's job and deployment
/// ids are integers, and anything else means the value was mangled between the listing and here.
fn numeric_id(value: &str, what: &str) -> Result<i64, String> {
    value.trim().parse::<i64>().map_err(|_| format!("“{value}” isn't a GitLab {what} id"))
}

// ---------------------------------------------------------------------------
// Starting a pipeline by hand
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct RawProject {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    default_branch: Option<String>,
    /// `null` or empty for the default `.gitlab-ci.yml`. Can also name a file in *another* project
    /// (`ci/main.yml@group/ci-templates`) or a URL, which is why [`project_definition`] looks.
    #[serde(default)]
    ci_config_path: Option<String>,
}

/// The one pipeline a GitLab project has.
///
/// GitLab has no "pipeline definitions" to list: a project runs whatever its CI config says, and
/// that config is one file. The dialog still gets a definition, so it can treat the three hosts
/// alike — one entry, whose path is where the prefilled variables are read from.
fn project_definition(host: &str, project: &str, raw: RawProject) -> PipelineDefinition {
    let configured = raw
        .ci_config_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(str::to_string);
    let path = match configured.as_deref() {
        None => Some(".gitlab-ci.yml".to_string()),
        // Another project's file, or one behind a URL: there is nothing in this working copy, or
        // in this project's repository, to read it from.
        Some(path) if path.contains('@') || path.contains("://") => None,
        Some(path) => Some(path.trim_start_matches('/').to_string()),
    };
    let name = raw
        .name
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| project.rsplit('/').next().unwrap_or(project).to_string());
    PipelineDefinition {
        provider: PROVIDER_GITLAB.to_string(),
        id: configured.unwrap_or_else(|| ".gitlab-ci.yml".to_string()),
        name,
        path,
        variables: Vec::new(),
        web_url: format!("https://{host}/{}/-/pipelines/new", project.trim_matches('/')),
    }
}

/// What the "Run pipeline" dialog opens with. One request: the project, for its default branch and
/// its CI config path.
pub async fn launch_context(host: &str, project: &str, token: &str) -> Result<PipelineLaunchContext, String> {
    let url = format!("{}/projects/{}", api_root(host), encode_path(project));
    let raw: RawProject =
        http::get_json(authed(http::client().get(&url), token), http::Provider::GitLab).await?;
    let default_branch = raw
        .default_branch
        .clone()
        .map(|branch| branch.trim().to_string())
        .filter(|branch| !branch.is_empty());
    Ok(PipelineLaunchContext {
        provider: PROVIDER_GITLAB.to_string(),
        definitions: vec![project_definition(host, project, raw)],
        default_branch,
        // GitLab inputs have no `environment` type to fill.
        environments: Vec::new(),
    })
}

/// A file as the project's repository has it at `reference`. The path is encoded whole — slashes
/// included — because that is how this endpoint takes it: `ci%2Fbuild.yml`, one segment.
pub async fn definition_file(
    host: &str,
    project: &str,
    path: &str,
    reference: Option<&str>,
    token: &str,
) -> Result<Option<String>, String> {
    let mut url = format!(
        "{}/projects/{}/repository/files/{}/raw",
        api_root(host),
        encode_path(project),
        encode_path(path)
    );
    if let Some(reference) = reference.map(str::trim).filter(|value| !value.is_empty()) {
        url.push_str(&format!("?ref={}", encode_path(&split_ref(reference).1)));
    }
    http::get_text(
        authed(http::client().get(&url), token),
        http::Provider::GitLab,
        http::MAX_DEFINITION_BYTES,
    )
    .await
}

/// The body `POST /pipeline` takes.
///
/// The ref is sent short (`main`, not `refs/heads/main`): GitLab resolves a branch or a tag by
/// name and matches nothing for the full form. Variables go as `env_var` — the only type the
/// dialog offers; a file variable is a thing you set up in the project, not type into a box.
/// `inputs` (the typed `spec:inputs` of GitLab 17) is only sent when there are any, so an instance
/// from before inputs existed never sees the key.
fn create_body(
    reference: &str,
    variables: &[PipelineVariable],
    inputs: &BTreeMap<String, Value>,
) -> Value {
    let mut body = json!({ "ref": split_ref(reference).1 });
    if !variables.is_empty() {
        body["variables"] = variables
            .iter()
            .map(|variable| {
                json!({ "key": variable.key.trim(), "value": variable.value, "variable_type": "env_var" })
            })
            .collect();
    }
    if !inputs.is_empty() {
        body["inputs"] = Value::Object(inputs.clone().into_iter().collect());
    }
    body
}

#[derive(Deserialize)]
struct RawCreated {
    id: i64,
    #[serde(default)]
    web_url: Option<String>,
}

/// Starts a pipeline on a ref. GitLab answers with the pipeline it created, so the run is known
/// straight away.
pub async fn create_pipeline(
    host: &str,
    project: &str,
    reference: &str,
    variables: &[PipelineVariable],
    inputs: &BTreeMap<String, Value>,
    token: &str,
) -> Result<StartedPipeline, String> {
    let url = format!("{}/projects/{}/pipeline", api_root(host), encode_path(project));
    let request = authed(http::client().post(&url), token).json(&create_body(reference, variables, inputs));
    let receipt = http::send_write_for::<RawCreated>(request, http::Provider::GitLab).await?;
    Ok(match receipt {
        Some(created) => StartedPipeline {
            run_id: Some(created.id.to_string()),
            web_url: created.web_url.filter(|url| !url.trim().is_empty()),
        },
        None => StartedPipeline::default(),
    })
}

// ---------------------------------------------------------------------------
// Manual jobs and protected-environment approvals
// ---------------------------------------------------------------------------

/// Every job waiting for somebody to press play, as a gate.
///
/// Optional manual jobs included — the ones that don't block the pipeline. They are exactly as
/// playable, and a deploy button left on a green pipeline is the most common manual job there is.
fn manual_gates(host: &str, project: &str, run_id: &str, jobs: &[RawJob]) -> Vec<PipelineGate> {
    jobs.iter()
        .filter(|job| job.status == "manual")
        .map(|job| {
            let id = job.id.to_string();
            PipelineGate {
                provider: PROVIDER_GITLAB.to_string(),
                run_id: run_id.to_string(),
                web_url: job
                    .web_url
                    .clone()
                    .filter(|url| !url.trim().is_empty())
                    .unwrap_or_else(|| web_job_url(host, project, &id)),
                kind: gate_kind::MANUAL.to_string(),
                name: job.name.clone(),
                stage_id: None,
                job_ids: vec![id.clone()],
                can_act: None,
                reviewers: Vec::new(),
                instructions: None,
                since: None,
                id,
            }
        })
        .collect()
}

#[derive(Deserialize)]
struct RawDeployment {
    id: i64,
    #[serde(default)]
    status: String,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    environment: Option<RawDeploymentEnvironment>,
    /// The job doing the deploying — which is how a blocked deployment is joined to the manual job
    /// in this pipeline that it is holding.
    #[serde(default)]
    deployable: Option<RawDeployable>,
}

#[derive(Deserialize)]
struct RawDeploymentEnvironment {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
struct RawDeployable {
    id: i64,
}

/// The project's deployments waiting for approval. One page: a project with more than a hundred
/// deployments blocked at once has a problem this screen is not going to solve.
async fn blocked_deployments(host: &str, project: &str, token: &str) -> Result<Vec<RawDeployment>, String> {
    let url = format!(
        "{}/projects/{}/deployments?status=blocked&order_by=id&sort=desc&per_page=100",
        api_root(host),
        encode_path(project)
    );
    http::get_json(authed(http::client().get(&url), token), http::Provider::GitLab).await
}

/// Turns every job of this pipeline that is a blocked deployment into the approval it waits for.
///
/// Until the approvers have spoken, pressing play on that job does nothing but earn an error; what
/// the person looking at it can actually do is approve or reject. So its manual gate, when it has
/// one, is *replaced* — and a held job that isn't `manual` gets an approval gate all the same:
/// GitLab documents that the jobs deploying to such an environment "are blocked", not which status
/// word it files them under, and a gate that only appeared for one of the words would silently not
/// appear for the other.
///
/// Once approved, GitLab still wants the job started by hand ("approval doesn't start the job"),
/// and on the next read the gate is a play button again — because the deployment is no longer
/// blocked. A blocked deployment of a job in some *other* pipeline is none of this run's business.
fn apply_approvals(
    host: &str,
    project: &str,
    run_id: &str,
    jobs: &[RawJob],
    gates: Vec<PipelineGate>,
    deployments: Vec<RawDeployment>,
) -> Vec<PipelineGate> {
    let approval_for = |job: &RawJob| -> Option<PipelineGate> {
        let deployment = deployments.iter().find(|deployment| {
            deployment.status == "blocked"
                && deployment.deployable.as_ref().is_some_and(|deployable| deployable.id == job.id)
        })?;
        let job_id = job.id.to_string();
        let environment = deployment
            .environment
            .as_ref()
            .map(|environment| environment.name.trim().to_string())
            .filter(|name| !name.is_empty());
        Some(PipelineGate {
            provider: PROVIDER_GITLAB.to_string(),
            run_id: run_id.to_string(),
            id: deployment.id.to_string(),
            kind: gate_kind::APPROVAL.to_string(),
            name: environment.unwrap_or_else(|| job.name.clone()),
            stage_id: None,
            job_ids: vec![job_id.clone()],
            can_act: None,
            reviewers: Vec::new(),
            instructions: None,
            since: deployment.created_at.clone(),
            web_url: job
                .web_url
                .clone()
                .filter(|url| !url.trim().is_empty())
                .unwrap_or_else(|| web_job_url(host, project, &job_id)),
        })
    };

    let mut out: Vec<PipelineGate> = gates
        .into_iter()
        .map(|gate| {
            let job = jobs.iter().find(|job| job.id.to_string() == gate.id);
            job.and_then(|job| approval_for(job)).unwrap_or(gate)
        })
        .collect();
    for job in jobs {
        let held = out.iter().any(|gate| gate.job_ids.iter().any(|id| *id == job.id.to_string()));
        if held {
            continue;
        }
        if let Some(gate) = approval_for(job) {
            out.push(gate);
        }
    }
    out
}

/// The body of `POST /jobs/:id/play`: the variables, only when there are any.
fn play_body(variables: &[PipelineVariable]) -> Value {
    if variables.is_empty() {
        return json!({});
    }
    json!({
        "job_variables_attributes": variables
            .iter()
            .map(|variable| json!({ "key": variable.key.trim(), "value": variable.value }))
            .collect::<Vec<_>>(),
    })
}

/// Starts a manual job, with job-level variables when the user typed any.
pub async fn play_job(
    host: &str,
    project: &str,
    job_id: &str,
    variables: &[PipelineVariable],
    token: &str,
) -> Result<(), String> {
    let id = numeric_id(job_id, "job")?;
    let url = format!("{}/projects/{}/jobs/{id}/play", api_root(host), encode_path(project));
    let request = authed(http::client().post(&url), token).json(&play_body(variables));
    http::send_write(request, http::Provider::GitLab).await
}

fn approval_body(approve: bool, comment: &str) -> Value {
    json!({ "status": if approve { "approved" } else { "rejected" }, "comment": comment.trim() })
}

/// Approves or rejects a deployment waiting at a protected environment.
pub async fn review_deployment(
    host: &str,
    project: &str,
    deployment_id: &str,
    approve: bool,
    comment: &str,
    token: &str,
) -> Result<(), String> {
    let id = numeric_id(deployment_id, "deployment")?;
    let url = format!(
        "{}/projects/{}/deployments/{id}/approval",
        api_root(host),
        encode_path(project)
    );
    let request = authed(http::client().post(&url), token).json(&approval_body(approve, comment));
    http::send_write(request, http::Provider::GitLab).await
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

/// One artifact per job that kept an archive, named after the job.
///
/// Named after the job rather than after the file because the file is `artifacts.zip` for every job
/// there is — ten of them in a list would be ten identical rows. No `expired` flag: GitLab removes
/// `artifacts_file` from the job when the archive is deleted, so a listed one is still there.
fn map_artifacts(run_id: &str, jobs: Vec<RawJob>) -> Vec<PipelineArtifact> {
    jobs.into_iter()
        .filter_map(|job| {
            let file = job.artifacts_file?;
            if file.filename.trim().is_empty() && file.size.is_none() {
                return None;
            }
            Some(PipelineArtifact {
                provider: PROVIDER_GITLAB.to_string(),
                run_id: run_id.to_string(),
                id: job.id.to_string(),
                file_name: artifact_file_name(&job.name),
                size_bytes: file.size,
                expires_at: job.artifacts_expire_at.filter(|stamp| !stamp.trim().is_empty()),
                expired: false,
                job_name: Some(job.name.clone()),
                name: job.name,
            })
        })
        .collect()
}

/// A pipeline's artifacts: one request, the same job list the detail reads.
pub async fn list_artifacts(
    host: &str,
    project: &str,
    pipeline_id: &str,
    token: &str,
) -> Result<Vec<PipelineArtifact>, String> {
    let jobs = pipeline_jobs(host, project, pipeline_id, token).await?;
    Ok(map_artifacts(pipeline_id, jobs))
}

/// The request that downloads a job's archive.
///
/// **`Authorization: Bearer`, not the `PRIVATE-TOKEN` every other call here sends**, and the
/// difference is the whole reason this is not `authed(...)`. With object storage configured, GitLab
/// answers this endpoint with a redirect to a signed URL on the storage host. reqwest strips
/// `Authorization` on a cross-host hop — it knows that header is a credential — and forwards any
/// custom header untouched, so `PRIVATE-TOKEN` would travel on to the storage provider. GitLab takes
/// a personal or project access token in either header; only one of them stays home.
pub fn artifact_download(
    host: &str,
    project: &str,
    job_id: &str,
    token: &str,
) -> Result<reqwest::RequestBuilder, String> {
    let id = numeric_id(job_id, "job")?;
    let url = format!("{}/projects/{}/jobs/{id}/artifacts", api_root(host), encode_path(project));
    Ok(http::download_client().get(&url).header("Authorization", format!("Bearer {token}")))
}

#[cfg(test)]
mod launch_tests {
    //! Fixtures are the response shapes GitLab's REST reference documents for each endpoint,
    //! trimmed to the fields read here, with placeholder projects.
    use super::*;
    use crate::gitlab::GITLAB_COM;

    fn jobs(json: &str) -> Vec<RawJob> {
        serde_json::from_str(json).expect("jobs fixture")
    }

    #[test]
    fn a_project_has_one_pipeline_and_it_is_its_ci_config() {
        let raw: RawProject = serde_json::from_str(
            r#"{"id":3,"name":"Example Repo","path_with_namespace":"example-org/example-repo",
                "default_branch":"main","ci_config_path":null}"#,
        )
        .expect("project");
        let definition = project_definition(GITLAB_COM, "example-org/example-repo", raw);
        assert_eq!(definition.id, ".gitlab-ci.yml");
        assert_eq!(definition.path.as_deref(), Some(".gitlab-ci.yml"));
        assert_eq!(definition.name, "Example Repo");
        assert_eq!(definition.web_url, "https://gitlab.com/example-org/example-repo/-/pipelines/new");

        // A config in the repository under another name is still a file to read.
        let custom: RawProject =
            serde_json::from_str(r#"{"ci_config_path":"/ci/pipeline.yml"}"#).expect("custom");
        let custom = project_definition(GITLAB_COM, "example-org/example-repo", custom);
        assert_eq!(custom.path.as_deref(), Some("ci/pipeline.yml"));
        // No name on the project: its path's last segment.
        assert_eq!(custom.name, "example-repo");

        // Another project's file, or a URL: nothing in this working copy to read inputs from.
        for elsewhere in [".gitlab-ci.yml@example-org/ci-templates", "https://example.test/ci.yml"] {
            let raw: RawProject =
                serde_json::from_str(&format!(r#"{{"ci_config_path":"{elsewhere}"}}"#)).expect("elsewhere");
            assert_eq!(project_definition(GITLAB_COM, "g/p", raw).path, None, "{elsewhere}");
        }
    }

    #[test]
    fn a_pipeline_is_created_on_the_short_ref_with_env_var_variables() {
        let variables = vec![
            PipelineVariable { key: " DEPLOY_ENV ".to_string(), value: "staging".to_string(), masked: false },
            PipelineVariable { key: "API_TOKEN".to_string(), value: "s3cret".to_string(), masked: true },
        ];
        let body = create_body("refs/heads/release/2.0", &variables, &BTreeMap::new());
        assert_eq!(
            body,
            json!({"ref":"release/2.0","variables":[
                {"key":"DEPLOY_ENV","value":"staging","variable_type":"env_var"},
                {"key":"API_TOKEN","value":"s3cret","variable_type":"env_var"}
            ]})
        );
        // A tag goes short too; no variables and no inputs means neither key is sent.
        assert_eq!(create_body("refs/tags/v1.0", &[], &BTreeMap::new()), json!({"ref":"v1.0"}));

        // Typed inputs travel typed: GitLab's `spec:inputs` check their types.
        let mut inputs = BTreeMap::new();
        inputs.insert("replicas".to_string(), json!(3));
        inputs.insert("dry_run".to_string(), json!(true));
        assert_eq!(
            create_body("main", &[], &inputs),
            json!({"ref":"main","inputs":{"dry_run":true,"replicas":3}})
        );
    }

    #[test]
    fn a_created_pipeline_names_itself() {
        let created: RawCreated = serde_json::from_str(
            r#"{"id":61,"iid":21,"project_id":1,"sha":"384c444e840a515b23f21915ee5766b87068a70d",
                "ref":"main","status":"pending","before_sha":"0000000000000000000000000000000000000000",
                "tag":false,"yaml_errors":null,"created_at":"2026-09-11T11:43:35.012Z",
                "web_url":"https://gitlab.example.test/example-org/example-repo/-/pipelines/61"}"#,
        )
        .expect("created");
        assert_eq!(created.id, 61);
        assert_eq!(
            created.web_url.as_deref(),
            Some("https://gitlab.example.test/example-org/example-repo/-/pipelines/61")
        );
    }

    #[test]
    fn manual_jobs_are_play_gates_and_a_blocked_deployment_turns_its_job_into_an_approval() {
        let raw = jobs(
            r#"[
              {"id":7,"name":"build","stage":"build","status":"success","allow_failure":false},
              {"id":8,"name":"deploy-staging","stage":"deploy","status":"manual","allow_failure":true,
               "web_url":"https://gitlab.com/example-org/example-repo/-/jobs/8"},
              {"id":9,"name":"deploy-production","stage":"deploy","status":"manual","allow_failure":false},
              {"id":10,"name":"deploy-eu","stage":"deploy","status":"created","allow_failure":false}
            ]"#,
        );
        let gates = manual_gates(GITLAB_COM, "example-org/example-repo", "901", &raw);
        assert_eq!(gates.len(), 2);
        assert!(gates.iter().all(|gate| gate.kind == gate_kind::MANUAL));
        assert_eq!(gates[0].id, "8");
        assert_eq!(gates[0].job_ids, vec!["8".to_string()]);
        assert_eq!(gates[0].web_url, "https://gitlab.com/example-org/example-repo/-/jobs/8");
        // No web_url on the job: built the browser way, with literal slashes.
        assert_eq!(gates[1].web_url, "https://gitlab.com/example-org/example-repo/-/jobs/9");

        let blocked: Vec<RawDeployment> = serde_json::from_str(
            r#"[
              {"created_at":"2026-09-11T07:36:40.222Z","updated_at":"2026-09-11T07:38:12.414Z",
               "status":"blocked",
               "deployable":{"id":9,"name":"deploy-production","stage":"deploy","status":"manual","ref":"main",
                 "pipeline":{"id":901,"ref":"main","sha":"99d03678b90d914dbb1b109132516d71a4a03ea8","status":"manual",
                   "web_url":"https://gitlab.com/example-org/example-repo/-/pipelines/901"}},
               "environment":{"id":9,"name":"production","external_url":"https://example.test"},
               "id":41,"iid":1,"ref":"main","sha":"99d03678b90d914dbb1b109132516d71a4a03ea8"},
              {"status":"blocked","deployable":{"id":55},"environment":{"name":"elsewhere"},"id":42},
              {"status":"blocked","deployable":{"id":10},"environment":{"name":"eu"},"id":43},
              {"status":"success","deployable":{"id":8},"environment":{"name":"staging"},"id":40}
            ]"#,
        )
        .expect("deployments");

        let gates = apply_approvals(GITLAB_COM, "example-org/example-repo", "901", &raw, gates, blocked);
        assert_eq!(gates.len(), 3);
        // The optional staging deploy is still a play button: its deployment isn't blocked.
        assert_eq!(gates[0].kind, gate_kind::MANUAL);
        assert_eq!(gates[0].id, "8");
        // Production waits for approval: answered with the *deployment* id, labelled by environment,
        // and still marking its own job on the graph.
        assert_eq!(gates[1].kind, gate_kind::APPROVAL);
        assert_eq!(gates[1].id, "41");
        assert_eq!(gates[1].name, "production");
        assert_eq!(gates[1].job_ids, vec!["9".to_string()]);
        assert_eq!(gates[1].since.as_deref(), Some("2026-09-11T07:36:40.222Z"));
        // A held job GitLab didn't file as `manual` is still an approval — and 55, a job of some other
        // pipeline, is not this run's gate at all.
        assert_eq!(gates[2].kind, gate_kind::APPROVAL);
        assert_eq!(gates[2].id, "43");
        assert_eq!(gates[2].name, "eu");
        assert_eq!(gates[2].job_ids, vec!["10".to_string()]);
        assert_eq!(gates[2].web_url, "https://gitlab.com/example-org/example-repo/-/jobs/10");
    }

    #[test]
    fn a_blocked_pipeline_is_gated_and_a_finished_one_with_a_play_button_is_not() {
        let listed = |status: &str| {
            let raw: RawPipeline = serde_json::from_str(&format!(
                r#"{{"id":1,"ref":"main","status":"{status}","created_at":"2026-09-11T07:36:40Z"}}"#
            ))
            .expect("pipeline");
            map_pipeline(GITLAB_COM, "g/p", raw)
        };
        let blocked = listed("manual");
        assert!(blocked.gated);
        // Still not live: a blocked pipeline must not be polled every five seconds for days.
        assert!(!super::super::is_live(&blocked.status));
        for other in ["success", "running", "failed", "skipped", "created"] {
            assert!(!listed(other).gated, "{other}");
        }
    }

    #[test]
    fn play_and_approval_bodies_say_only_what_they_need() {
        assert_eq!(play_body(&[]), json!({}));
        let variables = vec![PipelineVariable { key: " TARGET ".to_string(), value: "eu".to_string(), masked: true }];
        assert_eq!(play_body(&variables), json!({"job_variables_attributes":[{"key":"TARGET","value":"eu"}]}));

        assert_eq!(approval_body(true, " looks good "), json!({"status":"approved","comment":"looks good"}));
        assert_eq!(approval_body(false, "no")["status"], json!("rejected"));
        // Ids are checked before they reach a URL.
        assert!(numeric_id("41", "deployment").is_ok());
        assert!(numeric_id("41/../../x", "deployment").is_err());
    }

    /// The archive is the one artifact the endpoint serves; a job that kept none has no row.
    #[test]
    fn a_job_with_an_archive_is_an_artifact_named_after_the_job() {
        let raw = jobs(
            r#"[
              {"id":7,"name":"build:web","stage":"build","status":"success",
               "artifacts":[{"file_type":"archive","size":1000,"filename":"artifacts.zip","file_format":"zip"},
                            {"file_type":"metadata","size":186,"filename":"metadata.gz","file_format":"gzip"},
                            {"file_type":"trace","size":1500,"filename":"job.log","file_format":"raw"}],
               "artifacts_file":{"filename":"artifacts.zip","size":1000},
               "artifacts_expire_at":"2026-10-23T17:54:27.895Z"},
              {"id":8,"name":"lint","stage":"test","status":"success",
               "artifacts":[{"file_type":"trace","size":1500,"filename":"job.log","file_format":"raw"}]}
            ]"#,
        );
        let artifacts = map_artifacts("901", raw);
        assert_eq!(artifacts.len(), 1);
        assert_eq!(artifacts[0].id, "7");
        assert_eq!(artifacts[0].name, "build:web");
        assert_eq!(artifacts[0].file_name, "build_web.zip");
        assert_eq!(artifacts[0].size_bytes, Some(1000));
        assert_eq!(artifacts[0].expires_at.as_deref(), Some("2026-10-23T17:54:27.895Z"));
        assert_eq!(artifacts[0].job_name.as_deref(), Some("build:web"));
        assert_eq!(artifacts[0].run_id, "901");
    }

    /// The token must not follow a redirect to object storage — see [`artifact_download`].
    #[test]
    fn an_artifact_download_authenticates_with_a_header_that_stays_home() {
        let request = artifact_download(GITLAB_COM, "example-org/example-repo", "7", "glpat-example")
            .expect("request")
            .build()
            .expect("built");
        assert_eq!(
            request.url().as_str(),
            "https://gitlab.com/api/v4/projects/example-org%2Fexample-repo/jobs/7/artifacts"
        );
        assert_eq!(
            request.headers().get("authorization").and_then(|v| v.to_str().ok()),
            Some("Bearer glpat-example")
        );
        assert!(request.headers().get("private-token").is_none());
        assert!(artifact_download(GITLAB_COM, "g/p", "7/../x", "t").is_err());
    }
}
