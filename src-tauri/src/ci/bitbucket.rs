//! Bitbucket Pipelines as the fourth pipeline provider.
//!
//! A pipeline is a run and a step is a job — the step is the unit with a log, which is what
//! [`super::PipelineJob`] is. What does not fit cleanly, stated up front because the file follows
//! from it:
//!
//! - **There is no stage and no dependency on a step.** Steps run in the order the file declares,
//!   in parallel groups where it says so, and the API reports neither the groups nor any stage — so
//!   the graph falls back to overlapping time, which reconstructs a parallel group exactly, and says
//!   on its badge that it did.
//! - **A pipeline has a creation time and a completion time, and nothing in between.** When it
//!   started running is the first step's `started_on`, so a listed row carries no start and the
//!   opened one does — the same list-versus-detail difference `gitlab.rs` documents.
//! - **Every id is a `{uuid}` in braces**, which the tab carries as-is and which has to be
//!   percent-encoded into every address.
//! - **The API has no re-run, no "run this manual step", and no artifacts.** A re-run is a new
//!   pipeline on the same target — the same branch, commit and pipeline definition — which the UI
//!   labels as such, the way Azure's re-queue is. A paused pipeline's manual step is shown, and
//!   answered on Bitbucket. Artifacts are refused with a sentence rather than listed as none.
//!
//! Everything goes through [`super::http`], for the reasons `gitlab.rs` gives: this screen polls,
//! reads plain-text logs, and needs budgets of its own.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::bitbucket::{authed, repo_root, BitbucketAuth, BITBUCKET_ORG};

use super::http;
use super::{
    gate_kind, split_ref, status, JobLog, PipelineDefinition, PipelineGate, PipelineJob,
    PipelineLaunchContext, PipelineRun, PipelineRunDetail, PipelineVariable, RefKind,
    StartedPipeline, PROVIDER_BITBUCKET,
};

/// Fifty rows a page, the same trade `gitlab::PER_PAGE` explains.
const PER_PAGE: usize = 50;
/// A ceiling on the pagination loop, independent of `limit`, for a server that never stops
/// answering with a full page.
const MAX_PAGES: usize = 10;

/// The file every Bitbucket repository defines its pipelines in, at its root.
pub const DEFINITION_FILE: &str = "bitbucket-pipelines.yml";

/// The one definition the launch dialog is handed: "the pipeline this ref would run on a push" —
/// whatever `branches:`, `tags:` or `default:` the file matches it to. Custom pipelines are added by
/// the dialog from the file itself, as `custom:{name}`.
pub const BRANCH_DEFINITION: &str = "branch";
/// The prefix of a custom pipeline's definition id; the rest is its name in `pipelines.custom`.
pub const CUSTOM_PREFIX: &str = "custom:";

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default, Clone)]
struct RawName {
    #[serde(default)]
    name: Option<String>,
}

/// A pipeline's or a step's state: `PENDING`, `IN_PROGRESS` with a `stage` (`RUNNING`, `PAUSED`),
/// or `COMPLETED` with a `result` (`SUCCESSFUL`, `FAILED`, `ERROR`, `STOPPED`, `EXPIRED`, and for a
/// step `NOT_RUN`). Every level optional: an unrecognised shape must still map, to "queued".
#[derive(Deserialize, Default, Clone)]
struct RawState {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    result: Option<RawName>,
    #[serde(default)]
    stage: Option<RawName>,
}

#[derive(Deserialize, Default, Clone)]
struct RawCommit {
    #[serde(default)]
    hash: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Deserialize, Default, Clone)]
struct RawSelector {
    /// `default` · `branches` · `tags` · `bookmarks` · `custom` · `pull-requests`.
    #[serde(default, rename = "type")]
    kind: Option<String>,
    #[serde(default)]
    pattern: Option<String>,
}

#[derive(Deserialize, Default, Clone)]
struct RawTarget {
    /// `pipeline_ref_target` · `pipeline_commit_target` · `pipeline_pullrequest_target`.
    #[serde(default, rename = "type")]
    kind: Option<String>,
    #[serde(default)]
    ref_type: Option<String>,
    #[serde(default)]
    ref_name: Option<String>,
    #[serde(default)]
    commit: Option<RawCommit>,
    #[serde(default)]
    selector: Option<RawSelector>,
    /// A pull-request target names its branches here instead of in `ref_name`.
    #[serde(default)]
    source: Option<String>,
    #[serde(default)]
    destination: Option<String>,
    #[serde(default)]
    destination_commit: Option<RawCommit>,
    #[serde(default)]
    pullrequest: Option<Value>,
}

#[derive(Deserialize, Default, Clone)]
struct RawCreator {
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    nickname: Option<String>,
}

#[derive(Deserialize, Default, Clone)]
struct RawTrigger {
    /// `PUSH` · `MANUAL` · `SCHEDULE` — or, on a step, absent with only the `type`.
    #[serde(default)]
    name: Option<String>,
    #[serde(default, rename = "type")]
    kind: Option<String>,
}

#[derive(Deserialize, Default, Clone)]
struct RawVariable {
    #[serde(default)]
    key: Option<String>,
    #[serde(default)]
    value: Option<String>,
    #[serde(default)]
    secured: Option<bool>,
}

#[derive(Deserialize, Clone)]
struct RawPipeline {
    uuid: String,
    #[serde(default)]
    build_number: Option<i64>,
    #[serde(default)]
    creator: Option<RawCreator>,
    #[serde(default)]
    target: Option<RawTarget>,
    #[serde(default)]
    trigger: Option<RawTrigger>,
    #[serde(default)]
    state: Option<RawState>,
    #[serde(default)]
    created_on: Option<String>,
    #[serde(default)]
    completed_on: Option<String>,
    #[serde(default)]
    variables: Option<Vec<RawVariable>>,
}

