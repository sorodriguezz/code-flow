//! GitHub Actions — workflow runs, the jobs inside them, and their logs.
//!
//! Of the three providers this is the one whose API says the *least* about structure. A workflow
//! run is a flat bag of jobs: `/runs/{id}/jobs` returns no `needs`, no stage, no ordering, nothing
//! that says which two jobs ran in parallel and which one waited for the other. That single gap is
//! why [`PipelineRun::definition_path`] exists at all, and why every `stage` this module produces
//! is `None` — see the note on [`map_job`].
//!
//! The second thing worth knowing before reading any of this: GitHub splits a run's state across
//! two fields, `status` (where it is in its lifecycle) and `conclusion` (how it ended, `null` until
//! it has). Nothing in this file looks at one without the other; [`bucket_status`] is the only
//! place the pair is interpreted.

use serde::Deserialize;

use super::http;
use super::{
    status, JobLog, PipelineJob, PipelineRun, PipelineRunDetail, PROVIDER_GITHUB,
};
use crate::github::{api_root, bearer, API_VERSION, GITHUB_COM};

/// How many runs one page asks for.
///
/// Deliberately below GitHub's 100 maximum: this endpoint is polled while a run is live, and a run
/// object is large (it embeds the head commit, the repository, and both the triggering and
/// referenced workflow). 50 keeps a poll cheap while still filling the list in one request for the
/// page sizes the UI actually asks for.
const PER_PAGE: usize = 50;

/// The hard ceiling on pagination, in pages.
///
/// The loop below stops on its own as soon as it has `limit` runs or sees a short page; this only
/// bounds the pathological case where a caller asks for more than any list view could show. 10
/// pages is 500 runs — far past the point where a human is reading a list rather than searching.
const MAX_PAGES: usize = 10;

/// Percent-encodes a value that has to survive a trip through a URL.
///
/// Branch names are the reason: `release/2.0` unencoded turns `?branch=release/2.0` into a query
/// GitHub reads as a branch called `release` (and answers with an empty list, which reads as "no
/// runs" rather than as a bug). `NON_ALPHANUMERIC` is deliberately over-broad — encoding a `.` or
/// a `-` that did not need it is free, and the alternative is maintaining a fourth hand-rolled
/// character table next to the three `crate::gitlab` and `crate::ado` already carry.
fn encode(value: &str) -> String {
    percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC).to_string()
}

