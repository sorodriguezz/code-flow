//! The GitHub trigger: a repository's new issues, closed issues, new comments and published
//! releases, found by asking its REST API — github.com or an Enterprise server — every minute or
//! more.
//!
//! **A watermark, not a list.** Each look remembers the newest moment it has seen (and the ids at
//! exactly that moment); what comes after it is new. The first look only learns it, like every
//! poller here. A list of ids would fire again for an old issue that slid back into the page when a
//! newer one was deleted or transferred.
//!
//! **Asked politely.** Every request carries the last answer's ETag, and GitHub does not count an
//! unchanged answer (304) against the rate limit — without a token that limit is 60 an hour.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::AppHandle;
use tokio_util::sync::CancellationToken;

use super::{note_problem, TriggerView};
use crate::flows::run::Item;

fn text(params: &Value, key: &str) -> String {
    params.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string()
}

/// Where a repository's API is: `owner/name`, or a link to it on github.com or an Enterprise host.
pub fn repository(raw: &str) -> Result<(String, String, String), String> {
    let raw = raw.trim().trim_end_matches('/').trim_end_matches(".git");
    let (base, path) = match url::Url::parse(raw) {
        Ok(url) if matches!(url.scheme(), "http" | "https") => {
            let host = url.host_str().unwrap_or_default().to_string();
            let base = if host == "github.com" || host == "www.github.com" {
                "https://api.github.com".to_string()
            } else {
                let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
                format!("{}://{host}{port}/api/v3", url.scheme())
            };
            (base, url.path().trim_matches('/').to_string())
        }
        _ => ("https://api.github.com".to_string(), raw.to_string()),
    };
    let mut parts = path.split('/').filter(|p| !p.is_empty());
    match (parts.next(), parts.next()) {
        (Some(owner), Some(name)) => Ok((base, owner.to_string(), name.to_string())),
        _ => Err(format!("\"{raw}\" is not a repository — write owner/name or its link")),
    }
}

/// The newest moment a look has seen, and the ids seen at exactly that moment.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Mark {
    pub at: String,
    pub ids: HashSet<String>,
}

/// What is new in `found` (`(moment, id, item)`, any order) after `mark`, oldest first; the mark
/// moves to the newest. With no mark yet, nothing is new: the first look learns.
pub fn fresh(found: Vec<(String, String, Value)>, mark: &mut Option<Mark>) -> Vec<Value> {
    let Some(current) = mark.as_mut() else {
        let at = found.iter().map(|(at, _, _)| at.clone()).max().unwrap_or_default();
        let ids = found.iter().filter(|(when, _, _)| *when == at).map(|(_, id, _)| id.clone()).collect();
        *mark = Some(Mark { at, ids });
        return Vec::new();
    };
    let mut new: Vec<(String, String, Value)> =
        found.into_iter().filter(|(at, id, _)| *at > current.at || (*at == current.at && !current.ids.contains(id))).collect();
    new.sort_by(|a, b| a.0.cmp(&b.0));
    for (at, id, _) in &new {
        if *at > current.at {
            current.at = at.clone();
            current.ids.clear();
        }
        if *at == current.at {
            current.ids.insert(id.clone());
        }
    }
    new.into_iter().map(|(_, _, item)| item).collect()
}

fn login(user: &Value) -> Value {
    user.get("login").cloned().unwrap_or(Value::Null)
}

fn labels_of(issue: &Value) -> Vec<String> {
    issue["labels"].as_array().into_iter().flatten().filter_map(|l| l["name"].as_str().map(str::to_string)).collect()
}

/// An issue as the trigger hands it on.
fn issue_item(event: &str, repo: &str, issue: &Value) -> Value {
    json!({
        "event": event,
        "repository": repo,
        "number": issue["number"],
        "title": issue["title"],
        "body": issue["body"],
        "state": issue["state"],
        "author": login(&issue["user"]),
        "labels": labels_of(issue),
        "assignees": issue["assignees"].as_array().map(|list| list.iter().map(login).collect::<Vec<_>>()).unwrap_or_default(),
        "url": issue["html_url"],
        "createdAt": issue["created_at"],
        "closedAt": issue["closed_at"],
        "closedBy": login(&issue["closed_by"]),
    })
}