#[derive(Deserialize, Clone)]
struct RawStep {
    uuid: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    state: Option<RawState>,
    #[serde(default)]
    started_on: Option<String>,
    #[serde(default)]
    completed_on: Option<String>,
    /// `pipeline_step_trigger_automatic` · `pipeline_step_trigger_manual`.
    #[serde(default)]
    trigger: Option<RawTrigger>,
}

#[derive(Deserialize)]
struct Paged<T> {
    #[serde(default = "Vec::new")]
    values: Vec<T>,
    #[serde(default)]
    next: Option<String>,
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

fn named(level: &Option<RawName>) -> Option<&str> {
    level.as_ref().and_then(|n| n.name.as_deref()).map(str::trim).filter(|n| !n.is_empty())
}

/// The most specific word a state carries — the result of a finished one, the stage of a running
/// one, the state itself otherwise. What the tooltip shows as the host's own word.
fn raw_word(state: Option<&RawState>) -> String {
    let Some(state) = state else { return String::new() };
    named(&state.result)
        .or_else(|| named(&state.stage))
        .or(state.name.as_deref())
        .unwrap_or_default()
        .to_string()
}

/// Whether a pipeline is paused at a manual step — `IN_PROGRESS` in the `PAUSED` stage.
fn is_paused(state: Option<&RawState>) -> bool {
    state.is_some_and(|s| s.name.as_deref() == Some("IN_PROGRESS") && named(&s.stage) == Some("PAUSED"))
}

/// Collapses a pipeline's or a step's state into the seven buckets.
///
/// | Bitbucket | bucket |
/// |---|---|
/// | `PENDING`, `READY` | `QUEUED` |
/// | `IN_PROGRESS` (`RUNNING`, or no stage) | `RUNNING` |
/// | `IN_PROGRESS` · `PAUSED` | `SKIPPED`, and the run is gated |
/// | `COMPLETED` · `SUCCESSFUL` | `SUCCESS` |
/// | `COMPLETED` · `FAILED`, `ERROR` | `FAILED` |
/// | `COMPLETED` · `STOPPED`, `EXPIRED` | `CANCELLED` |
/// | `COMPLETED` · `NOT_RUN` | `SKIPPED` |
/// | anything else | `QUEUED` |
///
/// **Paused is not live**, for the reason `gitlab::is_blocked` gives for GitLab's `manual`: nothing
/// moves until somebody starts the manual step, which for a production deploy can be days, and a
/// live bucket would have the poll re-read it every five seconds for all of them. The gate flag is
/// what tells the list it is waiting rather than done.
///
/// **`EXPIRED` is a stop nobody pressed** — a paused pipeline Bitbucket gave up waiting on — so it
/// is cancelled, not failed: nothing in it broke.
///
/// **Unknown words are queued**, the one bucket that asserts no outcome and keeps polling until
/// the run reaches a word this knows — the rule `gitlab::bucket_status` explains.
fn bucket(state: Option<&RawState>) -> &'static str {
    let Some(state) = state else { return status::QUEUED };
    match state.name.as_deref().unwrap_or_default() {
        "PENDING" | "READY" => status::QUEUED,
        "IN_PROGRESS" => match named(&state.stage) {
            Some("PAUSED") => status::SKIPPED,
            _ => status::RUNNING,
        },
        "COMPLETED" => match named(&state.result) {
            Some("SUCCESSFUL") => status::SUCCESS,
            Some("FAILED") | Some("ERROR") => status::FAILED,
            Some("STOPPED") | Some("EXPIRED") => status::CANCELLED,
            Some("NOT_RUN") => status::SKIPPED,
            _ => status::QUEUED,
        },
        _ => status::QUEUED,
    }
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/// A `{uuid}` (or anything else from the frontend) as one path segment: braces, and any stray
/// slash, percent-encoded.
fn id_segment(id: &str) -> String {
    crate::ado::encode_segment(id.trim())
}

/// Where "open in Bitbucket" goes for a pipeline: its results page, addressed by build number —
/// what Bitbucket's own links use. A run without one falls back to the pipelines list.
pub fn web_pipeline_url(workspace: &str, repo: &str, build_number: Option<i64>) -> String {
    match build_number {
        Some(number) => format!("https://{BITBUCKET_ORG}/{workspace}/{repo}/pipelines/results/{number}"),
        None => format!("https://{BITBUCKET_ORG}/{workspace}/{repo}/pipelines"),
    }
}

/// A step's page, under its pipeline's.
fn web_step_url(workspace: &str, repo: &str, build_number: Option<i64>, step_uuid: &str) -> String {
    match build_number {
        Some(_) => format!(
            "{}/steps/{}",
            web_pipeline_url(workspace, repo, build_number),
            id_segment(step_uuid)
        ),
        None => web_pipeline_url(workspace, repo, None),
    }
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/// A run's name: the pipeline definition that ran, written the way `bitbucket-pipelines.yml` names
/// it — `default`, `branches: main`, `custom: deploy` — since Bitbucket gives a pipeline no name of
/// its own. A target without a selector is named after its branch.
fn run_name(target: Option<&RawTarget>, branch: &str) -> String {
    let selector = target.and_then(|t| t.selector.as_ref());
    let kind = selector.and_then(|s| s.kind.as_deref()).map(str::trim).filter(|k| !k.is_empty());
    let pattern = selector.and_then(|s| s.pattern.as_deref()).map(str::trim).filter(|p| !p.is_empty());
    match (kind, pattern) {
        (Some("default"), _) => "default".to_string(),
        (Some(kind), Some(pattern)) => format!("{kind}: {pattern}"),
        (Some(kind), None) => kind.to_string(),
        (None, _) if !branch.is_empty() => branch.to_string(),
        _ => "pipeline".to_string(),
    }
}

/// The branch a run is about: the ref it ran on, or a pull request's source branch.
fn run_branch(target: Option<&RawTarget>) -> String {
    let Some(target) = target else { return String::new() };
    target
        .ref_name
        .clone()
        .filter(|r| !r.trim().is_empty())
        .or_else(|| target.source.clone())
        .unwrap_or_default()
}

fn map_pipeline(workspace: &str, repo: &str, raw: RawPipeline, started_at: Option<String>) -> PipelineRun {
    let branch = run_branch(raw.target.as_ref());
    let commit = raw.target.as_ref().and_then(|t| t.commit.clone()).unwrap_or_default();
    PipelineRun {
        provider: PROVIDER_BITBUCKET.to_string(),
        id: raw.uuid,
        number: raw.build_number,
        name: run_name(raw.target.as_ref(), &branch),
        status: bucket(raw.state.as_ref()).to_string(),
        raw_status: raw_word(raw.state.as_ref()),
        gated: is_paused(raw.state.as_ref()),
        branch,
        commit_sha: commit.hash.unwrap_or_default(),
        commit_title: commit
            .message
            .and_then(|m| m.lines().next().map(str::trim).map(str::to_string))
            .filter(|m| !m.is_empty()),
        actor: raw.creator.and_then(|c| c.display_name.filter(|n| !n.trim().is_empty()).or(c.nickname)),
        event: raw.trigger.and_then(|t| t.name).map(|n| n.to_lowercase()).filter(|n| !n.is_empty()),
        created_at: raw.created_on.unwrap_or_default(),
        started_at,
        finished_at: raw.completed_on,
        web_url: web_pipeline_url(workspace, repo, raw.build_number),
        // Always this file, at the root: it is where Bitbucket reads every pipeline from, and what
        // the failure analysis reads next to the log. Nothing on the graph parses it — see the
        // module note on why the drawing is by time.
        definition_path: Some(DEFINITION_FILE.to_string()),
    }
}

fn map_step(workspace: &str, repo: &str, run_id: &str, build_number: Option<i64>, index: usize, raw: RawStep) -> PipelineJob {
    PipelineJob {
        provider: PROVIDER_BITBUCKET.to_string(),
        run_id: run_id.to_string(),
        web_url: web_step_url(workspace, repo, build_number, &raw.uuid),
        // A step without a `name:` in the file is shown by Bitbucket as its position; so is it here.
        name: raw
            .name
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| format!("Step {}", index + 1)),
        stage: None,
        stage_id: None,
        status: bucket(raw.state.as_ref()).to_string(),
        raw_status: raw_word(raw.state.as_ref()),
        started_at: raw.started_on,
        finished_at: raw.completed_on,
        // The log is addressed by the step's own uuid.
        log_ref: None,
        id: raw.uuid,
    }
}

/// A step that waits for somebody to start it: triggered by hand, and not started yet.
fn is_waiting_manual(step: &RawStep) -> bool {
    let manual = step
        .trigger
        .as_ref()
        .and_then(|t| t.kind.as_deref())
        .is_some_and(|kind| kind.to_ascii_lowercase().contains("manual"));
    let waiting = matches!(step.state.as_ref().and_then(|s| s.name.as_deref()), Some("PENDING") | Some("READY"));
    manual && waiting
}

/// The gates of a paused pipeline: its manual steps still waiting to be started.
///
/// `can_act: false`, because Bitbucket's public API has no verb for it — the gate is shown so the
/// run says why it isn't moving, and its link opens the step on Bitbucket, where the button is.
fn manual_gates(workspace: &str, repo: &str, run: &PipelineRun, steps: &[RawStep]) -> Vec<PipelineGate> {
    if !run.gated {
        return Vec::new();
    }
    steps
        .iter()
        .enumerate()
        .filter(|(_, step)| is_waiting_manual(step))
        .map(|(index, step)| PipelineGate {
            provider: PROVIDER_BITBUCKET.to_string(),
            run_id: run.id.clone(),
            id: step.uuid.clone(),
            kind: gate_kind::MANUAL.to_string(),
            name: step
                .name
                .clone()
                .filter(|n| !n.trim().is_empty())
                .unwrap_or_else(|| format!("Step {}", index + 1)),
            stage_id: None,
            job_ids: vec![step.uuid.clone()],
            can_act: Some(false),
            reviewers: Vec::new(),
            instructions: None,
            since: None,
            web_url: web_step_url(workspace, repo, run.number, &step.uuid),
        })
        .collect()
}

/// When a run started: its earliest step's start. `None` until one has.
///
/// Compared as instants — seconds since the epoch, by the calendar `super::duration_secs` already
/// carries — rather than as text, which only orders stamps that share an offset and a precision.
fn first_start(steps: &[RawStep]) -> Option<String> {
    let instant = |stamp: &String| super::duration_secs(Some("1970-01-01T00:00:00Z"), Some(stamp)).unwrap_or(i64::MAX);
    steps
        .iter()
        .filter_map(|s| s.started_on.clone())
        .filter(|s| !s.trim().is_empty())
        .min_by_key(instant)
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/// The URL of one page of the pipeline list, newest first — `sort` and the branch filter are plain
/// query parameters on this endpoint, unlike the `q=` language the rest of Bitbucket's API uses.
fn list_url(workspace: &str, repo: &str, branch: Option<&str>, page: usize) -> String {
    let filter = branch
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(|b| format!("&target.branch={}", crate::ado::encode_segment(b)))
        .unwrap_or_default();
    format!(
        "{}/pipelines?sort=-created_on&pagelen={PER_PAGE}&page={page}{filter}",
        repo_root(workspace, repo)
    )
}

/// The most recent pipelines, newest first, optionally for one branch.
pub async fn list_pipelines(
    workspace: &str,
    repo: &str,
    branch: Option<&str>,
    limit: usize,
    auth: &BitbucketAuth,
) -> Result<Vec<PipelineRun>, String> {
    let mut runs: Vec<PipelineRun> = Vec::new();
    if limit == 0 {
        return Ok(runs);
    }
    let pages = limit.div_ceil(PER_PAGE).min(MAX_PAGES);
    for page in 1..=pages {
        let raw: Paged<RawPipeline> = http::get_json(
            authed(http::client().get(list_url(workspace, repo, branch, page)), auth),
            http::Provider::Bitbucket,
        )
        .await?;
        let received = raw.values.len();
        runs.extend(raw.values.into_iter().map(|p| map_pipeline(workspace, repo, p, None)));
        if raw.next.is_none() || received < PER_PAGE || runs.len() >= limit {
            break;
        }
    }
    runs.truncate(limit);
    Ok(runs)
}

async fn fetch_pipeline(workspace: &str, repo: &str, pipeline_uuid: &str, auth: &BitbucketAuth) -> Result<RawPipeline, String> {
    let url = format!("{}/pipelines/{}", repo_root(workspace, repo), id_segment(pipeline_uuid));
    http::get_json(authed(http::client().get(&url), auth), http::Provider::Bitbucket).await
}

/// Every step of a pipeline, in the order Bitbucket runs them.
async fn fetch_steps(workspace: &str, repo: &str, pipeline_uuid: &str, auth: &BitbucketAuth) -> Result<Vec<RawStep>, String> {
    let mut url = Some(format!(
        "{}/pipelines/{}/steps?pagelen=100",
        repo_root(workspace, repo),
        id_segment(pipeline_uuid)
    ));
    let mut steps = Vec::new();
    for _ in 0..MAX_PAGES {
        let Some(current) = url.take() else { break };
        let page: Paged<RawStep> =
            http::get_json(authed(http::client().get(&current), auth), http::Provider::Bitbucket).await?;
        steps.extend(page.values);
        // Only a `next` on the API host is followed — the credential rides on every request.
        url = page.next.filter(|next| next.starts_with(&format!("{}/", crate::bitbucket::API_ROOT)));
    }
    Ok(steps)
}

/// One pipeline with its steps. The detail is where a run gets its start time and its gates.
pub async fn pipeline_detail(
    workspace: &str,
    repo: &str,
    pipeline_uuid: &str,
    auth: &BitbucketAuth,
) -> Result<PipelineRunDetail, String> {
    let raw = fetch_pipeline(workspace, repo, pipeline_uuid, auth).await?;
    let steps = fetch_steps(workspace, repo, pipeline_uuid, auth).await?;
    let build_number = raw.build_number;
    let run = map_pipeline(workspace, repo, raw, first_start(&steps));
    let gates = manual_gates(workspace, repo, &run, &steps);
    let jobs = steps
        .into_iter()
        .enumerate()
        .map(|(index, step)| map_step(workspace, repo, &run.id, build_number, index, step))
        .collect();
    Ok(PipelineRunDetail { run, jobs, stages: Vec::new(), gates })
}

/// A step's log, as Bitbucket serves it. Once a step finishes the log moves to long-term storage
/// and the endpoint answers 307 to a signed address on another host — which the transport follows,
/// dropping the credential on the way, as `http::client` documents.
pub async fn step_log(
    workspace: &str,
    repo: &str,
    pipeline_uuid: &str,
    step_uuid: &str,
    auth: &BitbucketAuth,
) -> Result<JobLog, String> {
    let url = format!(
        "{}/pipelines/{}/steps/{}/log",
        repo_root(workspace, repo),
        id_segment(pipeline_uuid),
        id_segment(step_uuid)
    );
    http::get_log(authed(http::client().get(&url), auth), http::Provider::Bitbucket).await
}

/// Stops a running pipeline and every step of it not yet finished.
pub async fn stop(workspace: &str, repo: &str, pipeline_uuid: &str, auth: &BitbucketAuth) -> Result<(), String> {
    let url = format!("{}/pipelines/{}/stopPipeline", repo_root(workspace, repo), id_segment(pipeline_uuid));
    http::send_write(authed(http::client().post(&url), auth), http::Provider::Bitbucket).await
}

/// The target of a new pipeline that runs `raw`'s again: its kind, its ref or pull request, its
/// commit, and the selector that picked its definition — and nothing Bitbucket added of its own
/// (links, a repository), which a create request has no use for.
fn rerun_target(raw: &RawTarget) -> Result<Value, String> {
    let kind = raw.kind.as_deref().unwrap_or("pipeline_ref_target");
    let mut target = json!({ "type": kind });
    if let Some(hash) = raw.commit.as_ref().and_then(|c| c.hash.clone()).filter(|h| !h.is_empty()) {
        target["commit"] = json!({ "type": "commit", "hash": hash });
    }
    if let Some(selector) = &raw.selector {
        let mut value = json!({});
        if let Some(kind) = selector.kind.as_deref().filter(|k| !k.is_empty()) {
            value["type"] = json!(kind);
        }
        if let Some(pattern) = selector.pattern.as_deref().filter(|p| !p.is_empty()) {
            value["pattern"] = json!(pattern);
        }
        if value.as_object().is_some_and(|o| !o.is_empty()) {
            target["selector"] = value;
        }
    }
    match kind {
        "pipeline_ref_target" => {
            let name = raw
                .ref_name
                .clone()
                .filter(|n| !n.trim().is_empty())
                .ok_or_else(|| "That pipeline doesn't say which branch or tag it ran on".to_string())?;
            target["ref_type"] = json!(raw.ref_type.clone().unwrap_or_else(|| "branch".to_string()));
            target["ref_name"] = json!(name);
        }
        "pipeline_pullrequest_target" => {
            for (key, value) in [("source", &raw.source), ("destination", &raw.destination)] {
                if let Some(value) = value.as_deref().filter(|v| !v.is_empty()) {
                    target[key] = json!(value);
                }
            }
            if let Some(hash) = raw.destination_commit.as_ref().and_then(|c| c.hash.clone()) {
                target["destination_commit"] = json!({ "hash": hash });
            }
            if let Some(id) = raw.pullrequest.as_ref().and_then(|p| p.get("id")).cloned() {
                target["pullrequest"] = json!({ "id": id });
            }
        }
        _ => {
            if target.get("commit").is_none() {
                return Err("That pipeline doesn't say which commit it ran on".to_string());
            }
        }
    }
    Ok(target)
}

/// The variables a re-run carries: the ones the first run had. A secured value never comes back out
/// of the API, so a pipeline that had one cannot be re-run faithfully from here — that is refused
/// rather than re-run with the secret blanked, which is the failure a person would least expect.
fn rerun_variables(variables: &[RawVariable]) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    for variable in variables {
        let Some(key) = variable.key.as_deref().map(str::trim).filter(|k| !k.is_empty()) else {
            continue;
        };
        if variable.secured.unwrap_or(false) {
            return Err(format!(
                "This pipeline ran with the secured variable “{key}”, whose value Bitbucket never hands \
                 back — start it again from Run pipeline, or from Bitbucket"
            ));
        }
        out.push(json!({ "key": key, "value": variable.value.clone().unwrap_or_default() }));
    }
    Ok(out)
}

/// Runs a pipeline again — as a new pipeline on the same target, since the API has no re-run.
pub async fn rerun(workspace: &str, repo: &str, pipeline_uuid: &str, auth: &BitbucketAuth) -> Result<(), String> {
    let raw = fetch_pipeline(workspace, repo, pipeline_uuid, auth).await?;
    let target = rerun_target(&raw.target.unwrap_or_default())?;
    let mut body = json!({ "target": target });
    let variables = rerun_variables(raw.variables.as_deref().unwrap_or_default())?;
    if !variables.is_empty() {
        body["variables"] = Value::Array(variables);
    }
    let url = format!("{}/pipelines", repo_root(workspace, repo));
    http::send_write(authed(http::client().post(&url), auth).json(&body), http::Provider::Bitbucket).await
}

// ---------------------------------------------------------------------------
// Starting a pipeline by hand
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct RawRepository {
    #[serde(default)]
    mainbranch: Option<RawName>,
}

/// What the "Run pipeline" dialog opens with: the repository's main branch, and one definition —
/// the pipeline a ref runs by itself. The dialog reads the custom pipelines out of the file and adds
/// them next to it, working copy first, since the file is what declares them and their variables.
pub async fn launch_context(workspace: &str, repo: &str, auth: &BitbucketAuth) -> Result<PipelineLaunchContext, String> {
    let raw: RawRepository = http::get_json(
        authed(http::client().get(repo_root(workspace, repo)), auth),
        http::Provider::Bitbucket,
    )
    .await?;
    Ok(PipelineLaunchContext {
        provider: PROVIDER_BITBUCKET.to_string(),
        definitions: vec![PipelineDefinition {
            provider: PROVIDER_BITBUCKET.to_string(),
            id: BRANCH_DEFINITION.to_string(),
            name: DEFINITION_FILE.to_string(),
            path: Some(DEFINITION_FILE.to_string()),
            variables: Vec::new(),
            web_url: format!("https://{BITBUCKET_ORG}/{workspace}/{repo}/pipelines"),
        }],
        default_branch: raw.mainbranch.and_then(|b| b.name).map(|b| b.trim().to_string()).filter(|b| !b.is_empty()),
        // Bitbucket has deployment environments, but no input type that takes one.
        environments: Vec::new(),
    })
}

/// A file as the repository has it at `reference` (the main branch when none), or `None` when it
/// isn't there. The ref is one encoded segment — `feature%2Fx` — so its slashes can't be read as
/// part of the path that follows it.
pub async fn definition_file(
    workspace: &str,
    repo: &str,
    path: &str,
    reference: Option<&str>,
    auth: &BitbucketAuth,
) -> Result<Option<String>, String> {
    let reference = match reference.map(str::trim).filter(|r| !r.is_empty()) {
        Some(reference) => split_ref(reference).1,
        None => match launch_context(workspace, repo, auth).await?.default_branch {
            Some(branch) => branch,
            None => return Ok(None),
        },
    };
    let segments: Vec<String> = path.split('/').map(crate::ado::encode_segment).collect();
    let url = format!(
        "{}/src/{}/{}",
        repo_root(workspace, repo),
        crate::ado::encode_segment(&reference),
        segments.join("/")
    );
    http::get_text(
        authed(http::client().get(&url), auth),
        http::Provider::Bitbucket,
        http::MAX_DEFINITION_BYTES,
    )
    .await
}

/// The body `POST /pipelines` takes to run `definition_id` on `reference`: a ref target, the
/// custom pipeline's selector when it is one, and the variables — `masked` sent as `secured`, which
/// Bitbucket keeps out of the logs and out of the API.
fn start_body(definition_id: &str, reference: &str, variables: &[PipelineVariable]) -> Result<Value, String> {
    let (kind, name) = split_ref(reference);
    if name.trim().is_empty() {
        return Err("Pick a branch or tag to run on".to_string());
    }
    let mut target = json!({
        "type": "pipeline_ref_target",
        "ref_type": if kind == RefKind::Tag { "tag" } else { "branch" },
        "ref_name": name,
    });
    if let Some(custom) = definition_id.strip_prefix(CUSTOM_PREFIX) {
        let custom = custom.trim();
        if custom.is_empty() {
            return Err("Pick a pipeline to run".to_string());
        }
        target["selector"] = json!({ "type": "custom", "pattern": custom });
    } else if definition_id != BRANCH_DEFINITION {
        return Err(format!("“{definition_id}” isn't a pipeline of this repository"));
    }
    let mut body = json!({ "target": target });
    if !variables.is_empty() {
        body["variables"] = variables
            .iter()
            .map(|v| json!({ "key": v.key.trim(), "value": v.value, "secured": v.masked }))
            .collect();
    }
    Ok(body)
}

#[derive(Deserialize)]
struct RawCreated {
    #[serde(default)]
    uuid: Option<String>,
    #[serde(default)]
    build_number: Option<i64>,
}

/// Starts a pipeline. Bitbucket answers with the pipeline it created, so the run is known at once.
pub async fn run_pipeline(
    workspace: &str,
    repo: &str,
    definition_id: &str,
    reference: &str,
    variables: &[PipelineVariable],
    auth: &BitbucketAuth,
) -> Result<StartedPipeline, String> {
    let body = start_body(definition_id, reference, variables)?;
    let url = format!("{}/pipelines", repo_root(workspace, repo));
    let receipt = http::send_write_for::<RawCreated>(authed(http::client().post(&url), auth).json(&body), http::Provider::Bitbucket).await?;
    Ok(match receipt {
        Some(created) => StartedPipeline {
            web_url: Some(web_pipeline_url(workspace, repo, created.build_number)),
            run_id: created.uuid.filter(|u| !u.trim().is_empty()),
        },
        None => StartedPipeline::default(),
    })
}

#[cfg(test)]
mod tests {
    //! Fixtures are the response shapes Bitbucket's REST reference documents for each endpoint,
    //! trimmed to the fields read here, with placeholder workspaces and repositories.
    use super::*;

