use base64::Engine;
use serde::{Deserialize, Serialize};

const API_VERSION: &str = "7.1";

fn auth_header(pat: &str) -> String {
    let token = base64::engine::general_purpose::STANDARD.encode(format!(":{pat}"));
    format!("Basic {token}")
}

/// Accepts whatever the user actually typed/saved as their "organization" — a bare name
/// like `contoso`, a full `https://dev.azure.com/contoso` URL, or a legacy
/// `https://contoso.visualstudio.com` URL — and reduces it to the bare org name. Azure
/// DevOps' server rejects any literal `:` in the request path (IIS request validation), so
/// interpolating a raw URL straight into the path 404s/400s in a confusing way; normalizing
/// here means it works no matter which form ended up saved.
fn normalize_org(org: &str) -> String {
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
fn encode_segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn client() -> reqwest::Client {
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

async fn get_json<T: for<'de> Deserialize<'de>>(url: &str, pat: &str) -> Result<T, String> {
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
}

#[derive(Deserialize)]
struct ListResponse<T> {
    value: Vec<T>,
}

#[derive(Deserialize)]
struct RawIdentity {
    #[serde(rename = "displayName")]
    display_name: String,
}

#[derive(Deserialize)]
struct RawRepoRef {
    name: String,
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

pub async fn list_pull_requests(
    org: &str,
    project: &str,
    repo_id: &str,
    pat: &str,
) -> Result<Vec<PullRequestSummary>, String> {
    let org = encode_segment(&normalize_org(org));
    let project_enc = encode_segment(project);
    let url = format!(
        "https://dev.azure.com/{org}/{project_enc}/_apis/git/repositories/{repo_id}/pullrequests\
         ?searchCriteria.status=all&api-version={API_VERSION}"
    );
    let parsed: ListResponse<RawPullRequest> = get_json(&url, pat).await?;
    Ok(parsed
        .value
        .into_iter()
        .map(|pr| PullRequestSummary {
            id: pr.pull_request_id,
            title: pr.title,
            description: pr.description,
            status: bucket_status(&pr.status, pr.is_draft),
            source_branch: strip_ref(&pr.source_ref_name),
            target_branch: strip_ref(&pr.target_ref_name),
            author: pr.created_by.display_name,
            created_at: pr.creation_date,
            url: format!(
                "https://dev.azure.com/{org}/{project_enc}/_git/{}/pullrequest/{}",
                encode_segment(&pr.repository.name),
                pr.pull_request_id
            ),
        })
        .collect())
}

/// Posts a general (non-file-anchored) comment thread on the PR — the MVP form of
/// publishing a review. Anchoring comments to specific files/lines would need Azure
/// DevOps' iteration/changes API on top of this, which isn't wired up yet.
pub async fn post_pr_comment(
    org: &str,
    project: &str,
    repo_id: &str,
    pr_id: i64,
    content: &str,
    pat: &str,
) -> Result<(), String> {
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
