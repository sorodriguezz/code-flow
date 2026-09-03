//! Azure Pipelines, through the **Build** API.
//!
//! The names line up with the other two clients only after a translation that is worth stating
//! once, because every awkward thing in this file falls out of it:
//!
//! * a *run* is a **build** (`/_apis/build/builds`), and its name is the *definition's* name —
//!   a build has no name of its own, only a `buildNumber`;
//! * a *job* is a **timeline record** of `type == "Job"`, out of a flat list of records that is
//!   really a tree held together by `parentId`;
//! * a *log* does not belong to the job. It belongs to a **record**, and the job record is not
//!   guaranteed to have one — see [`job_log`] and [`resolve_log_ref`].
//!
//! Everything shared with the pull-request client (`API_VERSION`, the `Basic` header, the org
//! normalisation, the path encoder, the `{count, value: […]}` envelope) is imported from
//! [`crate::ado`] rather than re-derived here: both halves talk to the same server, and a second
//! copy of `normalize_org` is a second thing to keep in step. The transport, on the other hand, is
//! this module's own ([`super::http`]) — `ado::get_json` has no timeout and no plain-text path,
//! and this screen both polls and downloads logs.

use std::collections::HashMap;

use serde::Deserialize;

use super::http;
use super::{
    status, JobLog, PipelineJob, PipelineRun, PipelineRunDetail, PipelineStage, MAX_LOG_BYTES,
    PROVIDER_AZURE,
};
use crate::ado::{
    auth_header, encode_segment, normalize_org, ListResponse, API_VERSION, BAD_CREDENTIALS,
};

/// How deep a `parentId` chain is walked before giving up.
///
/// A real timeline is three or four levels (Stage → Phase → Job → Task). The bound is not about
/// depth, it is about *cycles*: the records arrive as a flat array and nothing in the response
/// promises the parent links form a tree. A malformed one must not hang the UI thread on an
/// infinite walk.
const MAX_TIMELINE_DEPTH: usize = 16;

/// The ceiling on `$top` when the repository filter has to be applied on this side.
///
/// Asking for exactly `limit` builds and *then* discarding the ones belonging to other
/// repositories of the same project would answer three runs for a project with several
/// repositories. So the unfiltered path over-fetches and trims afterwards. The cap keeps that from
/// turning into a multi-megabyte response on a busy project.
const CLIENT_FILTER_TOP: usize = 200;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct RawBuild {
    #[serde(default)]
    id: i64,
    #[serde(rename = "buildNumber", default)]
    build_number: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    result: Option<String>,
    #[serde(rename = "queueTime", default)]
    queue_time: Option<String>,
    #[serde(rename = "startTime", default)]
    start_time: Option<String>,
    #[serde(rename = "finishTime", default)]
    finish_time: Option<String>,
    #[serde(rename = "sourceBranch", default)]
    source_branch: String,
    #[serde(rename = "sourceVersion", default)]
    source_version: String,
    /// What queued it: `manual`, `individualCI`, `pullRequest`, `schedule`… Shown, never matched.
    #[serde(default)]
    reason: Option<String>,
    #[serde(rename = "_links", default)]
    links: Option<RawLinks>,
    #[serde(default)]
    definition: Option<RawDefinition>,
    #[serde(rename = "requestedFor", default)]
    requested_for: Option<RawIdentity>,
    #[serde(default)]
    repository: Option<RawRepoRef>,
}

#[derive(Deserialize)]
struct RawLinks {
    #[serde(default)]
    web: Option<RawHref>,
}

#[derive(Deserialize)]
struct RawHref {
    #[serde(default)]
    href: Option<String>,
}

#[derive(Deserialize)]
struct RawDefinition {
    /// The definition's own id, which is what the definition-detail endpoint is addressed by. A
    /// build carries only this reference — never the pipeline file it was compiled from.
    #[serde(default)]
    id: i64,
    #[serde(default)]
    name: String,
}

/// A build definition, fetched only for the one field a build reference does not carry.
#[derive(Deserialize)]
struct RawDefinitionDetail {
    #[serde(default)]
    process: Option<RawProcess>,
}

#[derive(Deserialize)]
struct RawProcess {
    /// `1` = designer (classic), `2` = YAML. Only a YAML pipeline has a file to point at; a
    /// classic one is stored as a graph of tasks in the server's own database.
    #[serde(rename = "type", default)]
    kind: i64,
    #[serde(rename = "yamlFilename", default)]
    yaml_filename: String,
}

#[derive(Deserialize)]
struct RawIdentity {
    #[serde(rename = "displayName", default)]
    display_name: String,
}