    fn state(value: Value) -> RawState {
        serde_json::from_value(value).expect("a state")
    }

    #[test]
    fn every_bitbucket_state_lands_in_a_bucket_the_ui_can_draw() {
        let cases = [
            (json!({"name":"PENDING","type":"pipeline_state_pending"}), status::QUEUED),
            (json!({"name":"READY"}), status::QUEUED),
            (json!({"name":"IN_PROGRESS","stage":{"name":"RUNNING"}}), status::RUNNING),
            (json!({"name":"IN_PROGRESS"}), status::RUNNING),
            (json!({"name":"IN_PROGRESS","stage":{"name":"PAUSED"}}), status::SKIPPED),
            (json!({"name":"COMPLETED","result":{"name":"SUCCESSFUL"}}), status::SUCCESS),
            (json!({"name":"COMPLETED","result":{"name":"FAILED"}}), status::FAILED),
            (json!({"name":"COMPLETED","result":{"name":"ERROR"}}), status::FAILED),
            (json!({"name":"COMPLETED","result":{"name":"STOPPED"}}), status::CANCELLED),
            (json!({"name":"COMPLETED","result":{"name":"EXPIRED"}}), status::CANCELLED),
            (json!({"name":"COMPLETED","result":{"name":"NOT_RUN"}}), status::SKIPPED),
            (json!({"name":"SOMETHING_NEW"}), status::QUEUED),
            (json!({"name":"COMPLETED","result":{"name":"SOMETHING_NEW"}}), status::QUEUED),
        ];
        for (raw, expected) in cases {
            assert_eq!(bucket(Some(&state(raw.clone()))), expected, "{raw}");
        }
        assert_eq!(bucket(None), status::QUEUED);
        // A paused pipeline must not be polled every five seconds for days.
        assert!(!super::super::is_live(bucket(Some(&state(json!({"name":"IN_PROGRESS","stage":{"name":"PAUSED"}}))))));
        assert_eq!(raw_word(Some(&state(json!({"name":"COMPLETED","result":{"name":"FAILED"}})))), "FAILED");
        assert_eq!(raw_word(Some(&state(json!({"name":"IN_PROGRESS","stage":{"name":"PAUSED"}})))), "PAUSED");
        assert_eq!(raw_word(Some(&state(json!({"name":"PENDING"})))), "PENDING");
    }