/// A GET carrying the three headers every GitHub REST call in this crate sends.
///
/// The `User-Agent` is missing on purpose — [`http::client`] sets it once for the whole process,
/// and GitHub answers 403 to any request without one, so having it in exactly one place is the
/// version of this that cannot be got wrong.
fn request(url: &str, token: &str) -> reqwest::RequestBuilder {
    http::client()
        .get(url)
        .header("Authorization", bearer(token))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", API_VERSION)
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct RawRunsPage {
    #[serde(rename = "workflow_runs", default)]
    workflow_runs: Vec<RawRun>,
}

#[derive(Deserialize)]
struct RawRun {
    id: u64,
    /// The workflow's name. `null` for a run whose workflow file was deleted or renamed, which is
    /// exactly the run someone is looking at when they open this screen to find out what happened.
    #[serde(default)]
    name: Option<String>,
    /// The commit or pull-request title GitHub shows next to the run in its own UI.
    #[serde(rename = "display_title", default)]
    display_title: Option<String>,
    #[serde(rename = "run_number", default)]
    run_number: Option<i64>,
    #[serde(default)]
    status: String,
    #[serde(default)]
    conclusion: Option<String>,
    #[serde(rename = "head_branch", default)]
    head_branch: Option<String>,
    #[serde(rename = "head_sha", default)]
    head_sha: String,
    #[serde(default)]
    event: Option<String>,
    #[serde(rename = "created_at", default)]
    created_at: String,
    /// When a runner actually picked it up. Distinct from `created_at`, and the gap between the
    /// two is the queue wait — which is why the two are kept apart rather than collapsed.
    #[serde(rename = "run_started_at", default)]
    run_started_at: Option<String>,
    #[serde(rename = "updated_at", default)]
    updated_at: Option<String>,
    #[serde(rename = "html_url", default)]
    html_url: String,
    /// Repo-relative path of the workflow file, e.g. `.github/workflows/ci.yml`.
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    actor: Option<RawActor>,
    /// Absent on a run whose head commit GitHub can no longer resolve (force-pushed away,
    /// deleted branch), so it is optional rather than assumed.
    #[serde(rename = "head_commit", default)]
    head_commit: Option<RawHeadCommit>,
}

#[derive(Deserialize)]
struct RawActor {
    #[serde(default)]
    login: String,
}

#[derive(Deserialize)]
struct RawHeadCommit {
    #[serde(default)]
    message: String,
}

#[derive(Deserialize)]
struct RawJobsPage {
    #[serde(default)]
    jobs: Vec<RawJob>,
}

#[derive(Deserialize)]
struct RawJob {
    id: u64,
    #[serde(default)]
    name: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    conclusion: Option<String>,
    #[serde(rename = "started_at", default)]
    started_at: Option<String>,
    /// Unlike the run, a *job* does publish a real completion stamp — which is why
    /// [`map_job`] needs none of the guesswork [`map_run`] documents.
    #[serde(rename = "completed_at", default)]
    completed_at: Option<String>,
    #[serde(rename = "html_url", default)]
    html_url: Option<String>,
    #[serde(default)]
    steps: Vec<RawStep>,
}

/// A step, reduced to the two fields anything here reads.
///
/// The step's `name` and `number` are deliberately left on the wire. [`PipelineJob`] has no step
/// level — `ci::mod` states why: GitLab has no steps at all and Azure hangs the log off a timeline
/// record rather than off a job, so a step tier would be a GitHub-only shape the other two clients
/// could not fill. Deserializing a field nothing reads would be a promise this module does not
/// keep. What the steps *are* used for is [`has_soft_failures`], which needs only their outcome.
#[derive(Deserialize)]
struct RawStep {
    #[serde(default)]
    name: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    conclusion: Option<String>,
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/// Collapses GitHub's `(status, conclusion)` pair into the seven buckets in [`status`].
///
/// The lifecycle field decides first, because a run that has not finished has no conclusion to
/// consult:
///
/// | `status`                                     | bucket |
/// |----------------------------------------------|--------|
/// | `queued`, `waiting`, `requested`, `pending`   | `QUEUED` |
/// | `in_progress`                                | `RUNNING` |
///
/// `waiting` is an environment approval gate, `requested` a job awaiting a deployment review and
/// `pending` a concurrency-group hold. All three are the same thing to a reader — accepted, not
/// started — so they share a bucket, and the exact word survives in `raw_status`.
///
/// Once it is over, the conclusion decides:
///
/// | `conclusion`                                  | bucket |
/// |-----------------------------------------------|--------|
/// | `success`                                     | `SUCCESS` |
/// | `failure`, `startup_failure`, `timed_out`     | `FAILED` |
/// | `cancelled`                                   | `CANCELLED` |
/// | `skipped`                                     | `SKIPPED` |
/// | `neutral`, `action_required`, `stale`         | `WARNING` |
///
/// `startup_failure` is a workflow file that would not parse and `timed_out` is a runner that hit
/// its limit; both are the run failing to produce an answer, which is what `FAILED` means here.
/// `stale` — a run GitHub abandoned because a newer one superseded it — is a warning rather than
/// `CANCELLED` because nobody cancelled it; it simply never got a verdict.
///
/// **Anything unrecognised.** A conclusion this function has never heard of on a finished run
/// becomes `WARNING`, not `SUCCESS`. GitHub adds conclusions over time, and the failure mode of
/// guessing `SUCCESS` is the one that costs something: a red build silently painted green, which
/// is worse than a green build painted amber. If the run is *not* finished, the same unknown gets
/// `RUNNING` — it is still moving, [`super::is_live`] keeps polling it, and the next poll corrects
/// whatever this one got wrong.
fn bucket_status(status: &str, conclusion: Option<&str>) -> String {
    match status {
        "queued" | "waiting" | "requested" | "pending" => return status::QUEUED.to_string(),
        "in_progress" => return status::RUNNING.to_string(),
        _ => {}
    }

    match conclusion.map(str::trim).filter(|c| !c.is_empty()) {
        Some("success") => status::SUCCESS.to_string(),
        Some("failure") | Some("startup_failure") | Some("timed_out") => {
            status::FAILED.to_string()
        }
        Some("cancelled") => status::CANCELLED.to_string(),
        Some("skipped") => status::SKIPPED.to_string(),
        Some("neutral") | Some("action_required") | Some("stale") => status::WARNING.to_string(),
        // No conclusion and a lifecycle word we don't know, or a conclusion we don't know: see the
        // doc comment. Never `SUCCESS`.
        _ => {
            if status == "completed" {
                status::WARNING.to_string()
            } else {
                status::RUNNING.to_string()
            }
        }
    }
}

/// The provider's own word, for the tooltip: the conclusion once there is one, the lifecycle
/// status until then. This is what makes the bucketing above safe to be lossy.
fn raw_status(status: &str, conclusion: Option<&str>) -> String {
    if let Some(word) = conclusion.map(str::trim).filter(|c| !c.is_empty()) {
        return word.to_string();
    }
    if status.trim().is_empty() {
        return "unknown".to_string();
    }
    status.to_string()
}

/// Whether the jobs say the run went less cleanly than the run itself admits.
///
/// GitHub reports a workflow run as `success` when nothing in it *failed*, which is not the same
/// as everything in it having run. Two shapes hide under a green run:
///
/// 1. A job that concluded `neutral` or `action_required`. `action_required` in particular means a
///    deployment is sitting there waiting for a human — the run is over, the work is not.
/// 2. A job whose steps did not all execute.
///
/// The second one needs a narrower rule than it first looks like it does. `if: failure()` and
/// `if: cancelled()` cleanup steps are skipped on **every** healthy run, so "any skipped step"
/// would paint essentially every successful build amber and the colour would stop meaning
/// anything. So a skipped step only counts when a step that *did* run comes after it: something
/// in the middle of the job was bypassed and the job carried on regardless. A trailing block of
/// skipped conditionals — the ubiquitous pattern — is left alone.
///
/// A job with a step still in flight is not judged at all; the run is not over from this
/// function's point of view and the next poll will ask again.
fn has_soft_failures(jobs: &[RawJob]) -> bool {
    jobs.iter().any(|job| {
        matches!(job.conclusion.as_deref(), Some("neutral") | Some("action_required"))
            || skipped_mid_job(job)
    })
}

/// Steps the runner adds itself, rather than steps the workflow declared.
///
/// They always come after the user's, and they always conclude `success`, so they cannot be
/// evidence that the job carried on past a skip. `Set up job` opens every job, `Post <action>` and
/// `Complete job` close it. A workflow that genuinely names a step "Post something" gets a false
/// negative — green stays green — which is the safe direction to be wrong in.
fn is_runner_step(name: &str) -> bool {
    let name = name.trim();
    name == "Set up job" || name == "Complete job" || name.starts_with("Post ")
}

/// A job that skipped a step and then kept going — see [`has_soft_failures`].
fn skipped_mid_job(job: &RawJob) -> bool {
    if job.status != "completed" {
        return false;
    }
    let mut seen_skip = false;
    for step in &job.steps {
        match step.conclusion.as_deref() {
            // Still moving: refuse to draw a conclusion from a half-finished job.
            None | Some("") => {
                if step.status != "completed" {
                    return false;
                }
            }
            Some("skipped") => seen_skip = true,
            // A step that reached a real verdict after a skip is the signal — unless the runner
            // wrote it. This is the difference between the rule as designed and the rule as it
            // behaved: Actions appends `Post <action>` and `Complete job` to the end of *every*
            // job, always `success`, so the trailing block of skipped `if: failure()` cleanup that
            // this function is documented as leaving alone was in fact followed by a real verdict
            // every single time. Nearly every green run came back amber.
            Some(_) if seen_skip && !is_runner_step(&step.name) => return true,
            Some(_) => {}
        }
    }
    false
}

/// Upgrades a `SUCCESS` run to `WARNING` when its jobs say it should be — see
/// [`has_soft_failures`].
///
/// **This deliberately cannot happen in [`list_runs`].** The list endpoint returns runs without
/// their jobs, and asking for the jobs of fifty runs to render one list would be fifty extra
/// requests against a rate limit this screen already polls against. So a run with a `neutral` job
/// shows as green in the list and turns amber the moment it is opened. That is a known, accepted
/// difference between the two views, not a bug in either of them: the list is what GitHub itself
/// says, and the detail is what the jobs say.
///
/// `raw_status` is left untouched on purpose. It is defined as *what the provider actually said*,
/// and the provider said `success`; a tooltip that reports a word GitHub never used is a tooltip
/// that cannot be checked against GitHub's own UI.
fn refine_run_status(run: &mut PipelineRun, jobs: &[RawJob]) {
    if run.status == status::SUCCESS && has_soft_failures(jobs) {
        run.status = status::WARNING.to_string();
    }
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/// The first line of a commit message — the subject, which is the only part a one-line list has
/// room for. `None` rather than an empty string when there is nothing to show, so the frontend
/// can leave the slot out instead of rendering a blank.
fn first_line(message: &str) -> Option<String> {
    let line = message.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        None
    } else {
        Some(line.to_string())
    }
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.trim().is_empty())
}

/// What to call the run.
///
/// `name` is the workflow's own name and is what a reader recognises, so it wins. It is `null` for
/// a run whose workflow file has since been deleted or renamed, and `display_title` — the commit
/// or PR title — is the next most useful thing GitHub offers. Failing both, the workflow file's
/// basename at least names the thing that ran.
fn run_name(raw: &RawRun) -> String {
    if let Some(name) = raw.name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        return name.to_string();
    }
    if let Some(title) = raw.display_title.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        return title.to_string();
    }
    if let Some(path) = raw.path.as_deref() {
        if let Some(file) = path.rsplit('/').next().filter(|f| !f.is_empty()) {
            return file.to_string();
        }
    }
    "Workflow".to_string()
}

