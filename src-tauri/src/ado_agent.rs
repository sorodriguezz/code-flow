//! Azure DevOps for a chat's model — the `azure_devops` tool of the map server (`codemap::mcp`).
//!
//! **Read only, and with the user's own connection**: the PAT saved in CodeFlow for the
//! organization, used here and never shown. Every call is a GET except WIQL, which is a POST that
//! can only read (`SELECT`). Defaults come from the repository the chat runs in (its organization,
//! project and repository), so "the open PRs" or "work item 1234" need nothing else; any other
//! repository or project of an organization the user connected can be named.

use serde_json::{json, Value};

use crate::ado::{client, describe_failure, encode_segment, get_json, normalize_org, API_VERSION};
use crate::db::models::Project;

/// The most of anything one answer lists.
const MAX_LIST: u64 = 100;
/// The most of a file one answer carries.
const MAX_FILE: usize = 200_000;

pub async fn read(linked: Option<&Project>, args: &Value) -> Result<String, String> {
    let text = |key: &str| args.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string();
    let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(20).clamp(1, MAX_LIST);
    let org = Some(text("org")).filter(|o| !o.is_empty()).or_else(|| linked.and_then(|p| p.ado_org.clone())).map(|o| normalize_org(&o));
    let Some(org) = org.filter(|o| !o.is_empty()) else {
        return Err("no Azure DevOps organization: this repository is not linked to one — name it in org".into());
    };
    let pat = crate::commands::ado_cmd::pat_for_org(&org)?;
    let project = Some(text("project")).filter(|p| !p.is_empty()).or_else(|| linked.and_then(|p| p.ado_project.clone()));
    let own_repo = linked.and_then(|p| p.ado_repo_id.clone().or_else(|| Some(p.name.clone())));
    let repo = Some(text("repo")).filter(|r| !r.is_empty()).or(own_repo);
    let action = text("action");
    let need_project = || project.clone().filter(|p| !p.is_empty()).ok_or_else(|| "name the project".to_string());
    let need_repo = || repo.clone().filter(|r| !r.is_empty()).ok_or_else(|| "name the repository in repo".to_string());
    let o = encode_segment(&org);
    let base = |project: &str| format!("https://dev.azure.com/{o}/{}/_apis", encode_segment(project));
    let branch = text("branch");
    let version = |branch: &str| {
        if branch.is_empty() { String::new() } else { format!("&versionDescriptor.versionType=branch&versionDescriptor.version={}", encode_segment(branch)) }
    };

    let out = match action.as_str() {
        "projects" => {
            let found = crate::ado::list_projects(&org, &pat).await?;
            found.iter().map(|p| p.name.clone()).collect::<Vec<_>>().join("\n")
        }
        "repos" => {
            let project = need_project()?;
            let url = format!("{}/git/repositories?api-version={API_VERSION}", base(&project));
            let found: Value = get_json(&url, &pat).await?;
            list(&found, |r| {
                format!(
                    "{} — default {} · {}",
                    s(r, "/name"),
                    s(r, "/defaultBranch").trim_start_matches("refs/heads/"),
                    s(r, "/remoteUrl")
                )
            })
        }
        "branches" => {
            let (project, repo) = (need_project()?, need_repo()?);
            let url = format!("{}/git/repositories/{}/refs?filter=heads/&$top={limit}&api-version={API_VERSION}", base(&project), encode_segment(&repo));
            let found: Value = get_json(&url, &pat).await?;
            list(&found, |r| format!("{} {}", s(r, "/name").trim_start_matches("refs/heads/"), &s(r, "/objectId").chars().take(8).collect::<String>()))
        }
        "tree" => {
            let (project, repo) = (need_project()?, need_repo()?);
            let path = Some(text("path")).filter(|p| !p.is_empty()).unwrap_or_else(|| "/".into());
            let url = format!(
                "{}/git/repositories/{}/items?scopePath={}&recursionLevel=OneLevel{}&api-version={API_VERSION}",
                base(&project),
                encode_segment(&repo),
                encode_segment(&path),
                version(&branch)
            );
            let found: Value = get_json(&url, &pat).await?;
            list(&found, |item| format!("{}{}", s(item, "/path"), if item.get("isFolder").and_then(Value::as_bool).unwrap_or(false) { "/" } else { "" }))
        }
        "file" => {
            let (project, repo) = (need_project()?, need_repo()?);
            let path = text("path");
            if path.is_empty() {
                return Err("path is required".into());
            }
            let url = format!(
                "{}/git/repositories/{}/items?path={}&includeContent=true&$format=json{}&api-version={API_VERSION}",
                base(&project),
                encode_segment(&repo),
                encode_segment(&path),
                version(&branch)
            );
            let found: Value = get_json(&url, &pat).await?;
            let mut content = s(&found, "/content");
            if content.len() > MAX_FILE {
                let mut cut = MAX_FILE;
                while !content.is_char_boundary(cut) {
                    cut -= 1;
                }
                content.truncate(cut);
                content.push_str("\n[… cut]");
            }
            format!("{repo}:{path}\n\n{content}")
        }
        "commits" => {
            let (project, repo) = (need_project()?, need_repo()?);
            let mut url = format!("{}/git/repositories/{}/commits?$top={limit}&api-version={API_VERSION}", base(&project), encode_segment(&repo));
            if !branch.is_empty() {
                url.push_str(&format!("&searchCriteria.itemVersion.version={}", encode_segment(&branch)));
            }
            if !text("path").is_empty() {
                url.push_str(&format!("&searchCriteria.itemPath={}", encode_segment(&text("path"))));
            }
            let found: Value = get_json(&url, &pat).await?;
            list(&found, |c| {
                format!(
                    "{} {} — {} · {}",
                    &s(c, "/commitId").chars().take(8).collect::<String>(),
                    s(c, "/comment").lines().next().unwrap_or_default(),
                    s(c, "/author/name"),
                    s(c, "/author/date")
                )
            })
        }
        "prs" => {
            let project = need_project()?;
            let status = Some(text("status")).filter(|st| !st.is_empty()).unwrap_or_else(|| "active".into());
            let scope = match text("repo").as_str() {
                "" => format!("{}/git/pullrequests", base(&project)),
                named => format!("{}/git/repositories/{}/pullrequests", base(&project), encode_segment(named)),
            };
            let url = format!("{scope}?searchCriteria.status={}&$top={limit}&api-version={API_VERSION}", encode_segment(&status));
            let found: Value = get_json(&url, &pat).await?;
            list(&found, |pr| {
                format!(
                    "!{} [{}{}] {} — {} → {} · {} · {}",
                    pr.get("pullRequestId").and_then(Value::as_i64).unwrap_or_default(),
                    s(pr, "/status"),
                    if pr.get("isDraft").and_then(Value::as_bool).unwrap_or(false) { ", draft" } else { "" },
                    s(pr, "/title"),
                    s(pr, "/sourceRefName").trim_start_matches("refs/heads/"),
                    s(pr, "/targetRefName").trim_start_matches("refs/heads/"),
                    s(pr, "/repository/name"),
                    s(pr, "/createdBy/displayName")
                )
            })
        }
        "pr" => {
            let project = need_project()?;
            let id = args.get("id").and_then(Value::as_i64).ok_or("id is required")?;
            let url = format!("{}/git/pullrequests/{id}?api-version={API_VERSION}", base(&project));
            let pr: Value = get_json(&url, &pat).await?;
            let reviewers = pr
                .get("reviewers")
                .and_then(Value::as_array)
                .map(|all| all.iter().map(|r| format!("{} ({})", s(r, "/displayName"), vote(r.get("vote").and_then(Value::as_i64).unwrap_or(0)))).collect::<Vec<_>>().join(", "))
                .unwrap_or_default();
            format!(
                "!{id} {}\n{} → {} · {} · {} · merge {}\nReviewers: {reviewers}\n\n{}",
                s(&pr, "/title"),
                s(&pr, "/sourceRefName").trim_start_matches("refs/heads/"),
                s(&pr, "/targetRefName").trim_start_matches("refs/heads/"),
                s(&pr, "/repository/name"),
                s(&pr, "/status"),
                s(&pr, "/mergeStatus"),
                s(&pr, "/description")
            )
        }
        "work_items" => {
            let project = need_project()?;
            let found = crate::ado::search_work_items(&org, &project, &text("query"), &pat).await?;
            if found.is_empty() {
                "No work items found.".to_string()
            } else {
                found
                    .iter()
                    .take(limit as usize)
                    .map(|w| format!("#{} [{} · {}] {}{}", w.id, w.work_item_type, w.state, w.title, w.assigned_to.as_deref().map(|a| format!(" — {a}")).unwrap_or_default()))
                    .collect::<Vec<_>>()
                    .join("\n")
            }
        }
        "work_item" => {
            let id = args.get("id").and_then(Value::as_i64).ok_or("id is required")?;
            let url = format!("https://dev.azure.com/{o}/_apis/wit/workitems/{id}?$expand=relations&api-version={API_VERSION}");
            let item: Value = get_json(&url, &pat).await?;
            let mut out = work_item_text(&item);
            if let Some(project) = item.pointer("/fields/System.TeamProject").and_then(Value::as_str) {
                let url = format!("{}/wit/workItems/{id}/comments?$top=30&api-version={API_VERSION}-preview.4", base(project));
                if let Ok(comments) = get_json::<Value>(&url, &pat).await {
                    let lines: Vec<String> = comments
                        .get("comments")
                        .and_then(Value::as_array)
                        .map(|all| all.iter().map(|c| format!("- {} ({}): {}", s(c, "/createdBy/displayName"), s(c, "/createdDate"), plain(&s(c, "/text")))).collect())
                        .unwrap_or_default();
                    if !lines.is_empty() {
                        out.push_str("\n\nComments:\n");
                        out.push_str(&lines.join("\n"));
                    }
                }
            }
            out
        }
        "wiql" => {
            let project = need_project()?;
            let query = text("query");
            if !query.to_ascii_uppercase().trim_start().starts_with("SELECT") {
                return Err("wiql takes a SELECT query".into());
            }
            let url = format!("{}/wit/wiql?$top={limit}&api-version={API_VERSION}", base(&project));
            let res = client()
                .post(&url)
                .header("Authorization", crate::ado::auth_header(&pat))
                .json(&json!({ "query": query }))
                .send()
                .await
                .map_err(|e| format!("couldn't reach Azure DevOps: {e}"))?;
            let status = res.status();
            if !status.is_success() {
                return Err(describe_failure(status, &res.text().await.unwrap_or_default()));
            }
            let found: Value = res.json().await.map_err(|e| format!("unexpected response from Azure DevOps: {e}"))?;
            let ids: Vec<String> = found
                .get("workItems")
                .and_then(Value::as_array)
                .map(|all| all.iter().filter_map(|w| w.get("id").and_then(Value::as_i64)).take(limit as usize).map(|id| id.to_string()).collect())
                .unwrap_or_default();
            if ids.is_empty() {
                return Ok("No work items match.".into());
            }
            let fields = "System.Id,System.Title,System.WorkItemType,System.State,System.AssignedTo,System.IterationPath";
            let url = format!("https://dev.azure.com/{o}/_apis/wit/workitems?ids={}&fields={fields}&errorPolicy=omit&api-version={API_VERSION}", ids.join(","));
            let items: Value = get_json(&url, &pat).await?;
            list(&items, |w| {
                format!(
                    "#{} [{} · {}] {} — {} · {}",
                    w.get("id").and_then(Value::as_i64).unwrap_or_default(),
                    field(w, "System.WorkItemType"),
                    field(w, "System.State"),
                    field(w, "System.Title"),
                    w.pointer("/fields/System.AssignedTo/displayName").and_then(Value::as_str).unwrap_or("unassigned"),
                    field(w, "System.IterationPath")
                )
            })
        }
        "" => return Err("action is required".into()),
        other => return Err(format!("unknown action {other}")),
    };
    let out = if out.trim().is_empty() { "Nothing found.".to_string() } else { out };
    Ok(crate::secret_scan::redact(&out).0)
}