    fn pipeline(value: Value) -> RawPipeline {
        serde_json::from_value(value).expect("a pipeline")
    }

    fn listed() -> Value {
        json!({
            "type": "pipeline",
            "uuid": "{0b7f2b6e-1111-4c1d-9c3a-222222222222}",
            "build_number": 42,
            "creator": { "display_name": "Ana Example", "uuid": "{11111111-1111-1111-1111-111111111111}" },
            "target": {
                "type": "pipeline_ref_target", "ref_type": "branch", "ref_name": "feature/login",
                "commit": { "type": "commit", "hash": "ce5b7431602f7cbba007062eeb55225c6e18e956" },
                "selector": { "type": "branches", "pattern": "feature/*" }
            },
            "trigger": { "name": "PUSH", "type": "pipeline_trigger_push" },
            "state": { "name": "IN_PROGRESS", "type": "pipeline_state_in_progress", "stage": { "name": "RUNNING" } },
            "created_on": "2026-09-01T10:00:00.000000Z",
            "completed_on": null
        })
    }

    #[test]
    fn a_listed_pipeline_maps_onto_the_shared_run() {
        let run = map_pipeline("example-workspace", "example-repo", pipeline(listed()), None);
        assert_eq!(run.provider, PROVIDER_BITBUCKET);
        assert_eq!(run.id, "{0b7f2b6e-1111-4c1d-9c3a-222222222222}", "the uuid, braces and all");
        assert_eq!(run.number, Some(42));
        assert_eq!(run.name, "branches: feature/*");
        assert_eq!(run.branch, "feature/login");
        assert_eq!(run.commit_sha, "ce5b7431602f7cbba007062eeb55225c6e18e956");
        assert_eq!(run.status, status::RUNNING);
        assert_eq!(run.raw_status, "RUNNING");
        assert_eq!(run.actor.as_deref(), Some("Ana Example"));
        assert_eq!(run.event.as_deref(), Some("push"));
        assert!(run.started_at.is_none(), "the listing has no start");
        assert!(run.finished_at.is_none());
        assert!(!run.gated);
        assert_eq!(run.web_url, "https://bitbucket.org/example-workspace/example-repo/pipelines/results/42");
        assert_eq!(run.definition_path.as_deref(), Some(DEFINITION_FILE));
    }

