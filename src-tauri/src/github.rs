use serde::{Deserialize, Serialize};

// The shared, provider-neutral PR wire types (`PullRequestSummary`, `PrCommentThread`,
// `PrThreadComment`) live in `crate::ado` — they're what the frontend already consumes, so
// GitHub produces the exact same shapes rather than a parallel set the UI would have to learn.
use crate::ado::{PrCommentThread, PrThreadComment, PullRequestSummary};

/// GitHub pins REST behavior to a dated API version via this header; sending it keeps us on a
/// known contract instead of whatever "latest" happens to be.
const API_VERSION: &str = "2022-11-28";
/// GitHub rejects any request without a User-Agent (403), unlike Azure DevOps.
const USER_AGENT: &str = "CodeFlow";
/// The canonical public host — everything else is treated as a GitHub Enterprise Server.
pub const GITHUB_COM: &str = "github.com";

/// The REST API base for a host. GitHub.com serves its API from a dedicated `api.` subdomain;
/// a GitHub Enterprise Server serves it from `https://<host>/api/v3` on the same host.
fn api_root(host: &str) -> String {
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

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

/// Both classic and fine-grained personal access tokens authenticate as a Bearer token on the
/// modern REST API, so a single scheme covers whatever the user pasted.
fn bearer(token: &str) -> String {
    format!("Bearer {token}")
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
    let res = client()
        .get(url)
        .header("Authorization", bearer(token))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", USER_AGENT)
        .header("X-GitHub-Api-Version", API_VERSION)
        .send()
        .await
        .map_err(|e| format!("couldn't reach GitHub: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("GitHub returned {status}: {body}"));
    }
    res.json::<T>().await.map_err(|e| format!("unexpected response from GitHub: {e}"))
}

async fn post_json(url: &str, token: &str, body: &serde_json::Value) -> Result<(), String> {
    let res = client()
        .post(url)
        .header("Authorization", bearer(token))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", USER_AGENT)
        .header("X-GitHub-Api-Version", API_VERSION)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("couldn't reach GitHub: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("GitHub returned {status}: {body}"));
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
    let res = client()
        .post(url)
        .header("Authorization", bearer(token))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", USER_AGENT)
        .header("X-GitHub-Api-Version", API_VERSION)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("couldn't reach GitHub: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("GitHub returned {status}: {body}"));
    }
    res.json::<T>().await.map_err(|e| format!("unexpected response from GitHub: {e}"))
}

async fn patch_json(url: &str, token: &str, body: &serde_json::Value) -> Result<(), String> {
    let res = client()
        .patch(url)
        .header("Authorization", bearer(token))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", USER_AGENT)
        .header("X-GitHub-Api-Version", API_VERSION)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("couldn't reach GitHub: {e}"))?;
    let status = res.status();
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("GitHub returned {status}: {body}"));
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

#[derive(Deserialize)]
struct RawRef {
    #[serde(rename = "ref")]
    ref_name: String,
    #[serde(default)]
    sha: String,
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

pub async fn list_pull_requests(host: &str, owner: &str, repo: &str, token: &str) -> Result<Vec<PullRequestSummary>, String> {
    let url = format!(
        "{}/repos/{owner}/{repo}/pulls?state=all&per_page=100&sort=created&direction=desc",
        api_root(host)
    );
    let raw: Vec<RawPull> = get_json(&url, token).await?;
    Ok(raw.into_iter().map(map_pull).collect())
}

/// Fetches a single pull request by number. Unlike [`list_pull_requests`] this reaches a PR
/// regardless of how old it is (the list is paginated), which is what a pasted link needs.
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

/// Marks the review thread that owns `comment_id` as resolved — GitHub's equivalent of Azure's
/// `fixed`. There's no REST endpoint for it, so it goes through GraphQL: find the review thread
/// whose comments include our comment (by `databaseId`), then `resolveReviewThread`. Best-effort by
/// design at the call site — a failure just leaves the thread open, it never fails the post.
pub async fn resolve_review_thread_for_comment(
    host: &str,
    owner: &str,
    repo: &str,
    pr_number: i64,
    comment_id: i64,
    token: &str,
) -> Result<(), String> {
    let graphql = graphql_root(host);
    // 1) Find the thread node id whose comments contain this databaseId.
    let query = format!(
        r#"query {{ repository(owner: "{owner}", name: "{repo}") {{ pullRequest(number: {pr_number}) {{ reviewThreads(first: 100) {{ nodes {{ id isResolved comments(first: 100) {{ nodes {{ databaseId }} }} }} }} }} }} }}"#
    );
    let res = client()
        .post(&graphql)
        .header("Authorization", bearer(token))
        .header("User-Agent", USER_AGENT)
        .json(&serde_json::json!({ "query": query }))
        .send()
        .await
        .map_err(|e| format!("couldn't reach GitHub: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("GitHub GraphQL returned {}", res.status()));
    }
    let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let threads = data["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"]
        .as_array()
        .ok_or("no review threads in GraphQL response")?;
    let thread_id = threads.iter().find_map(|t| {
        let has = t["comments"]["nodes"]
            .as_array()
            .map(|cs| cs.iter().any(|c| c["databaseId"].as_i64() == Some(comment_id)))
            .unwrap_or(false);
        if has { t["id"].as_str().map(str::to_string) } else { None }
    });
    let thread_id = thread_id.ok_or("couldn't find the review thread for this comment")?;

    // 2) Resolve it.
    let mutation = format!(r#"mutation {{ resolveReviewThread(input: {{ threadId: "{thread_id}" }}) {{ thread {{ isResolved }} }} }}"#);
    let res = client()
        .post(&graphql)
        .header("Authorization", bearer(token))
        .header("User-Agent", USER_AGENT)
        .json(&serde_json::json!({ "query": mutation }))
        .send()
        .await
        .map_err(|e| format!("couldn't reach GitHub: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("GitHub GraphQL resolve returned {}", res.status()));
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
    let url = format!("{}/repos/{owner}/{repo}/pulls/{number}/reviews?per_page=100", api_root(host));
    let reviews: Vec<RawReview> = get_json(&url, token).await?;
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
pub async fn list_pr_comment_threads(
    host: &str,
    owner: &str,
    repo: &str,
    pr_number: i64,
    token: &str,
) -> Result<Vec<PrCommentThread>, String> {
    let root = api_root(host);
    let review_url = format!("{root}/repos/{owner}/{repo}/pulls/{pr_number}/comments?per_page=100");
    let review_comments: Vec<RawReviewComment> = get_json(&review_url, token).await?;

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
    let issue_url = format!("{root}/repos/{owner}/{repo}/issues/{pr_number}/comments?per_page=100");
    let issue_comments: Vec<RawIssueComment> = get_json(&issue_url, token).await?;
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

    Ok(result)
}