fn map_run(host: &str, owner: &str, repo: &str, raw: RawRun) -> PipelineRun {
    let bucket = bucket_status(&raw.status, raw.conclusion.as_deref());
    let raw_word = raw_status(&raw.status, raw.conclusion.as_deref());
    let name = run_name(&raw);
    let id = raw.id.to_string();

    // GitHub publishes no `completed_at` on a workflow run — only on its jobs. `updated_at` is the
    // closest thing, and it is *only* the finish time once the run is `completed`: on a live run it
    // moves every time a job changes state, so reporting it as a finish stamp would show a run that
    // ended before it started. Left `None` until GitHub says the run is over, which costs a dash in
    // the duration column and never shows a wrong number. (A rerun bumps `updated_at` too, so on a
    // rerun run this is the *last* finish, not the first — still a real finish, and the alternative
    // is nothing at all.)
    let finished_at =
        if raw.status == "completed" { non_empty(raw.updated_at) } else { None };

    let web_url = if raw.html_url.trim().is_empty() {
        web_run_url(host, owner, repo, &id)
    } else {
        raw.html_url.clone()
    };

    PipelineRun {
        provider: PROVIDER_GITHUB.to_string(),
        id,
        number: raw.run_number,
        name,
        status: bucket,
        raw_status: raw_word,
        branch: raw.head_branch.unwrap_or_default(),
        commit_sha: raw.head_sha,
        commit_title: raw.head_commit.and_then(|c| first_line(&c.message)),
        actor: raw.actor.map(|a| a.login).filter(|login| !login.trim().is_empty()),
        event: non_empty(raw.event),
        created_at: raw.created_at,
        started_at: non_empty(raw.run_started_at),
        finished_at,
        web_url,
        // The workflow file's path, and the one field on `PipelineRun` that exists for GitHub
        // specifically. `/runs/{id}/jobs` publishes no `needs`, so this file is the only place the
        // job graph is written down; the frontend reads it out of the working copy and parses the
        // `needs:` to lay the jobs out in columns. Nothing in the backend parses it — handing over
        // the path costs one string and avoids both an extra request and a YAML dependency.
        definition_path: non_empty(raw.path),
    }
}