#[derive(Deserialize)]
struct RawRepoRef {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
struct RawTimeline {
    #[serde(default)]
    records: Vec<RawRecord>,
}

#[derive(Deserialize)]
struct RawRecord {
    #[serde(default)]
    id: String,
    #[serde(rename = "parentId", default)]
    parent_id: Option<String>,
    /// `Stage` | `Phase` | `Job` | `Task` | `Checkpoint` | … Compared case-insensitively: the
    /// value is documented as PascalCase, and one lower-cased `job` from a future server version
    /// would silently empty the graph.
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    result: Option<String>,
    #[serde(rename = "startTime", default)]
    start_time: Option<String>,
    #[serde(rename = "finishTime", default)]
    finish_time: Option<String>,
    #[serde(default)]
    order: i64,
    /// The record's own ref name — for a `Stage`, the `stage:` key in the pipeline file. The only
    /// token a `dependsOn:` can be matched against; see `PipelineStage::ref_name`.
    #[serde(default)]
    identifier: Option<String>,
    #[serde(default)]
    log: Option<RawLogRef>,
    #[serde(default)]
    issues: Vec<RawIssue>,
}

#[derive(Deserialize)]
struct RawLogRef {
    #[serde(default)]
    id: i64,
}

#[derive(Deserialize)]
struct RawIssue {
    /// `error` | `warning`. The message is deliberately not deserialised: it is not shown on this
    /// screen — the log is — and an unread field is a field that goes stale.
    #[serde(rename = "type", default)]
    kind: String,
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/// Whether a string is shaped like an Azure DevOps repository GUID:
/// `8-4-4-4-12` hex digits, e.g. `3f2504e0-4f89-11d3-9a0c-0305e82c3301`.
///
/// This is the single most expensive trap of this provider. The project's `ado_repo_id` column can
/// hold **either** form:
///
/// * a GUID, when the user picked the repository from the settings dropdown (`ado::list_repos`
///   answers ids), or
/// * a plain **name**, when the link was auto-detected from the git remote — `ado_cmd.rs` writes
///   `detected.repo`, and its comment there says why that is legal: Azure's *Git* REST API accepts
///   a name wherever it accepts a GUID.
///
/// The **Build** API does not. `?repositoryId=MiRepo&repositoryType=TfsGit` is not an error and not
/// a 404: it matches nothing and answers `{"count":0,"value":[]}`. The symptom is an empty
/// Pipelines tab on a repository that plainly has builds, with no failure to show the user — which
/// is why the filter is only sent when the value can actually work, and is otherwise applied here.
fn looks_like_guid(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(index, byte)| match index {
        8 | 13 | 18 | 23 => *byte == b'-',
        _ => byte.is_ascii_hexdigit(),
    })
}

/// `refs/heads/main` → `main`.
///
/// Only that one prefix is removed. A pull-request validation build reports
/// `refs/pull/123/merge`, which is not a branch and has no shorter honest form — showing it whole
/// tells the user what actually ran; trimming it to `123/merge` would not.
fn strip_branch_prefix(reference: &str) -> String {
    reference.strip_prefix("refs/heads/").unwrap_or(reference).to_string()
}

/// The human-facing build number as an `i64`, when it is one.
///
/// Azure's default numbering format is `$(Date:yyyyMMdd)$(Rev:.r)` — `20260821.3` — which is not
/// an integer and never will be. `None` is the correct answer there; the frontend already treats
/// a missing number as "show the id instead", and parsing it as `20260821` would invent a
/// counter that jumps by millions between days.
fn parse_build_number(number: &str) -> Option<i64> {
    number.trim().parse::<i64>().ok()
}

fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// The provider's own word, for the tooltip — the `result` once there is one, the `state`
/// otherwise. Keeping it is what makes [`bucket_status`] safe to be lossy: `partiallySucceeded`
/// and a `succeeded` build carrying warnings both bucket to `warning`, and only this tells them
/// apart on screen.
fn raw_label(state: &str, result: Option<&str>) -> String {
    match result.map(str::trim).filter(|value| !value.is_empty()) {
        Some(result) => result.to_string(),
        None => state.to_string(),
    }
}

/// Collapses Azure's state/result pair into the seven shared buckets.
///
/// | state | result | bucket |
/// |---|---|---|
/// | `notStarted`, `pending`, `postponed`, `none` | — | `QUEUED` |
/// | `inProgress`, `cancelling` | — | `RUNNING` |
/// | `completed` | `succeeded` | `SUCCESS`, or `WARNING` with warnings |
/// | `completed` | `partiallySucceeded` | `WARNING` |
/// | `completed` | `failed` | `FAILED` |
/// | `completed` | `canceled` | `CANCELLED` |
/// | `completed` | `skipped`, `abandoned` | `SKIPPED` |
/// | `completed` | absent / unknown | `QUEUED` |
///
/// Two notes on the edges. `cancelling` is `RUNNING`, not `CANCELLED`: the agent is still tearing
/// the job down, the log is still growing, and the polling cadence keyed off
/// [`super::is_live`] has to keep going or the run freezes half-cancelled on screen. And
/// `partiallySucceeded` is the reason [`status::WARNING`] exists at all — Azure is the only one of
/// the three that publishes the state outright instead of making us derive it.
///
/// Both inputs are lower-cased before matching because the *same vocabulary arrives in two
/// casings*: a build's `status` is `notStarted`/`inProgress`, a timeline record's `state` is
/// `pending`/`inProgress` — and `canceled` is spelled with one `l` by the API but with two by
/// roughly everyone typing a fixture.
fn bucket_status(state: &str, result: Option<&str>, has_warnings: bool) -> String {
    let state_key = state.trim().to_ascii_lowercase();
    let result_key = result.map(|value| value.trim().to_ascii_lowercase());

    if state_key != "completed" {
        return match state_key.as_str() {
            "inprogress" | "cancelling" | "canceling" => status::RUNNING.to_string(),
            // Anything unrecognised is treated as "not moving yet" rather than as a finished
            // state: an unknown *terminal* word rendered as SUCCESS would be a lie, while an
            // unknown pending word merely keeps the row polling for one more cycle.
            _ => status::QUEUED.to_string(),
        };
    }

    match result_key.as_deref() {
        Some("succeeded") => {
            if has_warnings {
                status::WARNING.to_string()
            } else {
                status::SUCCESS.to_string()
            }
        }
        Some("partiallysucceeded") => status::WARNING.to_string(),
        Some("failed") => status::FAILED.to_string(),
        Some("canceled") | Some("cancelled") => status::CANCELLED.to_string(),
        Some("skipped") | Some("abandoned") => status::SKIPPED.to_string(),
        // `completed` with no result at all is a build the server has accepted but not yet
        // adjudicated. QUEUED keeps it live so the next poll resolves it.
        _ => status::QUEUED.to_string(),
    }
}

/// Short-circuits an empty PAT with the message the server would eventually produce anyway.
///
/// Worth doing because of the 203 quirk documented in [`crate::ado::get_json`]: an unauthenticated
/// request to `dev.azure.com` is not a 401, it is the sign-in *page* with a success-ish status. The
/// round trip buys nothing and the error would be identical.
fn require_pat(pat: &str) -> Result<(), String> {
    if pat.trim().is_empty() {
        return Err(BAD_CREDENTIALS.to_string());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Builds
// ---------------------------------------------------------------------------

/// The most recent builds of a repository, newest first.
///
/// `repo_id` may be a GUID or a repository name — see [`looks_like_guid`], which is where the
/// interesting half of this function lives. `branch` is a plain branch name (`main`); it is
/// re-prefixed to `refs/heads/…` because that is the only form the API matches on. An empty
/// `repo_id` means the project is linked to the Azure *project* but not to one of its
/// repositories, and every build of the project is returned rather than none.
pub async fn list_builds(
    org: &str,
    project: &str,
    repo_id: &str,
    branch: Option<&str>,
    limit: usize,
    pat: &str,
) -> Result<Vec<PipelineRun>, String> {
    require_pat(pat)?;

    let org_enc = encode_segment(&normalize_org(org));
    let project_enc = encode_segment(project);
    let limit = limit.max(1);

    let repo_id = repo_id.trim();
    let filter_on_server = looks_like_guid(repo_id);
    let filter_here = !repo_id.is_empty() && !filter_on_server;

    // When the server can filter, `$top` is exactly what the caller asked for. When it cannot, the
    // response is every repository's builds interleaved, so ask for more and trim at the end.
    let top = if filter_here { (limit * 5).min(CLIENT_FILTER_TOP).max(limit) } else { limit };

    let mut url = format!(
        "https://dev.azure.com/{org_enc}/{project_enc}/_apis/build/builds\
         ?api-version={API_VERSION}&$top={top}&queryOrder=queueTimeDescending"
    );
    if filter_on_server {
        url.push_str(&format!(
            "&repositoryId={}&repositoryType=TfsGit",
            encode_segment(repo_id)
        ));
    }
    if let Some(branch) = branch.map(str::trim).filter(|value| !value.is_empty()) {
        // Stripped and re-prefixed rather than concatenated blindly: callers upstream hold the
        // branch in both forms (the checkout knows `main`, a PR link knows `refs/heads/main`),
        // and `refs/heads/refs/heads/main` matches nothing and reports it as "no builds".
        let full = format!("refs/heads/{}", strip_branch_prefix(branch));
        url.push_str(&format!("&branchName={}", encode_segment(&full)));
    }

    let request = http::client().get(&url).header("Authorization", auth_header(pat));
    let parsed: ListResponse<RawBuild> = http::get_json(request, http::Provider::Azure).await?;

    let mut runs: Vec<PipelineRun> = parsed
        .value
        .into_iter()
        .filter(|build| !filter_here || belongs_to_repo(build, repo_id))
        .map(|build| map_build(&org_enc, &project_enc, build))
        .collect();
    runs.truncate(limit);
    Ok(runs)
}

/// Whether a build came from the repository the project is linked to, matched by *either*
/// identifier.
///
/// Both are compared because we do not know which one `repo_id` is: the auto-link stores a name,
/// but a hand-edited link or an older row can hold a GUID that simply failed
/// [`looks_like_guid`]'s shape check (a trimmed brace form, say). Comparing against both costs
/// nothing and removes a whole class of "the tab is empty" reports.
///
/// A build with no `repository` block at all is dropped rather than kept: it cannot be attributed
/// to this repository, and showing another repository's runs under this one's tab is worse than
/// showing one run fewer.
fn belongs_to_repo(build: &RawBuild, repo_id: &str) -> bool {
    build.repository.as_ref().is_some_and(|repo| {
        repo.id.eq_ignore_ascii_case(repo_id) || repo.name.eq_ignore_ascii_case(repo_id)
    })
}

fn map_build(org_enc: &str, project_enc: &str, build: RawBuild) -> PipelineRun {
    let id = build.id.to_string();
    let web_url = build
        .links
        .as_ref()
        .and_then(|links| links.web.as_ref())
        .and_then(|web| web.href.as_deref())
        .and_then(non_empty)
        // `_links` is absent from some server responses (and from every cached fixture), and the
        // results page is addressable without it. Built from the already-encoded segments so an
        // org or project with a space in it stays a single path segment.
        .unwrap_or_else(|| {
            format!(
                "https://dev.azure.com/{org_enc}/{project_enc}/_build/results?buildId={id}"
            )
        });

    PipelineRun {
        provider: PROVIDER_AZURE.to_string(),
        id,
        number: parse_build_number(&build.build_number),
        // A build carries no name of its own; the definition's is what a human recognises.
        name: build
            .definition
            .as_ref()
            .and_then(|definition| non_empty(&definition.name))
            .unwrap_or_else(|| "Pipeline".to_string()),
        status: bucket_status(&build.status, build.result.as_deref(), false),
        raw_status: raw_label(&build.status, build.result.as_deref()),
        branch: strip_branch_prefix(&build.source_branch),
        commit_sha: build.source_version,
        // The Build API returns the commit *id* and nothing else about it. Fetching the message
        // would be one Git API call per row of the list, for a subtitle — the frontend already
        // renders a run without one.
        commit_title: None,
        actor: build
            .requested_for
            .as_ref()
            .and_then(|identity| non_empty(&identity.display_name)),
        event: build.reason.as_deref().and_then(non_empty),
        // `queueTime` is the honest creation stamp: a build waiting for an agent has no
        // `startTime` yet, and a list sorted by "created" that fell back to the start time would
        // reorder itself as builds picked up runners.
        created_at: build
            .queue_time
            .clone()
            .or_else(|| build.start_time.clone())
            .unwrap_or_default(),
        started_at: build.start_time,
        finished_at: build.finish_time,
        web_url,
        // Filled in by `build_detail`, which is the only caller that has a definition id and a
        // spare round trip to spend on it — a build resource carries a `DefinitionReference` whose
        // `path` is the folder in the *pipeline definitions* tree, not a repo path, so the YAML
        // filename takes a second lookup.
        //
        // This used to be a hard `None` on the premise that Azure's timeline already gives the
        // graph its stages. It gives the *stages*; it says nothing whatsoever about which one waits
        // for which, so the board was left inferring the shape from the stage clocks — which reads
        // two stages that ran in parallel as a chain whenever one of them was skipped.
        definition_path: None,
    }
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

/// One build with its jobs, read from the build itself plus its timeline.
///
/// Two round trips, sequentially: the timeline is only meaningful for a build that exists, and
/// firing both at once would mean explaining a timeline error for a build that turned out to be
/// deleted.
pub async fn build_detail(
    org: &str,
    project: &str,
    build_id: &str,
    pat: &str,
) -> Result<PipelineRunDetail, String> {
    require_pat(pat)?;

    let org_enc = encode_segment(&normalize_org(org));
    let project_enc = encode_segment(project);
    let build_enc = encode_segment(build_id.trim());

    let build_url = format!(
        "https://dev.azure.com/{org_enc}/{project_enc}/_apis/build/builds/{build_enc}\
         ?api-version={API_VERSION}"
    );
    let request = http::client().get(&build_url).header("Authorization", auth_header(pat));
    let build: RawBuild = http::get_json(request, http::Provider::Azure).await?;
    let definition_id = build.definition.as_ref().map(|definition| definition.id).unwrap_or(0);
    let mut run = map_build(&org_enc, &project_enc, build);

    // Where the pipeline is written down, when it is written down at all.
    //
    // Deliberately best-effort, and deliberately not `?`: this exists to give the stage board its
    // `dependsOn`, and a build whose definition cannot be read is a build that draws the board it
    // drew before — from the stage clocks, with the badge saying so. Failing the whole detail over
    // it would trade a slightly weaker drawing for no drawing at all.
    if definition_id > 0 {
        run.definition_path = definition_yaml_path(&org_enc, &project_enc, definition_id, pat).await;
    }

    let timeline_url = format!(
        "https://dev.azure.com/{org_enc}/{project_enc}/_apis/build/builds/{build_enc}/Timeline\
         ?api-version={API_VERSION}"
    );
    let request = http::client().get(&timeline_url).header("Authorization", auth_header(pat));
    let timeline: RawTimeline = http::get_json(request, http::Provider::Azure).await?;

    let jobs = map_timeline(&run.id, &org_enc, &project_enc, &timeline.records);
    // Read from the same records, in a second pass rather than as a by-product of the first: the
    // stage list has to include the stages that *do* have jobs, and `map_timeline` only ever looks
    // at a `Stage` record when it turns out to have none.
    let stages = map_stages(&run.id, &timeline.records);
    Ok(PipelineRunDetail { run, jobs, stages })
}

/// The repo-relative pipeline file a definition points at, or `None` if there isn't one.
///
/// Never returns an error: every failure here — a PAT without definition read, a deleted
/// definition, a classic pipeline that has no file at all — means the same thing to the caller,
/// which is "draw the board from the clocks".
async fn definition_yaml_path(
    org_enc: &str,
    project_enc: &str,
    definition_id: i64,
    pat: &str,
) -> Option<String> {
    let url = format!(
        "https://dev.azure.com/{org_enc}/{project_enc}/_apis/build/definitions/{definition_id}\
         ?api-version={API_VERSION}"
    );
    let request = http::client().get(&url).header("Authorization", auth_header(pat));
    let detail: RawDefinitionDetail = http::get_json(request, http::Provider::Azure).await.ok()?;
    yaml_path(&detail)
}

/// The mapping half of [`definition_yaml_path`], as a pure function so it is testable without a
/// network.
fn yaml_path(detail: &RawDefinitionDetail) -> Option<String> {
    let process = detail.process.as_ref()?;
    // A classic definition has no file to read; pointing the parser at one would be a read that
    // could only ever fail.
    if process.kind != 2 {
        return None;
    }
    // Azure reports it with a leading slash; `readFileText` joins it onto the working copy's root
    // and an absolute-looking segment there would escape it.
    non_empty(&process.yaml_filename).map(|path| path.trim_start_matches('/').to_string())
}

/// Turns the flat record array into the job list the graph draws.
///
/// Split out of [`build_detail`] so the part with all the reasoning in it — ancestry, ordering,
/// log addressing — is testable without a network.
fn map_timeline(
    run_id: &str,
    org_enc: &str,
    project_enc: &str,
    records: &[RawRecord],
) -> Vec<PipelineJob> {
    let by_id: HashMap<&str, usize> = records
        .iter()
        .enumerate()
        .filter(|(_, record)| !record.id.is_empty())
        .map(|(index, record)| (record.id.as_str(), index))
        .collect();

    let mut children: HashMap<&str, Vec<usize>> = HashMap::new();
    for (index, record) in records.iter().enumerate() {
        if let Some(parent) = record.parent_id.as_deref().filter(|id| !id.is_empty()) {
            children.entry(parent).or_default().push(index);
        }
    }

    let mut jobs: Vec<(i64, i64, PipelineJob)> = Vec::new();
    // Which stages ended up with a job under them, so the ones that did not can be drawn as
    // stages. Keyed by the record **id** and not by the name: two stages sharing a `displayName`
    // are two stages, and keying by name let a jobless one be suppressed by its namesake's jobs —
    // which is exactly the disappearance the placeholder loop below exists to prevent.
    let mut stages_with_jobs: std::collections::HashSet<String> = std::collections::HashSet::new();

    for (index, record) in records.iter().enumerate() {
        if !record.kind.eq_ignore_ascii_case("Job") {
            continue;
        }
        let (stage, stage_id, stage_order) = resolve_stage(records, &by_id, index);
        if let Some(id) = stage_id.as_deref() {
            stages_with_jobs.insert(id.to_string());
        }
        let has_warnings = has_warning_issues(records, &children, index);

        let job = PipelineJob {
            provider: PROVIDER_AZURE.to_string(),
            run_id: run_id.to_string(),
            id: record.id.clone(),
            name: non_empty(&record.name).unwrap_or_else(|| "Job".to_string()),
            stage,
            stage_id,
            status: bucket_status(&record.state, record.result.as_deref(), has_warnings),
            raw_status: raw_label(&record.state, record.result.as_deref()),
            started_at: record.start_time.clone(),
            finished_at: record.finish_time.clone(),
            // `j=` is how the results page selects one timeline record in the logs view, so this
            // opens the browser on *this* job rather than on the build's first one.
            web_url: format!(
                "https://dev.azure.com/{org_enc}/{project_enc}/_build/results\
                 ?buildId={build}&view=logs&j={record}",
                build = encode_segment(run_id),
                record = encode_segment(&record.id)
            ),
            log_ref: resolve_log_ref(records, &children, index),
        };
        jobs.push((stage_order, record.order, job));
    }

    // A stage the timeline knows about and has no jobs under — yet, or ever.
    //
    // # Why this loop exists
    //
    // Azure fills a build's timeline as the build runs. A stage that has **not started** is in it
    // from the beginning as a `pending` record, but its phases and jobs are not: job expansion can
    // depend on runtime expressions, so the server defers it until the stage begins. A stage that
    // was **skipped by a condition** is the same shape from this side — a record with
    // `result: "skipped"` and, frequently, nothing underneath it at all.
    //
    // Mapping only `Job` records therefore made those stages *disappear*. A build sitting on its
    // second of four stages drew two columns and no hint that two more were coming, next to a
    // browser tab showing all four — which is the whole complaint: the app said the pipeline was
    // two stages long and the pipeline was not.
    //
    // So a stage with no jobs becomes one card carrying the stage's own state. It is deliberately
    // **not** an invented job list: the timeline does not say what those jobs will be called, and a
    // guessed name on a CI screen is worse than an honest "this stage, not started". When the stage
    // does start, its real jobs arrive on the next poll and replace the placeholder, because it is
    // only emitted while `stages_with_jobs` has nothing for that stage.
    for record in records.iter() {
        if !record.kind.eq_ignore_ascii_case("Stage") {
            continue;
        }
        let Some(name) = non_empty(&record.name) else { continue };
        if stages_with_jobs.contains(&record.id) {
            continue;
        }
        jobs.push((
            record.order,
            // Behind every real job of the same stage order, which there are none of by
            // construction — this is only for sorting against *other* stages' placeholders.
            i64::MIN,
            PipelineJob {
                provider: PROVIDER_AZURE.to_string(),
                run_id: run_id.to_string(),
                id: record.id.clone(),
                name: name.clone(),
                stage: Some(name),
                stage_id: non_empty(&record.id),
                status: bucket_status(&record.state, record.result.as_deref(), false),
                raw_status: raw_label(&record.state, record.result.as_deref()),
                started_at: record.start_time.clone(),
                finished_at: record.finish_time.clone(),
                web_url: format!(
                    "https://dev.azure.com/{org_enc}/{project_enc}/_build/results\
                     ?buildId={build}&view=results",
                    build = encode_segment(run_id)
                ),
                // A stage record has no log of its own, and its children are the phases whose logs
                // belong to jobs that do not exist yet. Nothing to fetch is `None`, not an empty
                // string — see `job_log`.
                log_ref: None,
            },
        ));
    }

    // Sorted by the *stage's* order first, then by the job's own, so the graph reads the way the
    // YAML does. The array as it arrives is in no useful order: it is the server's record table,
    // and a job of stage 3 routinely precedes a job of stage 1 in it.
    jobs.sort_by_key(|(stage_order, record_order, _)| (*stage_order, *record_order));
    jobs.into_iter().map(|(_, _, job)| job).collect()
}

/// The `Stage` records, as themselves.
///
/// [`map_timeline`] flattens the timeline into jobs and keeps only the *name* of the stage each one
/// sits under, which is all a column heading needs. A stage card needs the rest: its own state, and
/// its own clock.
///
/// Those two are not recoverable from the jobs, which is the whole argument for this function:
///
/// * a stage sitting on an **approval** is `inProgress` with no jobs started under it at all, and
///   rolled up from its (empty, or already-succeeded) job list it would read as queued or done;
/// * a stage's `startTime` precedes its first job's — the agent allocation, the checkpoint, the
///   `dependsOn` wait all land in the stage's span and in no job's — so `max(finish) - min(start)`
///   over the jobs is systematically shorter than the number Azure prints;
/// * `canceled` above jobs that finished cleanly is an ordinary shape, not a corrupted one.
///
/// Stages with no usable name are dropped rather than emitted anonymously: the frontend joins these
/// to their jobs *by name*, so a nameless one could only ever match a column that isn't there.
fn map_stages(run_id: &str, records: &[RawRecord]) -> Vec<PipelineStage> {
    let mut stages: Vec<(i64, PipelineStage)> = records
        .iter()
        .filter(|record| record.kind.eq_ignore_ascii_case("Stage"))
        .filter_map(|record| {
            let name = non_empty(&record.name)?;
            Some((
                record.order,
                PipelineStage {
                    provider: PROVIDER_AZURE.to_string(),
                    run_id: run_id.to_string(),
                    id: record.id.clone(),
                    name,
                    ref_name: record.identifier.as_deref().and_then(non_empty),
                    // `false` for warnings, deliberately: a stage's own record carries no issues,
                    // and hunting the tree for a descendant's would make the card disagree with the
                    // word Azure itself puts on the stage. The jobs inside it show their own.
                    status: bucket_status(&record.state, record.result.as_deref(), false),
                    raw_status: raw_label(&record.state, record.result.as_deref()),
                    started_at: record.start_time.clone(),
                    finished_at: record.finish_time.clone(),
                },
            ))
        })
        .collect();

    // Declaration order, matching what `map_timeline` sorts the jobs by, so the two arrive in the
    // same sequence and a reader stepping through them is stepping through the YAML.
    stages.sort_by_key(|(order, _)| *order);
    stages.into_iter().map(|(_, stage)| stage).collect()
}

/// The stage a job belongs to, found by walking up `parentId`.
///
/// A job's parent is normally a `Phase`, not a `Stage` — the phase is the *definition* of the job
/// (a matrix of one) and the stage is above it — so a one-level lookup finds the wrong name, or
/// none, on every classic multi-stage pipeline. Hence the walk.
///
/// If no `Stage` ancestor exists the phase's name is used instead. That is not a fallback for
/// broken data: a classic (non-YAML) build definition has phases and no stages at all, and its
/// phase names are exactly the column headings a user expects.
///
/// Returns the ancestor's display name, **its record id**, and the order to sort that column by —
/// the ancestor's order, since the job's own is only meaningful within its phase.
///
/// The id is what the graph actually groups by. A display name is not an identity here: Azure
/// requires the `stage:` key to be unique and says nothing about `displayName`, and it is the
/// display name the timeline reports, so one template instantiated twice with a constant
/// `displayName` produces two genuinely different stages under one string.
fn resolve_stage(
    records: &[RawRecord],
    by_id: &HashMap<&str, usize>,
    start: usize,
) -> (Option<String>, Option<String>, i64) {
    let mut phase: Option<(String, String, i64)> = None;
    let mut cursor = records[start].parent_id.as_deref();

    for _ in 0..MAX_TIMELINE_DEPTH {
        let Some(id) = cursor.filter(|id| !id.is_empty()) else { break };
        let Some(&index) = by_id.get(id) else { break };
        let parent = &records[index];

        if parent.kind.eq_ignore_ascii_case("Stage") {
            // A nameless stage gives no column at all, so it gives no id either: the two travel
            // together, and a job with an id and no name would be grouped by something the header
            // could not print.
            return match non_empty(&parent.name) {
                Some(name) => (Some(name), non_empty(&parent.id), parent.order),
                None => (None, None, parent.order),
            };
        }
        if phase.is_none() && parent.kind.eq_ignore_ascii_case("Phase") {
            phase = non_empty(&parent.name).map(|name| (name, parent.id.clone(), parent.order));
        }
        cursor = parent.parent_id.as_deref();
    }

    match phase {
        Some((name, id, order)) => (Some(name), non_empty(&id), order),
        // No container at all — a job hanging off the root, which a hand-authored classic
        // definition produces. Its sort key is its *own* order rather than zero: zero is a
        // position, and it is the front one, so an orphan job would jump ahead of the first real
        // stage every time. Its own order is the only claim about where it belongs that anything
        // here actually knows.
        None => (None, None, records[start].order),
    }
}

/// How this job's log is addressed — the structural difference that costs this provider its own
/// [`PipelineJob::log_ref`] field.
///
/// GitHub and GitLab both have one endpoint per job that answers that job's whole log. Azure does
/// not: logs are numbered per *build* and hang off timeline **records**, and `log.id` is a
/// different number from the record id, so the job's own identity cannot address it.
///
/// Worse, whether the job record has a log at all depends on how the pipeline ran. An agent job
/// usually publishes an aggregated log for the job and every task writes its own as well; a
/// server/container job, a job that failed during initialisation, and a job whose tasks were all
/// skipped frequently publish only the per-task ones — the job record's `log` is simply absent.
///
/// So: the job's own `log.id` when there is one, otherwise the comma-joined ids of its `Task`
/// children in execution order, which [`job_log`] fetches and concatenates back into the log the
/// other two providers hand over in a single request. `None` means there is nothing to fetch —
/// a queued job, or one that never started — and the UI shows "no log yet" instead of an error.
fn resolve_log_ref(
    records: &[RawRecord],
    children: &HashMap<&str, Vec<usize>>,
    job: usize,
) -> Option<String> {
    if let Some(id) = records[job].log.as_ref().map(|log| log.id).filter(|id| *id > 0) {
        return Some(id.to_string());
    }

    let mut tasks: Vec<&RawRecord> = children
        .get(records[job].id.as_str())
        .map(|indexes| {
            indexes
                .iter()
                .map(|&index| &records[index])
                .filter(|record| record.kind.eq_ignore_ascii_case("Task"))
                .collect()
        })
        .unwrap_or_default();
    tasks.sort_by_key(|record| record.order);

    let ids: Vec<String> = tasks
        .iter()
        .filter_map(|record| record.log.as_ref().map(|log| log.id))
        .filter(|id| *id > 0)
        .map(|id| id.to_string())
        .collect();

    if ids.is_empty() {
        None
    } else {
        Some(ids.join(","))
    }
}

/// Whether anything inside this job reported a `warning` issue.
///
/// The job record's own issues are checked *and* its tasks': a warning is raised by the task that
/// logged it, and only sometimes rolled up to the job. Reading just the job record would let a
/// `succeeded` job with three `##[warning]`s look indistinguishable from a clean one, which is the
/// exact distinction [`status::WARNING`] exists to draw.
fn has_warning_issues(
    records: &[RawRecord],
    children: &HashMap<&str, Vec<usize>>,
    job: usize,
) -> bool {
    let is_warning = |record: &RawRecord| {
        record.issues.iter().any(|issue| issue.kind.eq_ignore_ascii_case("warning"))
    };
    if is_warning(&records[job]) {
        return true;
    }
    children
        .get(records[job].id.as_str())
        .is_some_and(|indexes| indexes.iter().any(|&index| is_warning(&records[index])))
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

/// One job's log.
///
/// `log_ref` is whatever [`resolve_log_ref`] produced: a single log id, or several separated by
/// commas when the job's output only exists as its tasks'. The parts are fetched in order and
/// joined with a blank line — a separator rather than a heading, because [`JobLog::text`] is
/// contractually the host's own bytes and a `=== Task 3 ===` banner invented here would be read
/// by users, and by the failure analysis, as something the pipeline printed.
///
/// The first truncated part ends the loop. Past that point the cap has already been reached, so
/// the remaining requests would download megabytes to throw them away; `total_bytes` then counts
/// what was actually read, which is what its documentation promises for a truncated log.
pub async fn job_log(
    org: &str,
    project: &str,
    build_id: &str,
    log_ref: &str,
    pat: &str,
) -> Result<JobLog, String> {
    require_pat(pat)?;

    let org_enc = encode_segment(&normalize_org(org));
    let project_enc = encode_segment(project);
    let build_enc = encode_segment(build_id.trim());

    // Validated rather than encoded. A log id is always a positive integer; anything else means
    // the reference was mangled between the timeline and here, and a mangled value belongs in an
    // error message, not interpolated into a URL.
    let ids: Vec<&str> = log_ref
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();
    if ids.is_empty() {
        return Err("that job has no log in Azure DevOps yet".to_string());
    }
    if let Some(bad) = ids.iter().find(|id| !id.chars().all(|c| c.is_ascii_digit())) {
        return Err(format!("that job's log reference isn't a valid Azure DevOps log id: {bad}"));
    }

    let mut text = String::new();
    let mut truncated = false;
    let mut total_bytes: u64 = 0;

    // The task still writing is the last one in the list, and it is the one that must never be
    // cached — see the note below.
    let writing = ids.len() - 1;

    for (index, id) in ids.iter().copied().enumerate() {
        /*
         * A *completed* task's log never changes again, and this loop runs on every poll tick
         * while the job is alive — a live job publishes no aggregated log of its own, so it always
         * falls back to its children. Without the cache a build with twenty-five tasks cost
         * twenty-five requests every five seconds; with it, only the parts that are new.
         *
         * "Completed" was the precondition and nothing checked it. Every part was cached, the
         * currently-writing one included, so the task actually producing output was read once and
         * then served from memory for the rest of the build: the log stopped growing on screen and
         * stayed stopped, and the finished job kept the truncated copy. A cache whose key cannot
         * change and whose value still can is not a cache.
         *
         * `resolve_log_ref` returns the task children in execution order and a task has no log id
         * before it starts, so the last id in the list is the one being written and everything
         * before it has finished. Only those are cached. The cost is one extra fetch per task over
         * the life of a job — the poll after it settles reads it once more, in full, and *that* is
         * what gets remembered.
         */
        let settled = index < writing;
        if settled {
            if let Some(cached) = cached_part(&org_enc, &project_enc, &build_enc, id) {
                append_part(&mut text, &cached);
                total_bytes += cached.len() as u64;
                continue;
            }
        }

        let url = format!(
            "https://dev.azure.com/{org_enc}/{project_enc}/_apis/build/builds/{build_enc}\
             /logs/{id}?api-version={API_VERSION}"
        );
        let request = http::client()
            .get(&url)
            .header("Authorization", auth_header(pat))
            // Without it the endpoint is content-negotiated into a JSON envelope with the lines in
            // an array, which is the same log at twice the size and none of the formatting.
            .header("Accept", "text/plain");
        let part = http::get_log(request, http::Provider::Azure).await?;
        if settled && !part.truncated {
            remember_part(&org_enc, &project_enc, &build_enc, id, &part.text);
        }

        append_part(&mut text, &part.text);
        total_bytes += part.total_bytes;

        // The cap is per **job**, not per part. `http::get_log` applies MAX_LOG_BYTES to each
        // response on its own, so a job with thirty tasks writing three megabytes each returned
        // ninety megabytes across the IPC bridge with `truncated: false`. This is the only
        // provider whose log arrives in pieces, and so the only one where the documented ceiling
        // did not hold.
        if part.truncated || text.len() as u64 >= MAX_LOG_BYTES {
            if text.len() as u64 > MAX_LOG_BYTES {
                let mut cut = MAX_LOG_BYTES as usize;
                while cut > 0 && !text.is_char_boundary(cut) {
                    cut -= 1;
                }
                text.truncate(cut);
            }
            truncated = true;
            break;
        }
    }

    Ok(JobLog { text, truncated, total_bytes })
}

/// A blank line between concatenated parts, so two tasks' output never runs together on one line.
fn append_part(text: &mut String, part: &str) {
    if !text.is_empty() {
        if !text.ends_with('\n') {
            text.push('\n');
        }
        text.push('\n');
    }
    text.push_str(part);
}

/// Downloaded task logs, keyed by log id within one build.
///
/// Bounded by construction rather than by a size limit: the whole map is dropped the first time a
/// *different* build asks for a part, so it holds at most the one build that is open. Nothing here
/// survives a restart, which is right — it is a request optimisation, not storage.
fn part_cache() -> &'static std::sync::Mutex<(String, std::collections::HashMap<String, String>)> {
    static CACHE: std::sync::OnceLock<
        std::sync::Mutex<(String, std::collections::HashMap<String, String>)>,
    > = std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new((String::new(), std::collections::HashMap::new())))
}

fn build_scope(org: &str, project: &str, build: &str) -> String {
    format!("{org}/{project}/{build}")
}

fn cached_part(org: &str, project: &str, build: &str, log_id: &str) -> Option<String> {
    let guard = part_cache().lock().ok()?;
    if guard.0 != build_scope(org, project, build) {
        return None;
    }
    guard.1.get(log_id).cloned()
}

fn remember_part(org: &str, project: &str, build: &str, log_id: &str, text: &str) {
    let scope = build_scope(org, project, build);
    let Ok(mut guard) = part_cache().lock() else { return };
    if guard.0 != scope {
        guard.0 = scope;
        guard.1.clear();
    }
    guard.1.insert(log_id.to_string(), text.to_string());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn timeline(json: &str) -> Vec<RawRecord> {
        serde_json::from_str::<RawTimeline>(json).expect("fixture de timeline inválida").records
    }

    #[test]
    fn every_azure_state_lands_in_one_of_the_seven_buckets() {
        // Not finished yet.
        assert_eq!(bucket_status("notStarted", None, false), status::QUEUED);
        assert_eq!(bucket_status("pending", None, false), status::QUEUED);
        assert_eq!(bucket_status("postponed", None, false), status::QUEUED);
        assert_eq!(bucket_status("none", None, false), status::QUEUED);
        assert_eq!(bucket_status("inProgress", None, false), status::RUNNING);
        // Still tearing down: the log is still growing, so the row has to keep polling.
        assert_eq!(bucket_status("cancelling", None, false), status::RUNNING);

        // Finished, by result.
        assert_eq!(bucket_status("completed", Some("succeeded"), false), status::SUCCESS);
        assert_eq!(bucket_status("completed", Some("failed"), false), status::FAILED);
        assert_eq!(bucket_status("completed", Some("canceled"), false), status::CANCELLED);
        assert_eq!(bucket_status("completed", Some("skipped"), false), status::SKIPPED);
        assert_eq!(bucket_status("completed", Some("abandoned"), false), status::SKIPPED);

        // The two roads to WARNING: derived from issues, and stated outright — the only provider
        // of the three that has a word for it.
        assert_eq!(bucket_status("completed", Some("succeeded"), true), status::WARNING);
        assert_eq!(bucket_status("completed", Some("partiallySucceeded"), false), status::WARNING);
        // ...and warnings never downgrade a real failure.
        assert_eq!(bucket_status("completed", Some("failed"), true), status::FAILED);

        // Adjudication pending, and a word we have never seen: both keep the row live rather than
        // claiming a terminal state that might be wrong.
        assert_eq!(bucket_status("completed", None, false), status::QUEUED);
        assert_eq!(bucket_status("completed", Some("marvelous"), false), status::QUEUED);
        assert_eq!(bucket_status("teleporting", None, false), status::QUEUED);
    }

    /// The build API's `status` and the timeline's `state` are the same vocabulary in two casings.
    #[test]
    fn the_two_casings_azure_uses_agree() {
        assert_eq!(bucket_status("inprogress", None, false), status::RUNNING);
        assert_eq!(bucket_status("Completed", Some("Succeeded"), false), status::SUCCESS);
        assert_eq!(bucket_status(" completed ", Some(" failed "), false), status::FAILED);
    }

    #[test]
    fn a_guid_is_told_apart_from_a_repository_name() {
        assert!(looks_like_guid("3f2504e0-4f89-11d3-9a0c-0305e82c3301"));
        assert!(looks_like_guid("3F2504E0-4F89-11D3-9A0C-0305E82C3301"));
        // What the auto-link from the remote writes into `ado_repo_id`.
        assert!(!looks_like_guid("MiRepo"));
        assert!(!looks_like_guid(""));
        // 36 characters, hex, and not a GUID: the dashes have to be in their places, or the Build
        // API's `repositoryId` filter silently matches nothing.
        assert!(!looks_like_guid("3f2504e04f8911d39a0c0305e82c33011234"));
        assert!(!looks_like_guid("3f2504e0-4f89-11d3-9a0c0305e82c3301-"));
        // Right shape, wrong alphabet.
        assert!(!looks_like_guid("zf2504e0-4f89-11d3-9a0c-0305e82c3301"));
        // A braced GUID is 38 characters, and is correctly refused — `belongs_to_repo` still
        // matches it on the client side.
        assert!(!looks_like_guid("{3f2504e0-4f89-11d3-9a0c-0305e82c3301}"));
    }

    #[test]
    fn only_the_branch_prefix_is_trimmed() {
        assert_eq!(strip_branch_prefix("refs/heads/main"), "main");
        assert_eq!(strip_branch_prefix("refs/heads/feature/ci-tab"), "feature/ci-tab");
        assert_eq!(strip_branch_prefix("main"), "main");
        // A PR validation build: not a branch, and shown whole.
        assert_eq!(strip_branch_prefix("refs/pull/123/merge"), "refs/pull/123/merge");
        assert_eq!(strip_branch_prefix("refs/tags/v1.2.0"), "refs/tags/v1.2.0");
    }

    #[test]
    fn a_dated_build_number_is_not_forced_into_an_integer() {
        assert_eq!(parse_build_number("42"), Some(42));
        assert_eq!(parse_build_number(" 42 "), Some(42));
        // Azure's default format. `20260821` would be a counter that jumps by millions per day.
        assert_eq!(parse_build_number("20260821.3"), None);
        assert_eq!(parse_build_number("release-7"), None);
        assert_eq!(parse_build_number(""), None);
    }

    /// A build half way through: two stages done, one skipped by a condition, one not started.
    ///
    /// The two that have not produced jobs are exactly what used to vanish — the graph drew the
    /// stages that had run and nothing else, so a four-stage pipeline looked like a two-stage one
    /// next to a browser tab showing all four.
    #[test]
    fn a_stage_with_no_jobs_yet_is_still_a_column() {
        let records = timeline(
            r#"{"records":[
              {"id":"stage-env","parentId":null,"type":"Stage","name":"Environment","order":1,
               "state":"completed","result":"succeeded"},
              {"id":"phase-env","parentId":"stage-env","type":"Phase","name":"Environment","order":1},
              {"id":"job-env","parentId":"phase-env","type":"Job","name":"Checkout","order":1,
               "state":"completed","result":"succeeded"},
              {"id":"stage-val","parentId":null,"type":"Stage","name":"Validations","order":2,
               "state":"completed","result":"skipped"},
              {"id":"stage-test","parentId":null,"type":"Stage","name":"Testing","order":3,
               "state":"inProgress"},
              {"id":"phase-test","parentId":"stage-test","type":"Phase","name":"Testing","order":1},
              {"id":"job-test","parentId":"phase-test","type":"Job","name":"Unit tests","order":1,
               "state":"inProgress"},
              {"id":"stage-quality","parentId":null,"type":"Stage","name":"Quality Code","order":4,
               "state":"pending"}
            ]}"#,
        );

        let jobs = map_timeline("42", "contoso", "App", &records);
        let named: Vec<(&str, &str, &str)> = jobs
            .iter()
            .map(|job| (job.name.as_str(), job.stage.as_deref().unwrap_or(""), job.status.as_str()))
            .collect();

        assert_eq!(
            named,
            vec![
                ("Checkout", "Environment", status::SUCCESS),
                // The skipped stage, as itself: the timeline never named its jobs.
                ("Validations", "Validations", status::SKIPPED),
                ("Unit tests", "Testing", status::RUNNING),
                // And the one that has not started, in the stage's own order rather than last.
                ("Quality Code", "Quality Code", status::QUEUED),
            ]
        );
    }

    /// The stage cards read the stage's *own* record, not a roll-up of the jobs under it.
    ///
    /// The approval case is the one that made this necessary: `Deploy` is `inProgress` while its
    /// only job has already succeeded, and its clock started 40 seconds before that job did.
    #[test]
    fn stages_carry_their_own_state_and_their_own_clock() {
        let records = timeline(
            r#"{"records":[
              {"id":"stage-build","parentId":null,"type":"Stage","name":"Build","order":1,
               "state":"completed","result":"succeeded",
               "startTime":"2026-08-24T10:00:00Z","finishTime":"2026-08-24T10:02:00Z"},
              {"id":"phase-build","parentId":"stage-build","type":"Phase","name":"Build","order":1},
              {"id":"job-build","parentId":"phase-build","type":"Job","name":"Compile","order":1,
               "state":"completed","result":"succeeded",
               "startTime":"2026-08-24T10:00:10Z","finishTime":"2026-08-24T10:01:50Z"},
              {"id":"stage-deploy","parentId":null,"type":"Stage","name":"Deploy","order":2,
               "state":"inProgress","startTime":"2026-08-24T10:02:00Z"},
              {"id":"phase-deploy","parentId":"stage-deploy","type":"Phase","name":"Deploy","order":1},
              {"id":"job-deploy","parentId":"phase-deploy","type":"Job","name":"Push image","order":1,
               "state":"completed","result":"succeeded",
               "startTime":"2026-08-24T10:02:40Z","finishTime":"2026-08-24T10:03:30Z"},
              {"id":"stage-nameless","parentId":null,"type":"Stage","name":"","order":3,
               "state":"pending"}
            ]}"#,
        );

