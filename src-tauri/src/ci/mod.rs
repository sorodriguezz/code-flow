//! CI/CD pipelines — the runs a repository has executed, the jobs inside them, and their logs.
//!
//! Named `ci` rather than `pipelines` on purpose: in this crate "pipeline" already means the
//! *AI review* pipeline (`commands::review_pipeline`, `review::*`), and a second meaning for the
//! same word in the same codebase is a bug waiting to be read into existence.
//!
//! The shape is the one `crate::ado`'s [`PullRequestSummary`] established for pull requests: the
//! wire types are declared **once**, here, with a `provider` field, and each of the four clients
//! produces exactly them. The frontend never branches on the host, and neither does anything
//! between here and it.
//!
//! What each provider actually gives us differs enough to be worth stating up front, because the
//! whole shape of this module follows from it:
//!
//! | | run | jobs | log | grouping |
//! |---|---|---|---|---|
//! | GitHub | workflow run | `/runs/{id}/jobs` | per job, behind a 302 | **none** — see [`PipelineRun::definition_path`] |
//! | GitLab | pipeline | `/pipelines/{id}/jobs` | per job (`trace`), text/plain | `job.stage`, first-class |
//! | Azure | build | `timeline` records | per *record*, not per job | the record's `Stage` parent |
//! | Bitbucket | pipeline | `/pipelines/{uuid}/steps` | per step, behind a 307 once finished | **none** — overlapping time |
//!
//! And for the three things a person can *do* besides re-running and cancelling:
//!
//! | | start by hand | waiting on a person | artifacts |
//! |---|---|---|---|
//! | GitHub | `workflow_dispatch`, inputs declared in the workflow file | `pending_deployments` of the run | per run, a zip behind a 302 |
//! | GitLab | `POST /pipeline` on a ref, with variables | `manual` jobs; `blocked` deployments | per job: its one archive |
//! | Azure | `pipelines/{id}/runs`, template parameters from the YAML | `Checkpoint.*` records in the timeline | per build, `downloadUrl` |
//! | Bitbucket | `POST /pipelines` on a ref, a custom pipeline with variables | a paused pipeline's manual step — no API to start it | **none** in the API |
//!
//! [`PullRequestSummary`]: crate::ado::PullRequestSummary

pub mod azure;
pub mod bitbucket;
pub mod github;
pub mod gitlab;
pub mod http;

use serde::{Deserialize, Serialize};

/// The provider ids as they travel to the frontend. Same four strings the PR types use, so a
/// component that already knows how to label "github" doesn't learn a second vocabulary.
pub const PROVIDER_GITHUB: &str = "github";
pub const PROVIDER_GITLAB: &str = "gitlab";
pub const PROVIDER_AZURE: &str = "azure";
pub const PROVIDER_BITBUCKET: &str = "bitbucket";

/// The seven buckets every provider's taxonomy is collapsed into before it crosses to TypeScript.
///
/// Normalising in Rust rather than in the UI is the rule the PR clients already follow
/// (`github::bucket_status`, `gitlab::bucket_status`, `ado::bucket_status`). The UI gets a closed
/// set it can exhaustively map to an icon and a colour; the provider's own word survives in
/// [`PipelineRun::raw_status`] for the tooltip, so nothing is actually lost.
pub mod status {
    /// Accepted by the host, no runner yet.
    pub const QUEUED: &str = "queued";
    /// A runner has it. The only bucket the UI draws with an orb instead of a glyph.
    pub const RUNNING: &str = "running";
    pub const SUCCESS: &str = "success";
    /// Finished, but not cleanly. Only Azure says this outright (`partiallySucceeded`); for the
    /// other two it is derived — see each client's `bucket_status`.
    pub const WARNING: &str = "warning";
    pub const FAILED: &str = "failed";
    pub const CANCELLED: &str = "cancelled";
    /// Never ran: a branch condition, a manual job nobody launched, or a stage skipped because
    /// the one before it failed.
    pub const SKIPPED: &str = "skipped";
}

/// True for the two buckets that are still moving, which is what decides the polling cadence and
/// whether a run may be handed to the failure analysis yet.
pub fn is_live(bucket: &str) -> bool {
    bucket == status::RUNNING || bucket == status::QUEUED
}