/// The items one answer holds for `event`, each with the moment that orders it and its id.
pub fn found_in(event: &str, repo: &str, answer: &Value, label_filter: &[String]) -> Vec<(String, String, Value)> {
    let list = answer.as_array().cloned().unwrap_or_default();
    let wanted = |issue: &Value| {
        // Pull requests are issues to this API; they have their own trigger.
        issue.get("pull_request").is_none() && (label_filter.is_empty() || labels_of(issue).iter().any(|l| label_filter.iter().any(|w| w.eq_ignore_ascii_case(l))))
    };
    match event {
        "issueClosed" => list
            .iter()
            .filter(|issue| wanted(issue) && issue["closed_at"].is_string())
            .map(|issue| {
                let at = issue["closed_at"].as_str().unwrap_or_default().to_string();
                // Closed, reopened and closed again is a second close.
                (at.clone(), format!("{}@{at}", issue["id"]), issue_item("issueClosed", repo, issue))
            })
            .collect(),
        "issueComment" => list
            .iter()
            .map(|comment| {
                let url = comment["html_url"].as_str().unwrap_or_default();
                let number = comment["issue_url"].as_str().and_then(|u| u.rsplit('/').next()).and_then(|n| n.parse::<u64>().ok());
                let item = json!({
                    "event": "issueComment",
                    "repository": repo,
                    "id": comment["id"],
                    "body": comment["body"],
                    "author": login(&comment["user"]),
                    "number": number,
                    "isPullRequest": url.contains("/pull/"),
                    "url": url,
                    "createdAt": comment["created_at"],
                });
                (comment["created_at"].as_str().unwrap_or_default().to_string(), comment["id"].to_string(), item)
            })
            .collect(),
        "release" => list
            .iter()
            .filter(|release| release["draft"] != json!(true) && release["published_at"].is_string())
            .map(|release| {
                let assets: Vec<Value> = release["assets"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|a| json!({"name": a["name"], "size": a["size"], "url": a["browser_download_url"]}))
                    .collect();
                let item = json!({
                    "event": "release",
                    "repository": repo,
                    "tag": release["tag_name"],
                    "name": release["name"],
                    "body": release["body"],
                    "prerelease": release["prerelease"],
                    "author": login(&release["author"]),
                    "url": release["html_url"],
                    "publishedAt": release["published_at"],
                    "assets": assets,
                });
                (release["published_at"].as_str().unwrap_or_default().to_string(), release["id"].to_string(), item)
            })
            .collect(),
        _ => list
            .iter()
            .filter(|issue| wanted(issue))
            .map(|issue| (issue["created_at"].as_str().unwrap_or_default().to_string(), issue["id"].to_string(), issue_item("issueOpened", repo, issue)))
            .collect(),
    }
}

/// The request that lists what `event` watches, newest first.
fn listing(base: &str, owner: &str, name: &str, event: &str) -> (String, Vec<(&'static str, &'static str)>) {
    let repo = format!("{base}/repos/{owner}/{name}");
    match event {
        "issueClosed" => (format!("{repo}/issues"), vec![("state", "closed"), ("sort", "updated"), ("direction", "desc"), ("per_page", "50")]),
        "issueComment" => (format!("{repo}/issues/comments"), vec![("sort", "created"), ("direction", "desc"), ("per_page", "50")]),
        "release" => (format!("{repo}/releases"), vec![("per_page", "30")]),
        _ => (format!("{repo}/issues"), vec![("state", "all"), ("sort", "created"), ("direction", "desc"), ("per_page", "50")]),
    }
}

/// Checks a GitHub trigger can be armed: a repository it can read, and — when it names one — a
/// token credential of this flow's workspace.
pub fn check(app: &AppHandle, flow_id: &str, params: &Value) -> Result<(), String> {
    repository(&text(params, "repository"))?;
    let credential = text(params, "credential");
    if !credential.is_empty() {
        super::credential_secret(app, flow_id, &credential, &["bearer"])?;
    }
    Ok(())
}

