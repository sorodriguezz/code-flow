use base64::Engine;
use serde::{Deserialize, Serialize};

pub(crate) const API_VERSION: &str = "7.1";
/// A handful of Azure DevOps endpoints (notably `connectionData`) never went GA, and the server
/// rejects a plain `7.1` on them with a 400 demanding the `-preview` suffix.
const PREVIEW_API_VERSION: &str = "7.1-preview";

pub(crate) fn auth_header(pat: &str) -> String {
    let token = base64::engine::general_purpose::STANDARD.encode(format!(":{pat}"));
    format!("Basic {token}")
}

/// Accepts whatever the user actually typed/saved as their "organization" — a bare name
/// like `contoso`, a full `https://dev.azure.com/contoso` URL, or a legacy
/// `https://contoso.visualstudio.com` URL — and reduces it to the bare org name. Azure
/// DevOps' server rejects any literal `:` in the request path (IIS request validation), so
/// interpolating a raw URL straight into the path 404s/400s in a confusing way; normalizing
/// here means it works no matter which form ended up saved.
pub(crate) fn normalize_org(org: &str) -> String {
    let trimmed = org.trim().trim_end_matches('/');
    for prefix in ["https://dev.azure.com/", "http://dev.azure.com/"] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            return rest.trim_end_matches('/').split('/').next().unwrap_or(rest).to_string();
        }
    }
    if let Some(rest) = trimmed.strip_prefix("https://").or_else(|| trimmed.strip_prefix("http://")) {
        if let Some(host) = rest.split('/').next() {
            if let Some(name) = host.strip_suffix(".visualstudio.com") {
                return name.to_string();
            }
        }
    }
    trimmed.to_string()
}

/// Percent-encodes a single URL path segment (org/project names routinely contain spaces —
/// e.g. "Marketing Website" — which a raw, unencoded `format!` would send straight through
/// and break just as badly as the `:` case above).
pub(crate) fn encode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// One client for the process, cloned per call — see `crate::github::client` for why building a
/// rustls client per request cost a full TLS handshake and an unshared connection pool every time.
/// Nothing here varies the transport per call, so the pool is pure gain.
pub(crate) fn client() -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(pr_http_client).clone()
}

/// How long one request to a pull-request host may take, start to finish, before it is given up.
///
/// The three PR clients were `Client::new()`, which has no timeout of any kind: a host that accepted
/// the connection and then stopped answering parked the request — and the spinner on screen — until
/// the app was restarted. Generous on purpose, because this is a ceiling for the hung case, not a
/// budget: a PR's diff can be megabytes, and a self-managed GitLab behind a VPN is not fast.
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);
/// Reaching the host at all is quick or it is not happening.
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// The transport all three pull-request clients (`ado`, `github`, `gitlab`) are built on, so they
/// share one policy on how long to wait. The CI screen has its own (`ci::http`), tuned for polling.
pub(crate) fn pr_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

#[derive(Debug, Clone, Serialize)]
pub struct DetectedAdoRepo {
    pub org: String,
    pub project: String,
    /// Azure DevOps' Git REST API accepts either the repository's GUID or its plain name
    /// in place of `{repositoryId}` — so the name parsed straight out of the remote URL is
    /// enough to call the API with, no extra "resolve the repo" round-trip needed.
    pub repo: String,
}

fn decode_path_segment(s: &str) -> String {
    s.replace("%20", " ")
}

/// Recognizes the shapes an Azure Repos git remote actually comes in — HTTPS via
/// `dev.azure.com`, the legacy `<org>.visualstudio.com` HTTPS form (with or without
/// `/DefaultCollection`), and the SSH form — and pulls org/project/repo straight out of it.
/// Returns `None` for anything else (GitHub, GitLab, a bare local repo, etc.).
pub fn detect_from_remote_url(remote_url: &str) -> Option<DetectedAdoRepo> {
    let url = remote_url.trim().trim_end_matches(".git");

    if let Some(rest) = url.strip_prefix("git@ssh.dev.azure.com:v3/") {
        let parts: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
        return match parts.as_slice() {
            [org, project, repo] => Some(DetectedAdoRepo {
                org: decode_path_segment(org),
                project: decode_path_segment(project),
                repo: decode_path_segment(repo),
            }),
            _ => None,
        };
    }

    let without_scheme = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
    let without_userinfo = without_scheme.rsplit('@').next().unwrap_or(without_scheme);
    let mut split = without_userinfo.splitn(2, '/');
    let host = split.next()?;
    let path_parts: Vec<&str> = split.next().unwrap_or("").split('/').filter(|s| !s.is_empty()).collect();

    if host.eq_ignore_ascii_case("dev.azure.com") {
        // {org}/{project}/_git/{repo}
        if let [org, project, "_git", repo] = path_parts.as_slice() {
            return Some(DetectedAdoRepo {
                org: decode_path_segment(org),
                project: decode_path_segment(project),
                repo: decode_path_segment(repo),
            });
        }
        return None;
    }

    if let Some(org) = host.strip_suffix(".visualstudio.com") {
        let parts: &[&str] = if path_parts.first() == Some(&"DefaultCollection") {
            &path_parts[1..]
        } else {
            &path_parts
        };
        if let [project, "_git", repo] = parts {
            return Some(DetectedAdoRepo {
                org: org.to_string(),
                project: decode_path_segment(project),
                repo: decode_path_segment(repo),
            });
        }
        return None;
    }

    None
}

/// What a rejected token actually means, in words a user can act on. Worth a constant because the
/// server's own answer says none of it — see the 203 handling in [`get_json`].
pub(crate) const BAD_CREDENTIALS: &str = "Azure DevOps rejected the credentials — check that the \
organization name is right and that the personal access token is valid, not expired, and has the \
scopes CodeFlow needs (Code, Project and Team, and Work Items / Wiki if you use those)";

/// An expired personal access token, said as what it is. Azure answers it with a whole HTML page
/// ("Access Denied: The Personal Access Token used has expired."), which [`describe_failure`] reads
/// the title of instead of pasting the page — style sheet and all — into the settings row.
pub(crate) const PAT_EXPIRED: &str = "Azure DevOps rejected the personal access token because it has \
expired — create a new one and connect the organization again";

/// A failed Azure DevOps request as one readable sentence.
///
/// The body is whatever the service had to hand: `{"message": …}` from the REST API, or — for a
/// token that expired or was revoked — a complete HTML error page, which used to reach the screen
/// verbatim. The page's `<title>` is its sentence and the rest is markup; a JSON error's `message`
/// is its sentence and the rest is ids. A 401 is always the token, and gets the sentence that says
/// what to do about it.
pub(crate) fn describe_failure(status: reqwest::StatusCode, body: &str) -> String {
    let detail = failure_detail(body);
    if status == reqwest::StatusCode::UNAUTHORIZED {
        let expired = detail.as_deref().is_some_and(|d| d.to_ascii_lowercase().contains("expired"));
        return if expired { PAT_EXPIRED } else { BAD_CREDENTIALS }.to_string();
    }
    match detail {
        Some(detail) => format!("Azure DevOps returned {status}: {detail}"),
        None => format!("Azure DevOps returned {status}"),
    }
}

/// The sentence inside an error body, one line and at most 300 characters. `None` for a body with
/// nothing readable in it (an HTML page with no title, or nothing at all).
fn failure_detail(body: &str) -> Option<String> {
    let body = body.trim();
    if body.is_empty() {
        return None;
    }
    let one_line = |text: &str| -> Option<String> {
        let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
        (!text.is_empty()).then(|| text.chars().take(300).collect())
    };
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(message) = value.get("message").and_then(serde_json::Value::as_str) {
            return one_line(message);
        }
    }
    let lower = body.to_ascii_lowercase();
    if lower.starts_with("<!doctype") || lower.starts_with("<html") || lower.contains("<html") {
        // ASCII lower-casing keeps every byte where it was, so the offsets found in `lower` are
        // offsets into `body` too.
        let start = lower.find("<title>")? + "<title>".len();
        let end = start + lower[start..].find("</title>")?;
        return one_line(&body[start..end]);
    }
    one_line(body)
}