fn map_job(host: &str, owner: &str, repo: &str, run_id: &str, raw: RawJob) -> PipelineJob {
    let id = raw.id.to_string();
    let web_url = match raw.html_url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
        Some(url) => url.to_string(),
        None => format!("{}/job/{id}", web_run_url(host, owner, repo, run_id)),
    };

    PipelineJob {
        provider: PROVIDER_GITHUB.to_string(),
        run_id: run_id.to_string(),
        id,
        name: raw.name,
        // Always `None`, and not because it was overlooked. GitHub's API publishes no relation
        // between jobs at all: no stage, no `needs`, no order. Inventing one from the job names
        // ("build" before "test") would be a guess the UI would then draw as fact. The honest
        // answer is nothing, and `PipelineRun::definition_path` is how the frontend gets the real
        // graph — from the workflow file, which is where GitHub actually keeps it.
        stage: None,
        status: bucket_status(&raw.status, raw.conclusion.as_deref()),
        raw_status: raw_status(&raw.status, raw.conclusion.as_deref()),
        started_at: non_empty(raw.started_at),
        finished_at: non_empty(raw.completed_at),
        web_url,
        // The job id addresses its own log. Only Azure needs a second identifier here.
        log_ref: None,
    }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// The most recent workflow runs, newest first, optionally narrowed to one branch.