/// One execution of a pipeline: a GitHub workflow run, a GitLab pipeline, an Azure build.
#[derive(Debug, Clone, Serialize)]
pub struct PipelineRun {
    /// "github" | "gitlab" | "azure" | "bitbucket".
    pub provider: String,
    /// The host's own id, as a string. Deliberately not an `i64`: the three providers don't share
    /// an id space, the value is only ever echoed back to the host or used as a map key, and a
    /// string keeps Azure's build ids and GitHub's 64-bit run ids in the same field without
    /// anyone having to remember which is which.
    pub id: String,
    /// The number a human sees — `run_number`, the pipeline `iid`, the build number. Absent when
    /// the host doesn't publish one.
    pub number: Option<i64>,
    /// The workflow / pipeline / build-definition name.
    pub name: String,
    /// One of [`status`].
    pub status: String,
    /// What the provider actually said, for the tooltip. Keeping it is what makes the bucketing
    /// above safe to be lossy.
    pub raw_status: String,
    pub branch: String,
    pub commit_sha: String,
    pub commit_title: Option<String>,
    pub actor: Option<String>,
    /// What triggered it — `push`, `pull_request`, `schedule`, `individualCI`… Free-form: it is
    /// shown, never matched on.
    pub event: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    /// Where "open in GitHub / GitLab / Azure DevOps" goes. Always a browser URL, never an API
    /// one, and always built with the *web* encoder — a `/` percent-encoded into `%2F` is correct
    /// for GitLab's API and broken in a browser.
    pub web_url: String,
    /// Repo-relative path of the file that defines this run, when the host names one.
    ///
    /// GitHub and Azure populate it, for the same reason and with two different files.
    ///
    /// Neither host will say which units ran in parallel. GitHub's `/runs/{id}/jobs` does not
    /// return `needs:`, and Azure's timeline carries `Stage` records with no `dependsOn` on them
    /// at all. So in both cases the frontend reads this file out of the working copy and parses
    /// the declaration itself — no extra request, no new dependency.
    ///
    /// The two parsers have **opposite defaults** and are deliberately separate functions: a
    /// GitHub job with no `needs:` runs immediately, while an Azure stage with no `dependsOn:`
    /// waits for the stage written above it. See `parseWorkflowNeeds` and `parseAzureStages`.
    ///
    /// When the file can't be read — renamed, working copy on another commit, or a pipeline that
    /// builds a repository other than the one holding it — the graph falls back to grouping by
    /// overlapping time, and says so on the badge rather than pretending it was declared.
    pub definition_path: Option<String>,
    /// Whether the run is held at a gate — nearly always waiting on a person: an environment's
    /// reviewers, a blocking manual job, an Azure approval; occasionally on a check the host runs by
    /// itself (a wait timer, business hours). See [`PipelineGate`].
    ///
    /// A flag rather than an eighth [`status`] bucket, because it is not a state the run is *in* so
    /// much as the reason it isn't moving — and the three hosts file it under three different
    /// states: GitHub says `waiting` (bucketed `QUEUED`), GitLab `manual` (bucketed `SKIPPED`),
    /// Azure plain `inProgress`. The bucket keeps meaning what it meant, including whether the poll
    /// treats the run as live; this adds the one thing the list has to show on top of it.
    ///
    /// The list only knows it where the host puts it in the list response. GitHub and GitLab do;
    /// an Azure build says `inProgress` and nothing about its approvals, so an Azure row learns it
    /// when the run is opened and the timeline is read — the same accepted difference between list
    /// and detail that `github::refine_run_status` documents for warnings.
    pub gated: bool,
}

/// One unit inside a run. The unit that has a log — which is why there is no `step` level: GitLab
/// has no steps at all, and in Azure the log hangs off a timeline *record*, not off the job.
#[derive(Debug, Clone, Serialize)]
pub struct PipelineJob {
    pub provider: String,
    pub run_id: String,
    pub id: String,
    pub name: String,
    /// The column this job belongs to in the graph, when the provider says. `None` for GitHub,
    /// where nothing in the API knows — see [`PipelineRun::definition_path`].
    ///
    /// A *display* name, and therefore not an identity: see [`PipelineJob::stage_id`].
    pub stage: Option<String>,
    /// The host's own id for that stage, when it has one. `None` for GitLab and GitHub.
    ///
    /// This is what the graph groups by, and [`stage`] is only what it *writes on the column*.
    /// Azure requires a stage's `stage:` key to be unique and its `displayName` not to be, and the
    /// timeline reports the display name — so two stages instantiated from one template with a
    /// constant `displayName: Deploy` arrive as two records both called "Deploy". Grouped by name
    /// they collapse into a single card that takes one stage's verdict and the other's jobs; the
    /// failed one then has no representation on the board at all.
    ///
    /// [`stage`]: PipelineJob::stage
    pub stage_id: Option<String>,
    pub status: String,
    pub raw_status: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub web_url: String,
    /// A second identifier the log needs, when the job's own id isn't enough. Azure addresses
    /// logs by the timeline record's `log.id`, which is a different number from the record id.
    pub log_ref: Option<String>,
}

