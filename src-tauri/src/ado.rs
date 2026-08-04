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

pub(crate) fn client() -> reqwest::Client {
    reqwest::Client::new()
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
        return Err(format!("Azure DevOps returned {status}: {body}"));
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
}

#[derive(Deserialize)]
struct RawRepoRef {
    name: String,
    /// Azure includes the owning team project on the repository it returns with a pull request.
    /// That's the only way to recover the project's *name* from a link that carries its GUID.
    #[serde(default)]
    project: Option<RawProjectRef>,
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

pub async fn list_pull_requests(
    org: &str,
    project: &str,
    repo_id: &str,
    pat: &str,
) -> Result<Vec<PullRequestSummary>, String> {
    let org_enc = encode_segment(&normalize_org(org));
    let project_enc = encode_segment(project);
    let url = format!(
        "https://dev.azure.com/{org_enc}/{project_enc}/_apis/git/repositories/{repo_id}/pullrequests\
         ?searchCriteria.status=all&api-version={API_VERSION}"
    );
    let parsed: ListResponse<RawPullRequest> = get_json(&url, pat).await?;
    Ok(parsed
        .value
        .into_iter()
        .map(|pr| map_pull_request(&org_enc, &project_enc, pr))
        .collect())
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

/// Fetches a single pull request by id. Unlike [`list_pull_requests`] this reaches a PR no
/// matter how far down the list it is, which is what a pasted link needs. `project` and `repo_id`
/// may each be a name or a GUID — Azure's Git REST API accepts either.
pub async fn get_pull_request(
    org: &str,
    project: &str,
    repo_id: &str,
    pr_id: i64,
    pat: &str,
) -> Result<AdoPullRequest, String> {
    let org_enc = encode_segment(&normalize_org(org));
    let url = format!(
        "https://dev.azure.com/{org_enc}/{}/_apis/git/repositories/{}/pullRequests/{pr_id}\
         ?api-version={API_VERSION}",
        encode_segment(project),
        encode_segment(repo_id)
    );
    let raw: RawPullRequest = get_json(&url, pat).await?;
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
        return Err(format!("Azure DevOps returned {status}: {text}"));
    }
    let pr: RawPullRequest =
        res.json().await.map_err(|e| format!("unexpected response from Azure DevOps: {e}"))?;
    Ok(map_pull_request(&org_enc, &project_enc, pr))
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
        return Err(format!("Azure DevOps returned {status}: {body}"));
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
        return Err(format!("Azure DevOps returned {status}: {body}"));
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
        return Err(format!("Azure DevOps returned {status}: {body}"));
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
        return Err(format!("Azure DevOps returned {status}: {body}"));
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
    let org_enc = encode_segment(&normalize_org(org));
    let url = format!(
        "https://dev.azure.com/{org_enc}/{}/_apis/git/repositories/{}/pullRequests/{pr_id}\
         ?api-version={API_VERSION}",
        encode_segment(project),
        encode_segment(repo_id)
    );
    let pr: RawPullRequest = get_json(&url, pat).await?;
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
        return Err(format!("Azure DevOps returned {status}: {body}"));
    }
    Ok(())
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
}