///
/// Paginated with a bounded loop rather than by following the `Link` header: `Link` would have to
/// be parsed (it is a comma-separated list of angle-bracketed URLs with `rel=` parameters, and
/// getting it slightly wrong loops forever), and the caller already knows how many runs it wants.
/// The loop stops at whichever comes first — `limit` reached, a short page, or [`MAX_PAGES`].
pub async fn list_runs(
    host: &str,
    owner: &str,
    repo: &str,
    branch: Option<&str>,
    limit: usize,
    token: &str,
) -> Result<Vec<PipelineRun>, String> {
    let wanted = limit.max(1);
    let pages = wanted.div_ceil(PER_PAGE).min(MAX_PAGES);
    let root = api_root(host);
    let branch = branch.map(str::trim).filter(|b| !b.is_empty());

    let mut runs: Vec<PipelineRun> = Vec::with_capacity(wanted.min(PER_PAGE * pages));
    for page in 1..=pages {
        let mut url =
            format!("{root}/repos/{owner}/{repo}/actions/runs?per_page={PER_PAGE}&page={page}");
        if let Some(branch) = branch {
            url.push_str(&format!("&branch={}", encode(branch)));
        }

        let body: RawRunsPage = http::get_json(request(&url, token), http::Provider::GitHub).await?;
        let returned = body.workflow_runs.len();
        for raw in body.workflow_runs {
            if runs.len() >= wanted {
                break;
            }
            runs.push(map_run(host, owner, repo, raw));
        }

        // A page shorter than what we asked for is the last page; anything else would be a second
        // request for a response we already know is empty.
        if returned < PER_PAGE || runs.len() >= wanted {
            break;
        }
    }
    Ok(runs)
}

/// One run and its jobs.
///
/// The two requests go out together: the UI never renders one without the other, and running them
/// in sequence would put a full round trip to GitHub between opening a run and seeing it. Either
/// failing fails the pair — a run drawn with an empty job list would look like a run that had no
/// jobs, which is a state GitHub does not actually produce.
///
/// This is also where the run's status is re-derived from what the jobs say — see
/// [`refine_run_status`], which documents why the list view cannot do the same and why that
/// difference is expected rather than a defect.
pub async fn run_detail(
    host: &str,
    owner: &str,
    repo: &str,
    run_id: &str,
    token: &str,
) -> Result<PipelineRunDetail, String> {
    let root = api_root(host);
    let id = encode(run_id);
    let run_url = format!("{root}/repos/{owner}/{repo}/actions/runs/{id}");
    // 100 is the endpoint's maximum. A workflow run with more than 100 jobs is a matrix build well
    // past what the graph can draw, and paging for the tail would double the cost of every open.
    let jobs_url = format!("{root}/repos/{owner}/{repo}/actions/runs/{id}/jobs?per_page=100");

    let (raw_run, raw_jobs) = tokio::try_join!(
        http::get_json::<RawRun>(request(&run_url, token), http::Provider::GitHub),
        http::get_json::<RawJobsPage>(request(&jobs_url, token), http::Provider::GitHub),
    )?;

    let mut run = map_run(host, owner, repo, raw_run);
    refine_run_status(&mut run, &raw_jobs.jobs);

    let jobs = raw_jobs
        .jobs
        .into_iter()
        .map(|job| map_job(host, owner, repo, &run.id, job))
        .collect();

    Ok(PipelineRunDetail { run, jobs })
}

/// One job's log.
///
/// The endpoint does not serve the log: it answers `302` with a signed URL into blob storage on a
/// **different host**, and the log comes from there. Two things make that work without any special
/// handling here.
///
/// First, reqwest follows the redirect on its own (the default policy allows up to 10 hops), so
/// one request is still one request.
///
/// Second — and this is the part worth writing down — reqwest strips the `Authorization` header on
/// a cross-host hop (`remove_sensitive_headers`). That is not an obstacle being worked around, it
/// is exactly what has to happen: the signed URL carries its own credentials in the query string,
/// and blob storage rejects a request that also presents someone else's `Authorization`. Sending
/// our token along would break the download; having it quietly dropped is the behaviour that makes
/// this a two-line function.
///
/// The response is `text/plain`, which is why this goes through [`http::get_log`] rather than
/// `get_json` — and why the cap is applied to the *stream*, since a job that loops printing can
/// produce hundreds of megabytes.
pub async fn job_log(
    host: &str,
    owner: &str,
    repo: &str,
    job_id: &str,
    token: &str,
) -> Result<JobLog, String> {
    let url = format!(
        "{}/repos/{owner}/{repo}/actions/jobs/{}/logs",
        api_root(host),
        encode(job_id)
    );
    http::get_log(request(&url, token), http::Provider::GitHub).await
}