fn s(value: &Value, pointer: &str) -> String {
    value.pointer(pointer).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn field(item: &Value, name: &str) -> String {
    item.get("fields").and_then(|f| f.get(name)).and_then(Value::as_str).unwrap_or_default().to_string()
}

/// One line per element of the answer's `value` array.
fn list(found: &Value, line: impl Fn(&Value) -> String) -> String {
    found.get("value").and_then(Value::as_array).map(|all| all.iter().map(line).collect::<Vec<_>>().join("\n")).unwrap_or_default()
}

fn vote(vote: i64) -> &'static str {
    match vote {
        10 => "approved",
        5 => "approved with suggestions",
        -5 => "waiting for author",
        -10 => "rejected",
        _ => "no vote",
    }
}

/// Azure's rich-text fields are HTML: as plain text, roughly.
fn plain(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut tag = String::new();
    for c in html.chars() {
        match c {
            '<' => {
                in_tag = true;
                tag.clear();
            }
            '>' if in_tag => {
                in_tag = false;
                let name = tag.trim_start_matches('/').split(|c: char| c.is_whitespace() || c == '/').next().unwrap_or_default().to_ascii_lowercase();
                let closing = tag.starts_with('/');
                if name == "li" {
                    if !closing {
                        out.push_str("\n- ");
                    }
                } else if matches!(name.as_str(), "br" | "p" | "div" | "tr" | "h1" | "h2" | "h3" | "h4") {
                    out.push('\n');
                }
            }
            _ if in_tag => tag.push(c),
            _ => out.push(c),
        }
    }
    let out = out.replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&amp;", "&");
    let lines: Vec<&str> = out.lines().map(str::trim_end).collect();
    let mut joined = lines.join("\n");
    while joined.contains("\n\n\n") {
        joined = joined.replace("\n\n\n", "\n\n");
    }
    joined.trim().to_string()
}