        let stages = map_stages("42", &records);

        // Declaration order, and the nameless one dropped: it could never join to a column.
        let named: Vec<(&str, &str)> =
            stages.iter().map(|s| (s.name.as_str(), s.status.as_str())).collect();
        assert_eq!(named, vec![("Build", status::SUCCESS), ("Deploy", status::RUNNING)]);

        // A stage that is still going above a job that has finished — the fact a roll-up loses.
        let jobs = map_timeline("42", "contoso", "App", &records);
        assert_eq!(jobs[1].status, status::SUCCESS);
        assert_eq!(stages[1].status, status::RUNNING);

        // And its clock is the stage's, which opened 40s before the job's did.
        assert_eq!(stages[1].started_at.as_deref(), Some("2026-08-24T10:02:00Z"));
        assert_eq!(stages[1].finished_at, None);
        assert_eq!(stages[1].run_id, "42");
        assert_eq!(stages[1].provider, PROVIDER_AZURE);
        // The id the frontend matches the placeholder job against.
        assert_eq!(stages[0].id, "stage-build");
    }

    /// The ref name is carried through, because it is the only thing a `dependsOn:` can be
    /// matched against.
    ///
    /// The display name deliberately differs from the ref name here: matching a `dependsOn` against
    /// display names is the mistake this field exists to make impossible.
    #[test]
    fn stages_carry_the_ref_name_the_pipeline_file_refers_to() {
        let records = timeline(
            r#"{"records":[
              {"id":"stage-env","parentId":null,"type":"Stage","name":"Environment Variables",
               "identifier":"Environment","order":1,"state":"completed","result":"succeeded"},
              {"id":"stage-val","parentId":null,"type":"Stage","name":"Validations","order":2,
               "identifier":"","state":"completed","result":"skipped"},
              {"id":"stage-test","parentId":null,"type":"Stage","name":"Testing","order":3,
               "state":"inProgress"}
            ]}"#,
        );

        let stages = map_stages("42", &records);
        let refs: Vec<(&str, Option<&str>)> =
            stages.iter().map(|s| (s.name.as_str(), s.ref_name.as_deref())).collect();

        assert_eq!(
            refs,
            vec![
                // Ref name and display name are two different strings, and both survive.
                ("Environment Variables", Some("Environment")),
                // Present but blank, and absent entirely, both mean "nothing to join on" — never
                // an empty string, which would match a `dependsOn: ""` nobody wrote.
                ("Validations", None),
                ("Testing", None),
            ]
        );
    }

    /// Only a YAML definition has a file to point the parser at.
    #[test]
    fn yaml_path_is_only_read_from_a_yaml_definition() {
        let parse = |json: &str| -> Option<String> {
            yaml_path(&serde_json::from_str::<RawDefinitionDetail>(json).expect("definition"))
        };

        // A YAML pipeline: the filename, with Azure's leading slash stripped so it can be joined
        // onto the working copy without escaping it.
        assert_eq!(
            parse(r#"{"process":{"type":2,"yamlFilename":"/pipelines/build.yml"}}"#),
            Some("pipelines/build.yml".to_string())
        );
        assert_eq!(
            parse(r#"{"process":{"type":2,"yamlFilename":"azure-pipelines.yml"}}"#),
            Some("azure-pipelines.yml".to_string())
        );

        // A classic (designer) definition is stored as a task graph on the server. There is no file.
        assert_eq!(parse(r#"{"process":{"type":1,"yamlFilename":""}}"#), None);
        // A YAML definition that somehow names no file is the same "nothing to read" answer.
        assert_eq!(parse(r#"{"process":{"type":2,"yamlFilename":"   "}}"#), None);
        // And a definition with no process block at all must not panic.
        assert_eq!(parse(r#"{}"#), None);
    }

    /// A stage whose jobs *are* in the timeline must not also get a card of its own — that would
    /// double every column of every finished build.
    #[test]
    fn a_stage_that_has_jobs_is_not_drawn_twice() {
        let records = timeline(
            r#"{"records":[
              {"id":"stage-1","parentId":null,"type":"Stage","name":"Build","order":1,
               "state":"completed","result":"succeeded"},
              {"id":"phase-1","parentId":"stage-1","type":"Phase","name":"Build","order":1},
              {"id":"job-1","parentId":"phase-1","type":"Job","name":"Compile","order":1,
               "state":"completed","result":"succeeded"}
            ]}"#,
        );
        let jobs = map_timeline("42", "contoso", "App", &records);
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].name, "Compile");
    }

    /// Two stages instantiated from one template with a constant `displayName` are two stages.
    ///
    /// Azure requires the `stage:` key to be unique and says nothing about `displayName`, and the
    /// timeline reports the display name — so the name is not an identity. Keyed by it, the jobless
    /// one was suppressed by its namesake's jobs and vanished from the board, which is the exact
    /// disappearance the placeholder loop exists to prevent.
    #[test]
    fn two_stages_sharing_a_display_name_stay_two_stages() {
        let records = timeline(
            r#"{"records":[
              {"id":"stage-dev","parentId":null,"type":"Stage","name":"Deploy","order":1,
               "state":"completed","result":"succeeded"},
              {"id":"phase-dev","parentId":"stage-dev","type":"Phase","name":"Deploy","order":1},
              {"id":"job-dev","parentId":"phase-dev","type":"Job","name":"Run","order":1,
               "state":"completed","result":"succeeded"},
              {"id":"stage-prod","parentId":null,"type":"Stage","name":"Deploy","order":2,
               "state":"pending"}
            ]}"#,
        );

        let jobs = map_timeline("42", "contoso", "App", &records);

        // The second one still gets its placeholder: it is a different stage, however it is spelled.
        assert_eq!(jobs.len(), 2);
        assert_eq!(jobs[0].name, "Run");
        assert_eq!(jobs[0].stage_id.as_deref(), Some("stage-dev"));
        assert_eq!(jobs[1].name, "Deploy");
        assert_eq!(jobs[1].status, status::QUEUED);
        // And the two carry different group keys under the one display name, which is what keeps
        // the frontend from merging them into a single card.
        assert_eq!(jobs[1].stage_id.as_deref(), Some("stage-prod"));
        assert_eq!(jobs[0].stage.as_deref(), jobs[1].stage.as_deref());

        // Both records reach the frontend, each addressable by the id its jobs carry.
        let stages = map_stages("42", &records);
        assert_eq!(stages.len(), 2);
        assert_eq!(stages[0].id, "stage-dev");
        assert_eq!(stages[1].id, "stage-prod");
    }

    /// A classic definition has phases and no stages, and its jobs group by the phase they hang
    /// off — so the phase's id is what they carry.
    #[test]
    fn a_phase_lends_its_id_as_well_as_its_name() {
        let records = timeline(
            r#"{"records":[
              {"id":"phase-1","parentId":null,"type":"Phase","name":"Agent job","order":1},
              {"id":"job-1","parentId":"phase-1","type":"Job","name":"Run tests","order":1,
               "state":"inProgress"},
              {"id":"job-orphan","parentId":null,"type":"Job","name":"Orphan","order":9,
               "state":"notStarted"}
            ]}"#,
        );
        let jobs = map_timeline("7", "contoso", "App", &records);
        assert_eq!(jobs[0].stage_id.as_deref(), Some("phase-1"));
        // Nothing above it: no column, and so no key for one either.
        assert_eq!(jobs[1].stage_id, None);
    }

    /// The three things the timeline mapping has to get right at once: a job's stage is its
    /// *grandparent*, the order is the stage's and not the array's, and a job with no log of its
    /// own borrows its tasks'.
    #[test]
    fn jobs_take_their_stage_from_the_ancestor_and_their_log_from_wherever_it_is() {
        let records = timeline(
            r#"{"records":[
              {"id":"job-deploy","parentId":"phase-deploy","type":"Job","name":"Deploy",
               "state":"completed","result":"succeeded","order":1},
              {"id":"stage-build","parentId":null,"type":"Stage","name":"Build",
               "state":"completed","result":"succeeded","order":1},
              {"id":"phase-build","parentId":"stage-build","type":"Phase","name":"Build jobs",
               "state":"completed","result":"succeeded","order":1},
              {"id":"job-build","parentId":"phase-build","type":"Job","name":"Compile",
               "state":"completed","result":"succeeded","order":1,"log":{"id":7}},
              {"id":"task-a","parentId":"job-deploy","type":"Task","name":"Push",
               "state":"completed","result":"succeeded","order":2,"log":{"id":13}},
              {"id":"task-b","parentId":"job-deploy","type":"Task","name":"Checkout",
               "state":"completed","result":"succeeded","order":1,"log":{"id":12}},
              {"id":"stage-deploy","parentId":null,"type":"Stage","name":"Deploy",
               "state":"completed","result":"succeeded","order":2},
              {"id":"phase-deploy","parentId":"stage-deploy","type":"Phase","name":"Deploy jobs",
               "state":"completed","result":"succeeded","order":1},
              {"id":"checkpoint","parentId":"stage-deploy","type":"Checkpoint","name":"Approval",
               "state":"completed","result":"succeeded","order":1}
            ]}"#,
        );

        let jobs = map_timeline("55", "contoso", "Web%20App", &records);

        // Only `Job` records become jobs: no stages, phases, checkpoints or tasks.
        assert_eq!(jobs.len(), 2);
        // Ordered by the stage's order, not by the order the server listed them in.
        assert_eq!(jobs[0].name, "Compile");
        assert_eq!(jobs[1].name, "Deploy");
        // The stage is the grandparent; the intermediate Phase is walked through, not reported.
        assert_eq!(jobs[0].stage.as_deref(), Some("Build"));
        assert_eq!(jobs[1].stage.as_deref(), Some("Deploy"));

        // The job that publishes its own aggregated log addresses it directly...
        assert_eq!(jobs[0].log_ref.as_deref(), Some("7"));
        // ...and the one that doesn't borrows its tasks', in execution order (task-b runs first).
        assert_eq!(jobs[1].log_ref.as_deref(), Some("12,13"));

        assert_eq!(jobs[0].run_id, "55");
        assert_eq!(jobs[0].id, "job-build");
        assert_eq!(jobs[0].provider, PROVIDER_AZURE);
        assert!(jobs[0].web_url.contains("buildId=55"));
        assert!(jobs[0].web_url.contains("j=job-build"));
    }

    /// A classic (non-YAML) definition has phases and no stages at all, and a job outside any
    /// container still has to appear.
    #[test]
    fn a_pipeline_without_stages_falls_back_to_the_phase_then_to_nothing() {
        let records = timeline(
            r#"{"records":[
              {"id":"phase-1","parentId":null,"type":"Phase","name":"Agent job","order":1},
              {"id":"job-1","parentId":"phase-1","type":"Job","name":"Run tests",
               "state":"inProgress","order":1},
              {"id":"job-orphan","parentId":null,"type":"Job","name":"Orphan",
               "state":"notStarted","order":9}
            ]}"#,
        );
        let jobs = map_timeline("7", "contoso", "App", &records);

        assert_eq!(jobs[0].stage.as_deref(), Some("Agent job"));
        assert_eq!(jobs[0].status, status::RUNNING);
        // Nothing above it: no column, and no crash walking a chain that ends immediately.
        assert_eq!(jobs[1].stage, None);
        assert_eq!(jobs[1].status, status::QUEUED);
        // Nothing published a log yet, which is a state the UI shows rather than an error.
        assert_eq!(jobs[1].log_ref, None);
    }

    /// A `succeeded` job whose *task* raised a warning is a warning: the issue is filed against
    /// the task that logged it, and is only sometimes rolled up.
    #[test]
    fn a_task_level_warning_reaches_the_job_it_belongs_to() {
        let records = timeline(
            r#"{"records":[
              {"id":"job-1","parentId":null,"type":"Job","name":"Build",
               "state":"completed","result":"succeeded","order":1,"log":{"id":4}},
              {"id":"task-1","parentId":"job-1","type":"Task","name":"npm ci",
               "state":"completed","result":"succeeded","order":1,"log":{"id":5},
               "issues":[{"type":"warning","message":"deprecated package"}]},
              {"id":"job-2","parentId":null,"type":"Job","name":"Lint",
               "state":"completed","result":"succeeded","order":2,"log":{"id":6}}
            ]}"#,
        );
        let jobs = map_timeline("7", "contoso", "App", &records);

        assert_eq!(jobs[0].status, status::WARNING);
        // The provider's own word survives the bucketing, which is what makes it safe to be lossy.
        assert_eq!(jobs[0].raw_status, "succeeded");
        // A clean job next to it is untouched.
        assert_eq!(jobs[1].status, status::SUCCESS);
    }

    /// The parent links arrive as a flat array with nothing promising they form a tree.
    #[test]
    fn a_cyclic_parent_chain_terminates_instead_of_hanging_the_screen() {
        let records = timeline(
            r#"{"records":[
              {"id":"a","parentId":"b","type":"Phase","name":"A","order":1},
              {"id":"b","parentId":"a","type":"Phase","name":"B","order":1},
              {"id":"job","parentId":"a","type":"Job","name":"Looping","order":1}
            ]}"#,
        );
        let jobs = map_timeline("7", "contoso", "App", &records);
        assert_eq!(jobs.len(), 1);
        // The first Phase found on the way up wins; the walk stops at the depth bound.
        assert_eq!(jobs[0].stage.as_deref(), Some("A"));
    }

    #[test]
    fn a_build_is_attributed_by_either_identifier_and_never_by_guesswork() {
        let with_repo = |id: &str, name: &str| RawBuild {
            id: 1,
            build_number: String::new(),
            status: String::new(),
            result: None,
            queue_time: None,
            start_time: None,
            finish_time: None,
            source_branch: String::new(),
            source_version: String::new(),
            reason: None,
            links: None,
            definition: None,
            requested_for: None,
            repository: Some(RawRepoRef { id: id.to_string(), name: name.to_string() }),
        };

        let build = with_repo("3f2504e0-4f89-11d3-9a0c-0305e82c3301", "MiRepo");
        // The name form, which is what the auto-link stores...
        assert!(belongs_to_repo(&build, "MiRepo"));
        assert!(belongs_to_repo(&build, "mirepo"));
        // ...and the GUID form, which is what the settings dropdown stores.
        assert!(belongs_to_repo(&build, "3F2504E0-4F89-11D3-9A0C-0305E82C3301"));
        assert!(!belongs_to_repo(&build, "OtroRepo"));

        // A build that doesn't say where it came from is dropped: showing another repository's
        // runs under this tab is worse than showing one run fewer.
        let mut anonymous = with_repo("", "");
        anonymous.repository = None;
        assert!(!belongs_to_repo(&anonymous, "MiRepo"));
    }
}

