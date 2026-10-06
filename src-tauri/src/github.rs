use serde::{Deserialize, Serialize};

// The shared, provider-neutral PR wire types (`PullRequestSummary`, `PrCommentThread`,
// `PrThreadComment`) live in `crate::ado` — they're what the frontend already consumes, so
// GitHub produces the exact same shapes rather than a parallel set the UI would have to learn.
use crate::ado::{PrCommentThread, PrThreadComment, PullRequestSummary};

/// GitHub pins REST behavior to a dated API version via this header; sending it keeps us on a
/// known contract instead of whatever "latest" happens to be.
pub(crate) const API_VERSION: &str = "2022-11-28";
/// GitHub rejects any request without a User-Agent (403), unlike Azure DevOps.
pub(crate) const USER_AGENT: &str = "CodeFlow";
/// The canonical public host — everything else is treated as a GitHub Enterprise Server.
pub const GITHUB_COM: &str = "github.com";

/// The REST API base for a host. GitHub.com serves its API from a dedicated `api.` subdomain;
/// a GitHub Enterprise Server serves it from `https://<host>/api/v3` on the same host.
pub(crate) fn api_root(host: &str) -> String {
    if host.eq_ignore_ascii_case(GITHUB_COM) {
        "https://api.github.com".to_string()
    } else {
        format!("https://{host}/api/v3")
    }
}

/// The GraphQL endpoint — `api.github.com/graphql` on github.com, `<host>/api/graphql` on
/// Enterprise. Used to resolve review threads (there's no REST endpoint for that).
fn graphql_root(host: &str) -> String {
    if host.eq_ignore_ascii_case(GITHUB_COM) {
        "https://api.github.com/graphql".to_string()
    } else {
        format!("https://{host}/api/graphql")
    }
}

/// One client for the process, cloned per call.
///
/// It used to be `Client::new()` at every call site. With rustls that is not cheap: each one
/// builds a fresh `ClientConfig` and populates a root certificate store, and — worse — each one
/// gets its own empty connection pool, so every request re-handshaked TLS to api.github.com and
/// no two could share an HTTP/2 connection. Reviewing a PR is a dozen requests to one host, so
/// that was ~100-300ms of pure handshake per call, on top of a UI waiting for the answer.
///
/// Cloning is free (a `reqwest::Client` is an `Arc` around the inner state) and the clone shares
/// the pool, which is the whole point. Kept returning by value rather than `&'static` so no call
/// site has to change. Nothing here varies the transport per request — no proxy toggle, no
/// per-request certificate trust — so one shared client is behaviour-identical to the old code.
///
/// Built with the pull-request clients' shared timeouts (`ado::pr_http_client`): without them a host
/// that stopped answering mid-request held the review, and its spinner, forever.
fn client() -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(crate::ado::pr_http_client).clone()
}

/// Both classic and fine-grained personal access tokens authenticate as a Bearer token on the
/// modern REST API, so a single scheme covers whatever the user pasted.
pub(crate) fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}

/// A request with the four headers every REST call here carries.
fn rest(request: reqwest::RequestBuilder, token: &str) -> reqwest::RequestBuilder {
    request
        .header("Authorization", bearer(token))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", USER_AGENT)
        .header("X-GitHub-Api-Version", API_VERSION)
}