pub fn spawn(app: &AppHandle, flow_id: &str, node_id: &str, params: &Value, view: Arc<Mutex<TriggerView>>, cancel: CancellationToken) -> Result<(), String> {
    let (base, owner, name) = repository(&text(params, "repository"))?;
    let event = text(params, "event");
    let credential = text(params, "credential");
    let labels: Vec<String> = text(params, "labelFilter").split(',').map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
    let interval = Duration::from_secs(params.get("intervalSec").and_then(Value::as_f64).unwrap_or(60.0).max(60.0) as u64);
    let (app, flow_id, node_id) = (app.clone(), flow_id.to_string(), node_id.to_string());
    tauri::async_runtime::spawn(async move {
        let client = match reqwest::Client::builder().timeout(Duration::from_secs(30)).user_agent("CodeFlow-Flujos").build() {
            Ok(client) => client,
            Err(error) => return note_problem(&view, Some(error.to_string())),
        };
        let repo = format!("{owner}/{name}");
        let (url, query) = listing(&base, &owner, &name, &event);
        let mut mark: Option<Mark> = None;
        let mut etag: Option<String> = None;
        loop {
            let look = async {
                let mut request = client.get(&url).query(&query).header("Accept", "application/vnd.github+json").header("X-GitHub-Api-Version", "2022-11-28");
                if !credential.is_empty() {
                    // Read on every look: a token replaced in the vault is used from the next one.
                    let token = super::credential_secret(&app, &flow_id, &credential, &["bearer"])?;
                    request = request.bearer_auth(token);
                }
                if let Some(tag) = &etag {
                    request = request.header("If-None-Match", tag);
                }
                let response = request.send().await.map_err(|e| format!("GitHub could not be reached: {e}"))?;
                let status = response.status();
                if status == reqwest::StatusCode::NOT_MODIFIED {
                    return Ok(None);
                }
                let tag = response.headers().get("etag").and_then(|v| v.to_str().ok()).map(str::to_string);
                let body = response.text().await.map_err(|e| e.to_string())?;
                if !status.is_success() {
                    return Err(format!("GitHub answered {}: {}", status.as_u16(), crate::oauth::describe(status, &body)));
                }
                let answer: Value = serde_json::from_str(&body).map_err(|_| "GitHub did not answer JSON".to_string())?;
                Ok(Some((tag, answer)))
            };
            match look.await {
                Ok(None) => note_problem(&view, None),
                Ok(Some((tag, answer))) => {
                    note_problem(&view, None);
                    etag = tag;
                    for item in fresh(found_in(&event, &repo, &answer, &labels), &mut mark) {
                        if let Err(error) = super::fire(&app, &flow_id, &node_id, vec![Item::new(item)]) {
                            note_problem(&view, Some(error));
                        }
                    }
                }
                Err(error) => note_problem(&view, Some(error)),
            }
            tokio::select! {
                _ = tokio::time::sleep(interval) => {}
                _ = cancel.cancelled() => return,
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_repository_is_read_from_its_name_or_its_link() {
        assert_eq!(repository("octo/app").unwrap(), ("https://api.github.com".into(), "octo".into(), "app".into()));
        assert_eq!(repository("https://github.com/octo/app.git").unwrap().2, "app");
        assert_eq!(repository("https://git.example.com/team/svc/issues").unwrap(), ("https://git.example.com/api/v3".into(), "team".into(), "svc".into()));
        assert!(repository("solo").is_err());
    }

    #[test]
    fn the_first_look_learns_and_later_ones_fire_only_what_is_newer() {
        let item = |at: &str, id: &str| (at.to_string(), id.to_string(), json!({"id": id}));
        let mut mark = None;
        assert!(fresh(vec![item("2026-10-01T10:00:00Z", "1"), item("2026-10-02T10:00:00Z", "2")], &mut mark).is_empty());
        // "1" slid back into the page; "3" and "4" are new — oldest first.
        let new = fresh(
            vec![item("2026-10-04T08:00:00Z", "4"), item("2026-10-03T09:00:00Z", "3"), item("2026-10-02T10:00:00Z", "2"), item("2026-10-01T10:00:00Z", "1")],
            &mut mark,
        );
        assert_eq!(new, vec![json!({"id": "3"}), json!({"id": "4"})]);
        // Same second as the mark, different id: new; same id: not.
        let new = fresh(vec![item("2026-10-04T08:00:00Z", "4"), item("2026-10-04T08:00:00Z", "5")], &mut mark);
        assert_eq!(new, vec![json!({"id": "5"})]);
        assert!(fresh(vec![item("2026-10-04T08:00:00Z", "5")], &mut mark).is_empty());

        let mut empty = None;
        assert!(fresh(Vec::new(), &mut empty).is_empty());
        assert_eq!(fresh(vec![item("2026-10-05T00:00:00Z", "9")], &mut empty).len(), 1);
    }

    #[test]
    fn answers_are_read_per_event_leaving_pull_requests_out() {
        let issues = json!([
            {"id": 11, "number": 7, "title": "Falla el login", "state": "open", "created_at": "2026-10-05T10:00:00Z", "user": {"login": "ana"}, "labels": [{"name": "bug"}], "html_url": "https://github.com/o/r/issues/7"},
            {"id": 12, "number": 8, "title": "PR", "created_at": "2026-10-05T11:00:00Z", "pull_request": {}},
            {"id": 13, "number": 9, "title": "Docs", "created_at": "2026-10-05T12:00:00Z", "labels": [{"name": "docs"}], "closed_at": "2026-10-05T13:00:00Z"}
        ]);
        let opened = found_in("issueOpened", "o/r", &issues, &[]);
        assert_eq!(opened.len(), 2);
        assert_eq!(opened[0].2["author"], "ana");
        assert_eq!(found_in("issueOpened", "o/r", &issues, &["BUG".into()]).len(), 1);
        let closed = found_in("issueClosed", "o/r", &issues, &[]);
        assert_eq!((closed.len(), closed[0].1.as_str()), (1, "13@2026-10-05T13:00:00Z"));

        let comments = json!([{"id": 5, "body": "LGTM", "user": {"login": "bruno"}, "created_at": "2026-10-05T10:00:00Z",
            "issue_url": "https://api.github.com/repos/o/r/issues/42", "html_url": "https://github.com/o/r/pull/42#issuecomment-5"}]);
        let comment = &found_in("issueComment", "o/r", &comments, &[])[0].2;
        assert_eq!((comment["number"].as_u64(), comment["isPullRequest"].as_bool()), (Some(42), Some(true)));

        let releases = json!([{"id": 1, "draft": true, "published_at": null}, {"id": 2, "tag_name": "v1.2.0", "draft": false, "published_at": "2026-10-05T09:00:00Z", "assets": [{"name": "app.dmg", "size": 10, "browser_download_url": "https://example.com/app.dmg"}]}]);
        let release = found_in("release", "o/r", &releases, &[]);
        assert_eq!((release.len(), release[0].2["tag"].as_str()), (1, Some("v1.2.0")));
    }
}