// ---------------------------------------------------------------------------
// Writes: re-queue and cancel
// ---------------------------------------------------------------------------

/// What a re-queue needs from the build being re-run: which definition, which branch, which commit.
///
/// A separate read rather than fields on `PipelineRun`, because only Azure needs any of it — adding
/// a `definition_id` to the shared type for one provider's write path would put a null in every
/// GitHub and GitLab row forever.
pub async fn requeue_info(
    org: &str,
    project: &str,
    build_id: &str,
    pat: &str,
) -> Result<(i64, String, String), String> {
    require_pat(pat)?;
    let org_enc = encode_segment(&normalize_org(org));
    let project_enc = encode_segment(project);
    let id = encode_segment(build_id);
    let url = format!(
        "https://dev.azure.com/{org_enc}/{project_enc}/_apis/build/builds/{id}?api-version={API_VERSION}"
    );
    let request = http::client().get(&url).header("Authorization", auth_header(pat));
    let raw: RawBuild = http::get_json(request, http::Provider::Azure).await?;
    let definition = raw
        .definition
        .as_ref()
        .map(|definition| definition.id)
        .ok_or_else(|| "That build does not say which pipeline it came from".to_string())?;
    Ok((
        definition,
        raw.source_branch.clone(),
        raw.source_version.clone(),
    ))
}

