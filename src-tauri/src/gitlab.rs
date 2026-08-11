//! GitLab as a third VCS host, alongside Azure DevOps and GitHub.
//!
//! The wire types are the provider-neutral ones in [`crate::ado`] — `PullRequestSummary`,
//! `PrCommentThread`, `PrThreadComment` — because the frontend already consumes those. A merge
//! request comes out of here shaped exactly like a pull request, which is what lets the sidebar,
//! the review pipeline and the comment panel stay provider-agnostic.
//!
//! Four things about GitLab differ from GitHub enough to shape this file:
//!
//! - **A project is one path, not an owner and a repo.** Groups nest arbitrarily, so
//!   `acme/backend/services/auth` is an ordinary project and there is nothing to split off the
//!   front of it. That full path, URL-encoded, *is* the API's project id — which is why it is
//!   stored whole (`projects.gitlab_project`) rather than as a pair.
//! - **`iid` is not `id`.** Every merge request has a global `id` and a per-project `iid`; the
//!   number in the URL, and the one every endpoint here takes, is the `iid`. Using `id` would
//!   silently address a different merge request in another project.
//! - **An inline comment needs a `position` object**, not a line number: GitLab wants the three
//!   SHAs of the diff it is anchored to (`base_sha`, `start_sha`, `head_sha`) alongside the path
//!   and line. They come from the merge request's own `diff_refs`, read fresh before posting.
//! - **Threads are "discussions", keyed by a SHA string.** CodeFlow's finding memory stores a
//!   thread id as an integer, so what is recorded here is the root *note* id (which is an integer)
//!   and the discussion is looked up from it when replying or resolving — the same shape as the
//!   GitHub GraphQL lookup, and for the same reason.

use serde::{Deserialize, Serialize};

use crate::ado::{PrCommentThread, PrThreadComment, PullRequestSummary};

/// The canonical public host — everything else is treated as a self-managed GitLab instance.
pub const GITLAB_COM: &str = "gitlab.com";

/// gitlab.com and a self-managed instance serve the API from the same place: `/api/v4` on the
/// host itself. There is no `api.` subdomain to special-case, unlike GitHub.
fn api_root(host: &str) -> String {
    format!("https://{host}/api/v4")
}

/// One client for the process, cloned per call — see `crate::github::client` for why building a
/// rustls client per request cost a full TLS handshake and an unshared connection pool every time.
/// Nothing here varies the transport per call, so the pool is pure gain.
fn client() -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new).clone()
}

/// Percent-encodes a project path for use as a path segment.
///
/// The slashes are the point: `acme/backend/auth` has to reach GitLab as `acme%2Fbackend%2Fauth`,
/// or the router reads it as three segments and answers 404. Everything outside the unreserved set
/// is encoded, which also covers the `.` and `-` that project paths are full of (harmlessly) and
/// the spaces that a hand-typed path occasionally carries.
fn encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len() + 8);
    for byte in path.trim_matches('/').bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[derive(Debug, Clone, Serialize)]
pub struct DetectedGitlabRepo {
    /// `gitlab.com` or a self-managed hostname — picks both the token and the API base URL.
    pub host: String,
    /// The full path with every group in it.
    pub project: String,
}

/// Splits a git remote URL into `(host, path)` — the same shapes `github::detect_from_remote_url`
/// handles: scheme URLs with optional credentials, and the scp-like `git@host:group/repo` form.
fn split_host_path(remote_url: &str) -> Option<(String, String)> {
    let url = remote_url.trim().trim_end_matches('/');
    let url = url.strip_suffix(".git").unwrap_or(url);

    if let Some(index) = url.find("://") {
        let after = &url[index + 3..];
        let after = after.rsplit('@').next().unwrap_or(after);
        let (host, path) = after.split_once('/')?;
        return Some((host.to_string(), path.to_string()));
    }

    let after = url.rsplit('@').next().unwrap_or(url);
    let (host, path) = after.split_once(':')?;
    Some((host.to_string(), path.to_string()))
}

