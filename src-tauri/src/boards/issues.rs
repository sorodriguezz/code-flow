//! GitHub Issues and GitLab Issues as boards: the issue tracker that comes with the repository.
//!
//! The target slots read as the other boards' do — which host, which container, where inside it:
//! the host (`github.com`, a GitHub Enterprise or a GitLab server), the repository (`owner/repo`,
//! `group/sub/project`), and a **label** in place of a work-item type, since neither tracker has
//! types — an empty one publishes a plain issue. The tokens are the ones the app already holds for
//! that host's pull requests.
//!
//! An issue is addressed by the repository *and* its number, and the dispatch in [`super`] hands a
//! client only the host and an id — so the item's key carries the rest: `owner/repo#12`, the way
//! both trackers write a cross-repository reference anyway.
//!
//! A story's tasks become **sub-issues** on GitHub and **linked issues** on GitLab (Free has no
//! child issues; a "relates to" link is what every tier offers). Prose is Markdown on both.

use serde::Deserialize;
use serde_json::{json, Value};

use super::{text_to_html, ExistingItem, ItemRef, NewChildItem, NewWorkItem, WorkItem, WorkItemChild, WorkItemEdit, WorkItemType};

/// The heading the criteria sit under inside the issue body — the same words every board writes.
const CRITERIA_HEADING: &str = "Criterios de aceptación";
/// Pages of issues a duplicate check reads, 100 to a page.
const RECENT_PAGES: u32 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tracker {
    GitHub,
    GitLab,
}

impl Tracker {
    pub(super) fn name(self) -> &'static str {
        match self {
            Tracker::GitHub => "GitHub",
            Tracker::GitLab => "GitLab",
        }
    }
}

fn client() -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(crate::ado::pr_http_client).clone()
}

pub(super) fn request(tracker: Tracker, method: reqwest::Method, url: &str, token: &str) -> reqwest::RequestBuilder {
    let builder = client().request(method, url).header("User-Agent", crate::github::USER_AGENT);
    match tracker {
        Tracker::GitHub => builder
            .header("Authorization", crate::github::bearer(token))
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", crate::github::API_VERSION),
        Tracker::GitLab => builder.header("PRIVATE-TOKEN", token),
    }
}

pub(super) async fn send(tracker: Tracker, builder: reqwest::RequestBuilder) -> Result<Value, String> {
    let res = builder.send().await.map_err(|e| format!("no se pudo conectar con {}: {e}", tracker.name()))?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        let detail = serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|v| v.get("message").or_else(|| v.get("error")).map(|m| m.to_string().trim_matches('"').to_string()))
            .unwrap_or_else(|| text.chars().take(300).collect());
        return Err(format!("{} respondió {status}: {detail}", tracker.name()));
    }
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text).map_err(|e| format!("respuesta inesperada de {} ({e})", tracker.name()))
}

/// The repository's API prefix: `…/repos/owner/repo` or `…/projects/group%2Fproject`.
pub(super) fn repo_root(tracker: Tracker, host: &str, repo: &str) -> Result<String, String> {
    let repo = repo.trim().trim_matches('/');
    if repo.split('/').filter(|part| !part.is_empty()).count() < 2 {
        return Err(format!("«{repo}» no es un repositorio (dueño/repositorio)"));
    }
    Ok(match tracker {
        Tracker::GitHub => format!("{}/repos/{repo}", crate::github::api_root(host.trim())),
        Tracker::GitLab => format!("{}/projects/{}", crate::gitlab::api_root(host.trim()), crate::gitlab::encode_path(repo)),
    })
}

/// `owner/repo#12` → (`owner/repo`, 12).
pub fn split_key(key: &str) -> Option<(String, i64)> {
    let (repo, number) = key.trim().rsplit_once('#')?;
    let number: i64 = number.parse().ok()?;
    (!repo.is_empty() && number > 0).then(|| (repo.to_string(), number))
}

pub(super) fn key_of(repo: &str, number: i64) -> String {
    format!("{}#{number}", repo.trim().trim_matches('/'))
}