/// Queues the same definition again, on the same branch and commit.
///
/// Azure has no "re-run this build" verb: a build is queued from its *definition*, so re-running
/// means reading the finished build to find out which definition, branch and commit it came from
/// and queuing a new one with the same three. That is what the portal's "Run new" does with the
/// fields pre-filled, and the result — a new build number — is honest about it.
pub async fn requeue(
    org: &str,
    project: &str,
    definition_id: i64,
    branch: &str,
    commit: &str,
    pat: &str,
) -> Result<(), String> {
    require_pat(pat)?;
    let org_enc = encode_segment(&normalize_org(org));
    let project_enc = encode_segment(project);
    let url = format!(
        "https://dev.azure.com/{org_enc}/{project_enc}/_apis/build/builds?api-version={API_VERSION}"
    );

    let mut body = serde_json::json!({ "definition": { "id": definition_id } });
    // Both are optional to Azure and both matter here: without them the queued build takes the
    // definition's default branch, which for a re-run of a PR build is the wrong code entirely.
    if !branch.trim().is_empty() {
        let full = if branch.starts_with("refs/") {
            branch.to_string()
        } else {
            format!("refs/heads/{branch}")
        };
        body["sourceBranch"] = serde_json::Value::String(full);
    }
    if !commit.trim().is_empty() {
        body["sourceVersion"] = serde_json::Value::String(commit.to_string());
    }

    let request = http::client()
        .post(&url)
        .header("Authorization", auth_header(pat))
        .json(&body);
    http::send_write(request, http::Provider::Azure).await
}

/// Cancels a running build.
///
/// A PATCH setting `status: cancelling` — Azure has no cancel verb either. The state it moves to is
/// `cancelling`, not `cancelled`: the agent has to notice, so the run stays live in the list for a
/// few seconds afterwards, which is correct rather than a lag.
pub async fn cancel(org: &str, project: &str, build_id: &str, pat: &str) -> Result<(), String> {
    require_pat(pat)?;
    let org_enc = encode_segment(&normalize_org(org));
    let project_enc = encode_segment(project);
    let id = encode_segment(build_id);
    let url = format!(
        "https://dev.azure.com/{org_enc}/{project_enc}/_apis/build/builds/{id}?api-version={API_VERSION}"
    );
    let request = http::client()
        .patch(&url)
        .header("Authorization", auth_header(pat))
        .json(&serde_json::json!({ "status": "cancelling" }));
    http::send_write(request, http::Provider::Azure).await
}