    #[test]
    fn a_run_is_named_after_the_definition_that_ran() {
        let named = |selector: Value, branch: &str| {
            let target: RawTarget = serde_json::from_value(json!({ "selector": selector })).unwrap();
            run_name(Some(&target), branch)
        };
        assert_eq!(named(json!({"type":"default"}), "main"), "default");
        assert_eq!(named(json!({"type":"custom","pattern":"deploy-prod"}), "main"), "custom: deploy-prod");
        assert_eq!(named(json!({"type":"pull-requests","pattern":"**"}), "feature/x"), "pull-requests: **");
        assert_eq!(run_name(None, "main"), "main");
        assert_eq!(run_name(None, ""), "pipeline");
    }

    #[test]
    fn a_pull_request_pipeline_is_about_its_source_branch() {
        let raw = pipeline(json!({
            "uuid": "{p}",
            "target": { "type": "pipeline_pullrequest_target", "source": "feature/login", "destination": "main",
                        "commit": { "hash": "1a372fc" }, "destination_commit": { "hash": "9f848b7" },
                        "pullrequest": { "id": 3 }, "selector": { "type": "pull-requests", "pattern": "**" } },
            "state": { "name": "COMPLETED", "result": { "name": "SUCCESSFUL" } }
        }));
        let run = map_pipeline("ws", "repo", raw.clone(), None);
        assert_eq!(run.branch, "feature/login");
        assert_eq!(run.status, status::SUCCESS);
        // A run without a build number links to the list, not to a results page that isn't there.
        assert_eq!(run.web_url, "https://bitbucket.org/ws/repo/pipelines");

        let target = rerun_target(raw.target.as_ref().unwrap()).unwrap();
        assert_eq!(
            target,
            json!({
                "type": "pipeline_pullrequest_target",
                "commit": { "type": "commit", "hash": "1a372fc" },
                "selector": { "type": "pull-requests", "pattern": "**" },
                "source": "feature/login",
                "destination": "main",
                "destination_commit": { "hash": "9f848b7" },
                "pullrequest": { "id": 3 }
            })
        );
    }