/// Recognizes a GitLab remote, but **only** on a host already known to be GitLab (`gitlab.com`
/// plus whatever self-managed hosts the user has connected).
///
/// The allowlist matters more here than it does for GitHub: a GitLab path has no fixed number of
/// segments, so `git@example.com:a/b/c.git` is a perfectly plausible GitLab remote *and* a
/// perfectly plausible anything-else. Without the allowlist this would claim every self-hosted git
/// server in existence.
pub fn detect_from_remote_url(remote_url: &str, known_hosts: &[String]) -> Option<DetectedGitlabRepo> {
    let (host, path) = split_host_path(remote_url)?;
    let matched = known_hosts.iter().find(|h| h.eq_ignore_ascii_case(&host))?;
    let project = path.trim_matches('/').trim_end_matches(".git").to_string();
    // A bare `host/name` with nothing before it is not a project — GitLab always has at least a
    // namespace and a project.
    if project.split('/').filter(|s| !s.is_empty()).count() < 2 {
        return None;
    }
    Some(DetectedGitlabRepo { host: matched.clone(), project })
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/// `PRIVATE-TOKEN` rather than a bearer: it is the header GitLab documents for personal and
/// project access tokens, and it is the one that works on every version back to the ones a
/// self-managed instance is likely to be pinned to.
fn authed(request: reqwest::RequestBuilder, token: &str) -> reqwest::RequestBuilder {
    request.header("PRIVATE-TOKEN", token)
}

/// GitLab's errors are `{"message": …}` or `{"error": …}`, and the message is sometimes an object
/// keyed by field. All three are more use than a bare status code.
fn describe(status: reqwest::StatusCode, body: &str) -> String {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        for key in ["message", "error", "error_description"] {
            match value.get(key) {
                Some(serde_json::Value::String(text)) => return format!("GitLab: {text}"),
                Some(other @ serde_json::Value::Object(_)) => {
                    return format!("GitLab: {other}");
                }
                _ => {}
            }
        }
    }
    let excerpt: String = body.chars().take(300).collect();
    format!("GitLab returned {status}: {excerpt}")
}

async fn get_json<T: for<'de> Deserialize<'de>>(url: &str, token: &str) -> Result<T, String> {
    let response = authed(client().get(url), token)
        .send()
        .await
        .map_err(|e| format!("couldn't reach GitLab: {e}"))?;
    let status = response.status();
    let body = response.text().await.map_err(|e| format!("unexpected response from GitLab: {e}"))?;
    if !status.is_success() {
        return Err(describe(status, &body));
    }
    serde_json::from_str(&body).map_err(|e| format!("unexpected response from GitLab: {e}"))
}