/// A criterion as one item of a numbered Markdown list: its first line after the number, the rest
/// indented under it so a Gherkin scenario stays one item.
fn criteria_markdown(criteria: &[String]) -> String {
    criteria
        .iter()
        .map(|c| c.trim())
        .filter(|c| !c.is_empty())
        .enumerate()
        .map(|(index, criterion)| {
            let mut lines = criterion.lines();
            let first = lines.next().unwrap_or_default();
            let rest: Vec<String> = lines.map(|line| format!("   {line}")).collect();
            if rest.is_empty() {
                format!("{}. {first}", index + 1)
            } else {
                format!("{}. {first}\n{}", index + 1, rest.join("\n"))
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// The body of an issue: the narrative in bold, the description, the criteria under their heading.
pub fn compose_body(narrative: &str, description: &str, criteria: &[String]) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !narrative.trim().is_empty() {
        parts.push(format!("**{}**", narrative.trim()));
    }
    if !description.trim().is_empty() {
        parts.push(description.trim().to_string());
    }
    let list = criteria_markdown(criteria);
    if !list.is_empty() {
        parts.push(format!("## {CRITERIA_HEADING}\n\n{list}"));
    }
    parts.join("\n\n")
}

fn labels_of(work_item_type: &str, tags: &str) -> Vec<String> {
    let mut labels: Vec<String> = Vec::new();
    for label in std::iter::once(work_item_type).chain(tags.split([',', ';'])) {
        let label = label.trim();
        if !label.is_empty() && !labels.iter().any(|l| l.eq_ignore_ascii_case(label)) {
            labels.push(label.to_string());
        }
    }
    labels
}

/// The repository's labels, as the "type" picker lists them — after a plain issue with none.
pub async fn list_labels(tracker: Tracker, host: &str, repo: &str, token: &str) -> Result<Vec<WorkItemType>, String> {
    let url = format!("{}/labels?per_page=100", repo_root(tracker, host, repo)?);
    let found = send(tracker, request(tracker, reqwest::Method::GET, &url, token)).await?;
    let mut types = vec![WorkItemType {
        name: "Issue".into(),
        reference_name: String::new(),
        description: String::new(),
        color: String::new(),
        subtask: false,
    }];
    for label in found.as_array().into_iter().flatten() {
        let Some(name) = label.get("name").and_then(Value::as_str) else { continue };
        types.push(WorkItemType {
            name: name.to_string(),
            reference_name: name.to_string(),
            description: label.get("description").and_then(Value::as_str).unwrap_or_default().to_string(),
            color: label.get("color").and_then(Value::as_str).unwrap_or_default().trim_start_matches('#').to_string(),
            subtask: false,
        });
    }
    Ok(types)
}

#[derive(Deserialize)]
struct RawIssue {
    #[serde(default)]
    id: i64,
    /// GitHub's number; GitLab's `iid`.
    #[serde(default, alias = "iid")]
    number: i64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    state: String,
    #[serde(default, alias = "web_url")]
    html_url: String,
    /// GitHub only: present on a pull request, which the issues listing also returns.
    #[serde(default)]
    pull_request: Option<Value>,
}

pub async fn create_issue(tracker: Tracker, host: &str, repo: &str, label: &str, item: &NewWorkItem<'_>, token: &str) -> Result<ItemRef, String> {
    if item.title.trim().is_empty() {
        return Err("La historia no tiene título".to_string());
    }
    let body = compose_body(item.narrative, item.description, item.acceptance_criteria);
    let labels = labels_of(label, item.tags);
    let url = format!("{}/issues", repo_root(tracker, host, repo)?);
    let payload = match tracker {
        Tracker::GitHub => json!({ "title": item.title.trim(), "body": body, "labels": labels }),
        Tracker::GitLab => json!({ "title": item.title.trim(), "description": body, "labels": labels.join(",") }),
    };
    let created: RawIssue = serde_json::from_value(send(tracker, request(tracker, reqwest::Method::POST, &url, token).json(&payload)).await?)
        .map_err(|e| e.to_string())?;
    Ok(ItemRef { id: created.number, url: created.html_url, key: key_of(repo, created.number) })
}

/// A task of a published story: an issue of its own, hung under the story — a sub-issue on GitHub,
/// a linked issue on GitLab. When the hanging fails the issue stays, naming its parent in its body.
pub async fn create_child(tracker: Tracker, host: &str, repo: &str, parent_number: i64, task: &NewChildItem<'_>, token: &str) -> Result<ItemRef, String> {
    if task.title.trim().is_empty() {
        return Err("Esa tarea no tiene título".to_string());
    }
    let root = repo_root(tracker, host, repo)?;
    let body = format!("{}\n\nParte de #{parent_number}", task.detail.trim()).trim().to_string();
    let payload = match tracker {
        Tracker::GitHub => json!({ "title": task.title.trim(), "body": body }),
        Tracker::GitLab => json!({ "title": task.title.trim(), "description": body }),
    };
    let created: RawIssue = serde_json::from_value(send(tracker, request(tracker, reqwest::Method::POST, &format!("{root}/issues"), token).json(&payload)).await?)
        .map_err(|e| e.to_string())?;
    let link = match tracker {
        // Sub-issues take the child's database id, not its number.
        Tracker::GitHub => request(tracker, reqwest::Method::POST, &format!("{root}/issues/{parent_number}/sub_issues"), token).json(&json!({ "sub_issue_id": created.id })),
        Tracker::GitLab => {
            // The target project as its URL-encoded path, which the API takes in place of an id.
            let project = crate::gitlab::encode_path(repo.trim().trim_matches('/'));
            request(tracker, reqwest::Method::POST, &format!("{root}/issues/{parent_number}/links"), token).json(&json!({
                "target_project_id": project,
                "target_issue_iid": created.number,
                "link_type": "relates_to",
            }))
        }
    };
    let _ = send(tracker, link).await;
    Ok(ItemRef { id: created.number, url: created.html_url, key: key_of(repo, created.number) })
}

/// Rewrites an issue's title and body. The body is replaced whole: the narrative, description and
/// criteria all live in it, as they were written at the publish.
pub async fn update_issue(tracker: Tracker, host: &str, key: &str, edit: &WorkItemEdit, token: &str) -> Result<ItemRef, String> {
    let (repo, number) = split_key(key).ok_or_else(|| format!("«{key}» no es una referencia de issue"))?;
    let url = format!("{}/issues/{number}", repo_root(tracker, host, &repo)?);
    let mut payload = serde_json::Map::new();
    if let Some(title) = &edit.title {
        payload.insert("title".into(), json!(title.trim()));
    }
    if edit.description.is_some() || edit.acceptance_criteria.is_some() {
        let prose = edit.description.clone().unwrap_or_default();
        let prose = if edit.prose_is_html { super::html_to_text(&prose) } else { prose };
        let body = compose_body("", &prose, edit.acceptance_criteria.as_deref().unwrap_or_default());
        payload.insert(if tracker == Tracker::GitHub { "body" } else { "description" }.into(), json!(body));
    }
    let method = if tracker == Tracker::GitHub { reqwest::Method::PATCH } else { reqwest::Method::PUT };
    let updated: RawIssue = serde_json::from_value(send(tracker, request(tracker, method, &url, token).json(&Value::Object(payload))).await?)
        .map_err(|e| e.to_string())?;
    Ok(ItemRef { id: updated.number, url: updated.html_url, key: key_of(&repo, updated.number) })
}

/// One issue and its children (sub-issues, linked issues), as the review screen reads it.
pub async fn get_issue(tracker: Tracker, host: &str, key: &str, token: &str) -> Result<WorkItem, String> {
    let (repo, number) = split_key(key).ok_or_else(|| format!("«{key}» no es una referencia de issue"))?;
    let root = repo_root(tracker, host, &repo)?;
    let raw = send(tracker, request(tracker, reqwest::Method::GET, &format!("{root}/issues/{number}"), token)).await?;
    let text = |name: &str| raw.get(name).and_then(Value::as_str).unwrap_or_default().to_string();
    let body = if tracker == Tracker::GitHub { text("body") } else { text("description") };
    let labels: Vec<String> = raw
        .get("labels")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|l| l.as_str().map(str::to_string).or_else(|| l.get("name").and_then(Value::as_str).map(str::to_string)))
        .collect();
    let children_url = match tracker {
        Tracker::GitHub => format!("{root}/issues/{number}/sub_issues"),
        Tracker::GitLab => format!("{root}/issues/{number}/links"),
    };
    let children = send(tracker, request(tracker, reqwest::Method::GET, &children_url, token))
        .await
        .ok()
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|child| {
            let raw: RawIssue = serde_json::from_value(child.clone()).ok()?;
            Some(WorkItemChild {
                id: raw.number,
                url: raw.html_url,
                key: key_of(&repo, raw.number),
                work_item_type: "Issue".into(),
                title: raw.title,
                state: raw.state,
                description_html: text_to_html(child.get("body").or_else(|| child.get("description")).and_then(Value::as_str).unwrap_or_default()),
                assigned_to: child
                    .get("assignee")
                    .and_then(|a| a.get("login").or_else(|| a.get("username")))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            })
        })
        .collect();
    Ok(WorkItem {
        id: number,
        url: if tracker == Tracker::GitHub { text("html_url") } else { text("web_url") },
        key: key_of(&repo, number),
        work_item_type: "Issue".into(),
        title: text("title"),
        state: text("state"),
        team_project: repo.clone(),
        container_id: repo.clone(),
        description_html: text_to_html(&body),
        repro_steps_html: String::new(),
        system_info_html: String::new(),
        acceptance_criteria_html: String::new(),
        effort: 0.0,
        effort_field: String::new(),
        tags: labels.join(", "),
        area_path: String::new(),
        iteration_path: String::new(),
        children,
    })
}

/// The repository's newest issues, pull requests left out — what a duplicate check compares with.
pub async fn recent_issues(tracker: Tracker, host: &str, repo: &str, token: &str) -> Result<Vec<ExistingItem>, String> {
    let root = repo_root(tracker, host, repo)?;
    let mut found = Vec::new();
    for page in 1..=RECENT_PAGES {
        let url = match tracker {
            Tracker::GitHub => format!("{root}/issues?state=all&per_page=100&page={page}"),
            Tracker::GitLab => format!("{root}/issues?per_page=100&page={page}&order_by=created_at&sort=desc"),
        };
        let batch: Vec<RawIssue> = serde_json::from_value(send(tracker, request(tracker, reqwest::Method::GET, &url, token)).await?).unwrap_or_default();
        let full = batch.len() == 100;
        found.extend(batch.into_iter().filter(|issue| issue.pull_request.is_none()).map(|issue| ExistingItem {
            id: issue.number,
            key: key_of(repo, issue.number),
            title: issue.title,
            state: issue.state,
            url: issue.html_url,
        }));
        if !full {
            break;
        }
    }
    Ok(found)
}

/// A pasted issue link: `https://github.com/acme/web/issues/12`, `https://gitlab.com/g/p/-/issues/7`
/// (or a GitLab work item). Pull requests and merge requests are not issues and are declined.
pub fn parse_issue_ref(input: &str) -> Option<(Tracker, String, String, i64)> {
    let url = reqwest::Url::parse(input.trim()).ok()?;
    let host = url.host_str()?.to_string();
    let segments: Vec<&str> = url.path_segments()?.filter(|s| !s.is_empty()).collect();
    if let Some(at) = segments.iter().position(|s| *s == "-") {
        if let (Some(kind), Some(number)) = (segments.get(at + 1), segments.get(at + 2)) {
            if matches!(*kind, "issues" | "work_items") && at >= 2 {
                return Some((Tracker::GitLab, host, segments[..at].join("/"), number.parse().ok()?));
            }
        }
        return None;
    }
    if segments.len() >= 4 && segments[2] == "issues" && !host.ends_with("dev.azure.com") && !host.ends_with("visualstudio.com") {
        return Some((Tracker::GitHub, host, format!("{}/{}", segments[0], segments[1]), segments[3].parse().ok()?));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_issue_body_carries_the_narrative_the_description_and_numbered_criteria() {
        let criteria = vec!["Dado X\nCuando Y\nEntonces Z".to_string(), "Se guarda".to_string()];
        let body = compose_body("Como cliente quiero pagar", "Detalle", &criteria);
        assert_eq!(
            body,
            "**Como cliente quiero pagar**\n\nDetalle\n\n## Criterios de aceptación\n\n1. Dado X\n   Cuando Y\n   Entonces Z\n2. Se guarda"
        );
    }

    #[test]
    fn issue_links_are_read_and_pull_requests_are_not() {
        assert_eq!(
            parse_issue_ref("https://github.com/acme/web/issues/12"),
            Some((Tracker::GitHub, "github.com".into(), "acme/web".into(), 12))
        );
        assert_eq!(
            parse_issue_ref("https://gitlab.example.com/group/sub/app/-/issues/7"),
            Some((Tracker::GitLab, "gitlab.example.com".into(), "group/sub/app".into(), 7))
        );
        assert_eq!(parse_issue_ref("https://github.com/acme/web/pull/3"), None);
        assert_eq!(parse_issue_ref("https://gitlab.com/g/p/-/merge_requests/3"), None);
        assert_eq!(split_key("group/sub/app#7"), Some(("group/sub/app".into(), 7)));
        assert_eq!(labels_of("story", "ux; Story, api"), vec!["story", "ux", "api"]);
    }
}