    fn step(value: Value) -> RawStep {
        serde_json::from_value(value).expect("a step")
    }

    #[test]
    fn steps_become_jobs_and_the_run_starts_when_its_first_step_did() {
        let steps = vec![
            step(json!({
                "uuid": "{s1}", "name": "Build", "started_on": "2026-09-01T10:00:30.000Z", "completed_on": "2026-09-01T10:02:00.000Z",
                "state": { "name": "COMPLETED", "result": { "name": "SUCCESSFUL" } },
                "trigger": { "type": "pipeline_step_trigger_automatic" }
            })),
            step(json!({
                "uuid": "{s2}", "name": null, "started_on": "2026-09-01T10:00:10.000Z",
                "state": { "name": "IN_PROGRESS" }
            })),
        ];
        assert_eq!(first_start(&steps).as_deref(), Some("2026-09-01T10:00:10.000Z"));
        let jobs: Vec<PipelineJob> = steps
            .into_iter()
            .enumerate()
            .map(|(i, s)| map_step("ws", "repo", "{p}", Some(42), i, s))
            .collect();
        assert_eq!(jobs[0].name, "Build");
        assert_eq!(jobs[0].status, status::SUCCESS);
        assert_eq!(jobs[0].web_url, "https://bitbucket.org/ws/repo/pipelines/results/42/steps/%7Bs1%7D");
        assert_eq!(jobs[1].name, "Step 2", "no name: its position, as Bitbucket shows it");
        assert_eq!(jobs[1].status, status::RUNNING);
        assert!(jobs.iter().all(|job| job.stage.is_none() && job.stage_id.is_none()));
        assert_eq!(first_start(&[]), None);
    }