/// One stage of a run, as the **provider itself** reports it.
///
/// Not derived from the jobs, and that is the entire reason it exists. A stage is a container with
/// a life of its own: it can be `inProgress` while every job under it has already succeeded (an
/// approval, a post-job check, a gate still evaluating), it can be `canceled` above jobs that
/// finished cleanly, and its wall clock starts before its first job and ends after its last. A
/// card that rolled those facts up out of the job list would be confidently wrong exactly on the
/// builds a person opens this screen to understand.
///
/// Only Azure fills it: its timeline carries `Stage` records next to the `Job` ones. GitLab knows
/// which stage a job is in and *nothing else about the stage*, and GitHub has no stages at all —
/// both send an empty vector, and the UI falls back to summarising the jobs, saying so.
#[derive(Debug, Clone, Serialize)]
pub struct PipelineStage {
    pub provider: String,
    pub run_id: String,
    /// The host's own id for the stage. Shared with the placeholder job emitted for a stage that
    /// has no jobs yet, which is how the UI tells that "job" apart from a real one — see
    /// `azure::map_timeline`.
    pub id: String,
    /// What the job's `stage` field holds for every job inside it. The join key.
    pub name: String,
    /// The stage's **ref name** — the `stage: Validations` key in the pipeline file, which Azure
    /// publishes as the timeline record's `identifier`.
    ///
    /// Not a duplicate of [`name`], and the difference is the whole reason this exists: `name` is
    /// the *display* name, which is what a person reads and what nothing can be joined on, while a
    /// `dependsOn:` list refers to *this*. Reading `dependsOn` out of the pipeline file and
    /// matching it against display names would silently mis-wire the one pipeline shape that makes
    /// the difference visible — a template instantiated twice under one `displayName` — which is
    /// the same trap `PipelineJob::stage_id` exists to avoid.
    ///
    /// `None` for GitLab, which has no stage object at all, and for any Azure record that omits it.
    pub ref_name: Option<String>,
    /// One of [`status`], bucketed exactly like a job's.
    pub status: String,
    pub raw_status: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

/// A run plus its jobs, fetched together because the UI never wants one without the other.
#[derive(Debug, Clone, Serialize)]
pub struct PipelineRunDetail {
    pub run: PipelineRun,
    pub jobs: Vec<PipelineJob>,
    /// The stages the provider declared, when it says anything about them beyond their names.
    /// Empty for GitHub and GitLab — see [`PipelineStage`].
    pub stages: Vec<PipelineStage>,
    /// What the run is waiting on a person for, right now. Empty for a run that isn't waiting.
    pub gates: Vec<PipelineGate>,
}

/// What a [`PipelineGate`] is waiting for. The three words the UI branches on — never the host.
pub mod gate_kind {
    /// Somebody has to say yes or no: a GitHub environment's reviewers, a GitLab protected
    /// environment's approvers, an Azure approval check.
    pub const APPROVAL: &str = "approval";
    /// A job that only runs when somebody starts it — GitLab's `when: manual`.
    pub const MANUAL: &str = "manual";
    /// A check the host evaluates by itself — Azure's business hours, an invoked function, a
    /// monitor query. Nothing to answer from here; it is shown so a stage that isn't moving says why.
    pub const CHECK: &str = "check";
}

/// One thing a run is waiting on a person for.
///
/// All three hosts have the idea and none of them agree on its shape, so this is the common
/// denominator the UI can put a button on: what is waiting, who may answer, and the id the host
/// wants back. How each host finds its own is in its client — GitHub asks a dedicated endpoint,
/// GitLab reads its manual jobs and blocked deployments, Azure reads `Checkpoint.*` records out of
/// the timeline it already fetched.
#[derive(Debug, Clone, Serialize)]
pub struct PipelineGate {
    pub provider: String,
    pub run_id: String,
    /// What the host is answered with: a GitHub environment id, a GitLab deployment id (approval)
    /// or job id (manual), an Azure approval id — which *is* the id of the timeline's
    /// `Checkpoint.Approval` record.
    pub id: String,
    /// One of [`gate_kind`].
    pub kind: String,
    /// What is waiting, in the host's words: the environment, the job, the stage.
    pub name: String,
    /// The stage it holds, when the host has stage objects (Azure). The same id the jobs carry in
    /// [`PipelineJob::stage_id`], which is what lets the stage board mark the right card.
    pub stage_id: Option<String>,
    /// The jobs it holds, for the graph to mark. Exactly as precise as the host allows: GitHub
    /// never says which waiting job belongs to which environment, so there every waiting job is
    /// listed under every pending environment.
    pub job_ids: Vec<String>,
    /// Whether *this* token may answer it. `None` when the host doesn't say — every host but
    /// GitHub — and then a refusal comes back from the host, in its own words, when it is tried.
    pub can_act: Option<bool>,
    /// Who may answer it, as the host names them.
    pub reviewers: Vec<String>,
    /// What the pipeline's author asked approvers to check first (Azure's `instructions`).
    pub instructions: Option<String>,
    /// When it started waiting.
    pub since: Option<String>,
    /// Where to answer it in the browser instead.
    pub web_url: String,
}

/// A file a run published: a GitHub workflow artifact, a GitLab job's archive, an Azure build
/// artifact.
#[derive(Debug, Clone, Serialize)]
pub struct PipelineArtifact {
    pub provider: String,
    pub run_id: String,
    /// What the download command is handed back. GitHub's artifact id, GitLab's **job** id (a job
    /// has one archive, and the job is what the download endpoint is addressed by), Azure's
    /// artifact id.
    pub id: String,
    pub name: String,
    /// `None` where the host doesn't publish one — an Azure file-container artifact.
    pub size_bytes: Option<u64>,
    /// When the host will delete it. `None` for Azure, whose artifacts live as long as the build.
    pub expires_at: Option<String>,
    /// Past its retention. Listed so the user can see it existed; there is nothing to download.
    pub expired: bool,
    /// The job that produced it, when the host says.
    pub job_name: Option<String>,
    /// What the save dialog proposes: safe on every filesystem, and ending in `.zip` — the archive
    /// is saved exactly as the host delivers it, never unpacked.
    pub file_name: String,
}

/// A pipeline that can be started by hand: a workflow with `workflow_dispatch`, the project's
/// `.gitlab-ci.yml`, an Azure pipeline definition.
#[derive(Debug, Clone, Serialize)]
pub struct PipelineDefinition {
    pub provider: String,
    /// What [`StartPipelineRequest::definition_id`] carries back: the GitHub workflow id, the Azure
    /// definition id. GitLab has one pipeline per project, so there it is the config path.
    pub id: String,
    pub name: String,
    /// Repo-relative path of the file that declares it — and its inputs. `None` for a classic Azure
    /// definition (stored on the server, not in the repository) and for a GitLab config that lives
    /// in another project or behind a URL.
    pub path: Option<String>,
    /// The variables the host lets a person set at queue time, with their defaults — Azure's
    /// "let users override this value" variables. Empty for the other two: GitLab's prefilled
    /// variables are read out of the file, and GitHub has no queue-time variables at all.
    pub variables: Vec<DeclaredVariable>,
    pub web_url: String,
}

/// One queue-time variable a definition declares.
#[derive(Debug, Clone, Serialize)]
pub struct DeclaredVariable {
    pub name: String,
    /// Its default. Empty for a secret: the host never hands those back.
    pub value: String,
    pub secret: bool,
}

/// Everything the "Run pipeline" dialog needs before the user has picked anything.
#[derive(Debug, Clone, Serialize)]
pub struct PipelineLaunchContext {
    pub provider: String,
    pub definitions: Vec<PipelineDefinition>,
    /// The branch the host treats as the repository's default, which is where a GitHub workflow
    /// has to exist to be dispatchable at all.
    pub default_branch: Option<String>,
    /// The repository's deployment environments, for a GitHub input of `type: environment`. Empty
    /// when the host has none, has no such concept, or wouldn't say.
    pub environments: Vec<String>,
}

/// A run to start, as the dialog sends it.
#[derive(Debug, Clone, Deserialize)]
pub struct StartPipelineRequest {
    /// [`PipelineDefinition::id`].
    pub definition_id: String,
    /// The branch or tag to run on, bare (`main`, `v1.2.0`) or full (`refs/heads/main`). Each client
    /// reshapes it into what its host takes.
    #[serde(rename = "ref")]
    pub ref_name: String,
    /// GitHub `inputs`, GitLab `inputs`, Azure `templateParameters`.
    ///
    /// JSON values rather than strings, because the three hosts disagree on types: GitHub and
    /// Azure take every value as text (a `type: boolean` input receives `"true"`), while GitLab's
    /// typed `spec:inputs` expect a real boolean or number. The form sends what it has, and each
    /// client converts on its own side of the dispatch.
    #[serde(default)]
    pub inputs: std::collections::BTreeMap<String, serde_json::Value>,
    /// GitLab pipeline variables, Azure run variables. GitHub has none.
    #[serde(default)]
    pub variables: Vec<PipelineVariable>,
}

/// One key/value the user typed for a run or a manual job.
#[derive(Debug, Clone, Deserialize)]
pub struct PipelineVariable {
    pub key: String,
    #[serde(default)]
    pub value: String,
    /// Hidden on screen and in the confirmation — and, where the host has the notion (Azure's
    /// `isSecret`), sent as a secret. GitLab has no queue-time masking at all.
    #[serde(default)]
    pub masked: bool,
}

/// What starting a run produced.
#[derive(Debug, Clone, Serialize, Default)]
pub struct StartedPipeline {
    /// The new run, when the host says which it is. GitLab and Azure always do; GitHub does on
    /// github.com (a `200` carrying `workflow_run_id`) and not on an older Enterprise Server, which
    /// answers `204` with no body — there the frontend finds the run on the next page of the list.
    pub run_id: Option<String>,
    pub web_url: Option<String>,
}

/// A file name the save dialog can propose for an artifact, on any of the three desktop
/// filesystems.
///
/// Artifact names are free text on every host — `coverage report (linux)`, `dist/web`, `a:b` — and
/// the save dialog is handed this verbatim. A `/` would be read as a folder the dialog then fails
/// to find, and `:` or `?` is a name Windows refuses outright. Everything outside what all three
/// accept is replaced rather than dropped, so two artifacts differing only in punctuation still
/// propose different names.
pub fn artifact_file_name(name: &str) -> String {
    let mut out: String = name
        .trim()
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    // Windows also refuses a name that ends in a dot or a space, and a leading dot hides the file
    // everywhere else.
    out = out.trim_matches(|c: char| c == '.' || c == ' ').to_string();
    if out.is_empty() {
        out = "artifact".to_string();
    }
    if !out.to_ascii_lowercase().ends_with(".zip") {
        out.push_str(".zip");
    }
    out
}

/// Splits a ref into what kind it is and its short name: `refs/tags/v1` → `(Tag, "v1")`,
/// `refs/heads/main` and `main` → `(Branch, "main")`.
///
/// A bare name is taken as a branch. That is the only guess in here, and it is the one every host
/// makes too: GitLab and GitHub resolve a bare name against branches before tags.
pub fn split_ref(reference: &str) -> (RefKind, String) {
    let trimmed = reference.trim();
    if let Some(tag) = trimmed.strip_prefix("refs/tags/") {
        return (RefKind::Tag, tag.to_string());
    }
    let bare = trimmed.strip_prefix("refs/heads/").unwrap_or(trimmed);
    (RefKind::Branch, bare.to_string())
}

/// See [`split_ref`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefKind {
    Branch,
    Tag,
}