/// One work item in full: the fields a developer reads, its description and acceptance criteria as
/// text, and what it links to.
fn work_item_text(item: &Value) -> String {
    let id = item.get("id").and_then(Value::as_i64).unwrap_or_default();
    let mut out = vec![
        format!("#{id} [{} · {}] {}", field(item, "System.WorkItemType"), field(item, "System.State"), field(item, "System.Title")),
        format!(
            "Assigned: {} · Area: {} · Iteration: {} · Tags: {}",
            item.pointer("/fields/System.AssignedTo/displayName").and_then(Value::as_str).unwrap_or("unassigned"),
            field(item, "System.AreaPath"),
            field(item, "System.IterationPath"),
            field(item, "System.Tags")
        ),
    ];
    for (label, name) in [
        ("Description", "System.Description"),
        ("Acceptance criteria", "Microsoft.VSTS.Common.AcceptanceCriteria"),
        ("Repro steps", "Microsoft.VSTS.TCM.ReproSteps"),
    ] {
        let value = plain(&field(item, name));
        if !value.is_empty() {
            out.push(format!("\n{label}:\n{value}"));
        }
    }
    let relations: Vec<String> = item
        .get("relations")
        .and_then(Value::as_array)
        .map(|all| {
            all.iter()
                .map(|r| {
                    let kind = r.pointer("/attributes/name").and_then(Value::as_str).unwrap_or_else(|| r.get("rel").and_then(Value::as_str).unwrap_or_default());
                    let url = s(r, "/url");
                    let target = url.rsplit('/').next().unwrap_or(&url);
                    format!("- {kind}: {target}")
                })
                .collect()
        })
        .unwrap_or_default();
    if !relations.is_empty() {
        out.push(format!("\nLinks:\n{}", relations.join("\n")));
    }
    out.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rich_text_reads_as_text() {
        assert_eq!(plain("<div>Hola&nbsp;<b>mundo</b></div><ul><li>uno</li><li>dos</li></ul>"), "Hola mundo\n\n- uno\n- dos");
    }

    #[test]
    fn a_work_item_names_what_a_developer_reads() {
        let item = json!({
            "id": 7,
            "fields": {"System.WorkItemType": "Bug", "System.State": "Active", "System.Title": "Falla login", "System.Description": "<p>Pasos</p>"},
            "relations": [{"rel": "ArtifactLink", "url": "vstfs:///Git/PullRequestId/x%2Fy%2F42", "attributes": {"name": "Pull Request"}}]
        });
        let text = work_item_text(&item);
        assert!(text.starts_with("#7 [Bug · Active] Falla login"), "{text}");
        assert!(text.contains("Description:\nPasos"), "{text}");
        assert!(text.contains("- Pull Request: x%2Fy%2F42"), "{text}");
    }
}