/// The browser URL for a run, built by hand.
///
/// Only a fallback: every run object carries an `html_url` and that is what [`map_run`] uses. This
/// covers the case where it comes back empty, so "open in GitHub" is never a dead button. The web
/// host is the host itself for both github.com and an Enterprise Server — unlike the API, which
/// lives on `api.github.com` for the former and `/api/v3` for the latter, which is why this does
/// not go through [`api_root`].
pub fn web_run_url(host: &str, owner: &str, repo: &str, run_id: &str) -> String {
    let host = match host.trim() {
        "" => GITHUB_COM,
        host => host,
    };
    format!("https://{host}/{owner}/{repo}/actions/runs/{run_id}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(status: &str, conclusion: Option<&str>) -> RawStep {
        named_step("", status, conclusion)
    }

    fn named_step(name: &str, status: &str, conclusion: Option<&str>) -> RawStep {
        RawStep {
            name: name.to_string(),
            status: status.to_string(),
            conclusion: conclusion.map(str::to_string),
        }
    }

    fn job(conclusion: Option<&str>, steps: Vec<RawStep>) -> RawJob {
        RawJob {
            id: 1,
            name: "build".to_string(),
            status: "completed".to_string(),
            conclusion: conclusion.map(str::to_string),
            started_at: None,
            completed_at: None,
            html_url: None,
            steps,
        }
    }

    #[test]
    fn a_run_that_has_not_finished_is_bucketed_by_its_lifecycle_alone() {
        for word in ["queued", "waiting", "requested", "pending"] {
            assert_eq!(bucket_status(word, None), status::QUEUED, "{word}");
        }
        assert_eq!(bucket_status("in_progress", None), status::RUNNING);
        // The lifecycle wins even if a conclusion is somehow present: a queued run has not ended.
        assert_eq!(bucket_status("queued", Some("success")), status::QUEUED);
        assert_eq!(bucket_status("in_progress", Some("failure")), status::RUNNING);
    }

    #[test]
    fn a_finished_run_is_bucketed_by_its_conclusion() {
        let cases = [
            ("success", status::SUCCESS),
            ("failure", status::FAILED),
            ("startup_failure", status::FAILED),
            ("timed_out", status::FAILED),
            ("cancelled", status::CANCELLED),
            ("skipped", status::SKIPPED),
            ("neutral", status::WARNING),
            ("action_required", status::WARNING),
            ("stale", status::WARNING),
        ];
        for (conclusion, expected) in cases {
            assert_eq!(
                bucket_status("completed", Some(conclusion)),
                expected,
                "conclusion {conclusion}"
            );
        }
    }

    /// The whole point of the fallback: a conclusion nobody has taught this function about must
    /// not be painted green. GitHub adds conclusions; silently reporting a red build as a passing
    /// one is the single most expensive thing this file could get wrong.
    #[test]
    fn an_unknown_outcome_never_reads_as_success() {
        assert_eq!(bucket_status("completed", Some("some_future_verdict")), status::WARNING);
        assert_eq!(bucket_status("completed", None), status::WARNING);
        assert_eq!(bucket_status("completed", Some("")), status::WARNING);
        // Not finished and not a word we know: still moving, so it keeps being polled.
        assert_eq!(bucket_status("blocked_by_something_new", None), status::RUNNING);
        assert_eq!(bucket_status("", None), status::RUNNING);
    }

    #[test]
    fn the_hosts_own_word_survives_the_bucketing() {
        assert_eq!(raw_status("completed", Some("timed_out")), "timed_out");
        assert_eq!(raw_status("in_progress", None), "in_progress");
        // An empty conclusion is not a conclusion.
        assert_eq!(raw_status("queued", Some("")), "queued");
        assert_eq!(raw_status("", None), "unknown");
    }

    #[test]
    fn a_commit_title_is_only_the_subject_line() {
        assert_eq!(
            first_line("fix(ci): stop retrying a 404\n\nThe body explains why.\nAnd goes on."),
            Some("fix(ci): stop retrying a 404".to_string())
        );
        // A message that is already one line comes through whole.
        assert_eq!(first_line("bump deps"), Some("bump deps".to_string()));
        // Trailing whitespace and CRLF checkouts must not leak into the UI.
        assert_eq!(first_line("subject  \r\nbody"), Some("subject".to_string()));
        assert_eq!(first_line(""), None);
        assert_eq!(first_line("\n\nonly a body?"), None);
    }

    #[test]
    fn a_run_falls_back_through_the_names_github_offers() {
        let mut raw = RawRun {
            id: 7,
            name: Some("CI".to_string()),
            display_title: Some("fix the thing".to_string()),
            run_number: Some(42),
            status: "completed".to_string(),
            conclusion: Some("success".to_string()),
            head_branch: None,
            head_sha: String::new(),
            event: None,
            created_at: String::new(),
            run_started_at: None,
            updated_at: None,
            html_url: String::new(),
            path: Some(".github/workflows/ci.yml".to_string()),
            actor: None,
            head_commit: None,
        };
        assert_eq!(run_name(&raw), "CI");

        // Workflow deleted or renamed: GitHub sends `null` and the commit title is what is left.
        raw.name = None;
        assert_eq!(run_name(&raw), "fix the thing");

        raw.display_title = None;
        assert_eq!(run_name(&raw), "ci.yml");

        raw.path = None;
        assert_eq!(run_name(&raw), "Workflow");
    }

    #[test]
    fn a_finish_time_is_only_claimed_once_the_run_is_over() {
        let raw = RawRun {
            id: 7,
            name: Some("CI".to_string()),
            display_title: None,
            run_number: Some(42),
            status: "in_progress".to_string(),
            conclusion: None,
            head_branch: Some("main".to_string()),
            head_sha: "abc123".to_string(),
            event: Some("push".to_string()),
            created_at: "2026-08-21T17:00:00Z".to_string(),
            run_started_at: Some("2026-08-21T17:00:09Z".to_string()),
            updated_at: Some("2026-08-21T17:03:00Z".to_string()),
            html_url: String::new(),
            path: Some(".github/workflows/ci.yml".to_string()),
            actor: Some(RawActor { login: "octocat".to_string() }),
            head_commit: Some(RawHeadCommit {
                message: "fix the thing\n\nlong body".to_string(),
            }),
        };

        let live = map_run("github.com", "acme", "app", raw);
        assert_eq!(live.status, status::RUNNING);
        // `updated_at` moves on every job transition, so on a live run it is not a finish time.
        assert_eq!(live.finished_at, None);
        assert_eq!(live.started_at.as_deref(), Some("2026-08-21T17:00:09Z"));
        assert_eq!(live.commit_title.as_deref(), Some("fix the thing"));
        assert_eq!(live.actor.as_deref(), Some("octocat"));
        assert_eq!(live.definition_path.as_deref(), Some(".github/workflows/ci.yml"));
        // No `html_url` on the wire, so the hand-built browser URL stands in.
        assert_eq!(live.web_url, "https://github.com/acme/app/actions/runs/7");
    }

    #[test]
    fn a_completed_run_reports_its_last_update_as_the_finish() {
        let raw = RawRun {
            id: 7,
            name: None,
            display_title: None,
            run_number: None,
            status: "completed".to_string(),
            conclusion: Some("failure".to_string()),
            head_branch: None,
            head_sha: String::new(),
            event: None,
            created_at: "2026-08-21T17:00:00Z".to_string(),
            run_started_at: None,
            updated_at: Some("2026-08-21T17:03:00Z".to_string()),
            html_url: "https://github.com/acme/app/actions/runs/7".to_string(),
            path: None,
            actor: None,
            head_commit: None,
        };
        let done = map_run("github.com", "acme", "app", raw);
        assert_eq!(done.status, status::FAILED);
        assert_eq!(done.finished_at.as_deref(), Some("2026-08-21T17:03:00Z"));
        assert_eq!(done.commit_title, None);
        assert_eq!(done.definition_path, None);
    }

    /// A green run whose jobs say otherwise. This is the correction the list view cannot make.
    #[test]
    fn a_neutral_job_turns_a_green_run_amber() {
        let mut run = PipelineRun {
            provider: PROVIDER_GITHUB.to_string(),
            id: "7".to_string(),
            number: Some(42),
            name: "CI".to_string(),
            status: status::SUCCESS.to_string(),
            raw_status: "success".to_string(),
            branch: "main".to_string(),
            commit_sha: "abc123".to_string(),
            commit_title: None,
            actor: None,
            event: None,
            created_at: "2026-08-21T17:00:00Z".to_string(),
            started_at: None,
            finished_at: None,
            web_url: String::new(),
            definition_path: None,
        };

        refine_run_status(&mut run, &[job(Some("success"), vec![])]);
        assert_eq!(run.status, status::SUCCESS, "nothing to correct");

        refine_run_status(&mut run, &[job(Some("success"), vec![]), job(Some("neutral"), vec![])]);
        assert_eq!(run.status, status::WARNING);
        // The provider's own word is untouched — the tooltip must still match GitHub's UI.
        assert_eq!(run.raw_status, "success");
    }

    #[test]
    fn a_deployment_waiting_on_a_human_is_a_warning_too() {
        assert!(has_soft_failures(&[job(Some("action_required"), vec![])]));
        assert!(!has_soft_failures(&[job(Some("success"), vec![])]));
        // A failed job already made the run FAILED; `refine_run_status` never sees it, and this
        // function has no business second-guessing it either.
        assert!(!has_soft_failures(&[job(Some("failure"), vec![])]));
    }

    /// The narrowing that keeps `WARNING` meaning something: `if: failure()` cleanup steps are
    /// skipped on every healthy run, so a trailing skip is not a signal.
    #[test]
    fn trailing_conditional_steps_do_not_make_a_run_amber() {
        let healthy = job(
            Some("success"),
            vec![
                step("completed", Some("success")),
                step("completed", Some("success")),
                step("completed", Some("skipped")), // if: failure()
                step("completed", Some("skipped")), // if: cancelled()
            ],
        );
        assert!(!has_soft_failures(&[healthy]));
    }

    #[test]
    fn a_step_skipped_mid_job_is_a_signal() {
        let bypassed = job(
            Some("success"),
            vec![
                step("completed", Some("success")),
                step("completed", Some("skipped")), // something was bypassed...
                step("completed", Some("success")), // ...and the job carried on anyway
            ],
        );
        assert!(has_soft_failures(&[bypassed]));
    }

    #[test]
    fn a_job_still_running_is_not_judged() {
        let mut moving = job(
            Some("success"),
            vec![step("completed", Some("skipped")), step("in_progress", None)],
        );
        moving.status = "in_progress".to_string();
        assert!(!has_soft_failures(&[moving]));

        // Marked completed but carrying a step that never reached a verdict: still no judgement.
        let ragged = job(
            Some("success"),
            vec![
                step("completed", Some("skipped")),
                step("in_progress", None),
                step("completed", Some("success")),
            ],
        );
        assert!(!has_soft_failures(&[ragged]));
    }

    #[test]
    fn a_job_carries_no_stage_and_no_log_ref() {
        let mapped = map_job(
            "github.com",
            "acme",
            "app",
            "7",
            RawJob {
                id: 99,
                name: "test (ubuntu-latest)".to_string(),
                status: "completed".to_string(),
                conclusion: Some("timed_out".to_string()),
                started_at: Some("2026-08-21T17:00:11Z".to_string()),
                completed_at: Some("2026-08-21T17:02:00Z".to_string()),
                html_url: None,
                steps: vec![],
            },
        );
        assert_eq!(mapped.stage, None);
        assert_eq!(mapped.log_ref, None);
        assert_eq!(mapped.status, status::FAILED);
        assert_eq!(mapped.raw_status, "timed_out");
        assert_eq!(mapped.run_id, "7");
        assert_eq!(mapped.web_url, "https://github.com/acme/app/actions/runs/7/job/99");
    }

    #[test]
    fn the_browser_url_is_the_host_itself_on_both_github_com_and_enterprise() {
        assert_eq!(
            web_run_url("github.com", "acme", "app", "7"),
            "https://github.com/acme/app/actions/runs/7"
        );
        assert_eq!(
            web_run_url("git.contoso.com", "acme", "app", "7"),
            "https://git.contoso.com/acme/app/actions/runs/7"
        );
        // An empty host would otherwise produce `https:///acme/...`.
        assert_eq!(
            web_run_url("  ", "acme", "app", "7"),
            "https://github.com/acme/app/actions/runs/7"
        );
    }

    /// Unencoded, `?branch=release/2.0` reaches GitHub as a branch named `release` and comes back
    /// as an empty list — which reads like "no runs" rather than like a bug.
    #[test]
    fn a_branch_with_a_slash_survives_the_query_string() {
        assert_eq!(encode("release/2.0"), "release%2F2%2E0");
        assert_eq!(encode("feature/joe's branch"), "feature%2Fjoe%27s%20branch");
        assert_eq!(encode("main"), "main");
    }
    /// The regression this rule was quietly producing on nearly every green build.
    ///
    /// Actions appends its own steps to the end of every job — `Post <action>` for each action that
    /// registered cleanup, then `Complete job` — and they always conclude `success`. So the
    /// trailing block of skipped `if: failure()` steps that `has_soft_failures` is documented as
    /// leaving alone was, in fact, always followed by a step with a real verdict.
    #[test]
    fn the_runners_own_trailing_steps_do_not_turn_a_green_run_amber() {
        let green = job(
            Some("success"),
            vec![
                named_step("Set up job", "completed", Some("success")),
                named_step("Run actions/checkout@v4", "completed", Some("success")),
                named_step("pnpm build", "completed", Some("success")),
                // The ubiquitous `if: failure()` cleanup, skipped because nothing failed.
                named_step("Upload logs", "completed", Some("skipped")),
                // …and what the runner writes after it, every time.
                named_step("Post Run actions/checkout@v4", "completed", Some("success")),
                named_step("Complete job", "completed", Some("success")),
            ],
        );
        assert!(!skipped_mid_job(&green), "un build verde no puede leerse como 'con avisos'");
        assert!(!has_soft_failures(std::slice::from_ref(&green)));

        // And the rule it exists for still fires: a skip with real work after it.
        let amber = job(
            Some("success"),
            vec![
                named_step("run tests", "completed", Some("skipped")),
                named_step("publish", "completed", Some("success")),
                named_step("Complete job", "completed", Some("success")),
            ],
        );
        assert!(skipped_mid_job(&amber));
    }

}