async fn send_json<T: for<'de> Deserialize<'de>>(
    request: reqwest::RequestBuilder,
    token: &str,
    body: &serde_json::Value,
) -> Result<T, String> {
    let response = authed(request, token)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("couldn't reach GitLab: {e}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| format!("unexpected response from GitLab: {e}"))?;
    if !status.is_success() {
        return Err(describe(status, &text));
    }
    serde_json::from_str(&text).map_err(|e| format!("unexpected response from GitLab: {e}"))
}

/// For the endpoints whose response is of no interest — only that they succeeded.
async fn send_ignoring_body(
    request: reqwest::RequestBuilder,
    token: &str,
    body: &serde_json::Value,
) -> Result<(), String> {
    let response = authed(request, token)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("couldn't reach GitLab: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(describe(status, &text));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Merge requests
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct RawAuthor {
    #[serde(default)]
    username: String,
}

/// The three SHAs an inline comment has to be anchored to. Absent on a merge request with no
/// diff yet (an empty branch), which is why every field is optional.
#[derive(Deserialize, Default, Clone)]
struct DiffRefs {
    #[serde(default)]
    base_sha: Option<String>,
    #[serde(default)]
    head_sha: Option<String>,
    #[serde(default)]
    start_sha: Option<String>,
}

#[derive(Deserialize)]
struct RawMergeRequest {
    /// The per-project number — what the URL shows and what every endpoint takes.
    iid: i64,
    title: String,
    #[serde(default)]
    description: Option<String>,
    /// `opened` | `closed` | `merged` | `locked`.
    state: String,
    /// GitLab 14.0+. Older instances only carry `work_in_progress`, so both are read.
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    work_in_progress: bool,
    source_branch: String,
    target_branch: String,
    author: RawAuthor,
    created_at: String,
    web_url: String,
    /// The three SHAs a diff note has to be anchored to. Read straight off the merge request
    /// rather than from a separate "versions" call, because it is already in this response and an
    /// anchored comment must use the refs of the diff it is being placed on.
    #[serde(default)]
    diff_refs: Option<DiffRefs>,
}

/// Collapses GitLab's state plus its draft flag into the same four buckets the sidebar groups by,
/// matching `github::bucket_status` and Azure's.
///
/// `locked` is a merged-or-closed merge request whose discussion has been frozen; it is reported as
/// closed rather than as a fifth bucket the UI has no column for.
fn bucket_status(state: &str, draft: bool) -> String {
    match state {
        "merged" => "merged".to_string(),
        "closed" | "locked" => "closed".to_string(),
        _ if draft => "draft".to_string(),
        _ => "open".to_string(),
    }
}

fn map_merge_request(mr: RawMergeRequest) -> PullRequestSummary {
    PullRequestSummary {
        id: mr.iid,
        title: mr.title,
        description: mr.description.unwrap_or_default(),
        status: bucket_status(&mr.state, mr.draft || mr.work_in_progress),
        source_branch: mr.source_branch,
        target_branch: mr.target_branch,
        author: mr.author.username,
        created_at: mr.created_at,
        url: mr.web_url,
        provider: "gitlab".to_string(),
    }
}

/// Validates a token against a host and returns the username it belongs to — what Settings uses to
/// confirm a pasted token works, and whose account it is, the moment it is saved.
pub async fn get_authenticated_user(host: &str, token: &str) -> Result<String, String> {
    #[derive(Deserialize)]
    struct RawUser {
        username: String,
    }
    let url = format!("{}/user", api_root(host));
    let user: RawUser = get_json(&url, token).await?;
    Ok(user.username)
}

pub async fn list_merge_requests(
    host: &str,
    project: &str,
    token: &str,
) -> Result<Vec<PullRequestSummary>, String> {
    let url = format!(
        "{}/projects/{}/merge_requests?state=all&per_page=100&order_by=created_at&sort=desc",
        api_root(host),
        encode_path(project)
    );
    let raw: Vec<RawMergeRequest> = get_json(&url, token).await?;
    Ok(raw.into_iter().map(map_merge_request).collect())
}

async fn fetch_merge_request(
    host: &str,
    project: &str,
    iid: i64,
    token: &str,
) -> Result<RawMergeRequest, String> {
    let url = format!(
        "{}/projects/{}/merge_requests/{iid}",
        api_root(host),
        encode_path(project)
    );
    get_json(&url, token).await
}

/// One merge request by its `iid`. Unlike the list this reaches a merge request however old it is,
/// which is what a pasted link needs.
pub async fn get_merge_request(
    host: &str,
    project: &str,
    iid: i64,
    token: &str,
) -> Result<PullRequestSummary, String> {
    Ok(map_merge_request(fetch_merge_request(host, project, iid, token).await?))
}

// GitHub's client exposes a `head_sha_for` because its review-comment endpoint takes a bare
// `commit_id` the caller has to supply. GitLab needs three SHAs rather than one, and only ever
// together, so [`post_pr_comment_anchored`] reads them itself instead of making every call site
// fetch them and hand them back.

#[derive(Deserialize)]
struct RawChange {
    old_path: String,
    new_path: String,
    #[serde(default)]
    new_file: bool,
    #[serde(default)]
    deleted_file: bool,
    /// The hunks, without any `diff --git` / `---` / `+++` header. Empty for a binary file.
    #[serde(default)]
    diff: String,
}

/// The merge request's unified diff, read from the host rather than from a local clone — this is
/// what makes reviewing from nothing but a link possible.
///
/// GitLab has no "give me the whole thing as a patch" API endpoint the way GitHub's `diff` media
/// type does, so the diff is reassembled from the per-file changes. Each entry carries only its
/// hunks, so the headers every diff parser keys on have to be put back — the same reconstruction
/// `github::pull_request_diff_from_files` does, for the same reason.
pub async fn merge_request_diff(
    host: &str,
    project: &str,
    iid: i64,
    token: &str,
) -> Result<String, String> {
    let root = api_root(host);
    let encoded = encode_path(project);
    let mut out = String::new();

    // `/diffs` is the paginated endpoint (GitLab 15.7+). On an older instance it 404s, and the
    // whole set comes from the `changes` field of the merge request itself instead.
    for page in 1..=3u32 {
        let url = format!("{root}/projects/{encoded}/merge_requests/{iid}/diffs?per_page=100&page={page}");
        match get_json::<Vec<RawChange>>(&url, token).await {
            Ok(changes) => {
                let count = changes.len();
                for change in &changes {
                    push_change(&mut out, change);
                }
                if count < 100 {
                    break;
                }
            }
            Err(_) if page == 1 => {
                #[derive(Deserialize)]
                struct WithChanges {
                    #[serde(default)]
                    changes: Vec<RawChange>,
                }
                let url = format!("{root}/projects/{encoded}/merge_requests/{iid}/changes");
                let payload: WithChanges = get_json(&url, token).await?;
                for change in &payload.changes {
                    push_change(&mut out, change);
                }
                break;
            }
            Err(message) => return Err(message),
        }
    }

    if out.trim().is_empty() {
        return Err("GitLab reported no changed files for this merge request".to_string());
    }
    Ok(out)
}

/// One file's entry in the reassembled diff. A file with no hunks — binary, or one GitLab declined
/// to render — is listed as a bare header, which is honest: the review is told the file changed but
/// not how, rather than being told nothing.
fn push_change(out: &mut String, change: &RawChange) {
    let old_path = if change.new_file {
        "/dev/null".to_string()
    } else {
        format!("a/{}", change.old_path)
    };
    let new_path = if change.deleted_file {
        "/dev/null".to_string()
    } else {
        format!("b/{}", change.new_path)
    };
    out.push_str(&format!(
        "diff --git a/{} b/{}\n--- {old_path}\n+++ {new_path}\n",
        change.old_path, change.new_path
    ));
    if change.diff.trim().is_empty() {
        out.push_str("(binary or too large to display)\n");
    } else {
        out.push_str(&change.diff);
        if !change.diff.ends_with('\n') {
            out.push('\n');
        }
    }
}

/// Opens a merge request. The branch must already exist on the remote.
///
/// GitLab has no `draft` field on creation — a merge request is a draft when its **title** starts
/// with `Draft:`, which is a convention the API and the web UI both read. So the flag is applied by
/// prefixing the title, and a title the user already prefixed is left alone rather than doubled.
#[allow(clippy::too_many_arguments)]
pub async fn create_merge_request(
    host: &str,
    project: &str,
    title: &str,
    description: &str,
    source_branch: &str,
    target_branch: &str,
    draft: bool,
    token: &str,
) -> Result<PullRequestSummary, String> {
    let already_draft = title.trim_start().to_ascii_lowercase().starts_with("draft:");
    let final_title = if draft && !already_draft {
        format!("Draft: {title}")
    } else {
        title.to_string()
    };
    let url = format!("{}/projects/{}/merge_requests", api_root(host), encode_path(project));
    let payload = serde_json::json!({
        "source_branch": source_branch,
        "target_branch": target_branch,
        "title": final_title,
        "description": description,
    });
    let raw: RawMergeRequest = send_json(client().post(&url), token, &payload).await?;
    Ok(map_merge_request(raw))
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct RawPosition {
    #[serde(default)]
    new_path: Option<String>,
    #[serde(default)]
    old_path: Option<String>,
    #[serde(default)]
    new_line: Option<i64>,
    #[serde(default)]
    old_line: Option<i64>,
}

#[derive(Deserialize)]
struct RawNote {
    id: i64,
    #[serde(default)]
    body: Option<String>,
    author: RawAuthor,
    created_at: String,
    /// True for the "changed the title", "added a commit" entries GitLab records as notes. They
    /// are not comments and must not show up as one.
    #[serde(default)]
    system: bool,
    #[serde(default)]
    position: Option<RawPosition>,
}

#[derive(Deserialize)]
struct RawDiscussion {
    id: String,
    #[serde(default)]
    notes: Vec<RawNote>,
}

async fn list_discussions(
    host: &str,
    project: &str,
    iid: i64,
    token: &str,
) -> Result<Vec<RawDiscussion>, String> {
    let url = format!(
        "{}/projects/{}/merge_requests/{iid}/discussions?per_page=100",
        api_root(host),
        encode_path(project)
    );
    get_json(&url, token).await
}

/// The merge request's existing conversations — inline diff notes and plain comments alike — so a
/// human reviewer's feedback shows alongside CodeFlow's own findings and can be answered the same
/// way. Mirrors `github::list_pr_comment_threads`.
///
/// The thread's id is its **root note's** id rather than GitLab's own discussion id, which is a
/// SHA string: the finding memory records a thread as an integer, and every reply and resolve here
/// looks the discussion back up from a note id anyway.
pub async fn list_pr_comment_threads(
    host: &str,
    project: &str,
    iid: i64,
    token: &str,
) -> Result<Vec<PrCommentThread>, String> {
    let discussions = list_discussions(host, project, iid, token).await?;
    let mut threads = Vec::new();

    for discussion in discussions {
        let mut comments = Vec::new();
        let mut file_path = None;
        let mut start_line = None;
        let mut end_line = None;

        for note in &discussion.notes {
            if note.system {
                continue;
            }
            let Some(content) = note
                .body
                .as_ref()
                .map(|b| b.trim().to_string())
                .filter(|b| !b.is_empty())
            else {
                continue;
            };
            if file_path.is_none() {
                if let Some(position) = &note.position {
                    file_path = position.new_path.clone().or_else(|| position.old_path.clone());
                    // A comment on a deleted line has only `old_line`; reporting that is better
                    // than reporting no line at all.
                    let line = position.new_line.or(position.old_line);
                    start_line = line;
                    end_line = line;
                }
            }
            comments.push(PrThreadComment {
                author: note.author.username.clone(),
                content,
                published_date: note.created_at.clone(),
            });
        }

        // A discussion of nothing but system notes is not a conversation.
        if comments.is_empty() {
            continue;
        }
        let root_id = discussion.notes.iter().find(|n| !n.system).map(|n| n.id).unwrap_or(0);
        threads.push(PrCommentThread {
            id: root_id,
            file_path,
            start_line,
            end_line,
            comments,
        });
    }

    Ok(threads)
}

/// Which discussion a note belongs to. GitLab addresses replies and resolution by discussion id (a
/// SHA), and CodeFlow only ever remembers the integer note id — so the mapping is looked up, the
/// same way the GitHub path resolves a review thread from a comment's `databaseId`.
async fn discussion_of_note(
    host: &str,
    project: &str,
    iid: i64,
    note_id: i64,
    token: &str,
) -> Result<String, String> {
    let discussions = list_discussions(host, project, iid, token).await?;
    discussions
        .into_iter()
        .find(|d| d.notes.iter().any(|n| n.id == note_id))
        .map(|d| d.id)
        .ok_or_else(|| "couldn't find the discussion for this comment".to_string())
}

/// Posts an inline comment anchored to a file and line — GitLab's equivalent of a GitHub review
/// comment, and it needs rather more: the `position` object carries the three SHAs of the diff the
/// line belongs to, which is why the merge request is re-read first. Returns the root note's id so
/// a re-review can reply to the same conversation instead of opening a second one.
#[allow(clippy::too_many_arguments)]
pub async fn post_pr_comment_anchored(
    host: &str,
    project: &str,
    iid: i64,
    content: &str,
    file_path: &str,
    start_line: i64,
    end_line: i64,
    token: &str,
) -> Result<i64, String> {
    let mr = fetch_merge_request(host, project, iid, token).await?;
    let refs = mr.diff_refs.clone().unwrap_or_default();
    let (Some(base_sha), Some(head_sha)) = (refs.base_sha.clone(), refs.head_sha.clone()) else {
        return Err("GitLab didn't report the diff this merge request is against".to_string());
    };
    // `start_sha` is the merge base; on the rare merge request where GitLab omits it, the base
    // commit is the correct stand-in and the note still anchors.
    let start_sha = refs.start_sha.clone().unwrap_or_else(|| base_sha.clone());

    // GitLab anchors a note to a single line — there is no multi-line range on a diff note in the
    // REST API — so the end of the range is where the comment lands, matching how GitHub treats
    // `line` as the anchor and `start_line` as decoration.
    let line = end_line.max(start_line).max(1);
    let normalized = file_path.trim_start_matches('/');

    let url = format!(
        "{}/projects/{}/merge_requests/{iid}/discussions",
        api_root(host),
        encode_path(project)
    );
    let payload = serde_json::json!({
        "body": content,
        "position": {
            "base_sha": base_sha,
            "start_sha": start_sha,
            "head_sha": head_sha,
            "old_path": normalized,
            "new_path": normalized,
            "position_type": "text",
            "new_line": line,
        },
    });

    #[derive(Deserialize)]
    struct Created {
        #[serde(default)]
        notes: Vec<RawNote>,
    }
    let created: Created = send_json(client().post(&url), token, &payload).await?;
    created
        .notes
        .first()
        .map(|n| n.id)
        .ok_or_else(|| "GitLab's response carried no note id".to_string())
}

/// Posts a plain comment on the merge request — the summary comment, and the fallback for a
/// finding whose location couldn't be parsed.
pub async fn post_pr_comment(
    host: &str,
    project: &str,
    iid: i64,
    content: &str,
    token: &str,
) -> Result<i64, String> {
    let url = format!(
        "{}/projects/{}/merge_requests/{iid}/notes",
        api_root(host),
        encode_path(project)
    );
    #[derive(Deserialize)]
    struct Created {
        id: i64,
    }
    let created: Created = send_json(client().post(&url), token, &serde_json::json!({ "body": content })).await?;
    Ok(created.id)
}

/// Replies on the conversation a note belongs to, keeping it one thread rather than opening a new
/// one beside it.
pub async fn reply_pr_comment(
    host: &str,
    project: &str,
    iid: i64,
    note_id: i64,
    content: &str,
    token: &str,
) -> Result<(), String> {
    let discussion = discussion_of_note(host, project, iid, note_id, token).await?;
    let url = format!(
        "{}/projects/{}/merge_requests/{iid}/discussions/{discussion}/notes",
        api_root(host),
        encode_path(project)
    );
    send_ignoring_body(client().post(&url), token, &serde_json::json!({ "body": content })).await
}

/// Marks the conversation owning `note_id` resolved — GitLab's equivalent of GitHub's resolved
/// review thread and Azure's `fixed`.
///
/// Only a diff-anchored discussion is resolvable; a plain comment on the merge request is not, and
/// GitLab answers 400 for it. Best-effort at the call site, exactly as on GitHub.
pub async fn resolve_discussion_for_note(
    host: &str,
    project: &str,
    iid: i64,
    note_id: i64,
    token: &str,
) -> Result<(), String> {
    let discussion = discussion_of_note(host, project, iid, note_id, token).await?;
    let url = format!(
        "{}/projects/{}/merge_requests/{iid}/discussions/{discussion}",
        api_root(host),
        encode_path(project)
    );
    send_ignoring_body(client().put(&url), token, &serde_json::json!({ "resolved": true })).await
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/// Which decision the signed-in user has already recorded, read from the host rather than
/// remembered locally — they may well have approved it from the website or another machine.
///
/// GitLab models this as approval rather than as a review verdict: the user is either in
/// `approved_by` or they are not. There is no free-tier "changes requested" state to read back, so
/// this answers `approved` or `none` — [`submit_pr_review`] explains what the other verb does.
pub async fn viewer_decision(
    host: &str,
    project: &str,
    iid: i64,
    token: &str,
) -> Result<String, String> {
    let username = get_authenticated_user(host, token).await?;
    #[derive(Deserialize)]
    struct ApprovedBy {
        #[serde(default)]
        user: Option<RawAuthor>,
    }
    #[derive(Deserialize)]
    struct Approvals {
        #[serde(default)]
        approved_by: Vec<ApprovedBy>,
    }
    let url = format!(
        "{}/projects/{}/merge_requests/{iid}/approvals",
        api_root(host),
        encode_path(project)
    );
    // A self-managed instance with approvals disabled answers 404 here; "nobody has approved" is
    // the right reading of that, not an error the user can act on.
    let Ok(approvals) = get_json::<Approvals>(&url, token).await else {
        return Ok("none".to_string());
    };
    let approved = approvals.approved_by.iter().any(|entry| {
        entry
            .user
            .as_ref()
            .is_some_and(|u| u.username.eq_ignore_ascii_case(&username))
    });
    Ok(if approved { "approved" } else { "none" }.to_string())
}

/// Records a decision.
///
/// `APPROVE` is GitLab's own approval endpoint. `REQUEST_CHANGES` has no free-tier equivalent —
/// GitLab's reviewer states are a paid feature — so it is expressed the way a reviewer would by
/// hand: withdraw any approval, and post the explanation as a comment. That is a real, visible
/// change of state on the merge request rather than a silently dropped verb, and the comment is
/// required for exactly that reason.
pub async fn submit_pr_review(
    host: &str,
    project: &str,
    iid: i64,
    event: &str,
    body: &str,
    token: &str,
) -> Result<(), String> {
    let root = api_root(host);
    let encoded = encode_path(project);
    if event.eq_ignore_ascii_case("APPROVE") {
        if !body.trim().is_empty() {
            post_pr_comment(host, project, iid, body, token).await?;
        }
        let url = format!("{root}/projects/{encoded}/merge_requests/{iid}/approve");
        return send_ignoring_body(client().post(&url), token, &serde_json::json!({})).await;
    }

    if body.trim().is_empty() {
        return Err("GitLab has no \"request changes\" state, so this needs a comment explaining what to change".to_string());
    }
    // Unapproving a merge request the user never approved answers 404 on some versions; that is
    // the state we wanted anyway, so it must not fail the comment that carries the actual verdict.
    let unapprove = format!("{root}/projects/{encoded}/merge_requests/{iid}/unapprove");
    let _ = send_ignoring_body(client().post(&unapprove), token, &serde_json::json!({})).await;
    post_pr_comment(host, project, iid, body, token).await.map(|_| ())
}

/// Closes the merge request without merging.
pub async fn close_merge_request(
    host: &str,
    project: &str,
    iid: i64,
    token: &str,
) -> Result<(), String> {
    let url = format!(
        "{}/projects/{}/merge_requests/{iid}",
        api_root(host),
        encode_path(project)
    );
    send_ignoring_body(client().put(&url), token, &serde_json::json!({ "state_event": "close" })).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hosts() -> Vec<String> {
        vec!["gitlab.com".to_string(), "git.contoso.com".to_string()]
    }

    /// The slashes are the whole point: unencoded, GitLab reads the path as three route segments
    /// and answers 404.
    #[test]
    fn a_nested_project_path_is_encoded_whole() {
        assert_eq!(encode_path("acme/backend/auth"), "acme%2Fbackend%2Fauth");
        assert_eq!(encode_path("/acme/site/"), "acme%2Fsite");
        assert_eq!(encode_path("group/my-repo.js"), "group%2Fmy-repo.js");
    }

    #[test]
    fn gitlab_com_and_self_managed_share_one_api_root() {
        assert_eq!(api_root("gitlab.com"), "https://gitlab.com/api/v4");
        assert_eq!(api_root("git.contoso.com"), "https://git.contoso.com/api/v4");
    }

    /// Nested groups are the case GitHub's owner/repo rule cannot express.
    #[test]
    fn remotes_resolve_to_a_full_project_path() {
        let ssh = detect_from_remote_url("git@gitlab.com:acme/backend/auth.git", &hosts()).unwrap();
        assert_eq!(ssh.host, "gitlab.com");
        assert_eq!(ssh.project, "acme/backend/auth");

        let https =
            detect_from_remote_url("https://git.contoso.com/team/app.git", &hosts()).unwrap();
        assert_eq!(https.host, "git.contoso.com");
        assert_eq!(https.project, "team/app");

        // With credentials in the URL, as a CI checkout leaves it.
        let with_user =
            detect_from_remote_url("https://oauth2:tok@gitlab.com/acme/site", &hosts()).unwrap();
        assert_eq!(with_user.project, "acme/site");
    }

    /// A path with no namespace is not a GitLab project, and an unknown host could be any git
    /// server on earth — claiming either would break every other provider's detection.
    #[test]
    fn unknown_hosts_and_namespaceless_paths_are_refused() {
        assert!(detect_from_remote_url("git@example.com:a/b.git", &hosts()).is_none());
        assert!(detect_from_remote_url("https://gitlab.com/lonely", &hosts()).is_none());
    }

    #[test]
    fn states_collapse_into_the_four_buckets_the_sidebar_groups_by() {
        assert_eq!(bucket_status("opened", false), "open");
        assert_eq!(bucket_status("opened", true), "draft");
        assert_eq!(bucket_status("merged", false), "merged");
        assert_eq!(bucket_status("closed", false), "closed");
        // A frozen discussion is still a finished merge request, not a fifth bucket.
        assert_eq!(bucket_status("locked", false), "closed");
        // A merged merge request is merged whatever its title once said.
        assert_eq!(bucket_status("merged", true), "merged");
    }

    #[test]
    fn a_reassembled_diff_carries_the_headers_a_parser_needs() {
        let mut out = String::new();
        push_change(
            &mut out,
            &RawChange {
                old_path: "src/a.rs".into(),
                new_path: "src/a.rs".into(),
                new_file: false,
                deleted_file: false,
                diff: "@@ -1 +1 @@\n-old\n+new".into(),
            },
        );
        assert!(out.starts_with("diff --git a/src/a.rs b/src/a.rs\n--- a/src/a.rs\n+++ b/src/a.rs\n"));
        assert!(out.ends_with("+new\n"), "a missing trailing newline must be added: {out:?}");

        let mut added = String::new();
        push_change(
            &mut added,
            &RawChange {
                old_path: "new.rs".into(),
                new_path: "new.rs".into(),
                new_file: true,
                deleted_file: false,
                diff: String::new(),
            },
        );
        assert!(added.contains("--- /dev/null"));
        assert!(added.contains("(binary or too large to display)"));

        let mut removed = String::new();
        push_change(
            &mut removed,
            &RawChange {
                old_path: "gone.rs".into(),
                new_path: "gone.rs".into(),
                new_file: false,
                deleted_file: true,
                diff: "@@ -1 +0,0 @@\n-gone\n".into(),
            },
        );
        assert!(removed.contains("+++ /dev/null"));
    }

    #[test]
    fn gitlab_errors_become_sentences() {
        assert_eq!(
            describe(reqwest::StatusCode::UNAUTHORIZED, r#"{"message":"401 Unauthorized"}"#),
            "GitLab: 401 Unauthorized"
        );
        assert_eq!(
            describe(reqwest::StatusCode::FORBIDDEN, r#"{"error":"insufficient_scope"}"#),
            "GitLab: insufficient_scope"
        );
    }
}