pub(crate) async fn get_json<T: for<'de> Deserialize<'de>>(url: &str, pat: &str) -> Result<T, String> {
    let res = client()
        .get(url)
        .header("Authorization", auth_header(pat))
        .send()
        .await
        .map_err(|e| format!("couldn't reach Azure DevOps: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(describe_failure(status, &body));
    }

    // The trap this exists for: a wrong or expired PAT does **not** get a 401 out of
    // `dev.azure.com`. The service treats the request as anonymous and answers the browser
    // sign-in page — `203 Non-Authoritative Information`, `Content-Type: text/html`. `203` passes
    // `is_success()`, so the check above waves it through and the only symptom left is the JSON
    // decode below failing on `<!DOCTYPE html>`: "unexpected response from Azure DevOps", which
    // reads like a bug in this app rather than "your token is wrong". Both signals are checked
    // because either alone would be a guess about undocumented behaviour.
    let is_html = res
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.trim_start().starts_with("text/html"));
    if status.as_u16() == 203 || is_html {
        return Err(BAD_CREDENTIALS.to_string());
    }

    res.json::<T>().await.map_err(|e| format!("unexpected response from Azure DevOps: {e}"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdoProject {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdoRepo {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PullRequestSummary {
    pub id: i64,
    pub title: String,
    pub description: String,
    /// One of "open" | "draft" | "merged" | "closed" — already bucketed to match the
    /// sidebar's sections, so the frontend doesn't need to know Azure DevOps' raw
    /// status/isDraft combination.
    pub status: String,
    pub source_branch: String,
    pub target_branch: String,
    pub author: String,
    pub created_at: String,
    pub url: String,
    /// Which VCS this PR came from — "azure" | "github" | "gitlab" — so the UI can label the
    /// "view on…" link and post-confirmation correctly without inspecting the URL.
    pub provider: String,
}

/// Which pull requests a list asks for.
///
/// The lists used to be one page of *every* state, newest first — a hundred rows that a busy
/// repository fills with merged history in a week, so an open pull request only a few weeks old fell
/// off the end and could be neither seen nor reviewed. Open is now the default and every scope pages.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrListScope {
    /// Open and draft — what is still waiting on someone.
    Open,
    /// Merged and closed.
    Closed,
    All,
}

impl PrListScope {
    /// `"open"` (also the answer for anything unrecognised) · `"closed"` · `"all"`.
    pub fn parse(raw: Option<&str>) -> Self {
        match raw.map(str::trim) {
            Some("closed") => Self::Closed,
            Some("all") => Self::All,
            _ => Self::Open,
        }
    }

    /// Whether an already-bucketed pull request belongs in this scope. GitLab and Azure cannot ask for
    /// "merged or closed" in one query, so their `Closed` pages ask for everything and are filtered
    /// here — a page can then hold fewer rows than asked for, which is honest rather than wrong.
    pub fn admits(self, status: &str) -> bool {
        match self {
            Self::Open => matches!(status, "open" | "draft"),
            Self::Closed => matches!(status, "merged" | "closed"),
            Self::All => true,
        }
    }
}

/// How many pull requests one page asks the host for.
pub const PR_PAGE_SIZE: u32 = 50;

/// One page of a pull-request list.
#[derive(Debug, Clone, Serialize)]
pub struct PrPage {
    pub items: Vec<PullRequestSummary>,
    /// 1-based, as asked for.
    pub page: u32,
    /// Whether the host has another page after this one.
    pub has_more: bool,
}

/// One check on a pull request's head commit: a GitHub check run or commit status, a GitLab
/// pipeline or one of its jobs, an Azure DevOps PR status or branch-policy evaluation. The same
/// shape from all three, like [`PullRequestSummary`].
#[derive(Debug, Clone, Serialize)]
pub struct PrCheck {
    /// `"check"` · `"status"` · `"pipeline"` · `"job"` · `"policy"` — where it came from.
    pub kind: String,
    pub name: String,
    /// One of `crate::ci::status` — the vocabulary the Pipelines tab already draws.
    pub state: String,
    /// The host's own word, for the tooltip.
    pub raw_state: String,
    pub description: Option<String>,
    /// Where it opens in a browser.
    pub url: Option<String>,
    /// The run's id in the Pipelines tab (a GitHub workflow run, a GitLab pipeline, an Azure build),
    /// when this check is one — what lets the PR view jump straight to its jobs and logs.
    pub pipeline_run_id: Option<String>,
    /// Whether the host requires it to pass before merging. Known for Azure's policies (and GitLab's
    /// "pipeline must succeed"); `None` where the host doesn't say.
    pub required: Option<bool>,
}

/// The checks of a pull request's current head.
#[derive(Debug, Clone, Serialize)]
pub struct PrChecks {
    pub head_sha: Option<String>,
    pub checks: Vec<PrCheck>,
}

/// What merging a pull request from CodeFlow may look like on its host.
#[derive(Debug, Clone, Serialize)]
pub struct MergeOptions {
    /// The strategies the host lets this pull request be merged with, in the order to offer them:
    /// `"merge"` · `"squash"` · `"rebase"` · `"rebase_merge"` (Azure's semi-linear) · `"ff"` (a
    /// GitLab project set to fast-forward — fixed by the project, not choosable per merge request).
    pub methods: Vec<String>,
    /// False when `methods` is the provider's whole menu because the repository's own settings
    /// couldn't be read — the host may still refuse one of them, and says so when it does.
    pub methods_known: bool,
    pub default_method: Option<String>,
    /// GitLab's squash, which is a toggle beside the method rather than a method:
    /// `"never"` · `"always"` · `"default_on"` · `"default_off"`. `None` on the other hosts.
    pub squash: Option<String>,
    /// Whether deleting the source branch is offered at all — not for a branch in a fork.
    pub can_delete_source_branch: bool,
    pub delete_source_branch_default: bool,
    /// Azure DevOps only: completing can move the linked work items to their done state.
    pub transition_work_items: Option<bool>,
    /// What the host says about merging it right now: `"clean"` · `"conflicts"` · `"behind"` ·
    /// `"blocked"` · `"approvals"` · `"checks_pending"` · `"checks_failing"` · `"draft"` ·
    /// `"closed"` · `"unknown"`.
    pub readiness: String,
    /// The host's own word behind `readiness`, for the tooltip.
    pub readiness_detail: Option<String>,
}

/// Prefix of a merge the host refused for a reason the user can act on:
/// `MERGE_BLOCKED::{kind}::{the host's own words}`, with `kind` from [`classify_merge_refusal`].
/// The panel matches the kind to say *why* in its own words and keeps the host's sentence beside it
/// — "405 Method Not Allowed" on its own tells nobody that the branch has conflicts.
pub const MERGE_BLOCKED_MARKER: &str = "MERGE_BLOCKED::";

pub fn merge_refusal(kind: &str, message: &str) -> String {
    format!("{MERGE_BLOCKED_MARKER}{kind}::{}", message.trim())
}

/// What kind of "no" a host's refusal to merge is, read from its status and its own words:
/// `"stale"` · `"conflicts"` · `"behind"` · `"checks"` · `"approvals"` · `"method"` · `"draft"` ·
/// `"blocked"` · `"other"`.
///
/// Words before codes, because the codes are overloaded: GitHub answers 405 both for "has
/// conflicts" and for "a required review is missing", and only the message tells them apart. The
/// order matters too — "Base branch was modified" mentions neither checks nor reviews but is a stale
/// read, and must not fall through to the 405 catch-all; Azure's "policies that are not approved"
/// is a policy block, not a missing review.
pub fn classify_merge_refusal(status: u16, message: &str) -> &'static str {
    let m = message.to_lowercase();
    if m.contains("was modified") || m.contains("sha does not match") || m.contains("sha mismatch") || status == 409 {
        "stale"
    } else if m.contains("conflict") || m.contains("cannot be merged") || status == 406 {
        "conflicts"
    } else if m.contains("out of date") || m.contains("need_rebase") || m.contains("needs to be rebased") {
        "behind"
    } else if m.contains("status check") || m.contains("required check") || m.contains("pipeline") || m.contains("build") {
        "checks"
    } else if m.contains("polic") {
        "blocked"
    } else if m.contains("review") || m.contains("approv") {
        "approvals"
    } else if m.contains("not allowed") && (m.contains("merge") || m.contains("squash") || m.contains("rebase")) {
        "method"
    } else if m.contains("draft") || m.contains("work in progress") {
        "draft"
    } else if m.contains("not mergeable") || status == 405 {
        "blocked"
    } else {
        "other"
    }
}

#[derive(Deserialize)]
pub(crate) struct ListResponse<T> {
    pub(crate) value: Vec<T>,
}

#[derive(Deserialize)]
struct RawIdentity {
    #[serde(rename = "displayName")]
    display_name: String,
}

#[derive(Deserialize)]
struct RawProjectRef {
    name: String,
    /// The team project's GUID. A work-item artifact link addresses the project by id, never by
    /// name, and this is the only place the create-PR response hands it to us.
    #[serde(default)]
    id: String,
}

#[derive(Deserialize)]
struct RawRepoRef {
    name: String,
    /// The repository's GUID. The PR endpoints take a name wherever they take this, but the branch
    /// policy configurations do not.
    #[serde(default)]
    id: String,
    /// Azure includes the owning team project on the repository it returns with a pull request.
    /// That's the only way to recover the project's *name* from a link that carries its GUID.
    #[serde(default)]
    project: Option<RawProjectRef>,
}

#[derive(Deserialize)]
struct RawCommitRef {
    #[serde(rename = "commitId", default)]
    commit_id: String,
}

#[derive(Deserialize)]
struct RawReviewer {
    id: String,
    #[serde(default)]
    vote: i32,
}

#[derive(Deserialize)]
struct RawPullRequest {
    #[serde(rename = "pullRequestId")]
    pull_request_id: i64,
    title: String,
    #[serde(default)]
    description: String,
    status: String,
    #[serde(rename = "isDraft", default)]
    is_draft: bool,
    #[serde(rename = "sourceRefName")]
    source_ref_name: String,
    #[serde(rename = "targetRefName")]
    target_ref_name: String,
    #[serde(rename = "createdBy")]
    created_by: RawIdentity,
    #[serde(rename = "creationDate")]
    creation_date: String,
    repository: RawRepoRef,
    /// Present on a single-PR read; the list endpoint omits it, hence the default.
    #[serde(default)]
    reviewers: Vec<RawReviewer>,
    /// The source branch's head as of the PR's last update — the commit a completion must name, so
    /// that a push landing between reading the PR and completing it is refused rather than merged
    /// unseen. Also the head the checks are about.
    #[serde(rename = "lastMergeSourceCommit", default)]
    last_merge_source_commit: Option<RawCommitRef>,
    /// Azure's test merge: `succeeded` · `conflicts` · `rejectedByPolicy` · `queued` · `failure` ·
    /// `notSet`.
    #[serde(rename = "mergeStatus", default)]
    merge_status: Option<String>,
}

fn strip_ref(r: &str) -> String {
    r.strip_prefix("refs/heads/").unwrap_or(r).to_string()
}

fn bucket_status(status: &str, is_draft: bool) -> String {
    match status {
        "completed" => "merged".to_string(),
        "abandoned" => "closed".to_string(),
        _ if is_draft => "draft".to_string(),
        _ => "open".to_string(),
    }
}

pub async fn list_projects(org: &str, pat: &str) -> Result<Vec<AdoProject>, String> {
    let org = encode_segment(&normalize_org(org));
    let url = format!("https://dev.azure.com/{org}/_apis/projects?api-version={API_VERSION}");
    let parsed: ListResponse<AdoProject> = get_json(&url, pat).await?;
    Ok(parsed.value)
}

pub async fn list_repos(org: &str, project: &str, pat: &str) -> Result<Vec<AdoRepo>, String> {
    let org = encode_segment(&normalize_org(org));
    let project = encode_segment(project);
    let url = format!("https://dev.azure.com/{org}/{project}/_apis/git/repositories?api-version={API_VERSION}");
    let parsed: ListResponse<AdoRepo> = get_json(&url, pat).await?;
    Ok(parsed.value)
}

/// Maps one raw Azure DevOps pull request onto the shared, provider-neutral summary the
/// frontend consumes. `org_enc` / `project_enc` are the already-percent-encoded path segments,
/// since they go straight into the PR's browser URL.
fn map_pull_request(org_enc: &str, project_enc: &str, pr: RawPullRequest) -> PullRequestSummary {
    PullRequestSummary {
        id: pr.pull_request_id,
        title: pr.title,
        description: pr.description,
        status: bucket_status(&pr.status, pr.is_draft),
        source_branch: strip_ref(&pr.source_ref_name),
        target_branch: strip_ref(&pr.target_ref_name),
        author: pr.created_by.display_name,
        created_at: pr.creation_date,
        url: format!(
            "https://dev.azure.com/{org_enc}/{project_enc}/_git/{}/pullrequest/{}",
            encode_segment(&pr.repository.name),
            pr.pull_request_id
        ),
        provider: "azure".to_string(),
    }
}

/// One page of the repository's pull requests, newest first.
///
/// Azure pages by `$top`/`$skip` and sends no "next" link, so one row more than a page is asked for:
/// whether it came back is whether another page exists, known rather than guessed from a full page.
/// Its `status` filter takes one value, so `Closed` asks for `all` and drops the active ones — see
/// [`PrListScope::admits`].
pub async fn list_pull_requests_page(
    org: &str,
    project: &str,
    repo_id: &str,
    scope: PrListScope,
    page: u32,
    pat: &str,
) -> Result<PrPage, String> {
    let org_enc = encode_segment(&normalize_org(org));
    let project_enc = encode_segment(project);
    let page = page.max(1);
    let status = match scope {
        PrListScope::Open => "active",
        PrListScope::Closed | PrListScope::All => "all",
    };
    let url = format!(
        "https://dev.azure.com/{org_enc}/{project_enc}/_apis/git/repositories/{}/pullrequests\
         ?searchCriteria.status={status}&$top={}&$skip={}&api-version={API_VERSION}",
        encode_segment(repo_id),
        PR_PAGE_SIZE + 1,
        (page - 1) * PR_PAGE_SIZE,
    );
    let parsed: ListResponse<RawPullRequest> = get_json(&url, pat).await?;
    Ok(page_of(parsed.value, scope, page, |pr| map_pull_request(&org_enc, &project_enc, pr)))
}

/// A page out of the `PR_PAGE_SIZE + 1` rows asked for — see [`list_pull_requests_page`].
fn page_of(
    raw: Vec<RawPullRequest>,
    scope: PrListScope,
    page: u32,
    map: impl Fn(RawPullRequest) -> PullRequestSummary,
) -> PrPage {
    let has_more = raw.len() > PR_PAGE_SIZE as usize;
    let items = raw
        .into_iter()
        .take(PR_PAGE_SIZE as usize)
        .map(map)
        .filter(|pr| scope.admits(&pr.status))
        .collect();
    PrPage { items, page, has_more }
}

/// One pull request as Azure sends it. `project` and `repo_id` may each be a name or a GUID.
async fn fetch_raw_pull_request(
    org: &str,
    project: &str,
    repo_id: &str,
    pr_id: i64,
    pat: &str,
) -> Result<RawPullRequest, String> {
    let org_enc = encode_segment(&normalize_org(org));
    let url = format!(
        "https://dev.azure.com/{org_enc}/{}/_apis/git/repositories/{}/pullRequests/{pr_id}\
         ?api-version={API_VERSION}",
        encode_segment(project),
        encode_segment(repo_id)
    );
    get_json(&url, pat).await
}

/// A single pull request plus the **names** Azure reports for the project and repository that own
/// it. A pasted link doesn't necessarily carry those: Azure's own notification e-mails link with
/// GUIDs (`/{org}/{projectGuid}/_git/{repoGuid}/pullrequest/{id}`), and matching a link against a
/// local clone's git remote — which only ever spells out names — needs the names.
pub struct AdoPullRequest {
    pub summary: PullRequestSummary,
    pub project_name: String,
    pub repo_name: String,
}

/// Fetches a single pull request by id. Unlike [`list_pull_requests_page`] this reaches a PR no
/// matter how far down the list it is — what a pasted link needs, and what a review needs too.
/// `project` and `repo_id` may each be a name or a GUID — Azure's Git REST API accepts either.
pub async fn get_pull_request(
    org: &str,
    project: &str,
    repo_id: &str,
    pr_id: i64,
    pat: &str,
) -> Result<AdoPullRequest, String> {
    let org_enc = encode_segment(&normalize_org(org));
    let raw = fetch_raw_pull_request(org, project, repo_id, pr_id, pat).await?;
    let repo_name = raw.repository.name.clone();
    let project_name = raw
        .repository
        .project
        .as_ref()
        .map(|p| p.name.clone())
        .unwrap_or_else(|| project.to_string());
    // The browser URL is built from the canonical name, so a PR reached through a GUID link
    // still gets a readable "view on Azure DevOps" address.
    let summary = map_pull_request(&org_enc, &encode_segment(&project_name), raw);
    Ok(AdoPullRequest { summary, project_name, repo_name })
}

/// Opens a pull request via `POST .../pullrequests`. Azure DevOps requires the branch names with
/// their full `refs/heads/` prefix (the inverse of [`strip_ref`]). Returns the created PR mapped
/// to the shared summary shape.
#[allow(clippy::too_many_arguments)]
pub async fn create_pull_request(
    org: &str,
    project: &str,
    repo_id: &str,
    title: &str,
    description: &str,
    source_branch: &str,
    target_branch: &str,
    draft: bool,
    work_item_ids: &[i64],
    pat: &str,
) -> Result<PullRequestSummary, String> {
    let org_enc = encode_segment(&normalize_org(org));
    let project_enc = encode_segment(project);
    let url = format!(
        "https://dev.azure.com/{org_enc}/{project_enc}/_apis/git/repositories/{repo_id}/pullrequests\
         ?api-version={API_VERSION}"
    );
    let body = serde_json::json!({
        "sourceRefName": format!("refs/heads/{source_branch}"),
        "targetRefName": format!("refs/heads/{target_branch}"),
        "title": title,
        "description": description,
        "isDraft": draft,
    });
    let res = client()
        .post(&url)
        .header("Authorization", auth_header(pat))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("couldn't reach Azure DevOps: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(describe_failure(status, &text));
    }
    let pr: RawPullRequest =
        res.json().await.map_err(|e| format!("unexpected response from Azure DevOps: {e}"))?;

    // Linked after the fact, and only now, because the artifact URL needs the project's GUID and
    // the pull request's own id — neither of which exists until the call above has returned. See
    // `link_work_items` for why `workItemRefs` on the create body is not the answer.
    if !work_item_ids.is_empty() {
        let project_id = pr
            .repository
            .project
            .as_ref()
            .map(|project| project.id.clone())
            .unwrap_or_default();
        if !project_id.is_empty() {
            let failures =
                link_work_items(org, &project_id, repo_id, pr.pull_request_id, work_item_ids, pat)
                    .await;
            // Logged, never returned as an error: the pull request exists and the caller must be
            // told so. A failed link is a missing link on a real PR, not a failed PR — and turning
            // it into an `Err` here would leave the user believing nothing was created while their
            // branch already had an open pull request against it.
            if !failures.is_empty() {
                crate::applog::warn(&format!(
                    "pull request {} created, but these work items could not be linked: {}",
                    pr.pull_request_id,
                    failures.join(", ")
                ));
            }
        }
    }

    Ok(map_pull_request(&org_enc, &project_enc, pr))
}

/// One work item, as the picker shows it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkItem {
    pub id: i64,
    pub title: String,
    /// `Bug`, `User Story`, `Task`, … — whatever this project's process template calls it.
    pub work_item_type: String,
    pub state: String,
    pub assigned_to: Option<String>,
}

#[derive(Deserialize)]
struct RawWiqlRef {
    id: i64,
}

#[derive(Deserialize)]
struct RawWiqlResult {
    #[serde(rename = "workItems", default)]
    work_items: Vec<RawWiqlRef>,
}

#[derive(Deserialize)]
struct RawWorkItem {
    id: i64,
    #[serde(default)]
    fields: serde_json::Value,
}

/// How many work items a search will pull back. A picker is for recognising the one you meant, not
/// for browsing a backlog — past a screenful the answer is a better query, not more rows.
const MAX_WORK_ITEMS: usize = 50;

/// Searches a project's work items by id or by text in the title.
///
/// Two round trips, because Azure splits the question in half: WIQL answers *which* ids match and
/// returns nothing else about them, so the fields the picker draws take a second, batched read.
///
/// A query that is just digits is treated as an id first and a title search second, joined with
/// `OR` — typing `391974` should find work item 391974 whether or not its title contains the
/// number, and that is overwhelmingly what a number typed into this box means.
pub async fn search_work_items(
    org: &str,
    project: &str,
    query: &str,
    pat: &str,
) -> Result<Vec<WorkItem>, String> {
    let org_enc = encode_segment(&normalize_org(org));
    let project_enc = encode_segment(project);
    let trimmed = query.trim();

    // Single-quote is the escape in WIQL, exactly as in SQL. Without this a title containing an
    // apostrophe would end the string literal and the query would be rejected — or worse.
    let escaped = trimmed.replace('\'', "''");
    let mut clauses: Vec<String> = vec![];
    if let Ok(id) = trimmed.parse::<i64>() {
        clauses.push(format!("[System.Id] = {id}"));
    }
    if !trimmed.is_empty() {
        clauses.push(format!("[System.Title] CONTAINS '{escaped}'"));
    }
    // An empty box asks for something useful rather than for everything: what is assigned to you
    // and still open is the list you want before you have typed anything.
    let where_clause = if clauses.is_empty() {
        "[System.AssignedTo] = @Me AND [System.State] NOT IN ('Closed', 'Removed', 'Done')".to_string()
    } else {
        clauses.join(" OR ")
    };
    let wiql = format!(
        "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @Project AND ({where_clause}) \
         ORDER BY [System.ChangedDate] DESC"
    );

    let url = format!(
        "https://dev.azure.com/{org_enc}/{project_enc}/_apis/wit/wiql?api-version={API_VERSION}"
    );
    let res = client()
        .post(&url)
        .header("Authorization", auth_header(pat))
        .json(&serde_json::json!({ "query": wiql }))
        .send()
        .await
        .map_err(|e| format!("couldn't reach Azure DevOps: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_default();
        return Err(describe_failure(status, &text));
    }
    let found: RawWiqlResult =
        res.json().await.map_err(|e| format!("unexpected response from Azure DevOps: {e}"))?;

    let ids: Vec<String> = found
        .work_items
        .iter()
        .take(MAX_WORK_ITEMS)
        .map(|item| item.id.to_string())
        .collect();
    if ids.is_empty() {
        return Ok(vec![]);
    }

    // Organisation-scoped, not project-scoped: the batch endpoint takes ids across the whole
    // account, and the ids came from a project-scoped query so they are already the right ones.
    let fields = "System.Id,System.Title,System.WorkItemType,System.State,System.AssignedTo";
    let detail_url = format!(
        "https://dev.azure.com/{org_enc}/_apis/wit/workitems?ids={}&fields={fields}\
         &$expand=none&errorPolicy=omit&api-version={API_VERSION}",
        ids.join(",")
    );
    let parsed: ListResponse<RawWorkItem> = get_json(&detail_url, pat).await?;

    let text = |value: &serde_json::Value, key: &str| -> String {
        value.get(key).and_then(|v| v.as_str()).unwrap_or_default().to_string()
    };
    Ok(parsed
        .value
        .into_iter()
        .map(|item| WorkItem {
            id: item.id,
            title: text(&item.fields, "System.Title"),
            work_item_type: text(&item.fields, "System.WorkItemType"),
            state: text(&item.fields, "System.State"),
            // `System.AssignedTo` is an identity object, not a string, and is absent when nobody
            // is assigned — which is ordinary rather than an error.
            assigned_to: item
                .fields
                .get("System.AssignedTo")
                .and_then(|v| v.get("displayName"))
                .and_then(|v| v.as_str())
                .map(str::to_string),
        })
        .collect())
}

/// Links work items to a pull request, one JSON-Patch per item.
///
/// **Done after the PR exists, not as a field on the create body.** Azure's `GitPullRequest` model
/// does carry `workItemRefs`, but it is documented as read-only on create and is quietly ignored by
/// the service — a PR created "with" work items comes back with none. The relation actually lives
/// on the *work item*, as an `ArtifactLink` pointing at a `vstfs:///Git/PullRequestId/...` URL, so
/// that is what this writes.
///
/// The artifact URL addresses the project by **GUID**, which is why the caller has to read it off
/// the created PR's own `repository.project.id` rather than reusing the project name it was given.
///
/// Failures are collected per item rather than returned on the first one: the pull request has
/// already been created by the time this runs, and a link that failed must never be reported in a
/// way that reads as "the PR failed".
pub async fn link_work_items(
    org: &str,
    project_id: &str,
    repo_id: &str,
    pr_id: i64,
    work_item_ids: &[i64],
    pat: &str,
) -> Vec<String> {
    let org_enc = encode_segment(&normalize_org(org));
    // The separators are part of the value, so they are encoded — Azure stores this string whole.
    let artifact = format!("vstfs:///Git/PullRequestId/{project_id}%2F{repo_id}%2F{pr_id}");
    let mut failures = vec![];
    for id in work_item_ids {
        let url = format!(
            "https://dev.azure.com/{org_enc}/_apis/wit/workitems/{id}?api-version={API_VERSION}"
        );
        let patch = serde_json::json!([{
            "op": "add",
            "path": "/relations/-",
            "value": {
                "rel": "ArtifactLink",
                "url": artifact,
                "attributes": { "name": "Pull Request" }
            }
        }]);
        let sent = client()
            .patch(&url)
            .header("Authorization", auth_header(pat))
            // Not `application/json`: the work-item update endpoint only accepts JSON-Patch, and
            // sending the wrong content type is a 400 that says nothing useful.
            .header("Content-Type", "application/json-patch+json")
            .body(patch.to_string())
            .send()
            .await;
        match sent {
            Ok(res) if res.status().is_success() => {}
            Ok(res) => {
                let status = res.status();
                failures.push(format!("#{id}: {status}"));
            }
            Err(e) => failures.push(format!("#{id}: {e}")),
        }
    }
    failures
}

#[derive(Deserialize)]
struct RawIteration {
    id: i64,
}

/// The most recent iteration id for this PR — anchoring a comment to a file/line requires
/// telling Azure DevOps which iteration's diff the line numbers refer to
/// (`pullRequestThreadContext.iterationContext`). Falls back to `1` for a PR with no
/// iterations reported (shouldn't happen for a real PR, but a comment landing on iteration 1
/// beats the whole review failing to post).
async fn get_latest_iteration_id(org: &str, project: &str, repo_id: &str, pr_id: i64, pat: &str) -> Result<i64, String> {
    let org = encode_segment(&normalize_org(org));
    let project = encode_segment(project);
    let url = format!(
        "https://dev.azure.com/{org}/{project}/_apis/git/repositories/{repo_id}/pullRequests/{pr_id}/iterations\
         ?api-version={API_VERSION}"
    );
    let parsed: ListResponse<RawIteration> = get_json(&url, pat).await?;
    Ok(parsed.value.last().map(|i| i.id).unwrap_or(1))
}

/// Azure caps how much of a pull request is worth pulling over the wire one blob at a time —
/// past this the review's own diff truncation would drop the tail anyway.
const MAX_DIFF_FILES: usize = 80;
/// Blobs bigger than this are almost always generated or binary; their content would swamp the
/// diff without telling a reviewer anything.
const MAX_BLOB_BYTES: usize = 512 * 1024;
/// The all-zero object id Azure uses for "this side doesn't exist" (an add's original, a
/// delete's current).
const NULL_OBJECT_ID: &str = "0000000000000000000000000000000000000000";

#[derive(Deserialize)]
struct RawChangeItem {
    #[serde(default)]
    path: Option<String>,
    #[serde(rename = "objectId", default)]
    object_id: Option<String>,
    #[serde(rename = "originalObjectId", default)]
    original_object_id: Option<String>,
    #[serde(rename = "isFolder", default)]
    is_folder: bool,
}

#[derive(Deserialize)]
struct RawChangeEntry {
    #[serde(rename = "changeType", default)]
    change_type: String,
    #[serde(default)]
    item: Option<RawChangeItem>,
}

#[derive(Deserialize)]
struct ChangesResponse {
    #[serde(rename = "changeEntries", default)]
    change_entries: Vec<RawChangeEntry>,
}

/// Reads one blob's raw bytes. Azure serves file content by object id, which is exactly what the
/// change list hands us for each side of a change.
async fn get_blob(org_enc: &str, project_enc: &str, repo_enc: &str, sha: &str, pat: &str) -> Result<Vec<u8>, String> {
    let url = format!(
        "https://dev.azure.com/{org_enc}/{project_enc}/_apis/git/repositories/{repo_enc}/blobs/{sha}\
         ?api-version={API_VERSION}"
    );
    let res = client()
        .get(&url)
        .header("Authorization", auth_header(pat))
        .header("Accept", "application/octet-stream")
        .send()
        .await
        .map_err(|e| format!("couldn't reach Azure DevOps: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        return Err(format!("Azure DevOps returned {status} reading a file"));
    }
    Ok(res.bytes().await.map_err(|e| e.to_string())?.to_vec())
}

/// Turns two versions of a file into a unified diff. Azure has no endpoint that returns a
/// pull request's diff as text, so it's rendered here with the same library the rest of the app
/// diffs with (libgit2), which produces byte-for-byte what `git diff` would.
fn unified_patch(path: &str, old: &[u8], new: &[u8]) -> Option<String> {
    let as_path = std::path::Path::new(path);
    let mut patch = git2::Patch::from_buffers(old, Some(as_path), new, Some(as_path), None).ok()?;
    let buf = patch.to_buf().ok()?;
    buf.as_str().map(str::to_string)
}

/// The pull request's diff, assembled from Azure's per-file change list — the equivalent of
/// GitHub's single `Accept: application/vnd.github.diff` request, which Azure has no counterpart
/// for. This is what lets a PR be reviewed from nothing but its link, with no clone on disk.
///
/// Files are fetched a few at a time rather than all at once (each one is two requests, old side
/// and new side) so a large pull request doesn't open a hundred concurrent connections.
pub async fn pull_request_diff(
    org: &str,
    project: &str,
    repo_id: &str,
    pr_id: i64,
    pat: &str,
) -> Result<String, String> {
    use futures_util::StreamExt;

    let iteration_id = get_latest_iteration_id(org, project, repo_id, pr_id, pat).await?;
    let org_enc = encode_segment(&normalize_org(org));
    let project_enc = encode_segment(project);
    let repo_enc = encode_segment(repo_id);
    // No `$compareTo`, so the changes are measured against the base — the whole pull request,
    // not just what the last push added.
    let url = format!(
        "https://dev.azure.com/{org_enc}/{project_enc}/_apis/git/repositories/{repo_enc}/pullRequests/{pr_id}\
         /iterations/{iteration_id}/changes?$top=1000&api-version={API_VERSION}"
    );
    let changes: ChangesResponse = get_json(&url, pat).await?;

    let files: Vec<(String, String, Option<String>, Option<String>)> = changes
        .change_entries
        .into_iter()
        .filter_map(|entry| {
            let item = entry.item?;
            if item.is_folder {
                return None;
            }
            // Azure paths are absolute within the repo ("/src/x.ts"); findings have to cite the
            // repo-relative path, which is also what the diff headers should carry.
            let path = item.path?.trim_start_matches('/').to_string();
            if path.is_empty() {
                return None;
            }
            let usable = |id: Option<String>| id.filter(|s| !s.is_empty() && s != NULL_OBJECT_ID);
            let change = entry.change_type.to_ascii_lowercase();
            let new_id = if change.contains("delete") { None } else { usable(item.object_id) };
            let old_id = if change.contains("add") { None } else { usable(item.original_object_id) };
            Some((path, change, old_id, new_id))
        })
        .collect();

    let total = files.len();
    let truncated = total > MAX_DIFF_FILES;
    let mut out = String::new();

    let sections: Vec<String> = futures_util::stream::iter(files.into_iter().take(MAX_DIFF_FILES).map(
        |(path, change, old_id, new_id)| {
            let (org_enc, project_enc, repo_enc) = (org_enc.clone(), project_enc.clone(), repo_enc.clone());
            async move {
                let side = |id: Option<String>| {
                    let (org_enc, project_enc, repo_enc) = (org_enc.clone(), project_enc.clone(), repo_enc.clone());
                    async move {
                        match id {
                            None => Ok(Vec::new()),
                            Some(sha) => get_blob(&org_enc, &project_enc, &repo_enc, &sha, pat).await,
                        }
                    }
                };
                let old = side(old_id).await;
                let new = side(new_id).await;
                let (Ok(old), Ok(new)) = (old, new) else {
                    return format!("diff --git a/{path} b/{path}\n(couldn't read this file from Azure DevOps)\n");
                };
                if old.len() > MAX_BLOB_BYTES || new.len() > MAX_BLOB_BYTES {
                    return format!("diff --git a/{path} b/{path}\n({change}, too large to display)\n");
                }
                unified_patch(&path, &old, &new)
                    .unwrap_or_else(|| format!("diff --git a/{path} b/{path}\n({change}, binary)\n"))
            }
        },
    ))
    .buffered(6)
    .collect()
    .await;

    for section in sections {
        out.push_str(&section);
        if !out.ends_with('\n') {
            out.push('\n');
        }
    }

    if out.trim().is_empty() {
        return Err("This pull request has no file changes to review".to_string());
    }
    if truncated {
        out.push_str(&format!(
            "\n(only the first {MAX_DIFF_FILES} of {total} changed files are included)\n"
        ));
    }
    Ok(out)
}

/// Posts a comment thread anchored to a specific file and line range on the PR's latest
/// iteration — this is what makes the comment show up attached to the actual diff hunk
/// (like `debe-ser.png`) instead of as a general PR-level remark.
#[allow(clippy::too_many_arguments)]
#[derive(Deserialize)]
struct ThreadCreated {
    id: i64,
}

/// Posts a file-anchored comment thread and returns its **thread id** — kept so a later re-review
/// can reply to (or resolve) the same thread instead of opening a duplicate.
#[allow(clippy::too_many_arguments)]
pub async fn post_pr_comment_anchored(
    org: &str,
    project: &str,
    repo_id: &str,
    pr_id: i64,
    content: &str,
    file_path: &str,
    start_line: i64,
    end_line: i64,
    pat: &str,
) -> Result<i64, String> {
    let iteration_id = get_latest_iteration_id(org, project, repo_id, pr_id, pat).await?;
    let org_enc = encode_segment(&normalize_org(org));
    let project_enc = encode_segment(project);
    let url = format!(
        "https://dev.azure.com/{org_enc}/{project_enc}/_apis/git/repositories/{repo_id}/pullRequests/{pr_id}/threads\
         ?api-version={API_VERSION}"
    );
    let normalized_path = if file_path.starts_with('/') { file_path.to_string() } else { format!("/{file_path}") };
    let body = serde_json::json!({
        "comments": [{ "parentCommentId": 0, "content": content, "commentType": 1 }],
        "status": 1,
        "threadContext": {
            "filePath": normalized_path,
            "rightFileStart": { "line": start_line, "offset": 1 },
            "rightFileEnd": { "line": end_line.max(start_line), "offset": 1 },
        },
        "pullRequestThreadContext": {
            "iterationContext": { "firstComparingIteration": 1, "secondComparingIteration": iteration_id },
        },
    });
    post_thread(&url, &body, pat).await
}

/// Posts a general (non-file-anchored) comment thread on the PR — used for the summary
/// comment and as a fallback for any finding whose location couldn't be parsed. Returns the id.
pub async fn post_pr_comment(
    org: &str,
    project: &str,
    repo_id: &str,
    pr_id: i64,
    content: &str,
    pat: &str,
) -> Result<i64, String> {
    let org = encode_segment(&normalize_org(org));
    let project = encode_segment(project);
    let url = format!(
        "https://dev.azure.com/{org}/{project}/_apis/git/repositories/{repo_id}/pullRequests/{pr_id}/threads\
         ?api-version={API_VERSION}"
    );
    let body = serde_json::json!({
        "comments": [{ "parentCommentId": 0, "content": content, "commentType": 1 }],
        "status": 1,
    });
    post_thread(&url, &body, pat).await
}

/// Shared POST for both thread flavors — returns the created thread's id.
async fn post_thread(url: &str, body: &serde_json::Value, pat: &str) -> Result<i64, String> {
    let res = client()
        .post(url)
        .header("Authorization", auth_header(pat))
        .json(body)
        .send()
        .await
        .map_err(|e| format!("couldn't reach Azure DevOps: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(describe_failure(status, &body));
    }
    let created: ThreadCreated = res.json().await.map_err(|e| format!("couldn't read Azure DevOps response: {e}"))?;
    Ok(created.id)
}

/// Adds a follow-up comment (reply) to an existing thread — used on re-review so a persisting or
/// resolved finding gets a note on its own thread rather than a duplicate.
pub async fn reply_pr_thread(
    org: &str,
    project: &str,
    repo_id: &str,
    pr_id: i64,
    thread_id: i64,
    content: &str,
    pat: &str,
) -> Result<(), String> {
    let org = encode_segment(&normalize_org(org));
    let project = encode_segment(project);
    let url = format!(
        "https://dev.azure.com/{org}/{project}/_apis/git/repositories/{repo_id}/pullRequests/{pr_id}/threads/{thread_id}/comments\
         ?api-version={API_VERSION}"
    );
    let body = serde_json::json!({ "parentCommentId": 1, "content": content, "commentType": 1 });
    let res = client()
        .post(&url)
        .header("Authorization", auth_header(pat))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("couldn't reach Azure DevOps: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(describe_failure(status, &body));
    }
    Ok(())
}

/// Sets a thread's status. Azure's thread status ints: 1=active, 2=fixed, 3=wontFix, 4=closed,
/// 5=byDesign, 6=pending. A resolved finding's thread is marked `2` (fixed).
pub async fn set_pr_thread_status(
    org: &str,
    project: &str,
    repo_id: &str,
    pr_id: i64,
    thread_id: i64,
    status: i32,
    pat: &str,
) -> Result<(), String> {
    let org = encode_segment(&normalize_org(org));
    let project = encode_segment(project);
    let url = format!(
        "https://dev.azure.com/{org}/{project}/_apis/git/repositories/{repo_id}/pullRequests/{pr_id}/threads/{thread_id}\
         ?api-version={API_VERSION}"
    );
    let body = serde_json::json!({ "status": status });
    let res = client()
        .patch(&url)
        .header("Authorization", auth_header(pat))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("couldn't reach Azure DevOps: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(describe_failure(status, &body));
    }
    Ok(())
}

#[derive(Deserialize)]
struct ConnectionData {
    #[serde(rename = "authenticatedUser")]
    authenticated_user: RawConnectionUser,
}

#[derive(Deserialize)]
struct RawConnectionUser {
    id: String,
    /// How this user is named on the comments they write. Optional because the field an account
    /// answers with varies (a custom display name overrides the provider's), and nothing here is
    /// worth failing a call over.
    #[serde(rename = "providerDisplayName", default)]
    provider_display_name: Option<String>,
    #[serde(rename = "customDisplayName", default)]
    custom_display_name: Option<String>,
    /// The loose bag Azure puts the sign-in address in, as `Account: {"$type": …, "$value": …}`.
    /// Untyped because the rest of the bag varies by account kind and none of it is wanted.
    #[serde(default)]
    properties: std::collections::HashMap<String, serde_json::Value>,
}

/// The signed-in user's Azure DevOps id (a GUID), needed to cast a reviewer vote — Azure votes
/// are keyed by reviewer id, not inferred from the token like GitHub's reviews are. Read from the
/// org-scoped `connectionData` endpoint.
async fn authenticated_user_id(org: &str, pat: &str) -> Result<String, String> {
    Ok(connection_data(org, pat).await?.authenticated_user.id)
}

/// The signed-in user as their comments name them — the counterpart of GitHub's login, and what
/// lets a caller tell "someone commented on this PR" apart from "this app commented on it for me".
/// Prefers the custom display name, since that is the one Azure shows when it is set.
pub async fn authenticated_user_name(org: &str, pat: &str) -> Result<String, String> {
    let user = connection_data(org, pat).await?.authenticated_user;
    user.custom_display_name
        .or(user.provider_display_name)
        .filter(|name| !name.trim().is_empty())
        .ok_or_else(|| "Azure DevOps didn't report a display name for this account".to_string())
}

/// The signed-in user in the shape `System.AssignedTo` can resolve back to a person.
///
/// Azure resolves that field from a string, and which strings it accepts is not uniform: a display
/// name alone is ambiguous the moment two people in the org share one, and an account name alone
/// is what a Microsoft-account org has instead of a directory address. `Display Name <account>` is
/// the form Azure itself hands back when you *read* the field, so it is the one form the server is
/// certain to understand — the halves are only used alone when the account reports just the one.
///
/// Used to assign what this app creates to whoever the token belongs to; see
/// [`crate::boards::azure::create_work_item`].
pub async fn authenticated_identity(org: &str, pat: &str) -> Result<String, String> {
    let user = connection_data(org, pat).await?.authenticated_user;
    let name = user
        .custom_display_name
        .or(user.provider_display_name)
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty());
    let account = user
        .properties
        .get("Account")
        .and_then(|account| account.get("$value"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|account| !account.is_empty());

    match (name, account) {
        (Some(name), Some(account)) => Ok(format!("{name} <{account}>")),
        (Some(name), None) => Ok(name),
        (None, Some(account)) => Ok(account.to_string()),
        (None, None) => Err("Azure DevOps didn't report who this token belongs to".to_string()),
    }
}

async fn connection_data(org: &str, pat: &str) -> Result<ConnectionData, String> {
    let org = encode_segment(&normalize_org(org));
    let url = format!("https://dev.azure.com/{org}/_apis/connectionData?api-version={PREVIEW_API_VERSION}");
    get_json(&url, pat).await
}

/// Casts the current user's review vote on a PR. Azure's reviewer vote: `10` = approve,
/// `-10` = reject (also `5`/`0`/`-5` for approve-with-suggestions/reset/waiting). PUT-ing to
/// `reviewers/{id}` adds the user as a reviewer if they aren't one yet, so this works whether or
/// not they were already assigned. Fetches the user's id first.
pub async fn set_reviewer_vote(
    org: &str,
    project: &str,
    repo_id: &str,
    pr_id: i64,
    vote: i32,
    pat: &str,
) -> Result<(), String> {
    let user_id = authenticated_user_id(org, pat).await?;
    let org = encode_segment(&normalize_org(org));
    let project = encode_segment(project);
    let url = format!(
        "https://dev.azure.com/{org}/{project}/_apis/git/repositories/{repo_id}/pullRequests/{pr_id}/reviewers/{user_id}\
         ?api-version={API_VERSION}"
    );
    let body = serde_json::json!({ "vote": vote });
    let res = client()
        .put(&url)
        .header("Authorization", auth_header(pat))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("couldn't reach Azure DevOps: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(describe_failure(status, &body));
    }
    Ok(())
}

/// Which decision the signed-in user has already recorded on this pull request, so the app can
/// show it and stop offering a decision that's already been made. Azure keeps it as the user's own
/// entry in the PR's reviewer list: `10` approved, `5` approved with suggestions, `-5` waiting for
/// the author, `-10` rejected, `0` no vote yet. Read from the host rather than remembered locally,
/// since the vote may well have been cast on the website.
pub async fn viewer_decision(
    org: &str,
    project: &str,
    repo_id: &str,
    pr_id: i64,
    pat: &str,
) -> Result<String, String> {
    let user_id = authenticated_user_id(org, pat).await?;
    let pr = fetch_raw_pull_request(org, project, repo_id, pr_id, pat).await?;
    let vote = pr
        .reviewers
        .iter()
        .find(|r| r.id.eq_ignore_ascii_case(&user_id))
        .map(|r| r.vote)
        .unwrap_or(0);
    Ok(match vote {
        v if v > 0 => "approved",
        v if v < 0 => "changes_requested",
        _ => "none",
    }
    .to_string())
}

/// Abandons the PR — Azure DevOps' equivalent of closing without merging.
pub async fn abandon_pull_request(
    org: &str,
    project: &str,
    repo_id: &str,
    pr_id: i64,
    pat: &str,
) -> Result<(), String> {
    let org = encode_segment(&normalize_org(org));
    let project = encode_segment(project);
    let url = format!(
        "https://dev.azure.com/{org}/{project}/_apis/git/repositories/{repo_id}/pullRequests/{pr_id}\
         ?api-version={API_VERSION}"
    );
    let body = serde_json::json!({ "status": "abandoned" });
    let res = client()
        .patch(&url)
        .header("Authorization", auth_header(pat))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("couldn't reach Azure DevOps: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(describe_failure(status, &body));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Completing (merging)
// ---------------------------------------------------------------------------

/// Azure's "Limit merge types" branch policy — the one place a repository says which strategies a
/// completion may use.
const LIMIT_MERGE_TYPES_POLICY: &str = "fa4e907d-c16b-4a4c-9dfa-4916e5d171ab";

/// Every strategy Azure has, in the order its own completion dialog lists them.
const AZURE_METHODS: [&str; 4] = ["merge", "squash", "rebase", "rebase_merge"];

/// Azure's name for one of [`MergeOptions::methods`].
fn azure_merge_strategy(method: &str) -> Option<&'static str> {
    match method {
        "merge" => Some("noFastForward"),
        "squash" => Some("squash"),
        "rebase" => Some("rebase"),
        "rebase_merge" => Some("rebaseMerge"),
        _ => None,
    }
}

/// Azure's error body is `{"message": …, "typeKey": …}`; the message is the part worth showing.
fn azure_error_message(body: &str) -> String {
    serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(str::to_string))
        .unwrap_or_else(|| body.chars().take(300).collect())
}

#[derive(Deserialize)]
struct RawPolicyType {
    #[serde(default)]
    id: String,
    #[serde(rename = "displayName", default)]
    display_name: String,
}

#[derive(Deserialize)]
struct RawPolicyConfiguration {
    #[serde(rename = "isEnabled", default)]
    is_enabled: bool,
    #[serde(rename = "isBlocking", default)]
    is_blocking: bool,
    #[serde(rename = "type", default)]
    kind: Option<RawPolicyType>,
    #[serde(default)]
    settings: serde_json::Value,
}

/// The strategies the "Limit merge types" policies on a branch leave open, or `None` when no such
/// policy is enabled there — every strategy is then allowed, which is known rather than assumed.
///
/// Two policies on one branch (a repository-wide one and a branch one) both have to allow a strategy
/// for a completion to use it. A policy written before the four switches existed carries only the
/// old `useSquashMerge`, which meant "squash, and nothing else".
fn allowed_by_merge_type_policies(configs: &[RawPolicyConfiguration]) -> Option<Vec<String>> {
    let limiting: Vec<&RawPolicyConfiguration> = configs
        .iter()
        .filter(|c| {
            c.is_enabled && c.kind.as_ref().is_some_and(|k| k.id.eq_ignore_ascii_case(LIMIT_MERGE_TYPES_POLICY))
        })
        .collect();
    if limiting.is_empty() {
        return None;
    }
    const SWITCHES: [(&str, &str); 4] = [
        ("merge", "allowNoFastForward"),
        ("squash", "allowSquash"),
        ("rebase", "allowRebase"),
        ("rebase_merge", "allowRebaseMerge"),
    ];
    let allows = |c: &RawPolicyConfiguration, method: &str, key: &str| {
        if SWITCHES.iter().any(|(_, k)| c.settings.get(k).is_some()) {
            c.settings.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
        } else {
            let squash_only = c.settings.get("useSquashMerge").and_then(|v| v.as_bool()).unwrap_or(false);
            !squash_only || method == "squash"
        }
    };
    Some(
        SWITCHES
            .iter()
            .filter(|(method, key)| limiting.iter().all(|c| allows(c, method, key)))
            .map(|(method, _)| method.to_string())
            .collect(),
    )
}

/// What Azure says about completing the pull request right now. Its `mergeStatus` is the test merge
/// only — conflicts or not; the policies that can still block completion are the checks list's to
/// show (see [`pr_checks`]).
fn azure_readiness(status: &str, is_draft: bool, merge_status: Option<&str>) -> &'static str {
    if status != "active" {
        return "closed";
    }
    if is_draft {
        return "draft";
    }
    match merge_status.unwrap_or_default() {
        "succeeded" => "clean",
        "conflicts" => "conflicts",
        "rejectedByPolicy" => "blocked",
        _ => "unknown",
    }
}

/// The branch policies configured on `ref_name` of a repository, which Azure only answers by GUID.
async fn branch_policies(
    org: &str,
    project: &str,
    repo_guid: &str,
    ref_name: &str,
    pat: &str,
) -> Result<Vec<RawPolicyConfiguration>, String> {
    let url = format!(
        "https://dev.azure.com/{}/{}/_apis/git/policy/configurations?repositoryId={}&refName={}\
         &policyType={LIMIT_MERGE_TYPES_POLICY}&api-version={API_VERSION}",
        encode_segment(&normalize_org(org)),
        encode_segment(project),
        encode_segment(repo_guid),
        encode_segment(ref_name),
    );
    let parsed: ListResponse<RawPolicyConfiguration> = get_json(&url, pat).await?;
    Ok(parsed.value)
}

/// How this pull request can be completed: the strategies the target branch's policies allow, and
/// whether Azure's test merge found conflicts.
pub async fn merge_options(
    org: &str,
    project: &str,
    repo_id: &str,
    pr_id: i64,
    pat: &str,
) -> Result<MergeOptions, String> {
    let pr = fetch_raw_pull_request(org, project, repo_id, pr_id, pat).await?;
    let limited = if pr.repository.id.is_empty() {
        Err(())
    } else {
        branch_policies(org, project, &pr.repository.id, &pr.target_ref_name, pat)
            .await
            .map(|configs| allowed_by_merge_type_policies(&configs))
            .map_err(|_| ())
    };
    let everything = || AZURE_METHODS.iter().map(|m| m.to_string()).collect::<Vec<_>>();
    let (methods, methods_known) = match limited {
        Ok(None) => (everything(), true),
        Ok(Some(allowed)) if !allowed.is_empty() => (allowed, true),
        // Unreadable, or a policy that allows nothing at all: offer everything and let Azure say no.
        _ => (everything(), false),
    };
    Ok(MergeOptions {
        default_method: methods.first().cloned(),
        methods,
        methods_known,
        squash: None,
        can_delete_source_branch: true,
        delete_source_branch_default: false,
        // Azure's own completion dialog has it on.
        transition_work_items: Some(true),
        readiness: azure_readiness(&pr.status, pr.is_draft, pr.merge_status.as_deref()).to_string(),
        readiness_detail: pr.merge_status.clone(),
    })
}

/// A completion that Azure accepted.
pub struct Completion {
    pub summary: PullRequestSummary,
    /// True once Azure reports the pull request completed. Completion runs in the background there,
    /// so a `false` means requested and still merging — not refused, which is an `Err`.
    pub merged: bool,
}

/// Completes (merges) the pull request.
///
/// `lastMergeSourceCommit` is required and is what keeps this honest: it names the head the user
/// looked at, so a push landing in between is refused as stale rather than merged unseen. Branch
/// policies are never bypassed from here.
#[allow(clippy::too_many_arguments)]
pub async fn complete_pull_request(
    org: &str,
    project: &str,
    repo_id: &str,
    pr_id: i64,
    method: &str,
    delete_source_branch: bool,
    transition_work_items: bool,
    pat: &str,
) -> Result<Completion, String> {
    let strategy = azure_merge_strategy(method).ok_or_else(|| format!("unknown merge strategy: {method}"))?;
    let pr = fetch_raw_pull_request(org, project, repo_id, pr_id, pat).await?;
    if pr.status != "active" {
        return Err(merge_refusal("other", "This pull request is no longer active"));
    }
    let head = pr
        .last_merge_source_commit
        .as_ref()
        .map(|c| c.commit_id.clone())
        .filter(|c| !c.is_empty())
        .ok_or_else(|| "Azure DevOps didn't report the pull request's head commit".to_string())?;

    let org_enc = encode_segment(&normalize_org(org));
    let project_enc = encode_segment(project);
    let url = format!(
        "https://dev.azure.com/{org_enc}/{project_enc}/_apis/git/repositories/{}/pullRequests/{pr_id}\
         ?api-version={API_VERSION}",
        encode_segment(repo_id)
    );
    let body = serde_json::json!({
        "status": "completed",
        "lastMergeSourceCommit": { "commitId": head },
        "completionOptions": {
            "mergeStrategy": strategy,
            "deleteSourceBranch": delete_source_branch,
            "transitionWorkItems": transition_work_items,
            "bypassPolicy": false,
        },
    });
    let res = client()
        .patch(&url)
        .header("Authorization", auth_header(pat))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("couldn't reach Azure DevOps: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let message = azure_error_message(&res.text().await.unwrap_or_default());
        return Err(merge_refusal(classify_merge_refusal(status.as_u16(), &message), &message));
    }
    let mut latest: RawPullRequest =
        res.json().await.map_err(|e| format!("unexpected response from Azure DevOps: {e}"))?;

    // The answer to the PATCH is usually still `active`, with the merge queued behind it. A few short
    // re-reads settle whether it went through or ran into a conflict; past that it is reported as
    // requested, which is exactly what it is.
    for _ in 0..4 {
        if latest.status == "completed" || latest.merge_status.as_deref() == Some("conflicts") {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        latest = fetch_raw_pull_request(org, project, repo_id, pr_id, pat).await?;
    }
    if latest.status != "completed" && latest.merge_status.as_deref() == Some("conflicts") {
        return Err(merge_refusal("conflicts", "Azure DevOps found conflicts while merging"));
    }
    let merged = latest.status == "completed";
    Ok(Completion { summary: map_pull_request(&org_enc, &project_enc, latest), merged })
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct RawStatusContext {
    #[serde(default)]
    name: String,
    #[serde(default)]
    genre: Option<String>,
}

#[derive(Deserialize)]
struct RawPrStatus {
    #[serde(default)]
    id: i64,
    #[serde(default)]
    state: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    context: Option<RawStatusContext>,
    #[serde(rename = "targetUrl", default)]
    target_url: Option<String>,
}

#[derive(Deserialize)]
struct RawPolicyEvaluation {
    #[serde(default)]
    status: String,
    #[serde(default)]
    configuration: Option<RawPolicyConfiguration>,
    /// Free-form per policy type — a build policy puts its `buildId` here.
    #[serde(default)]
    context: Option<serde_json::Value>,
}

/// The build id in an Azure build results address (`…/_build/results?buildId=123`) — the id the
/// Pipelines tab knows the run by.
fn build_id_in(url: &str) -> Option<String> {
    let at = url.find("buildId=")? + "buildId=".len();
    let digits: String = url[at..].chars().take_while(|c| c.is_ascii_digit()).collect();
    (!digits.is_empty()).then_some(digits)
}

fn status_state(state: &str) -> &'static str {
    use crate::ci::status;
    match state {
        "succeeded" => status::SUCCESS,
        "failed" | "error" => status::FAILED,
        "pending" => status::RUNNING,
        "notApplicable" => status::SKIPPED,
        _ => status::QUEUED,
    }
}

fn policy_state(state: &str) -> &'static str {
    use crate::ci::status;
    match state {
        "approved" => status::SUCCESS,
        "rejected" | "broken" => status::FAILED,
        "running" => status::RUNNING,
        "notApplicable" => status::SKIPPED,
        _ => status::QUEUED,
    }
}

/// Branch-policy evaluations as checks, blocking ones first. `results_url` turns a build id into
/// the address of its results page.
fn map_policy_evaluations(evaluations: Vec<RawPolicyEvaluation>, results_url: impl Fn(&str) -> String) -> Vec<PrCheck> {
    let mut checks: Vec<PrCheck> = evaluations
        .into_iter()
        .filter_map(|evaluation| {
            let config = evaluation.configuration?;
            if !config.is_enabled {
                return None;
            }
            let type_name = config.kind.as_ref().map(|k| k.display_name.clone()).unwrap_or_default();
            let context = evaluation.context.unwrap_or(serde_json::Value::Null);
            let text = |value: &serde_json::Value, key: &str| {
                value.get(key).and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
            };
            let build_id = context.get("buildId").and_then(|v| v.as_i64()).map(|id| id.to_string());
            let name = text(&config.settings, "displayName")
                .or_else(|| text(&context, "buildDefinitionName"))
                .unwrap_or_else(|| if type_name.is_empty() { "Policy".to_string() } else { type_name.clone() });
            Some(PrCheck {
                kind: "policy".to_string(),
                description: (!type_name.is_empty() && type_name != name).then_some(type_name),
                state: policy_state(&evaluation.status).to_string(),
                raw_state: evaluation.status,
                url: build_id.as_deref().map(&results_url),
                pipeline_run_id: build_id,
                required: Some(config.is_blocking),
                name,
            })
        })
        .collect();
    // Stable, so the host's own order survives within each half.
    checks.sort_by_key(|c| c.required != Some(true));
    checks
}

/// PR statuses as checks. Azure keeps every status ever posted, one per iteration, so only the
/// newest of each (genre, name) is the current one.
fn map_statuses(statuses: Vec<RawPrStatus>) -> Vec<PrCheck> {
    let mut latest: Vec<RawPrStatus> = Vec::new();
    for status in statuses {
        let key = |s: &RawPrStatus| {
            s.context.as_ref().map(|c| (c.genre.clone().unwrap_or_default(), c.name.clone())).unwrap_or_default()
        };
        match latest.iter_mut().find(|kept| key(kept) == key(&status)) {
            Some(kept) if kept.id < status.id => *kept = status,
            Some(_) => {}
            None => latest.push(status),
        }
    }
    latest
        .into_iter()
        .map(|status| {
            let (genre, name) =
                status.context.map(|c| (c.genre.filter(|g| !g.is_empty()), c.name)).unwrap_or_default();
            let url = status.target_url.filter(|u| !u.trim().is_empty());
            PrCheck {
                kind: "status".to_string(),
                name: match genre {
                    Some(genre) => format!("{genre}/{name}"),
                    None => name,
                },
                state: status_state(&status.state).to_string(),
                raw_state: status.state,
                description: status.description.filter(|d| !d.trim().is_empty()),
                pipeline_run_id: url.as_deref().and_then(build_id_in),
                url,
                required: None,
            }
        })
        .collect()
}

/// The checks on a pull request: its branch-policy evaluations (what can block completion, with
/// "required" known) and the statuses posted to it (builds and external services). A build that is
/// both — a build policy posts a status too — is listed once, as the policy.
pub async fn pr_checks(org: &str, project: &str, repo_id: &str, pr_id: i64, pat: &str) -> Result<PrChecks, String> {
    let pr = fetch_raw_pull_request(org, project, repo_id, pr_id, pat).await?;
    let project_guid = pr.repository.project.as_ref().map(|p| p.id.clone()).unwrap_or_default();
    let org_enc = encode_segment(&normalize_org(org));
    let project_enc = encode_segment(project);
    let statuses_url = format!(
        "https://dev.azure.com/{org_enc}/{project_enc}/_apis/git/repositories/{}/pullRequests/{pr_id}/statuses\
         ?api-version={API_VERSION}",
        encode_segment(repo_id)
    );
    let statuses = get_json::<ListResponse<RawPrStatus>>(&statuses_url, pat);
    let policies = async {
        if project_guid.is_empty() {
            return Ok(Vec::new());
        }
        let artifact = format!("vstfs:///CodeReview/CodeReviewId/{project_guid}/{pr_id}");
        let url = format!(
            "https://dev.azure.com/{org_enc}/{project_enc}/_apis/policy/evaluations?artifactId={}\
             &api-version={PREVIEW_API_VERSION}.1",
            encode_segment(&artifact)
        );
        get_json::<ListResponse<RawPolicyEvaluation>>(&url, pat).await.map(|list| list.value)
    };
    let (statuses, policies) = futures_util::join!(statuses, policies);
    // Either half alone is still worth showing; only both failing is a failure.
    if let (Err(e), Err(_)) = (&statuses, &policies) {
        return Err(e.clone());
    }
    let results_url = |build: &str| format!("https://dev.azure.com/{org_enc}/{project_enc}/_build/results?buildId={build}");
    let mut checks = map_policy_evaluations(policies.unwrap_or_default(), results_url);
    let covered: std::collections::HashSet<String> =
        checks.iter().filter_map(|c| c.pipeline_run_id.clone()).collect();
    checks.extend(
        map_statuses(statuses.map(|list| list.value).unwrap_or_default())
            .into_iter()
            .filter(|c| c.pipeline_run_id.as_ref().is_none_or(|id| !covered.contains(id))),
    );
    Ok(PrChecks {
        head_sha: pr.last_merge_source_commit.map(|c| c.commit_id).filter(|c| !c.is_empty()),
        checks,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct PrThreadComment {
    pub author: String,
    pub content: String,
    pub published_date: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PrCommentThread {
    pub id: i64,
    pub file_path: Option<String>,
    pub start_line: Option<i64>,
    pub end_line: Option<i64>,
    pub comments: Vec<PrThreadComment>,
}

#[derive(Deserialize)]
struct RawThreadComment {
    content: Option<String>,
    #[serde(rename = "commentType", default)]
    comment_type: Option<String>,
    author: RawIdentity,
    #[serde(rename = "publishedDate")]
    published_date: String,
}

#[derive(Deserialize)]
struct RawFilePosition {
    line: i64,
}

#[derive(Deserialize)]
struct RawThreadContext {
    #[serde(rename = "filePath", default)]
    file_path: Option<String>,
    #[serde(rename = "rightFileStart", default)]
    right_file_start: Option<RawFilePosition>,
    #[serde(rename = "rightFileEnd", default)]
    right_file_end: Option<RawFilePosition>,
}

#[derive(Deserialize)]
struct RawThread {
    id: i64,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    comments: Vec<RawThreadComment>,
    #[serde(rename = "threadContext", default)]
    thread_context: Option<RawThreadContext>,
}

/// Fetches the PR's still-open comment threads — e.g. from a human reviewer (a tech lead
/// leaving feedback directly on the PR, not through CodeFlow) — so they can be resolved with
/// AI the same way a finding from our own review can. Threads already marked fixed / closed /
/// won't-fix / by-design are left out (Azure DevOps' own UI treats those as done), and
/// system-generated comments (vote changes, iteration notices) are filtered out so only real
/// reviewer text remains; a thread left with no real comments after that is dropped entirely.
pub async fn list_pr_comment_threads(
    org: &str,
    project: &str,
    repo_id: &str,
    pr_id: i64,
    pat: &str,
) -> Result<Vec<PrCommentThread>, String> {
    let org = encode_segment(&normalize_org(org));
    let project = encode_segment(project);
    let url = format!(
        "https://dev.azure.com/{org}/{project}/_apis/git/repositories/{repo_id}/pullRequests/{pr_id}/threads\
         ?api-version={API_VERSION}"
    );
    let parsed: ListResponse<RawThread> = get_json(&url, pat).await?;

    Ok(parsed
        .value
        .into_iter()
        .filter(|t| matches!(t.status.as_deref().map(str::to_lowercase).as_deref(), Some("active") | Some("pending") | None))
        .filter_map(|t| {
            let comments: Vec<PrThreadComment> = t
                .comments
                .into_iter()
                .filter(|c| c.comment_type.as_deref().unwrap_or("text") == "text")
                .filter_map(|c| {
                    let content = c.content?.trim().to_string();
                    if content.is_empty() {
                        return None;
                    }
                    Some(PrThreadComment { author: c.author.display_name, content, published_date: c.published_date })
                })
                .collect();
            if comments.is_empty() {
                return None;
            }
            let (file_path, start_line, end_line) = match t.thread_context {
                Some(ctx) => (
                    ctx.file_path,
                    ctx.right_file_start.as_ref().map(|p| p.line),
                    ctx.right_file_end.as_ref().map(|p| p.line),
                ),
                None => (None, None, None),
            };
            Some(PrCommentThread { id: t.id, file_path, start_line, end_line, comments })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What Azure actually sends for an expired token — a whole HTML page — is said in one sentence.
    #[test]
    fn an_expired_token_is_one_sentence_not_a_page() {
        let page = "<!DOCTYPE html > <html> <head> <title>Access Denied: The Personal Access Token used has expired.</title> <style type=\"text/css\">html { height: 100%; } body { font-family: -apple-system; }</style></head><body>...</body></html>";
        assert_eq!(describe_failure(reqwest::StatusCode::UNAUTHORIZED, page), PAT_EXPIRED);
        // Any other 401 is still the credentials, and never the page.
        assert_eq!(describe_failure(reqwest::StatusCode::UNAUTHORIZED, "<html><body>no</body></html>"), BAD_CREDENTIALS);
        // A page on another status is its title.
        assert_eq!(
            describe_failure(reqwest::StatusCode::SERVICE_UNAVAILABLE, "<html><head><title>Service\n  Unavailable</title></head></html>"),
            "Azure DevOps returned 503 Service Unavailable: Service Unavailable"
        );
        // The REST API's own sentence beats its JSON.
        assert_eq!(
            describe_failure(reqwest::StatusCode::BAD_REQUEST, r#"{"$id":"1","message":"TF401019: The Git repository does not exist.","typeKey":"GitRepositoryNotFoundException"}"#),
            "Azure DevOps returned 400 Bad Request: TF401019: The Git repository does not exist."
        );
        // And nothing at all is still a sentence.
        assert_eq!(describe_failure(reqwest::StatusCode::FORBIDDEN, "  "), "Azure DevOps returned 403 Forbidden");
        let long = "x".repeat(900);
        assert!(describe_failure(reqwest::StatusCode::BAD_REQUEST, &long).chars().count() < 340);
    }

    /// Azure has no "give me the diff" endpoint, so the whole repo-less review of an Azure PR
    /// rests on this rendering two blobs into something a diff parser (and the model) reads the
    /// same way `git diff` output reads.
    #[test]
    fn unified_patch_renders_a_git_style_diff() {
        let patch = unified_patch("src/app.ts", b"linea uno\nlinea dos\n", b"linea uno\nlinea DOS\n")
            .expect("a patch");
        assert!(patch.contains("a/src/app.ts"), "{patch}");
        assert!(patch.contains("b/src/app.ts"), "{patch}");
        assert!(patch.contains("@@"), "{patch}");
        assert!(patch.contains("-linea dos"), "{patch}");
        assert!(patch.contains("+linea DOS"), "{patch}");
    }

    #[test]
    fn unified_patch_handles_added_and_deleted_files() {
        let added = unified_patch("nuevo.txt", b"", b"hola\n").expect("a patch");
        assert!(added.contains("+hola"), "{added}");
        let deleted = unified_patch("viejo.txt", b"adios\n", b"").expect("a patch");
        assert!(deleted.contains("-adios"), "{deleted}");
    }

    /// A pull request as `GET …/pullrequests` answers it, trimmed to the fields read here.
    fn raw_pr(id: i64, status: &str, draft: bool) -> RawPullRequest {
        serde_json::from_value(serde_json::json!({
            "pullRequestId": id,
            "title": format!("PR {id}"),
            "status": status,
            "isDraft": draft,
            "sourceRefName": "refs/heads/feature/login",
            "targetRefName": "refs/heads/main",
            "createdBy": { "displayName": "Ana Example" },
            "creationDate": "2026-09-01T10:00:00Z",
            "repository": { "id": "3a1f0c7e", "name": "example-repo", "project": { "id": "9b2d", "name": "Example Project" } },
            "lastMergeSourceCommit": { "commitId": "abc123" },
            "mergeStatus": "succeeded"
        }))
        .expect("a pull request")
    }

    #[test]
    fn a_pull_request_maps_onto_the_shared_summary() {
        let pr = map_pull_request("example-org", "Example%20Project", raw_pr(42, "active", false));
        assert_eq!(pr.id, 42);
        assert_eq!(pr.status, "open");
        assert_eq!(pr.source_branch, "feature/login");
        assert_eq!(pr.target_branch, "main");
        assert_eq!(pr.author, "Ana Example");
        assert_eq!(pr.provider, "azure");
        assert_eq!(pr.url, "https://dev.azure.com/example-org/Example%20Project/_git/example-repo/pullrequest/42");
        assert_eq!(map_pull_request("o", "p", raw_pr(1, "active", true)).status, "draft");
        assert_eq!(map_pull_request("o", "p", raw_pr(1, "completed", false)).status, "merged");
        assert_eq!(map_pull_request("o", "p", raw_pr(1, "abandoned", false)).status, "closed");
    }

    /// One row more than a page is asked for; its presence is the "there is more" answer, and it is
    /// never shown on this page.
    #[test]
    fn a_page_knows_whether_another_follows() {
        let full: Vec<RawPullRequest> = (0..=PR_PAGE_SIZE as i64).map(|i| raw_pr(i, "active", false)).collect();
        let page = page_of(full, PrListScope::Open, 1, |pr| map_pull_request("o", "p", pr));
        assert!(page.has_more);
        assert_eq!(page.items.len(), PR_PAGE_SIZE as usize);

        let short = vec![raw_pr(1, "active", false)];
        assert!(!page_of(short, PrListScope::Open, 3, |pr| map_pull_request("o", "p", pr)).has_more);
    }

    /// Azure's status filter takes one value, so "merged or closed" is asked as everything and the
    /// active ones are dropped here.
    #[test]
    fn a_closed_page_drops_what_is_still_open() {
        let mixed = vec![raw_pr(3, "active", false), raw_pr(2, "completed", false), raw_pr(1, "abandoned", false)];
        let page = page_of(mixed, PrListScope::Closed, 1, |pr| map_pull_request("o", "p", pr));
        let ids: Vec<i64> = page.items.iter().map(|pr| pr.id).collect();
        assert_eq!(ids, vec![2, 1]);
    }

    #[test]
    fn list_scopes_parse_with_open_as_the_default() {
        assert_eq!(PrListScope::parse(None), PrListScope::Open);
        assert_eq!(PrListScope::parse(Some("bogus")), PrListScope::Open);
        assert_eq!(PrListScope::parse(Some("closed")), PrListScope::Closed);
        assert_eq!(PrListScope::parse(Some("all")), PrListScope::All);
        assert!(PrListScope::Open.admits("draft"));
        assert!(!PrListScope::Open.admits("merged"));
        assert!(PrListScope::Closed.admits("merged"));
    }

    fn policy(settings: serde_json::Value, enabled: bool) -> RawPolicyConfiguration {
        serde_json::from_value(serde_json::json!({
            "isEnabled": enabled,
            "isBlocking": true,
            "type": { "id": LIMIT_MERGE_TYPES_POLICY, "displayName": "Require a merge strategy" },
            "settings": settings
        }))
        .expect("a policy")
    }

    #[test]
    fn merge_type_policies_limit_the_strategies() {
        assert_eq!(allowed_by_merge_type_policies(&[]), None, "no policy: everything, and known");
        let squash_or_rebase = policy(
            serde_json::json!({ "allowNoFastForward": false, "allowSquash": true, "allowRebase": true, "allowRebaseMerge": false }),
            true,
        );
        assert_eq!(
            allowed_by_merge_type_policies(&[squash_or_rebase]),
            Some(vec!["squash".to_string(), "rebase".to_string()])
        );
        // Both policies on a branch have to allow a strategy.
        let squash_only = policy(serde_json::json!({ "allowSquash": true }), true);
        let squash_or_rebase = policy(serde_json::json!({ "allowSquash": true, "allowRebase": true }), true);
        assert_eq!(allowed_by_merge_type_policies(&[squash_only, squash_or_rebase]), Some(vec!["squash".to_string()]));
        // The switch from before the four existed.
        let legacy = policy(serde_json::json!({ "useSquashMerge": true }), true);
        assert_eq!(allowed_by_merge_type_policies(&[legacy]), Some(vec!["squash".to_string()]));
        // A disabled policy limits nothing.
        let off = policy(serde_json::json!({ "allowSquash": true }), false);
        assert_eq!(allowed_by_merge_type_policies(&[off]), None);
    }

    #[test]
    fn readiness_reads_the_test_merge() {
        assert_eq!(azure_readiness("active", false, Some("succeeded")), "clean");
        assert_eq!(azure_readiness("active", false, Some("conflicts")), "conflicts");
        assert_eq!(azure_readiness("active", false, Some("rejectedByPolicy")), "blocked");
        assert_eq!(azure_readiness("active", true, Some("succeeded")), "draft");
        assert_eq!(azure_readiness("completed", false, None), "closed");
        assert_eq!(azure_readiness("active", false, Some("queued")), "unknown");
        assert_eq!(azure_merge_strategy("merge"), Some("noFastForward"));
        assert_eq!(azure_merge_strategy("rebase_merge"), Some("rebaseMerge"));
        assert_eq!(azure_merge_strategy("ff"), None);
    }

    #[test]
    fn refusals_are_classified_by_what_they_say() {
        assert_eq!(classify_merge_refusal(405, "Pull Request is not mergeable"), "blocked");
        assert_eq!(classify_merge_refusal(405, "Required status check \"ci\" is expected."), "checks");
        assert_eq!(
            classify_merge_refusal(405, "At least 1 approving review is required by reviewers with write access."),
            "approvals"
        );
        assert_eq!(classify_merge_refusal(405, "Base branch was modified. Review and try the merge again."), "stale");
        assert_eq!(classify_merge_refusal(409, "Head branch was modified. Review and try the merge again."), "stale");
        assert_eq!(classify_merge_refusal(405, "Merge commits are not allowed on this repository."), "method");
        assert_eq!(classify_merge_refusal(406, "Branch cannot be merged"), "conflicts");
        assert_eq!(
            classify_merge_refusal(400, "The pull request cannot be completed because it has policies that are not approved."),
            "blocked"
        );
        assert_eq!(classify_merge_refusal(422, "something else"), "other");
        assert_eq!(merge_refusal("checks", " ci is red "), "MERGE_BLOCKED::checks::ci is red");
    }

    #[test]
    fn a_build_id_is_read_out_of_a_results_address() {
        assert_eq!(
            build_id_in("https://dev.azure.com/example-org/Example/_build/results?buildId=1234&view=results"),
            Some("1234".to_string())
        );
        assert_eq!(build_id_in("https://example.com/status/7"), None);
    }

    /// Azure keeps one status per iteration; only the newest of each context is current.
    #[test]
    fn statuses_keep_only_the_newest_per_context() {
        let statuses: Vec<RawPrStatus> = serde_json::from_value(serde_json::json!([
            { "id": 1, "state": "failed", "context": { "name": "build", "genre": "continuous-integration" },
              "targetUrl": "https://dev.azure.com/example-org/Example/_build/results?buildId=10" },
            { "id": 3, "state": "succeeded", "context": { "name": "build", "genre": "continuous-integration" },
              "targetUrl": "https://dev.azure.com/example-org/Example/_build/results?buildId=11" },
            { "id": 2, "state": "pending", "context": { "name": "sonar" }, "description": "Analyzing" }
        ]))
        .expect("statuses");
        let checks = map_statuses(statuses);
        assert_eq!(checks.len(), 2);
        assert_eq!(checks[0].name, "continuous-integration/build");
        assert_eq!(checks[0].state, crate::ci::status::SUCCESS);
        assert_eq!(checks[0].pipeline_run_id.as_deref(), Some("11"));
        assert_eq!(checks[1].name, "sonar");
        assert_eq!(checks[1].state, crate::ci::status::RUNNING);
        assert_eq!(checks[1].description.as_deref(), Some("Analyzing"));
    }

    #[test]
    fn policy_evaluations_become_checks_blocking_first() {
        let evaluations: Vec<RawPolicyEvaluation> = serde_json::from_value(serde_json::json!([
            { "status": "approved",
              "configuration": { "isEnabled": true, "isBlocking": false,
                "type": { "id": "x", "displayName": "Comment requirements" }, "settings": {} } },
            { "status": "rejected",
              "configuration": { "isEnabled": true, "isBlocking": true,
                "type": { "id": "y", "displayName": "Build" }, "settings": { "displayName": null } },
              "context": { "buildId": 77, "buildDefinitionName": "example-ci" } },
            { "status": "running",
              "configuration": { "isEnabled": false, "isBlocking": true, "type": { "id": "z", "displayName": "Off" } } }
        ]))
        .expect("evaluations");
        let checks = map_policy_evaluations(evaluations, |id| format!("https://example.invalid/build/{id}"));
        assert_eq!(checks.len(), 2, "a disabled policy is not a check");
        assert_eq!(checks[0].name, "example-ci");
        assert_eq!(checks[0].required, Some(true));
        assert_eq!(checks[0].state, crate::ci::status::FAILED);
        assert_eq!(checks[0].pipeline_run_id.as_deref(), Some("77"));
        assert_eq!(checks[0].url.as_deref(), Some("https://example.invalid/build/77"));
        assert_eq!(checks[0].description.as_deref(), Some("Build"));
        assert_eq!(checks[1].name, "Comment requirements");
        assert_eq!(checks[1].description, None, "the type is not repeated under its own name");
    }
}