/// A form value as the text a host that takes text wants: `true` rather than `"true"` never
/// reaches GitHub or Azure, whose inputs are strings however the file typed them.
pub fn input_as_text(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// A job's log, already capped.
#[derive(Debug, Clone, Serialize)]
pub struct JobLog {
    /// The text as the host served it: ANSI intact, markers intact, nothing rewritten. The log
    /// pane renders it, and a pane that quietly edits what the host said is a pane you stop
    /// trusting. The cleaning happens on the *analysis* path only — see [`clean_ci_markers`].
    pub text: String,
    /// Whether [`MAX_LOG_BYTES`] cut it short. Announced in the UI rather than left implicit.
    pub truncated: bool,
    /// How much was read before the cap. Not the log's full size when `truncated` is true —
    /// nothing asked the host how big it was.
    pub total_bytes: u64,
}

/// Whether the repository is wired up for this screen at all, and to what.
///
/// One command answers both halves of the gate so the frontend doesn't have to re-implement
/// `linked_repo`'s provider precedence — which, if it drifted, would show the tab for one host and
/// fetch from another.
#[derive(Debug, Clone, Serialize)]
pub struct PipelineAvailability {
    /// The provider this project is linked to, or `None` if it is linked to nothing.
    pub provider: Option<String>,
    /// Whether that provider has a saved connection. Read from the `*_connections` app-settings,
    /// never from the keychain: on macOS with an ad-hoc signature every keychain read pops a
    /// password dialog, and this runs whenever a repository is selected.
    pub connected: bool,
    /// The host or organization the tab would talk to, for the "not connected" message.
    pub host: Option<String>,
}

// ---------------------------------------------------------------------------
// Log handling
// ---------------------------------------------------------------------------

/// How much of a log is read before giving up on it.
///
/// A GitLab `trace` has no guaranteed ceiling — the administrator of a self-managed instance sets
/// it — and a job that loops printing can produce hundreds of megabytes. The cap is on the read
/// itself (see [`http::read_capped`]), not on a buffer we have already filled.
pub const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

/// How much of a log the failure analysis is given.
///
/// Roughly the size of [`crate::ai::MAX_REVIEW_DIFF_CHARS`] halved: a log is far more repetitive
/// than a diff, so the same budget buys less signal, and what matters is nearly always at the end.
pub const MAX_AI_LOG_CHARS: usize = 60_000;

/// The marker written where the middle of a log was dropped.
fn elision(chars: usize) -> String {
    format!("\n… [{chars} caracteres omitidos por CodeFlow] …\n")
}

/// Trims a log to `max_chars`, **keeping the end**.
///
/// This is the one piece of this feature that could not reuse anything: every truncation in this
/// codebase is `text.chars().take(N)` (`ai.rs:1936`, `:2724`, `:2816`, `:3914`, `:3942`), which
/// keeps the *head*. On a diff that is right — a diff's first hunks are as informative as its
/// last. On a CI log it is exactly wrong: the head is `actions/checkout` and `npm install`, and
/// the thing that has to survive is the stack trace on the final screen.
///
/// A fifth of the budget is still spent on the head, because the head carries the command that
/// was run and the versions it ran with, and an analysis that can't see the command is guessing.
/// Both cuts land on a line boundary — a log is read as lines, and half a line at each seam is
/// half a line the model has to decide whether to trust.
///
/// Returns the text and whether anything was dropped.
pub fn head_and_tail(text: &str, max_chars: usize) -> (String, bool) {
    let total = text.chars().count();
    if total <= max_chars {
        return (text.to_string(), false);
    }

    let head_budget = max_chars / 5;
    let tail_budget = max_chars - head_budget;

    // Byte offset of the character at `index`, so the slices below are on char boundaries.
    let at = |index: usize| -> usize {
        text.char_indices().nth(index).map(|(byte, _)| byte).unwrap_or(text.len())
    };

    // The head ends at the last newline inside its budget, so it never stops mid-line.
    let head_end_raw = at(head_budget);
    let head_end = text[..head_end_raw].rfind('\n').map(|at| at + 1).unwrap_or(0);

    // The tail starts at the first newline *after* its budget opens, for the same reason.
    let tail_start_raw = at(total - tail_budget);
    let tail_start = text[tail_start_raw..]
        .find('\n')
        .map(|offset| tail_start_raw + offset + 1)
        .unwrap_or(tail_start_raw);

    // A pathological log — one line of ten megabytes, which a progress bar without newlines is —
    // leaves the two boundaries crossed. Keeping the tail alone is the honest answer there.
    if head_end >= tail_start {
        let kept: String = text.chars().skip(total.saturating_sub(max_chars)).collect();
        return (kept, true);
    }

    let dropped = text[head_end..tail_start].chars().count();
    let mut out = String::with_capacity(max_chars + 64);
    out.push_str(&text[..head_end]);
    out.push_str(&elision(dropped));
    out.push_str(&text[tail_start..]);
    (out, true)
}

/// Strips the scaffolding CI systems wrap their logs in, for the *analysis* payload only.
///
/// Every one of these is noise to a model and costs budget that the actual error should be
/// spending: GitHub's `##[group]` / `##[endgroup]` fold markers, GitLab's `section_start:` /
/// `section_end:` sequences, and the ISO timestamp Azure and GitHub Actions prepend to every
/// single line (28 characters × the whole log).
///
/// What it deliberately does **not** touch: `##[error]` and `##[warning]`, which are the host
/// telling us where it thinks the problem is, and are worth more to the analysis than they cost.
pub fn clean_ci_markers(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        let line = strip_timestamp(line);
        let trimmed = line.trim_start();
        if trimmed.starts_with("##[group]")
            || trimmed.starts_with("##[endgroup]")
            || trimmed.starts_with("##[debug]")
        {
            continue;
        }
        if trimmed.starts_with("section_start:") || trimmed.starts_with("section_end:") {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// Drops a leading `2026-08-21T17:04:11.1234567Z ` if there is one.
///
/// Matched structurally rather than with a regex (this crate has no regex dependency and does not
/// need one for this): 4 digits, `-`, and a `Z` or `+` before the first space.
fn strip_timestamp(line: &str) -> &str {
    let Some(space) = line.find(' ') else { return line };
    let (stamp, rest) = line.split_at(space);
    let bytes = stamp.as_bytes();
    if stamp.len() < 20 || bytes.len() < 11 {
        return line;
    }
    let looks_iso = bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && stamp.contains('T')
        && (stamp.ends_with('Z') || stamp.contains('+'));
    if looks_iso { rest.trim_start_matches(' ') } else { line }
}

/// The seconds between two RFC3339 stamps, when both are there and parse.
///
/// Hand-rolled rather than pulling in `chrono`: the crate doesn't depend on it, the only shape
/// these APIs emit is `YYYY-MM-DDTHH:MM:SS(.fff)?(Z|±HH:MM)`, and the frontend does the actual
/// formatting. Returns `None` rather than guessing on anything it doesn't recognise.
pub fn duration_secs(from: Option<&str>, to: Option<&str>) -> Option<i64> {
    let a = epoch_secs(from?)?;
    let b = epoch_secs(to?)?;
    Some((b - a).max(0))
}

/// Seconds since the epoch for an RFC3339 stamp, UTC or with an offset.
fn epoch_secs(stamp: &str) -> Option<i64> {
    let bytes = stamp.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> { stamp.get(from..to)?.parse::<i64>().ok() };
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, s) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);

    // Days since 1970-01-01, by the civil-from-days algorithm (Howard Hinnant's), which is exact
    // for every proleptic Gregorian date and needs no table.
    let y_adj = if mo <= 2 { y - 1 } else { y };
    let era = if y_adj >= 0 { y_adj } else { y_adj - 399 } / 400;
    let yoe = y_adj - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;

    let mut secs = days * 86_400 + h * 3600 + mi * 60 + s;

    // An offset means the stamp is *local*; subtracting it gets back to UTC.
    if let Some(sign_at) = stamp[19..].find(['+', '-']).map(|at| at + 19) {
        let offset = &stamp[sign_at..];
        if offset.len() >= 6 {
            let oh: i64 = offset.get(1..3)?.parse().ok()?;
            let om: i64 = offset.get(4..6)?.parse().ok()?;
            let magnitude = oh * 3600 + om * 60;
            secs += if offset.starts_with('-') { magnitude } else { -magnitude };
        }
    }
    Some(secs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_logs_are_returned_whole() {
        let (out, cut) = head_and_tail("one\ntwo\nthree\n", 500);
        assert_eq!(out, "one\ntwo\nthree\n");
        assert!(!cut);
    }

    #[test]
    fn truncation_keeps_the_end_which_is_the_whole_point() {
        let mut log = String::new();
        for i in 0..2000 {
            log.push_str(&format!("line {i}\n"));
        }
        log.push_str("error[E0599]: no method named `get_text`\n");

        let (out, cut) = head_and_tail(&log, 900);
        assert!(cut);
        // The failure survived...
        assert!(out.contains("error[E0599]"));
        // ...and so did the beginning, which says what was being run.
        assert!(out.starts_with("line 0\n"));
        assert!(out.contains("omitidos por CodeFlow"));
        // Nothing was cut mid-line: every line is one the original had.
        for line in out.lines().filter(|l| l.starts_with("line ")) {
            assert!(log.contains(&format!("{line}\n")), "línea partida: {line}");
        }
    }

    #[test]
    fn a_single_enormous_line_still_keeps_its_end() {
        let log = format!("{}FINAL", "x".repeat(5000));
        let (out, cut) = head_and_tail(&log, 100);
        assert!(cut);
        // The whole point: a progress bar that never printed a newline still surrenders its last
        // screen, which is where the failure is.
        assert!(out.ends_with("FINAL"));
        // There is no line boundary anywhere, so no head survives — only the marker and the tail.
        assert!(out.starts_with('\n'));
        // The budget bounds the *log*; the marker is CodeFlow talking, and it is allowed to cost
        // its own length on top. Anything else would mean silently returning less than asked for.
        let marker = elision(0).chars().count() + 8;
        assert!(out.chars().count() <= 100 + marker, "{} caracteres", out.chars().count());
    }

    #[test]
    fn multibyte_logs_are_cut_on_character_boundaries() {
        let log = "héllo wörld ñ\n".repeat(500);
        let (out, cut) = head_and_tail(&log, 200);
        assert!(cut);
        // Reaching here at all means no slice landed inside a character; assert the content too.
        assert!(out.contains("héllo"));
    }

    #[test]
    fn ci_scaffolding_goes_but_the_hosts_own_diagnosis_stays() {
        let raw = "2026-08-21T17:04:11.1234567Z ##[group]Run cargo test\n\
                   2026-08-21T17:04:12.0000000Z    Compiling codeflow_lib\n\
                   section_start:1755795851:step_script\n\
                   ##[endgroup]\n\
                   ##[error]Process completed with exit code 101.\n";
        let out = clean_ci_markers(raw);
        assert!(!out.contains("##[group]"));
        assert!(!out.contains("##[endgroup]"));
        assert!(!out.contains("section_start:"));
        assert!(!out.contains("2026-08-21T"));
        assert!(out.contains("Compiling codeflow_lib"));
        // The one marker worth its bytes.
        assert!(out.contains("##[error]Process completed with exit code 101."));
    }

    #[test]
    fn a_line_that_merely_starts_with_digits_keeps_them() {
        assert_eq!(strip_timestamp("2000 packages installed"), "2000 packages installed");
        assert_eq!(strip_timestamp("   indented"), "   indented");
    }

    #[test]
    fn durations_come_out_in_seconds() {
        assert_eq!(
            duration_secs(Some("2026-08-21T17:04:11Z"), Some("2026-08-21T17:07:31Z")),
            Some(200)
        );
        // Across a month boundary, which is where a hand-rolled calendar earns its test.
        assert_eq!(
            duration_secs(Some("2026-01-31T23:59:00Z"), Some("2026-02-01T00:00:00Z")),
            Some(60)
        );
        // Leap day.
        assert_eq!(
            duration_secs(Some("2028-02-28T00:00:00Z"), Some("2028-03-01T00:00:00Z")),
            Some(172_800)
        );
        // An offset is resolved to UTC, not taken at face value.
        assert_eq!(
            duration_secs(Some("2026-08-21T19:04:11+02:00"), Some("2026-08-21T17:07:31Z")),
            Some(200)
        );
        // A run that hasn't finished has no duration, rather than a wrong one.
        assert_eq!(duration_secs(Some("2026-08-21T17:04:11Z"), None), None);
        assert_eq!(duration_secs(Some("no es una fecha"), Some("2026-08-21T17:04:11Z")), None);
    }

    #[test]
    fn live_is_only_the_two_moving_buckets() {
        assert!(is_live(status::RUNNING));
        assert!(is_live(status::QUEUED));
        for done in [status::SUCCESS, status::WARNING, status::FAILED, status::CANCELLED, status::SKIPPED] {
            assert!(!is_live(done), "{done} no debería contar como vivo");
        }
    }
    /// Trimming an already-trimmed log must not eat the end of it.
    ///
    /// `analyze_pipeline_failure` applies a second, defensive ceiling on top of the caller's, so
    /// the two run back to back on the same text. A head-keeping `chars().take()` there would undo
    /// the whole point of this function — and, because the first pass leaves the text *exactly* at
    /// the budget plus an elision marker, it bit on every trimmed log rather than only on long ones.
    #[test]
    fn trimming_twice_still_keeps_the_end() {
        let mut log = String::new();
        for i in 0..3000 {
            log.push_str(&format!("line {i}\n"));
        }
        log.push_str("##[error]Process completed with exit code 101.\n");

        let (once, _) = head_and_tail(&log, 1200);
        let (twice, _) = head_and_tail(&once, 1200);
        assert!(twice.contains("##[error]Process completed with exit code 101."));
        assert!(twice.ends_with('\n'));
    }

    /// The save dialog is handed this verbatim, so it has to be a name every filesystem takes —
    /// and still read as the artifact it came from.
    #[test]
    fn an_artifact_name_becomes_a_file_name_any_desktop_accepts() {
        assert_eq!(artifact_file_name("dist"), "dist.zip");
        // A slash would be read as a folder, a colon is refused by Windows.
        assert_eq!(artifact_file_name("dist/web"), "dist_web.zip");
        assert_eq!(artifact_file_name("report: linux?"), "report_ linux_.zip");
        // Already a zip: not doubled, whatever the case.
        assert_eq!(artifact_file_name("bundle.ZIP"), "bundle.ZIP");
        // Leading dots hide a file; trailing dots and spaces are refused by Windows.
        assert_eq!(artifact_file_name(" .hidden. "), "hidden.zip");
        // Nothing usable left still proposes something.
        assert_eq!(artifact_file_name("..."), "artifact.zip");
        assert_eq!(artifact_file_name(""), "artifact.zip");
        // Control characters are replaced, never passed through.
        assert_eq!(artifact_file_name("a\tb"), "a_b.zip");
    }

    #[test]
    fn a_ref_is_split_into_its_kind_and_its_short_name() {
        assert_eq!(split_ref("main"), (RefKind::Branch, "main".to_string()));
        assert_eq!(split_ref("refs/heads/release/2.0"), (RefKind::Branch, "release/2.0".to_string()));
        assert_eq!(split_ref(" refs/tags/v1.2.0 "), (RefKind::Tag, "v1.2.0".to_string()));
        // Anything else under `refs/` is not second-guessed.
        assert_eq!(split_ref("refs/pull/7/merge"), (RefKind::Branch, "refs/pull/7/merge".to_string()));
    }

    /// GitHub and Azure take every input as text; `true` must arrive as `"true"`, not as `True`
    /// or as a JSON boolean the dispatch then rejects.
    #[test]
    fn form_values_become_the_text_a_text_only_host_wants() {
        use serde_json::json;
        assert_eq!(input_as_text(&json!("staging")), "staging");
        assert_eq!(input_as_text(&json!(true)), "true");
        assert_eq!(input_as_text(&json!(false)), "false");
        assert_eq!(input_as_text(&json!(3)), "3");
        assert_eq!(input_as_text(&json!(2.5)), "2.5");
        assert_eq!(input_as_text(&json!(null)), "");
    }

    /// The request the dialog sends, decoded the way the command decodes it: `ref` renamed,
    /// everything but the definition and the ref optional.
    #[test]
    fn a_start_request_decodes_from_what_the_dialog_sends() {
        let full: StartPipelineRequest = serde_json::from_str(
            r#"{"definition_id":"42","ref":"main","inputs":{"dry_run":true,"target":"staging"},
                "variables":[{"key":"TOKEN","value":"x","masked":true},{"key":"PLAIN","value":"y"}]}"#,
        )
        .expect("full request");
        assert_eq!(full.ref_name, "main");
        assert_eq!(full.inputs.get("dry_run"), Some(&serde_json::json!(true)));
        assert!(full.variables[0].masked);
        assert!(!full.variables[1].masked);

        let bare: StartPipelineRequest =
            serde_json::from_str(r#"{"definition_id":".gitlab-ci.yml","ref":"v1.0"}"#).expect("bare");
        assert!(bare.inputs.is_empty());
        assert!(bare.variables.is_empty());
    }
}
