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
//! `get_json`: that client has no timeout of any kind, and this screen polls and downloads logs.

use serde::Deserialize;

use crate::gitlab::{api_root, authed, encode_path};

use super::http;
use super::{status, JobLog, PipelineJob, PipelineRun, PipelineRunDetail, PROVIDER_GITLAB};

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

    // `include_retried=false` is the default and is stated anyway: with retries included the same
    // job name appears several times and the graph draws a column of ghosts alongside the attempt
    // that actually counts. 100 is GitLab's maximum page size, and a pipeline with more than a
    // hundred jobs is rare enough that a second page is not worth the round trip on every open.
    let jobs_url =
        format!("{root}/projects/{encoded}/pipelines/{id}/jobs?per_page=100&include_retried=false");
    let raw_jobs: Vec<RawJob> =
        http::get_json(authed(http::client().get(&jobs_url), token), http::Provider::GitLab).await?;

    let run = map_pipeline_detail(host, project, raw_run);
    let jobs = raw_jobs.into_iter().map(|job| map_job(host, project, &run.id, job)).collect();
    // GitLab names a job's stage and says nothing else about the stage itself — no state, no
    // start, no finish, and no endpoint that has them. The UI summarises the jobs instead, and
    // an empty vector is what tells it to.
    Ok(PipelineRunDetail { run, jobs, stages: Vec::new() })
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