/// GitHub's error body is `{"message": …, "errors": [ … ], "documentation_url": …}`, where each of
/// `errors` is a string or an object with a `message` or a `field` + `code`. The message and its
/// details are what is worth reading; the documentation link is not.
///
/// Always starts `GitHub returned {status}`, which [`is_unanchorable`] relies on.
fn describe(status: reqwest::StatusCode, body: &str) -> String {
    let detail = serde_json::from_str::<serde_json::Value>(body).ok().and_then(|value| {
        let message = value.get("message")?.as_str()?.to_string();
        let details: Vec<String> = value
            .get("errors")
            .and_then(|e| e.as_array())
            .map(|errors| {
                errors
                    .iter()
                    .filter_map(|e| {
                        e.as_str()
                            .map(str::to_string)
                            .or_else(|| e.get("message").and_then(|m| m.as_str()).map(str::to_string))
                            .or_else(|| {
                                let field = e.get("field")?.as_str()?;
                                let code = e.get("code")?.as_str()?;
                                Some(format!("{field}: {code}"))
                            })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Some(if details.is_empty() { message } else { format!("{message} ({})", details.join("; ")) })
    });
    match detail {
        Some(detail) => format!("GitHub returned {status}: {detail}"),
        None => format!("GitHub returned {status}: {}", body.chars().take(300).collect::<String>()),
    }
}

/// Whether posting an inline comment failed because GitHub won't anchor it there: a 422, which is
/// what it answers for a line outside the pull request's diff (and for a path the diff doesn't
/// have). The comment is still worth posting — as a general one that names the line.
pub fn is_unanchorable(error: &str) -> bool {
    error.starts_with("GitHub returned 422")
}

/// The `rel="next"` address in a `Link` header, if there is one — how GitHub paginates everything.
fn next_link(header: &str) -> Option<String> {
    header.split(',').find_map(|part| {
        let mut pieces = part.split(';');
        let url = pieces.next()?.trim().strip_prefix('<')?.strip_suffix('>')?;
        let is_next = pieces.any(|piece| {
            let piece = piece.trim();
            piece
                .strip_prefix("rel=")
                .map(|rel| rel.trim_matches('"').split_whitespace().any(|r| r == "next"))
                .unwrap_or(false)
        });
        is_next.then(|| url.to_string())
    })
}

/// How many pages a "read all of it" loop follows before stopping. A hundred per page, so thirty is
/// three thousand comments — far past any conversation a person reads, and a ceiling on what a
/// pathological pull request can cost the rate limit.
const MAX_PAGES: usize = 30;

/// One page of a list, plus the address of the next one when GitHub says there is one.
async fn get_json_page<T: for<'de> Deserialize<'de>>(url: &str, token: &str) -> Result<(T, Option<String>), String> {
    let res = rest(client().get(url), token)
        .send()
        .await
        .map_err(|e| format!("couldn't reach GitHub: {e}"))?;
    let status = res.status();
    let next = res
        .headers()
        .get("link")
        .and_then(|value| value.to_str().ok())
        .and_then(next_link);
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(describe(status, &body));
    }
    let page = res.json::<T>().await.map_err(|e| format!("unexpected response from GitHub: {e}"))?;
    Ok((page, next))
}

/// Every page of a list, in order, following `Link` headers from `first`.
///
/// Only addresses on the same API root are followed: the header comes from the response, and the
/// token must never be sent anywhere a response says to send it.
async fn get_all_pages<T: for<'de> Deserialize<'de>>(root: &str, first: &str, token: &str) -> Result<Vec<T>, String> {
    let mut all = Vec::new();
    let mut url = Some(first.to_string());
    let same_root = format!("{root}/");
    for _ in 0..MAX_PAGES {
        let Some(current) = url.take() else { break };
        let (page, next): (Vec<T>, Option<String>) = get_json_page(&current, token).await?;
        all.extend(page);
        url = next.filter(|next| next.starts_with(&same_root));
    }
    Ok(all)
}

#[derive(Debug, Clone, Serialize)]
pub struct DetectedGithubRepo {
    /// The GitHub host this remote lives on — "github.com" or an Enterprise hostname. Carried
    /// through so the token lookup and API base URL target the right server.
    pub host: String,
    pub owner: String,
    pub repo: String,
}

/// Splits a git remote URL into `(host, path)` for the shapes a git remote actually comes in —
/// HTTPS/SSH scheme URLs (`https://host/owner/repo`, `ssh://git@host/owner/repo`, optionally
/// with embedded credentials) and the scp-like SSH form (`git@host:owner/repo`). `.git` and a
/// trailing slash are stripped. Returns `None` for anything without a clear host/path split.
fn split_host_path(remote_url: &str) -> Option<(String, String)> {
    let url = remote_url.trim().trim_end_matches('/');
    let url = url.strip_suffix(".git").unwrap_or(url);

    if let Some(idx) = url.find("://") {
        // scheme://[user@]host/path
        let after = &url[idx + 3..];
        let after = after.rsplit('@').next().unwrap_or(after);
        let (host, path) = after.split_once('/')?;
        return Some((host.to_string(), path.to_string()));
    }

    // scp-like: [user@]host:owner/repo
    let after = url.rsplit('@').next().unwrap_or(url);
    let (host, path) = after.split_once(':')?;
    Some((host.to_string(), path.to_string()))
}

/// Pulls exactly `{owner}/{repo}` out of a path tail, ignoring any trailing path (GitHub repo
/// URLs are always exactly two path segments; anything deeper isn't a plain clone URL).
fn two_segments(path: &str) -> Option<(String, String)> {
    let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    match parts.as_slice() {
        [owner, repo, ..] => Some(((*owner).to_string(), repo.trim_end_matches(".git").to_string())),
        _ => None,
    }
}

/// Recognizes a GitHub remote **only** when its host is one we know is GitHub — `github.com`
/// plus whatever Enterprise hosts the user has configured (`known_hosts`). Without that
/// allowlist a GitLab/Bitbucket/self-hosted remote would be indistinguishable from a GitHub
/// Enterprise one, so an unknown host returns `None` and falls back to manual linking. The
/// detected host is normalized to the matching `known_hosts` entry so the token key stays
/// consistent with what was saved.
pub fn detect_from_remote_url(remote_url: &str, known_hosts: &[String]) -> Option<DetectedGithubRepo> {
    let (host, path) = split_host_path(remote_url)?;
    let matched = known_hosts.iter().find(|h| h.eq_ignore_ascii_case(&host))?;
    let (owner, repo) = two_segments(&path)?;
    Some(DetectedGithubRepo { host: matched.clone(), owner, repo })
}

async fn get_json<T: for<'de> Deserialize<'de>>(url: &str, token: &str) -> Result<T, String> {
    let res = rest(client().get(url), token)
        .send()
        .await
        .map_err(|e| format!("couldn't reach GitHub: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(describe(status, &body));
    }
    res.json::<T>().await.map_err(|e| format!("unexpected response from GitHub: {e}"))
}

async fn post_json(url: &str, token: &str, body: &serde_json::Value) -> Result<(), String> {
    let res = rest(client().post(url), token)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("couldn't reach GitHub: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(describe(status, &body));
    }
    Ok(())
}

/// Like [`post_json`] but deserializes the created resource from the response body — used by
/// endpoints (create PR) whose returned object we actually need (its number, URL).
async fn post_json_returning<T: for<'de> Deserialize<'de>>(
    url: &str,
    token: &str,
    body: &serde_json::Value,
) -> Result<T, String> {
    let res = rest(client().post(url), token)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("couldn't reach GitHub: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(describe(status, &body));
    }
    res.json::<T>().await.map_err(|e| format!("unexpected response from GitHub: {e}"))
}

async fn patch_json(url: &str, token: &str, body: &serde_json::Value) -> Result<(), String> {
    let res = rest(client().patch(url), token)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("couldn't reach GitHub: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(describe(status, &body));
    }
    Ok(())
}

#[derive(Deserialize)]
struct RawUser {
    login: String,
}

/// Validates a token against a host and returns the login it belongs to — used by Settings to
/// confirm a pasted token actually works (and show whose account it is) the moment it's saved,
/// rather than failing later when a PR list is first requested.
pub async fn get_authenticated_user(host: &str, token: &str) -> Result<String, String> {
    let url = format!("{}/user", api_root(host));
    let user: RawUser = get_json(&url, token).await?;
    Ok(user.login)
}

/// The open pull requests of `owner/repo` whose review is asked of the signed-in user — GitHub's own
/// `review-requested:@me` search, one call for the whole repository rather than one per pull request.
pub async fn review_requested_numbers(host: &str, owner: &str, repo: &str, token: &str) -> Result<Vec<i64>, String> {
    #[derive(Deserialize)]
    struct Hit {
        number: i64,
    }
    #[derive(Deserialize)]
    struct Found {
        #[serde(default)]
        items: Vec<Hit>,
    }
    let query = format!("repo:{owner}/{repo} is:pr is:open review-requested:@me");
    let encoded: String = url::form_urlencoded::byte_serialize(query.as_bytes()).collect();
    let found: Found = get_json(&format!("{}/search/issues?per_page=100&q={encoded}", api_root(host)), token).await?;
    Ok(found.items.into_iter().map(|hit| hit.number).collect())
}

#[derive(Deserialize)]
struct RawRepoName {
    #[serde(default)]
    full_name: String,
}

#[derive(Deserialize)]
struct RawRef {
    #[serde(rename = "ref")]
    ref_name: String,
    #[serde(default)]
    sha: String,
    /// The repository the branch lives in — `null` when it was a fork that has since been deleted.
    /// Head and base differing is what "from a fork" means.
    #[serde(default)]
    repo: Option<RawRepoName>,
}

#[derive(Deserialize)]
struct RawPull {
    number: i64,
    title: String,
    #[serde(default)]
    body: Option<String>,
    state: String,
    #[serde(default)]
    draft: bool,
    #[serde(rename = "merged_at", default)]
    merged_at: Option<String>,
    head: RawRef,
    base: RawRef,
    user: RawUser,
    #[serde(rename = "created_at")]
    created_at: String,
    #[serde(rename = "html_url")]
    html_url: String,
    /// Single-PR reads only, and computed lazily by GitHub: `null` until it has tried the merge.
    #[serde(default)]
    mergeable: Option<bool>,
    /// `clean` · `dirty` (conflicts) · `blocked` (protection: checks or reviews) · `behind` ·
    /// `unstable` (a non-required check failing) · `has_hooks` · `draft` · `unknown`.
    #[serde(default)]
    mergeable_state: Option<String>,
}

/// GitHub reports open/closed plus separate `draft`/`merged_at` flags; collapse them into the
/// same four buckets the sidebar groups by, matching Azure DevOps' `bucket_status`.
fn bucket_status(state: &str, draft: bool, merged_at: &Option<String>) -> String {
    if merged_at.is_some() {
        "merged".to_string()
    } else if state == "closed" {
        "closed".to_string()
    } else if draft {
        "draft".to_string()
    } else {
        "open".to_string()
    }
}

fn map_pull(pr: RawPull) -> PullRequestSummary {
    PullRequestSummary {
        id: pr.number,
        title: pr.title,
        description: pr.body.unwrap_or_default(),
        status: bucket_status(&pr.state, pr.draft, &pr.merged_at),
        source_branch: pr.head.ref_name,
        target_branch: pr.base.ref_name,
        author: pr.user.login,
        created_at: pr.created_at,
        url: pr.html_url,
        provider: "github".to_string(),
    }
}

/// The `/pulls` address for one page of a scope, newest first.
fn pulls_page_url(host: &str, owner: &str, repo: &str, scope: crate::ado::PrListScope, page: u32) -> String {
    let state = match scope {
        crate::ado::PrListScope::Open => "open",
        crate::ado::PrListScope::Closed => "closed",
        crate::ado::PrListScope::All => "all",
    };
    format!(
        "{}/repos/{owner}/{repo}/pulls?state={state}&per_page={}&page={}&sort=created&direction=desc",
        api_root(host),
        crate::ado::PR_PAGE_SIZE,
        page.max(1)
    )
}

/// One page of the repository's pull requests. GitHub's `state=closed` covers merged and closed
/// alike, so every scope is one exact query here; whether a next page exists is the `Link` header's
/// answer.
pub async fn list_pull_requests_page(
    host: &str,
    owner: &str,
    repo: &str,
    scope: crate::ado::PrListScope,
    page: u32,
    token: &str,
) -> Result<crate::ado::PrPage, String> {
    let url = pulls_page_url(host, owner, repo, scope, page);
    let (raw, next): (Vec<RawPull>, Option<String>) = get_json_page(&url, token).await?;
    Ok(crate::ado::PrPage { items: raw.into_iter().map(map_pull).collect(), page: page.max(1), has_more: next.is_some() })
}

/// Fetches a single pull request by number. Unlike [`list_pull_requests_page`] this reaches a PR
/// regardless of how old it is — what a pasted link needs, and what a review needs too.
pub async fn get_pull_request(
    host: &str,
    owner: &str,
    repo: &str,
    number: i64,
    token: &str,
) -> Result<PullRequestSummary, String> {
    let url = format!("{}/repos/{owner}/{repo}/pulls/{number}", api_root(host));
    let raw: RawPull = get_json(&url, token).await?;
    Ok(map_pull(raw))
}

#[derive(Deserialize)]
struct RawPullFile {
    filename: String,
    #[serde(default)]
    previous_filename: Option<String>,
    status: String,
    /// Absent for a binary file, and for one whose diff GitHub decided was too large to inline.
    #[serde(default)]
    patch: Option<String>,
}

/// Reassembles a unified diff from `GET /pulls/{n}/files`, the fallback for when GitHub refuses
/// to render the whole diff in one response (it answers 406 past its size limit). Each entry
/// carries only its hunks, so the `diff --git` / `---` / `+++` headers — the part every diff
/// parser keys on — have to be put back. Binary and over-size files have no hunks at all and are
/// listed as a bare header, which is honest: the review is told the file changed but not how.
async fn pull_request_diff_from_files(
    host: &str,
    owner: &str,
    repo: &str,
    number: i64,
    token: &str,
) -> Result<String, String> {
    let mut out = String::new();
    // 300 files is GitHub's own hard ceiling for this endpoint; past it the diff is truncated no
    // matter what, which the truncation the review applies would have done anyway.
    for page in 1..=3 {
        let url = format!(
            "{}/repos/{owner}/{repo}/pulls/{number}/files?per_page=100&page={page}",
            api_root(host)
        );
        let files: Vec<RawPullFile> = get_json(&url, token).await?;
        let count = files.len();
        for file in files {
            let old_path = match file.status.as_str() {
                "added" => "/dev/null".to_string(),
                _ => format!("a/{}", file.previous_filename.as_deref().unwrap_or(&file.filename)),
            };
            let new_path = if file.status == "removed" {
                "/dev/null".to_string()
            } else {
                format!("b/{}", file.filename)
            };
            out.push_str(&format!(
                "diff --git a/{} b/{}\n--- {old_path}\n+++ {new_path}\n",
                file.previous_filename.as_deref().unwrap_or(&file.filename),
                file.filename
            ));
            match &file.patch {
                Some(patch) => {
                    out.push_str(patch);
                    if !patch.ends_with('\n') {
                        out.push('\n');
                    }
                }
                None => out.push_str("(binary or too large to display)\n"),
            }
        }
        if count < 100 {
            break;
        }
    }
    if out.is_empty() {
        return Err("GitHub reported no changed files for this pull request".to_string());
    }
    Ok(out)
}

/// The pull request's unified diff, read straight from GitHub instead of from a local clone —
/// this is what makes reviewing a PR from nothing but its link possible. Asks for the `diff`
/// media type first (one request, the real thing git would produce) and falls back to
/// reassembling it from the per-file hunks when GitHub declines to render it whole.
pub async fn pull_request_diff(
    host: &str,
    owner: &str,
    repo: &str,
    number: i64,
    token: &str,
) -> Result<String, String> {
    let url = format!("{}/repos/{owner}/{repo}/pulls/{number}", api_root(host));
    let res = client()
        .get(&url)
        .header("Authorization", bearer(token))
        .header("Accept", "application/vnd.github.diff")
        .header("User-Agent", USER_AGENT)
        .header("X-GitHub-Api-Version", API_VERSION)
        .send()
        .await
        .map_err(|e| format!("couldn't reach GitHub: {e}"))?;
    if res.status().is_success() {
        let diff = res.text().await.map_err(|e| format!("unexpected response from GitHub: {e}"))?;
        if !diff.trim().is_empty() {
            return Ok(diff);
        }
    }
    pull_request_diff_from_files(host, owner, repo, number, token).await
}

/// Opens a pull request via `POST /repos/{owner}/{repo}/pulls`. `head`/`base` are branch names
/// (`head` is the source/compare branch, `base` the target) — the branch must already exist on
/// the remote. Returns the created PR mapped to the shared summary shape.
#[allow(clippy::too_many_arguments)]
pub async fn create_pull_request(
    host: &str,
    owner: &str,
    repo: &str,
    title: &str,
    body: &str,
    head: &str,
    base: &str,
    draft: bool,
    token: &str,
) -> Result<PullRequestSummary, String> {
    let url = format!("{}/repos/{owner}/{repo}/pulls", api_root(host));
    let payload = serde_json::json!({
        "title": title,
        "head": head,
        "base": base,
        "body": body,
        "draft": draft,
    });
    let raw: RawPull = post_json_returning(&url, token, &payload).await?;
    Ok(map_pull(raw))
}

/// The head commit SHA a new inline comment must be anchored to — GitHub requires `commit_id`
/// on every pull-request review comment (unlike Azure DevOps' iteration id, which we look up
/// separately). Fetched fresh right before posting so it points at the PR's current tip.
pub async fn head_sha_for(host: &str, owner: &str, repo: &str, pr_number: i64, token: &str) -> Result<String, String> {
    let url = format!("{}/repos/{owner}/{repo}/pulls/{pr_number}", api_root(host));
    let pr: RawPull = get_json(&url, token).await?;
    if pr.head.sha.is_empty() {
        return Err("GitHub didn't report a head commit for this pull request".to_string());
    }
    Ok(pr.head.sha)
}

/// Posts an inline review comment anchored to a file/line on the PR's head commit — the GitHub
/// equivalent of Azure DevOps' file-anchored thread. A multi-line range includes `start_line`;
/// a single line omits it (GitHub 422s if `start_line == line`).
#[derive(Deserialize)]
struct CommentCreated {
    id: i64,
}

/// Posts an inline review comment and returns its **comment id** — kept so a re-review can reply to
/// the same conversation (`/comments/{id}/replies`) and resolve its thread, rather than duplicate.
#[allow(clippy::too_many_arguments)]
pub async fn post_pr_comment_anchored(
    host: &str,
    owner: &str,
    repo: &str,
    pr_number: i64,
    content: &str,
    file_path: &str,
    start_line: i64,
    end_line: i64,
    commit_id: &str,
    token: &str,
) -> Result<i64, String> {
    let url = format!("{}/repos/{owner}/{repo}/pulls/{pr_number}/comments", api_root(host));
    // GitHub anchors to the last line of the range as `line`; `start_line` (when the range
    // spans more than one line) marks where the highlight begins.
    let line = end_line.max(start_line);
    let normalized_path = file_path.trim_start_matches('/');
    let mut body = serde_json::json!({
        "body": content,
        "commit_id": commit_id,
        "path": normalized_path,
        "line": line,
        "side": "RIGHT",
    });
    if start_line < line {
        body["start_line"] = serde_json::json!(start_line);
        body["start_side"] = serde_json::json!("RIGHT");
    }
    let created: CommentCreated = post_json_returning(&url, token, &body).await?;
    Ok(created.id)
}

/// Posts a general (non-file-anchored) comment on the PR's conversation — used for the summary
/// comment and as a fallback for any finding whose location couldn't be parsed. GitHub models
/// these as issue comments (a PR is an issue), a different endpoint from inline review comments.
/// Returns the created issue-comment id (issue comments aren't threaded, so it isn't reused).
pub async fn post_pr_comment(host: &str, owner: &str, repo: &str, pr_number: i64, content: &str, token: &str) -> Result<i64, String> {
    let url = format!("{}/repos/{owner}/{repo}/issues/{pr_number}/comments", api_root(host));
    let body = serde_json::json!({ "body": content });
    let created: CommentCreated = post_json_returning(&url, token, &body).await?;
    Ok(created.id)
}

/// Replies to an existing inline review comment (keeps the conversation on one thread instead of
/// opening a new one). GitHub threads replies off the root comment's id.
pub async fn reply_pr_review_comment(
    host: &str,
    owner: &str,
    repo: &str,
    pr_number: i64,
    comment_id: i64,
    content: &str,
    token: &str,
) -> Result<(), String> {
    let url = format!("{}/repos/{owner}/{repo}/pulls/{pr_number}/comments/{comment_id}/replies", api_root(host));
    let body = serde_json::json!({ "body": content });
    post_json(&url, token, &body).await
}

/// The `data` of a GraphQL answer, or why there is none.
///
/// GraphQL reports failure in the body, not in the status: a refused mutation — no permission to
/// resolve, a thread id that isn't one, a rate limit — comes back `200 OK` with an `errors` array and
/// `data` null or partial. Trusting the status is how a thread GitHub refused to resolve was shown
/// as resolved here. Any error fails the call, even beside partial data: none of the queries here
/// has a use for half an answer.
fn graphql_data(body: serde_json::Value) -> Result<serde_json::Value, String> {
    if let Some(errors) = body.get("errors").and_then(|e| e.as_array()).filter(|e| !e.is_empty()) {
        let messages: Vec<&str> = errors.iter().filter_map(|e| e.get("message").and_then(|m| m.as_str())).collect();
        return Err(if messages.is_empty() {
            "GitHub GraphQL returned an error".to_string()
        } else {
            format!("GitHub GraphQL: {}", messages.join("; "))
        });
    }
    match body.get("data") {
        Some(data) if !data.is_null() => Ok(data.clone()),
        _ => Err("GitHub GraphQL returned no data".to_string()),
    }
}

/// One GraphQL request, with variables rather than values spliced into the query text.
async fn graphql(host: &str, token: &str, query: &str, variables: serde_json::Value) -> Result<serde_json::Value, String> {
    let res = client()
        .post(graphql_root(host))
        .header("Authorization", bearer(token))
        .header("User-Agent", USER_AGENT)
        .json(&serde_json::json!({ "query": query, "variables": variables }))
        .send()
        .await
        .map_err(|e| format!("couldn't reach GitHub: {e}"))?;
    let status = res.status();
    let text = res.text().await.map_err(|e| format!("unexpected response from GitHub: {e}"))?;
    if !status.is_success() {
        return Err(describe(status, &text));
    }
    let body: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("unexpected response from GitHub: {e}"))?;
    graphql_data(body)
}

/// The review thread whose first comment is `comment_id`, among one page of `reviewThreads`.
///
/// Only the first comment is compared: every id this app holds for a thread is its root — the
/// comment it opened, or the root `list_pr_comment_threads` reported for a human's thread.
fn thread_rooted_at(data: &serde_json::Value, comment_id: i64) -> Option<String> {
    data["repository"]["pullRequest"]["reviewThreads"]["nodes"]
        .as_array()?
        .iter()
        .find(|thread| thread["comments"]["nodes"][0]["databaseId"].as_i64() == Some(comment_id))
        .and_then(|thread| thread["id"].as_str())
        .map(str::to_string)
}

/// Marks the review thread that owns `comment_id` as resolved — GitHub's equivalent of Azure's
/// `fixed`. There's no REST endpoint for it, so it goes through GraphQL: find the review thread
/// rooted at our comment (by `databaseId`, paging through every thread of the pull request), then
/// `resolveReviewThread` — and read back that GitHub actually resolved it. Callers that treat this
/// as best-effort still get the truth: an `Err` means the thread is still open.
pub async fn resolve_review_thread_for_comment(
    host: &str,
    owner: &str,
    repo: &str,
    pr_number: i64,
    comment_id: i64,
    token: &str,
) -> Result<(), String> {
    const FIND: &str = "query($owner: String!, $repo: String!, $number: Int!, $after: String) { \
        repository(owner: $owner, name: $repo) { pullRequest(number: $number) { \
        reviewThreads(first: 100, after: $after) { pageInfo { hasNextPage endCursor } \
        nodes { id comments(first: 1) { nodes { databaseId } } } } } } }";
    const RESOLVE: &str = "mutation($thread: ID!) { resolveReviewThread(input: { threadId: $thread }) { thread { isResolved } } }";

    let mut after: Option<String> = None;
    let mut thread_id = None;
    for _ in 0..MAX_PAGES {
        let data = graphql(
            host,
            token,
            FIND,
            serde_json::json!({ "owner": owner, "repo": repo, "number": pr_number, "after": after }),
        )
        .await?;
        thread_id = thread_rooted_at(&data, comment_id);
        let page = &data["repository"]["pullRequest"]["reviewThreads"]["pageInfo"];
        if thread_id.is_some() || page["hasNextPage"].as_bool() != Some(true) {
            break;
        }
        after = page["endCursor"].as_str().map(str::to_string);
    }
    let thread_id = thread_id.ok_or("couldn't find the review thread for this comment")?;

    let data = graphql(host, token, RESOLVE, serde_json::json!({ "thread": thread_id })).await?;
    if data["resolveReviewThread"]["thread"]["isResolved"].as_bool() != Some(true) {
        return Err("GitHub didn't resolve the review thread".to_string());
    }
    Ok(())
}

#[derive(Deserialize)]
struct RawReview {
    user: RawUser,
    state: String,
}

/// Which decision the signed-in user has already recorded on this pull request, so the app can
/// show it and stop offering a decision that's already been made.
///
/// Read from the host rather than remembered locally: the user may well have approved it from the
/// website, from another machine, or before CodeFlow ever saw this PR. GitHub keeps every review
/// ever submitted, in order, so the last one that carries a verdict wins — a `DISMISSED` review is
/// a verdict being taken back, which puts them back to having decided nothing.
pub async fn viewer_decision(
    host: &str,
    owner: &str,
    repo: &str,
    number: i64,
    token: &str,
) -> Result<String, String> {
    let login = get_authenticated_user(host, token).await?;
    let root = api_root(host);
    // Every page: the verdict is the *last* one given, and on a long-lived pull request that is
    // well past the first hundred reviews.
    let url = format!("{root}/repos/{owner}/{repo}/pulls/{number}/reviews?per_page=100");
    let reviews: Vec<RawReview> = get_all_pages(&root, &url, token).await?;
    let mut decision = "none";
    for review in reviews.iter().filter(|r| r.user.login.eq_ignore_ascii_case(&login)) {
        match review.state.to_ascii_uppercase().as_str() {
            "APPROVED" => decision = "approved",
            "CHANGES_REQUESTED" => decision = "changes_requested",
            "DISMISSED" => decision = "none",
            // `COMMENTED` and `PENDING` aren't verdicts — they leave the previous one standing.
            _ => {}
        }
    }
    Ok(decision.to_string())
}

/// Submits a review on the PR — `event` is GitHub's review verb (`"APPROVE"` or
/// `"REQUEST_CHANGES"`). GitHub infers the reviewer from the token, so no user-id lookup is
/// needed. A `REQUEST_CHANGES` review requires a non-empty body; `body` is omitted when blank so
/// an approval can carry no comment.
pub async fn submit_pr_review(
    host: &str,
    owner: &str,
    repo: &str,
    pr_number: i64,
    event: &str,
    body: &str,
    token: &str,
) -> Result<(), String> {
    let url = format!("{}/repos/{owner}/{repo}/pulls/{pr_number}/reviews", api_root(host));
    let mut payload = serde_json::json!({ "event": event });
    if !body.trim().is_empty() {
        payload["body"] = serde_json::Value::String(body.to_string());
    }
    post_json(&url, token, &payload).await
}

/// Closes the PR without merging (GitHub's `state = "closed"`).
pub async fn close_pull_request(host: &str, owner: &str, repo: &str, pr_number: i64, token: &str) -> Result<(), String> {
    let url = format!("{}/repos/{owner}/{repo}/pulls/{pr_number}", api_root(host));
    let body = serde_json::json!({ "state": "closed" });
    patch_json(&url, token, &body).await
}

#[derive(Deserialize)]
struct RawReviewComment {
    id: i64,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    line: Option<i64>,
    #[serde(rename = "start_line", default)]
    start_line: Option<i64>,
    #[serde(default)]
    body: Option<String>,
    user: RawUser,
    #[serde(rename = "created_at")]
    created_at: String,
    #[serde(rename = "in_reply_to_id", default)]
    in_reply_to_id: Option<i64>,
}

#[derive(Deserialize)]
struct RawIssueComment {
    id: i64,
    #[serde(default)]
    body: Option<String>,
    user: RawUser,
    #[serde(rename = "created_at")]
    created_at: String,
}

/// Fetches the PR's existing comments — both inline review comments (grouped into threads by
/// their reply chain) and conversation-level issue comments — so a human reviewer's feedback
/// shows alongside CodeFlow's own findings and can be resolved with AI the same way. Mirrors
/// Azure DevOps' `list_pr_comment_threads`; empty comments are dropped.
///
/// Every page of both lists. Both come oldest first, so reading only the first hundred — which is
/// what this did — dropped exactly the comments that matter most: the newest ones, including the
/// replies a re-review is supposed to answer.
pub async fn list_pr_comment_threads(
    host: &str,
    owner: &str,
    repo: &str,
    pr_number: i64,
    token: &str,
) -> Result<Vec<PrCommentThread>, String> {
    let root = api_root(host);
    let review_url = format!("{root}/repos/{owner}/{repo}/pulls/{pr_number}/comments?per_page=100");
    let review_comments: Vec<RawReviewComment> = get_all_pages(&root, &review_url, token).await?;
    Ok(group_comment_threads(
        review_comments,
        get_all_pages(&root, &format!("{root}/repos/{owner}/{repo}/issues/{pr_number}/comments?per_page=100"), token)
            .await?,
    ))
}

/// Inline review comments grouped into threads by their reply chain, followed by the conversation's
/// issue comments as threads of their own.
fn group_comment_threads(review_comments: Vec<RawReviewComment>, issue_comments: Vec<RawIssueComment>) -> Vec<PrCommentThread> {
    // Group inline comments into threads: a reply carries `in_reply_to_id` pointing at the
    // root comment; a root comment replies to nothing, so it keys on its own id. Preserve the
    // order roots first appear in.
    let mut order: Vec<i64> = Vec::new();
    let mut threads: std::collections::HashMap<i64, PrCommentThread> = std::collections::HashMap::new();

    for c in review_comments {
        let Some(content) = c.body.as_ref().map(|b| b.trim().to_string()).filter(|b| !b.is_empty()) else {
            continue;
        };
        let root_id = c.in_reply_to_id.unwrap_or(c.id);
        let comment = PrThreadComment {
            author: c.user.login,
            content,
            published_date: c.created_at,
        };
        match threads.get_mut(&root_id) {
            Some(thread) => thread.comments.push(comment),
            None => {
                order.push(root_id);
                threads.insert(
                    root_id,
                    PrCommentThread {
                        id: root_id,
                        file_path: c.path,
                        start_line: c.start_line.or(c.line),
                        end_line: c.line,
                        comments: vec![comment],
                    },
                );
            }
        }
    }

    let mut result: Vec<PrCommentThread> = order.into_iter().filter_map(|id| threads.remove(&id)).collect();

    // Conversation-level (issue) comments — no file/line — appended as their own PR-level
    // threads so nothing a reviewer wrote is dropped.
    for c in issue_comments {
        let Some(content) = c.body.as_ref().map(|b| b.trim().to_string()).filter(|b| !b.is_empty()) else {
            continue;
        };
        result.push(PrCommentThread {
            id: c.id,
            file_path: None,
            start_line: None,
            end_line: None,
            comments: vec![PrThreadComment {
                author: c.user.login,
                content,
                published_date: c.created_at,
            }],
        });
    }

    result
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/// The merge switches of a repository. GitHub only includes them for a token that can administer
/// or push to it, so each is optional: absent means "not told", never "not allowed".
#[derive(Deserialize)]
struct RawRepoSettings {
    #[serde(default)]
    allow_merge_commit: Option<bool>,
    #[serde(default)]
    allow_squash_merge: Option<bool>,
    #[serde(default)]
    allow_rebase_merge: Option<bool>,
    #[serde(default)]
    delete_branch_on_merge: Option<bool>,
}

/// The methods a repository's switches leave open, and whether the switches were readable at all.
fn allowed_methods(settings: Option<&RawRepoSettings>) -> (Vec<String>, bool) {
    let everything = || vec!["merge".to_string(), "squash".to_string(), "rebase".to_string()];
    let Some(s) = settings else { return (everything(), false) };
    if s.allow_merge_commit.is_none() && s.allow_squash_merge.is_none() && s.allow_rebase_merge.is_none() {
        return (everything(), false);
    }
    let methods: Vec<String> = [("merge", s.allow_merge_commit), ("squash", s.allow_squash_merge), ("rebase", s.allow_rebase_merge)]
        .into_iter()
        .filter(|(_, allowed)| allowed.unwrap_or(true))
        .map(|(method, _)| method.to_string())
        .collect();
    if methods.is_empty() {
        (everything(), false)
    } else {
        (methods, true)
    }
}

/// What GitHub's `mergeable_state` says about merging right now, in the shared vocabulary of
/// [`crate::ado::MergeOptions::readiness`]. `unstable` is mergeable — a check that isn't required
/// is failing — and is said as such rather than as blocked.
fn github_readiness(pr: &RawPull) -> &'static str {
    if pr.state == "closed" || pr.merged_at.is_some() {
        return "closed";
    }
    if pr.draft {
        return "draft";
    }
    match pr.mergeable_state.as_deref().unwrap_or_default() {
        "clean" | "has_hooks" => "clean",
        "dirty" => "conflicts",
        "behind" => "behind",
        "blocked" => "blocked",
        "unstable" => "checks_failing",
        "draft" => "draft",
        _ if pr.mergeable == Some(false) => "conflicts",
        _ => "unknown",
    }
}

/// Whether the head branch lives in the same repository as the base — the only case where deleting
/// it after the merge is ours to do.
fn same_repository(pr: &RawPull) -> bool {
    match (&pr.head.repo, &pr.base.repo) {
        (Some(head), Some(base)) => !head.full_name.is_empty() && head.full_name.eq_ignore_ascii_case(&base.full_name),
        _ => false,
    }
}

/// How this pull request can be merged: the methods the repository allows, whether deleting the
/// branch is offered, and what GitHub's own mergeability check says.
pub async fn merge_options(host: &str, owner: &str, repo: &str, number: i64, token: &str) -> Result<crate::ado::MergeOptions, String> {
    let root = api_root(host);
    let pr_url = format!("{root}/repos/{owner}/{repo}/pulls/{number}");
    let repo_url = format!("{root}/repos/{owner}/{repo}");
    let (pr, settings) = futures_util::join!(get_json::<RawPull>(&pr_url, token), get_json::<RawRepoSettings>(&repo_url, token));
    let pr = pr?;
    let settings = settings.ok();
    let (methods, methods_known) = allowed_methods(settings.as_ref());
    Ok(crate::ado::MergeOptions {
        default_method: methods.first().cloned(),
        methods,
        methods_known,
        squash: None,
        can_delete_source_branch: same_repository(&pr),
        delete_source_branch_default: settings.as_ref().and_then(|s| s.delete_branch_on_merge).unwrap_or(false),
        transition_work_items: None,
        readiness: github_readiness(&pr).to_string(),
        readiness_detail: pr.mergeable_state.clone(),
    })
}

/// A merge GitHub accepted.
pub struct Merged {
    pub summary: PullRequestSummary,
    /// Why the source branch is still there when deleting it was asked for. The merge stands.
    pub warning: Option<String>,
}

/// Percent-encodes a branch name for a URL path, keeping its slashes: `feature/login` is two
/// segments of the `git/refs/heads/…` address, and must stay two.
fn encode_ref_path(name: &str) -> String {
    name.split('/').map(crate::ado::encode_segment).collect::<Vec<_>>().join("/")
}

/// Merges the pull request with `method` (`merge` · `squash` · `rebase`).
///
/// The head SHA read here goes with the request, so a push landing between reading the pull request
/// and merging it is refused (409) instead of merged unseen. A refusal comes back as
/// [`crate::ado::merge_refusal`], classified. Deleting the branch afterwards is a second call that
/// can fail on its own — the merge is not undone, so that comes back as a warning.
pub async fn merge_pull_request(
    host: &str,
    owner: &str,
    repo: &str,
    number: i64,
    method: &str,
    delete_source_branch: bool,
    token: &str,
) -> Result<Merged, String> {
    if !matches!(method, "merge" | "squash" | "rebase") {
        return Err(format!("unknown merge method: {method}"));
    }
    let root = api_root(host);
    let pr_url = format!("{root}/repos/{owner}/{repo}/pulls/{number}");
    let pr: RawPull = get_json(&pr_url, token).await?;
    let res = rest(client().put(format!("{pr_url}/merge")), token)
        .json(&serde_json::json!({ "merge_method": method, "sha": pr.head.sha }))
        .send()
        .await
        .map_err(|e| format!("couldn't reach GitHub: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        let message = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("message").and_then(|m| m.as_str()).map(str::to_string))
            .unwrap_or_else(|| describe(status, &body));
        return Err(crate::ado::merge_refusal(crate::ado::classify_merge_refusal(status.as_u16(), &message), &message));
    }

    let mut warning = None;
    if delete_source_branch {
        if same_repository(&pr) {
            let url = format!("{root}/repos/{owner}/{repo}/git/refs/heads/{}", encode_ref_path(&pr.head.ref_name));
            let deleted = rest(client().delete(url), token).send().await;
            match deleted {
                // 422 "Reference does not exist": the repository deletes merged branches on its own
                // and got there first, which is the outcome that was asked for.
                Ok(res) if res.status().is_success() || res.status().as_u16() == 422 => {}
                Ok(res) => {
                    let status = res.status();
                    warning = Some(describe(status, &res.text().await.unwrap_or_default()));
                }
                Err(e) => warning = Some(format!("couldn't reach GitHub: {e}")),
            }
        } else {
            warning = Some("The source branch lives in a fork, so it wasn't deleted".to_string());
        }
    }

    Ok(Merged { summary: get_pull_request(host, owner, repo, number, token).await?, warning })
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct RawCheckApp {
    #[serde(default)]
    slug: String,
}

#[derive(Deserialize)]
struct RawCheckRun {
    #[serde(default)]
    name: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    conclusion: Option<String>,
    #[serde(default)]
    html_url: Option<String>,
    #[serde(default)]
    details_url: Option<String>,
    #[serde(default)]
    app: Option<RawCheckApp>,
}

#[derive(Deserialize)]
struct RawCheckRuns {
    #[serde(default)]
    total_count: usize,
    #[serde(default)]
    check_runs: Vec<RawCheckRun>,
}

#[derive(Deserialize)]
struct RawCommitStatus {
    #[serde(default)]
    context: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    target_url: Option<String>,
}

#[derive(Deserialize)]
struct RawCombinedStatus {
    #[serde(default)]
    statuses: Vec<RawCommitStatus>,
}

/// A check run's state in the Pipelines tab's vocabulary — the same mapping `ci::github` applies to
/// workflow jobs, so a check and the job it is read the same in both places.
fn check_run_state(status: &str, conclusion: Option<&str>) -> &'static str {
    use crate::ci::status;
    match status {
        "completed" => match conclusion.unwrap_or_default() {
            "success" => status::SUCCESS,
            "failure" | "timed_out" | "startup_failure" => status::FAILED,
            "cancelled" => status::CANCELLED,
            "skipped" | "stale" => status::SKIPPED,
            _ => status::WARNING,
        },
        "in_progress" => status::RUNNING,
        _ => status::QUEUED,
    }
}

fn commit_status_state(state: &str) -> &'static str {
    use crate::ci::status;
    match state {
        "success" => status::SUCCESS,
        "failure" | "error" => status::FAILED,
        _ => status::RUNNING,
    }
}

/// The workflow run a GitHub Actions check belongs to, out of its details address
/// (`…/actions/runs/{run}/job/{job}`) — the id the Pipelines tab knows the run by.
fn actions_run_id(url: &str) -> Option<String> {
    let at = url.find("/actions/runs/")? + "/actions/runs/".len();
    let digits: String = url[at..].chars().take_while(|c| c.is_ascii_digit()).collect();
    (!digits.is_empty()).then_some(digits)
}

fn map_check_run(run: RawCheckRun) -> crate::ado::PrCheck {
    let from_actions = run.app.as_ref().is_some_and(|app| app.slug == "github-actions");
    let url = run.details_url.clone().or(run.html_url.clone()).filter(|u| !u.trim().is_empty());
    crate::ado::PrCheck {
        kind: "check".to_string(),
        state: check_run_state(&run.status, run.conclusion.as_deref()).to_string(),
        raw_state: run.conclusion.clone().unwrap_or_else(|| run.status.clone()),
        description: None,
        pipeline_run_id: if from_actions { url.as_deref().and_then(actions_run_id) } else { None },
        url,
        required: None,
        name: run.name,
    }
}

fn map_commit_status(status: RawCommitStatus) -> crate::ado::PrCheck {
    crate::ado::PrCheck {
        kind: "status".to_string(),
        state: commit_status_state(&status.state).to_string(),
        raw_state: status.state,
        description: status.description.filter(|d| !d.trim().is_empty()),
        url: status.target_url.filter(|u| !u.trim().is_empty()),
        pipeline_run_id: None,
        required: None,
        name: status.context,
    }
}

/// The checks on the pull request's head commit: its check runs (GitHub Actions and every other
/// app) and its commit statuses (the older API that external CI still posts to).
pub async fn pr_checks(host: &str, owner: &str, repo: &str, number: i64, token: &str) -> Result<crate::ado::PrChecks, String> {
    let root = api_root(host);
    let pr: RawPull = get_json(&format!("{root}/repos/{owner}/{repo}/pulls/{number}"), token).await?;
    let sha = pr.head.sha;
    if sha.is_empty() {
        return Ok(crate::ado::PrChecks { head_sha: None, checks: Vec::new() });
    }

    let runs = async {
        let mut all: Vec<RawCheckRun> = Vec::new();
        let mut url = Some(format!("{root}/repos/{owner}/{repo}/commits/{sha}/check-runs?per_page=100&filter=latest"));
        let same_root = format!("{root}/");
        for _ in 0..MAX_PAGES {
            let Some(current) = url.take() else { break };
            let (page, next): (RawCheckRuns, Option<String>) = get_json_page(&current, token).await?;
            let total = page.total_count;
            all.extend(page.check_runs);
            if all.len() >= total {
                break;
            }
            url = next.filter(|next| next.starts_with(&same_root));
        }
        Ok::<_, String>(all)
    };
    let status_url = format!("{root}/repos/{owner}/{repo}/commits/{sha}/status?per_page=100");
    let statuses = get_json::<RawCombinedStatus>(&status_url, token);
    let (runs, statuses) = futures_util::join!(runs, statuses);
    if let (Err(e), Err(_)) = (&runs, &statuses) {
        return Err(e.clone());
    }
    let mut checks: Vec<crate::ado::PrCheck> = runs.unwrap_or_default().into_iter().map(map_check_run).collect();
    checks.extend(statuses.map(|s| s.statuses).unwrap_or_default().into_iter().map(map_commit_status));
    Ok(crate::ado::PrChecks { head_sha: Some(sha), checks })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A pull request as `GET /repos/{owner}/{repo}/pulls/{n}` answers it, trimmed to what is read.
    fn raw_pull(extra: serde_json::Value) -> RawPull {
        let mut value = serde_json::json!({
            "number": 42,
            "title": "Fix login",
            "body": null,
            "state": "open",
            "draft": false,
            "merged_at": null,
            "head": { "ref": "feature/login", "sha": "abc123", "repo": { "full_name": "example-org/example-repo" } },
            "base": { "ref": "main", "sha": "def456", "repo": { "full_name": "example-org/example-repo" } },
            "user": { "login": "ana" },
            "created_at": "2026-09-01T10:00:00Z",
            "html_url": "https://github.com/example-org/example-repo/pull/42"
        });
        if let (Some(base), Some(extra)) = (value.as_object_mut(), extra.as_object()) {
            for (key, v) in extra {
                base.insert(key.clone(), v.clone());
            }
        }
        serde_json::from_value(value).expect("a pull request")
    }

    #[test]
    fn github_com_and_enterprise_have_different_api_roots() {
        assert_eq!(api_root("github.com"), "https://api.github.com");
        assert_eq!(api_root("GitHub.com"), "https://api.github.com");
        assert_eq!(api_root("git.example.com"), "https://git.example.com/api/v3");
        assert_eq!(graphql_root("github.com"), "https://api.github.com/graphql");
        assert_eq!(graphql_root("git.example.com"), "https://git.example.com/api/graphql");
    }

    #[test]
    fn remotes_resolve_only_on_known_hosts() {
        let hosts = vec!["github.com".to_string(), "git.example.com".to_string()];
        let ssh = detect_from_remote_url("git@github.com:example-org/example-repo.git", &hosts).unwrap();
        assert_eq!((ssh.host.as_str(), ssh.owner.as_str(), ssh.repo.as_str()), ("github.com", "example-org", "example-repo"));
        let https = detect_from_remote_url("https://user:tok@GIT.EXAMPLE.COM/team/app/", &hosts).unwrap();
        assert_eq!(https.host, "git.example.com", "normalised to the connected spelling");
        assert_eq!((https.owner.as_str(), https.repo.as_str()), ("team", "app"));
        assert!(detect_from_remote_url("git@gitlab.example.com:a/b.git", &hosts).is_none());
    }

    #[test]
    fn states_collapse_into_the_four_buckets() {
        assert_eq!(bucket_status("open", false, &None), "open");
        assert_eq!(bucket_status("open", true, &None), "draft");
        assert_eq!(bucket_status("closed", false, &None), "closed");
        assert_eq!(bucket_status("closed", false, &Some("2026-09-02T00:00:00Z".into())), "merged");
    }

    #[test]
    fn a_pull_request_maps_onto_the_shared_summary() {
        let pr = map_pull(raw_pull(serde_json::json!({ "body": "Arregla el login" })));
        assert_eq!(pr.id, 42);
        assert_eq!(pr.description, "Arregla el login");
        assert_eq!((pr.source_branch.as_str(), pr.target_branch.as_str()), ("feature/login", "main"));
        assert_eq!(pr.author, "ana");
        assert_eq!(pr.provider, "github");
        assert_eq!(map_pull(raw_pull(serde_json::json!({}))).description, "", "a null body is an empty one");
    }

    /// Open is the default, every scope pages, and newest comes first.
    #[test]
    fn list_urls_carry_scope_page_and_order() {
        let url = pulls_page_url("github.com", "o", "r", crate::ado::PrListScope::Open, 1);
        assert_eq!(url, "https://api.github.com/repos/o/r/pulls?state=open&per_page=50&page=1&sort=created&direction=desc");
        assert!(pulls_page_url("github.com", "o", "r", crate::ado::PrListScope::Closed, 3).contains("state=closed&per_page=50&page=3"));
        assert!(pulls_page_url("github.com", "o", "r", crate::ado::PrListScope::All, 0).contains("page=1"), "page 0 is page 1");
    }

    #[test]
    fn the_next_page_comes_from_the_link_header() {
        let header = r#"<https://api.github.com/repositories/1/pulls?page=2>; rel="next", <https://api.github.com/repositories/1/pulls?page=9>; rel="last""#;
        assert_eq!(next_link(header).as_deref(), Some("https://api.github.com/repositories/1/pulls?page=2"));
        let last_page = r#"<https://api.github.com/repositories/1/pulls?page=1>; rel="first", <https://api.github.com/repositories/1/pulls?page=8>; rel="prev""#;
        assert_eq!(next_link(last_page), None);
        assert_eq!(next_link(""), None);
    }

    /// GraphQL answers 200 with `errors` when it refuses; that is a failure, whatever the status.
    #[test]
    fn graphql_errors_are_failures_even_with_a_200() {
        let refused = serde_json::json!({
            "data": { "resolveReviewThread": null },
            "errors": [{ "type": "FORBIDDEN", "message": "Resource not accessible by integration" }]
        });
        assert_eq!(graphql_data(refused).unwrap_err(), "GitHub GraphQL: Resource not accessible by integration");
        assert!(graphql_data(serde_json::json!({ "data": null })).is_err());
        assert!(graphql_data(serde_json::json!({ "errors": [{}] })).is_err());
        let ok = graphql_data(serde_json::json!({ "data": { "x": 1 }, "errors": [] })).unwrap();
        assert_eq!(ok["x"], 1);
    }

    #[test]
    fn a_thread_is_found_by_its_root_comment() {
        let data = serde_json::json!({ "repository": { "pullRequest": { "reviewThreads": { "nodes": [
            { "id": "T1", "comments": { "nodes": [{ "databaseId": 10 }] } },
            { "id": "T2", "comments": { "nodes": [{ "databaseId": 20 }] } }
        ] } } } });
        assert_eq!(thread_rooted_at(&data, 20).as_deref(), Some("T2"));
        assert_eq!(thread_rooted_at(&data, 30), None);
    }

    #[test]
    fn errors_read_as_the_message_github_wrote() {
        let body = r#"{"message":"Validation Failed","errors":[{"resource":"PullRequestReviewComment","code":"custom","field":"pull_request_review_thread.line","message":"could not be resolved"}],"documentation_url":"https://docs.github.com"}"#;
        let error = describe(reqwest::StatusCode::UNPROCESSABLE_ENTITY, body);
        assert_eq!(error, "GitHub returned 422 Unprocessable Entity: Validation Failed (could not be resolved)");
        assert!(is_unanchorable(&error));
        assert!(!is_unanchorable(&describe(reqwest::StatusCode::FORBIDDEN, r#"{"message":"Forbidden"}"#)));
        let field_code = describe(reqwest::StatusCode::UNPROCESSABLE_ENTITY, r#"{"message":"Validation Failed","errors":[{"field":"line","code":"invalid"}]}"#);
        assert!(field_code.ends_with("Validation Failed (line: invalid)"), "{field_code}");
        assert!(describe(reqwest::StatusCode::BAD_GATEWAY, "<html>").ends_with(": <html>"));
    }

    #[test]
    fn repository_switches_decide_the_methods() {
        let only_squash: RawRepoSettings = serde_json::from_value(serde_json::json!({
            "allow_merge_commit": false, "allow_squash_merge": true, "allow_rebase_merge": false
        }))
        .unwrap();
        assert_eq!(allowed_methods(Some(&only_squash)), (vec!["squash".to_string()], true));
        // Without push access GitHub leaves the switches out: nothing is known, everything is offered.
        let hidden: RawRepoSettings = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(allowed_methods(Some(&hidden)).1, false);
        assert_eq!(allowed_methods(None).0.len(), 3);
    }

    #[test]
    fn mergeable_state_becomes_readiness() {
        let with = |state: &str| raw_pull(serde_json::json!({ "mergeable_state": state }));
        assert_eq!(github_readiness(&with("clean")), "clean");
        assert_eq!(github_readiness(&with("dirty")), "conflicts");
        assert_eq!(github_readiness(&with("blocked")), "blocked");
        assert_eq!(github_readiness(&with("unstable")), "checks_failing");
        assert_eq!(github_readiness(&with("behind")), "behind");
        assert_eq!(github_readiness(&raw_pull(serde_json::json!({ "draft": true }))), "draft");
        assert_eq!(github_readiness(&raw_pull(serde_json::json!({ "state": "closed" }))), "closed");
        assert_eq!(github_readiness(&raw_pull(serde_json::json!({}))), "unknown", "not computed yet");
    }

    /// Deleting the source branch is only ours to do when it lives in the same repository.
    #[test]
    fn a_fork_branch_is_not_ours_to_delete() {
        assert!(same_repository(&raw_pull(serde_json::json!({}))));
        let fork = raw_pull(serde_json::json!({
            "head": { "ref": "patch-1", "sha": "a", "repo": { "full_name": "someone/example-repo" } }
        }));
        assert!(!same_repository(&fork));
        let deleted_fork = raw_pull(serde_json::json!({ "head": { "ref": "patch-1", "sha": "a", "repo": null } }));
        assert!(!same_repository(&deleted_fork));
        assert_eq!(encode_ref_path("feature/a b#1"), "feature/a%20b%231");
    }

    #[test]
    fn check_runs_map_onto_the_pipelines_vocabulary() {
        use crate::ci::status;
        assert_eq!(check_run_state("completed", Some("success")), status::SUCCESS);
        assert_eq!(check_run_state("completed", Some("timed_out")), status::FAILED);
        assert_eq!(check_run_state("completed", Some("neutral")), status::WARNING);
        assert_eq!(check_run_state("completed", Some("skipped")), status::SKIPPED);
        assert_eq!(check_run_state("in_progress", None), status::RUNNING);
        assert_eq!(check_run_state("queued", None), status::QUEUED);
        assert_eq!(commit_status_state("pending"), status::RUNNING);
        assert_eq!(commit_status_state("error"), status::FAILED);
    }

    /// An Actions check knows its workflow run, which is what links it into the Pipelines tab; a
    /// check from another app does not, even if its address happens to look alike.
    #[test]
    fn an_actions_check_knows_its_workflow_run() {
        let runs: RawCheckRuns = serde_json::from_value(serde_json::json!({
            "total_count": 2,
            "check_runs": [
                { "name": "build", "status": "completed", "conclusion": "failure",
                  "details_url": "https://github.com/example-org/example-repo/actions/runs/123456/job/789",
                  "app": { "slug": "github-actions" } },
                { "name": "external", "status": "in_progress", "conclusion": null,
                  "details_url": "https://ci.example.com/actions/runs/1", "app": { "slug": "example-ci" } }
            ]
        }))
        .unwrap();
        let checks: Vec<crate::ado::PrCheck> = runs.check_runs.into_iter().map(map_check_run).collect();
        assert_eq!(checks[0].pipeline_run_id.as_deref(), Some("123456"));
        assert_eq!(checks[0].state, crate::ci::status::FAILED);
        assert_eq!(checks[0].raw_state, "failure");
        assert_eq!(checks[1].pipeline_run_id, None);
        assert_eq!(checks[1].raw_state, "in_progress");
        assert_eq!(actions_run_id("https://github.com/o/r/pull/4"), None);
    }

    #[test]
    fn replies_are_grouped_under_their_root_comment() {
        let review: Vec<RawReviewComment> = serde_json::from_value(serde_json::json!([
            { "id": 1, "path": "src/a.ts", "line": 12, "body": "¿Y si es null?", "user": { "login": "ana" }, "created_at": "2026-09-01T10:00:00Z" },
            { "id": 2, "body": "Corregido", "user": { "login": "bea" }, "created_at": "2026-09-01T11:00:00Z", "in_reply_to_id": 1 },
            { "id": 3, "path": "src/b.ts", "line": 3, "body": "   ", "user": { "login": "ana" }, "created_at": "2026-09-01T12:00:00Z" }
        ]))
        .unwrap();
        let issue: Vec<RawIssueComment> = serde_json::from_value(serde_json::json!([
            { "id": 9, "body": "LGTM", "user": { "login": "carla" }, "created_at": "2026-09-02T10:00:00Z" }
        ]))
        .unwrap();
        let threads = group_comment_threads(review, issue);
        assert_eq!(threads.len(), 2, "the blank comment is dropped");
        assert_eq!(threads[0].id, 1);
        assert_eq!(threads[0].comments.len(), 2);
        assert_eq!(threads[0].file_path.as_deref(), Some("src/a.ts"));
        assert_eq!(threads[1].id, 9);
        assert_eq!(threads[1].file_path, None);
    }
}