    #[test]
    fn a_paused_pipeline_is_gated_at_its_waiting_manual_step_which_only_bitbucket_can_start() {
        let raw = pipeline(json!({
            "uuid": "{p}", "build_number": 7,
            "state": { "name": "IN_PROGRESS", "stage": { "name": "PAUSED" } }
        }));
        let run = map_pipeline("ws", "repo", raw, None);
        assert!(run.gated);
        assert_eq!(run.status, status::SKIPPED);

        let steps = vec![
            step(json!({ "uuid": "{build}", "name": "Build", "state": { "name": "COMPLETED", "result": { "name": "SUCCESSFUL" } },
                         "trigger": { "type": "pipeline_step_trigger_automatic" } })),
            step(json!({ "uuid": "{deploy}", "name": "Deploy to production", "state": { "name": "PENDING" },
                         "trigger": { "type": "pipeline_step_trigger_manual" } })),
        ];
        let gates = manual_gates("ws", "repo", &run, &steps);
        assert_eq!(gates.len(), 1);
        assert_eq!(gates[0].kind, gate_kind::MANUAL);
        assert_eq!(gates[0].name, "Deploy to production");
        assert_eq!(gates[0].job_ids, vec!["{deploy}".to_string()]);
        assert_eq!(gates[0].can_act, Some(false), "the API has no verb to start it");
        assert_eq!(gates[0].web_url, "https://bitbucket.org/ws/repo/pipelines/results/7/steps/%7Bdeploy%7D");

        // A run that isn't paused has no gate, whatever its steps say.
        let running = map_pipeline("ws", "repo", pipeline(listed()), None);
        assert!(manual_gates("ws", "repo", &running, &steps).is_empty());
    }

    #[test]
    fn list_urls_sort_newest_first_and_filter_by_branch_as_plain_parameters() {
        assert_eq!(
            list_url("example-workspace", "example-repo", None, 1),
            "https://api.bitbucket.org/2.0/repositories/example-workspace/example-repo/pipelines?sort=-created_on&pagelen=50&page=1"
        );
        assert!(list_url("ws", "repo", Some("feature/x"), 2).ends_with("&page=2&target.branch=feature%2Fx"));
        assert!(!list_url("ws", "repo", Some("  "), 1).contains("target.branch"));
    }

    #[test]
    fn a_rerun_is_the_same_target_without_what_bitbucket_added() {
        let raw = pipeline(json!({
            "uuid": "{p}",
            "target": {
                "type": "pipeline_ref_target", "ref_type": "branch", "ref_name": "main",
                "commit": { "type": "commit", "hash": "a3c4e02c9a3755eccdc3764e6ea13facdf30f923", "links": { "self": { "href": "https://api.bitbucket.org/x" } } },
                "selector": { "type": "custom", "pattern": "Deploy to production" }
            },
            "variables": [ { "key": "REGION", "value": "eu-west-1", "secured": false } ]
        }));
        let target = rerun_target(raw.target.as_ref().unwrap()).unwrap();
        assert_eq!(
            target,
            json!({
                "type": "pipeline_ref_target",
                "commit": { "type": "commit", "hash": "a3c4e02c9a3755eccdc3764e6ea13facdf30f923" },
                "selector": { "type": "custom", "pattern": "Deploy to production" },
                "ref_type": "branch",
                "ref_name": "main"
            })
        );
        assert_eq!(rerun_variables(raw.variables.as_deref().unwrap()).unwrap(), vec![json!({ "key": "REGION", "value": "eu-west-1" })]);

        // A secured value never comes back, so re-running would blank it.
        let secured: Vec<RawVariable> = serde_json::from_value(json!([{ "key": "TOKEN", "value": "", "secured": true }])).unwrap();
        assert!(rerun_variables(&secured).unwrap_err().contains("TOKEN"));

        // A commit target keeps its commit, and one without any is refused.
        let commit_only: RawTarget = serde_json::from_value(json!({ "type": "pipeline_commit_target", "commit": { "hash": "abc" } })).unwrap();
        assert_eq!(rerun_target(&commit_only).unwrap()["commit"]["hash"], "abc");
        let nothing: RawTarget = serde_json::from_value(json!({ "type": "pipeline_commit_target" })).unwrap();
        assert!(rerun_target(&nothing).is_err());
    }

    #[test]
    fn a_manual_run_targets_the_ref_and_a_custom_pipeline_by_its_selector() {
        assert_eq!(
            start_body(BRANCH_DEFINITION, "refs/heads/release/2.0", &[]).unwrap(),
            json!({ "target": { "type": "pipeline_ref_target", "ref_type": "branch", "ref_name": "release/2.0" } })
        );
        let variables = vec![
            PipelineVariable { key: " REGION ".into(), value: "eu-west-1".into(), masked: false },
            PipelineVariable { key: "API_TOKEN".into(), value: "placeholder".into(), masked: true },
        ];
        assert_eq!(
            start_body("custom:deploy-prod", "refs/tags/v1.2.0", &variables).unwrap(),
            json!({
                "target": {
                    "type": "pipeline_ref_target", "ref_type": "tag", "ref_name": "v1.2.0",
                    "selector": { "type": "custom", "pattern": "deploy-prod" }
                },
                "variables": [
                    { "key": "REGION", "value": "eu-west-1", "secured": false },
                    { "key": "API_TOKEN", "value": "placeholder", "secured": true }
                ]
            })
        );
        assert!(start_body("custom:  ", "main", &[]).is_err());
        assert!(start_body("something-else", "main", &[]).is_err());
    }

    #[test]
    fn a_created_pipeline_names_itself() {
        let created: RawCreated = serde_json::from_value(json!({
            "type": "pipeline", "uuid": "{0b7f2b6e-1111-4c1d-9c3a-222222222222}", "build_number": 43,
            "state": { "name": "PENDING", "type": "pipeline_state_pending" }
        }))
        .unwrap();
        assert_eq!(created.uuid.as_deref(), Some("{0b7f2b6e-1111-4c1d-9c3a-222222222222}"));
        assert_eq!(web_pipeline_url("ws", "repo", created.build_number), "https://bitbucket.org/ws/repo/pipelines/results/43");
    }

    #[test]
    fn the_main_branch_comes_off_the_repository() {
        let raw: RawRepository = serde_json::from_value(json!({ "mainbranch": { "type": "branch", "name": "main" } })).unwrap();
        assert_eq!(raw.mainbranch.and_then(|b| b.name).as_deref(), Some("main"));
    }
}
