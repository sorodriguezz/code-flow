//! "Assigned to me", per board — the reads behind the «Tickets» section (see [`super::tickets`]).
//!
//! Each board is asked the question in its own words, because each has one and none of them is a
//! filter over a full listing: Azure's WIQL `@Me`, Jira's `assignee = currentUser()`, Linear's
//! `viewer.assignedIssues`, GitHub's `filter=assigned`, GitLab's `scope=assigned_to_me`, monday's
//! `assigned_to_me` rule on a people column. All of them leave finished work out at the host, so
//! the list is what is still yours to do (or waiting on review).
//!
//! The answers are parsed by plain functions over `serde_json::Value` so each provider's shape is
//! tested against a fixture without a network. Credentials come from the callers, through the same
//! `board_auth` the «Especificación» app uses; nothing here reads or prints a secret.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};

use super::tickets::{fold, Ticket, TicketComment, TicketDetail, MAX_COMMENTS};
use super::{issues, jira, linear, monday, text_to_html, BoardAuth, BoardProvider};
use crate::ado::{auth_header, client as ado_client, encode_segment, get_json as ado_get_json, normalize_org, API_VERSION};

/// The most tickets one connection lists. A person with more than this assigned has a triage
/// problem a list cannot solve, and every board pages at about this size.
const MAX_TICKETS: usize = 200;

// ---------- shared ----------

fn s(value: &Value, pointer: &str) -> String {
    value.pointer(pointer).and_then(Value::as_str).unwrap_or_default().to_string()
}

/// A category from the state's *name*, for boards whose list answer carries no category (Azure's
/// item read, GitHub's open/closed). Unknown names stay uncategorised rather than guessed.
pub fn category_from_name(name: &str) -> String {
    let folded = fold(name.trim());
    const TODO: &[&str] = &["new", "to do", "todo", "por hacer", "proposed", "backlog", "open", "opened", "nuevo", "abierto", "pendiente"];
    const DOING: &[&str] = &["active", "in progress", "doing", "en curso", "en progreso", "committed", "approved", "en desarrollo", "started"];
    const REVIEW: &[&str] = &["in review", "en revision", "code review", "review", "resolved", "resuelto", "qa", "testing", "ready for review"];
    const DONE: &[&str] = &["done", "hecho", "closed", "cerrado", "completed", "completado", "terminado", "removed", "merged"];
    for (words, category) in [(TODO, "todo"), (DOING, "doing"), (REVIEW, "review"), (DONE, "done")] {
        if words.contains(&folded.as_str()) {
            return category.to_string();
        }
    }
    String::new()
}

/// Markdown prose split at its acceptance-criteria heading — the convention the app's own publish
/// writes (`Criterios de aceptación`) and the English one people type.
pub fn split_markdown_criteria(text: &str) -> (String, String) {
    let lines: Vec<&str> = text.lines().collect();
    // A line that is nothing but the heading — `## Criterios de aceptación`, `**Acceptance criteria:**`.
    let is_heading = |line: &str| {
        let bare = line.trim().trim_start_matches('#').trim().trim_matches('*').trim().trim_end_matches(':');
        matches!(fold(bare).as_str(), "criterios de aceptacion" | "acceptance criteria")
    };
    match lines.iter().position(|line| is_heading(line)) {
        Some(at) => (lines[..at].join("\n").trim().to_string(), lines[at + 1..].join("\n").trim().to_string()),
        None => (text.trim().to_string(), String::new()),
    }
}

/// Markdown body → the two HTML parts a detail shows.
fn markdown_parts(body: &str) -> (String, String) {
    let (prose, criteria) = split_markdown_criteria(body);
    (text_to_html(&prose), text_to_html(&criteria))
}

/// The newest [`MAX_COMMENTS`], oldest first — the order a conversation is read in.
fn newest_last(mut comments: Vec<TicketComment>) -> Vec<TicketComment> {
    comments.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    let skip = comments.len().saturating_sub(MAX_COMMENTS);
    comments.into_iter().skip(skip).collect()
}

// ---------- Azure Boards ----------

const AZURE_FIELDS: &str = "System.Id,System.Title,System.State,System.WorkItemType,System.TeamProject,\
System.IterationPath,Microsoft.VSTS.Common.Priority,System.ChangedDate";

/// The query: yours, across every project of the organisation, finished work left out by the
/// state names every stock process uses for it.
pub fn azure_wiql() -> String {
    "SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me \
     AND [System.State] NOT IN ('Closed', 'Done', 'Removed', 'Cut', 'Completed') \
     ORDER BY [System.ChangedDate] DESC"
        .to_string()
}

pub fn parse_azure_items(org: &str, body: &Value) -> Vec<Ticket> {
    let org_enc = encode_segment(&normalize_org(org));
    body["value"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| !item.is_null())
        .map(|item| {
            let fields = &item["fields"];
            let f = |name: &str| fields.get(name).and_then(Value::as_str).unwrap_or_default().to_string();
            let id = item["id"].as_i64().unwrap_or_default();
            let iteration = f("System.IterationPath");
            let project = f("System.TeamProject");
            // The iteration's own name: its path is `Project\Release 2\Sprint 14`, and the root
            // (no sprint picked) is just the project.
            let sprint = match iteration.rsplit('\\').next() {
                Some(last) if iteration.contains('\\') => last.to_string(),
                _ => String::new(),
            };
            let state = f("System.State");
            Ticket {
                provider: "azure".into(),
                account: normalize_org(org),
                project: project.clone(),
                container_id: project,
                id,
                key: String::new(),
                title: f("System.Title"),
                state_category: category_from_name(&state),
                state,
                work_item_type: f("System.WorkItemType"),
                sprint,
                priority: fields.get("Microsoft.VSTS.Common.Priority").and_then(Value::as_i64).map(|p| p.to_string()).unwrap_or_default(),
                url: format!("https://dev.azure.com/{org_enc}/_workitems/edit/{id}"),
                updated_at: f("System.ChangedDate"),
                state_field: String::new(),
            }
        })
        .collect()
}

async fn azure_assigned(org: &str, pat: &str) -> Result<Vec<Ticket>, String> {
    let org_enc = encode_segment(&normalize_org(org));
    let url = format!("https://dev.azure.com/{org_enc}/_apis/wit/wiql?$top={MAX_TICKETS}&api-version={API_VERSION}");
    let res = ado_client()
        .post(&url)
        .header("Authorization", auth_header(pat))
        .header("Content-Type", "application/json")
        .body(json!({ "query": azure_wiql() }).to_string())
        .send()
        .await
        .map_err(|e| format!("couldn't reach Azure DevOps: {e}"))?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(crate::ado::describe_failure(status, &text));
    }
    let found: Value = serde_json::from_str(&text).map_err(|e| format!("unexpected response from Azure DevOps: {e}"))?;
    let ids: Vec<String> = found["workItems"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| r["id"].as_i64())
        .take(MAX_TICKETS)
        .map(|id| id.to_string())
        .collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let url = format!(
        "https://dev.azure.com/{org_enc}/_apis/wit/workitems?ids={}&fields={AZURE_FIELDS}&errorPolicy=omit&api-version={API_VERSION}",
        ids.join(",")
    );
    let items: Value = ado_get_json(&url, pat).await?;
    Ok(parse_azure_items(org, &items))
}

pub fn parse_azure_comments(body: &Value) -> Vec<TicketComment> {
    newest_last(
        body["comments"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|c| TicketComment {
                author: s(c, "/createdBy/displayName"),
                created_at: s(c, "/createdDate"),
                // Already HTML on Azure.
                body_html: s(c, "/text"),
            })
            .collect(),
    )
}

async fn azure_detail(ticket: &Ticket, pat: &str) -> Result<TicketDetail, String> {
    let item = super::azure::get_work_item(&ticket.account, ticket.id, pat).await?;
    let org_enc = encode_segment(&normalize_org(&ticket.account));
    let project = encode_segment(if item.team_project.is_empty() { &ticket.container_id } else { &item.team_project });
    // The comments API is still a preview one; a failure costs the pane its comments, not the ticket.
    let comments_url = format!(
        "https://dev.azure.com/{org_enc}/{project}/_apis/wit/workItems/{}/comments?$top={MAX_COMMENTS}&order=desc&api-version=7.1-preview.4",
        ticket.id
    );
    let comments = ado_get_json::<Value>(&comments_url, pat).await.map(|v| parse_azure_comments(&v)).unwrap_or_default();
    let mut fresh = ticket.clone();
    fresh.title = item.title;
    fresh.state_category = category_from_name(&item.state);
    fresh.state = item.state;
    fresh.work_item_type = item.work_item_type;
    // A bug keeps its prose in Repro Steps; the pane has one description box.
    let description_html = match item.description_html.trim().is_empty() {
        true => item.repro_steps_html,
        false => item.description_html,
    };
    Ok(TicketDetail { ticket: fresh, description_html, acceptance_criteria_html: item.acceptance_criteria_html, comments })
}

// ---------- Jira ----------

pub const JIRA_JQL: &str = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";

/// Which custom field holds the sprint on this site — `customfield_10020` on most Cloud sites, but
/// it is the site's to number. Remembered per site once found.
fn sprint_memo() -> &'static Mutex<HashMap<String, String>> {
    static MEMO: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    MEMO.get_or_init(Default::default)
}

pub fn find_sprint_field(fields: &Value) -> Option<String> {
    fields.as_array()?.iter().find_map(|field| {
        let custom = field.pointer("/schema/custom").and_then(Value::as_str).unwrap_or_default();
        (custom == "com.pyxis.greenhopper.jira:gh-sprint").then(|| s(field, "/id")).filter(|id| !id.is_empty())
    })
}

async fn jira_sprint_field(site: &str, auth: &BoardAuth) -> Option<String> {
    if let Some(hit) = sprint_memo().lock().ok().and_then(|m| m.get(site).cloned()) {
        return Some(hit);
    }
    let fields: Value = jira::get_json(&format!("{site}/rest/api/2/field"), auth).await.ok()?;
    let id = find_sprint_field(&fields)?;
    if let Ok(mut memo) = sprint_memo().lock() {
        memo.insert(site.to_string(), id.clone());
    }
    Some(id)
}

/// The sprint a Jira issue is in: the active one if it has several, else the last. Cloud answers
/// objects; Server and Data Center answer `…Sprint@1a2b[id=3,state=ACTIVE,name=Sprint 3,…]` strings.
pub fn jira_sprint(value: &Value) -> String {
    let Some(list) = value.as_array() else { return String::new() };
    let parsed: Vec<(String, String)> = list
        .iter()
        .filter_map(|entry| {
            if let Some(name) = entry.get("name").and_then(Value::as_str) {
                return Some((name.to_string(), entry.get("state").and_then(Value::as_str).unwrap_or_default().to_ascii_lowercase()));
            }
            let raw = entry.as_str()?;
            let field = |key: &str| {
                let start = raw.find(&format!("{key}="))? + key.len() + 1;
                let rest = &raw[start..];
                let end = rest.find([',', ']']).unwrap_or(rest.len());
                Some(rest[..end].to_string())
            };
            Some((field("name")?, field("state").unwrap_or_default().to_ascii_lowercase()))
        })
        .collect();
    parsed
        .iter()
        .find(|(_, state)| state == "active")
        .or_else(|| parsed.last())
        .map(|(name, _)| name.clone())
        .unwrap_or_default()
}

pub fn parse_jira_search(site: &str, body: &Value, sprint_field: Option<&str>) -> Vec<Ticket> {
    body["issues"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|issue| {
            let key = s(issue, "/key");
            let fields = &issue["fields"];
            let category = match s(fields, "/status/statusCategory/key").as_str() {
                "new" => "todo",
                "indeterminate" => "doing",
                "done" => "done",
                _ => "",
            };
            let state = s(fields, "/status/name");
            // Jira files review under "In Progress"; the name is the better witness for that one.
            let category = match category_from_name(&state).as_str() {
                "review" => "review".to_string(),
                _ => category.to_string(),
            };
            Ticket {
                provider: "jira".into(),
                account: site.to_string(),
                project: s(fields, "/project/name"),
                container_id: s(fields, "/project/key"),
                id: jira::numeric_id(&s(issue, "/id")),
                url: jira::browse_url(site, &key),
                key,
                title: s(fields, "/summary"),
                state,
                state_category: category,
                work_item_type: s(fields, "/issuetype/name"),
                sprint: sprint_field.map(|field| jira_sprint(&fields[field])).unwrap_or_default(),
                priority: s(fields, "/priority/name"),
                updated_at: s(fields, "/updated"),
                state_field: String::new(),
            }
        })
        .collect()
}

async fn jira_assigned(site: &str, auth: &BoardAuth) -> Result<Vec<Ticket>, String> {
    let site = jira::normalize_site(site);
    let sprint = jira_sprint_field(&site, auth).await;
    let mut fields = "summary,status,issuetype,project,priority,updated".to_string();
    if let Some(field) = &sprint {
        fields.push(',');
        fields.push_str(field);
    }
    let url = |route: jira::SearchRoute| {
        let path = match route {
            jira::SearchRoute::Enhanced => "search/jql",
            jira::SearchRoute::Legacy => "search",
        };
        format!("{site}/rest/api/2/{path}?jql={}&maxResults=100&fields={fields}", jira::encode_segment(JIRA_JQL))
    };
    let found: Value = match jira::fetch_json(&url(jira::SearchRoute::Enhanced), auth).await {
        Ok(found) => found,
        Err(failure) if failure.status == Some(reqwest::StatusCode::NOT_FOUND) => jira::get_json(&url(jira::SearchRoute::Legacy), auth).await?,
        Err(failure) => return Err(failure.message),
    };
    Ok(parse_jira_search(&site, &found, sprint.as_deref()))
}

pub fn parse_jira_comments(body: &Value) -> Vec<TicketComment> {
    newest_last(
        body["comments"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|c| TicketComment { author: s(c, "/author/displayName"), created_at: s(c, "/created"), body_html: text_to_html(&s(c, "/body")) })
            .collect(),
    )
}

async fn jira_detail(ticket: &Ticket, auth: &BoardAuth) -> Result<TicketDetail, String> {
    let site = jira::normalize_site(&ticket.account);
    let item = jira::get_issue(&site, &ticket.key, auth).await?;
    let url = format!("{site}/rest/api/2/issue/{}/comment?orderBy=-created&maxResults={MAX_COMMENTS}", jira::encode_segment(&ticket.key));
    let comments = jira::get_json::<Value>(&url, auth).await.map(|v| parse_jira_comments(&v)).unwrap_or_default();
    let mut fresh = ticket.clone();
    fresh.title = item.title;
    fresh.state = item.state;
    Ok(TicketDetail { ticket: fresh, description_html: item.description_html, acceptance_criteria_html: item.acceptance_criteria_html, comments })
}

// ---------- Linear ----------

pub const LINEAR_ASSIGNED: &str = "query { viewer { assignedIssues(first: 100, orderBy: updatedAt, \
filter: { state: { type: { nin: [\"completed\", \"canceled\"] } } }) { nodes { identifier title url priorityLabel updatedAt \
state { name type } team { id key name } cycle { name number } labels { nodes { name } } } } } }";

/// Linear's state *type* is its category: backlog/unstarted/started/completed/canceled.
fn linear_category(kind: &str, name: &str) -> String {
    match kind {
        "backlog" | "unstarted" | "triage" => "todo".into(),
        "started" if category_from_name(name) == "review" => "review".into(),
        "started" => "doing".into(),
        "completed" | "canceled" => "done".into(),
        _ => String::new(),
    }
}

pub fn parse_linear_assigned(org: &str, data: &Value) -> Vec<Ticket> {
    data.pointer("/viewer/assignedIssues/nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|node| {
            let key = s(node, "/identifier");
            let labels: Vec<String> = node.pointer("/labels/nodes").and_then(Value::as_array).into_iter().flatten().map(|l| s(l, "/name")).collect();
            let state = s(node, "/state/name");
            let cycle = match s(node, "/cycle/name") {
                name if !name.is_empty() => name,
                _ => node.pointer("/cycle/number").and_then(Value::as_i64).map(|n| format!("Cycle {n}")).unwrap_or_default(),
            };
            Ticket {
                provider: "linear".into(),
                account: org.to_string(),
                project: s(node, "/team/name"),
                container_id: s(node, "/team/id"),
                id: key.rsplit('-').next().and_then(|n| n.parse().ok()).unwrap_or(0),
                title: s(node, "/title"),
                state_category: linear_category(&s(node, "/state/type"), &state),
                state,
                work_item_type: labels.iter().find(|l| fold(l).contains("bug")).cloned().or_else(|| labels.first().cloned()).unwrap_or_else(|| "Issue".into()),
                sprint: cycle,
                priority: match s(node, "/priorityLabel") {
                    label if label == "No priority" => String::new(),
                    label => label,
                },
                url: s(node, "/url"),
                updated_at: s(node, "/updatedAt"),
                key,
                state_field: String::new(),
            }
        })
        .collect()
}

pub fn parse_linear_detail(ticket: &Ticket, data: &Value) -> TicketDetail {
    let issue = &data["issue"];
    let (description_html, acceptance_criteria_html) = markdown_parts(&s(issue, "/description"));
    let comments = newest_last(
        issue
            .pointer("/comments/nodes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|c| TicketComment { author: s(c, "/user/name"), created_at: s(c, "/createdAt"), body_html: text_to_html(&s(c, "/body")) })
            .collect(),
    );
    let mut fresh = ticket.clone();
    if !s(issue, "/title").is_empty() {
        fresh.title = s(issue, "/title");
        fresh.state = s(issue, "/state/name");
        fresh.state_category = linear_category(&s(issue, "/state/type"), &fresh.state);
    }
    TicketDetail { ticket: fresh, description_html, acceptance_criteria_html, comments }
}

async fn linear_detail(ticket: &Ticket, auth: &BoardAuth) -> Result<TicketDetail, String> {
    let data = linear::run(
        "query ($id: String!) { issue(id: $id) { title description state { name type } \
         comments(first: 50) { nodes { body createdAt user { name } } } } }",
        json!({ "id": ticket.key.trim() }),
        auth,
    )
    .await?;
    Ok(parse_linear_detail(ticket, &data))
}

// ---------- GitHub / GitLab Issues ----------

fn tracker_of(provider: BoardProvider) -> issues::Tracker {
    match provider {
        BoardProvider::Gitlab => issues::Tracker::GitLab,
        _ => issues::Tracker::GitHub,
    }
}

fn label_names(issue: &Value) -> Vec<String> {
    issue["labels"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|l| l.as_str().map(str::to_string).or_else(|| l.get("name").and_then(Value::as_str).map(str::to_string)))
        .collect()
}

/// A priority read off the labels people actually use for it: `P1`, `priority: high`, `prioridad/alta`.
fn label_priority(labels: &[String]) -> String {
    labels
        .iter()
        .find_map(|label| {
            let folded = fold(label);
            let bare = folded.trim();
            if bare.len() == 2 && bare.starts_with('p') && bare[1..].chars().all(|c| c.is_ascii_digit()) {
                return Some(label.clone());
            }
            ["priority", "prioridad"].iter().find_map(|word| {
                bare.strip_prefix(word).map(|rest| rest.trim_start_matches([':', '/', ' ', '-']).trim().to_string()).filter(|r| !r.is_empty())
            })
        })
        .unwrap_or_default()
}

pub fn parse_tracker_assigned(provider: BoardProvider, host: &str, body: &Value) -> Vec<Ticket> {
    body.as_array()
        .into_iter()
        .flatten()
        // GitHub's issues listing carries pull requests too.
        .filter(|issue| issue.get("pull_request").is_none())
        .filter_map(|issue| {
            let (repo, number) = match provider {
                BoardProvider::Gitlab => {
                    let full = s(issue, "/references/full");
                    let (repo, _) = full.rsplit_once('#')?;
                    (repo.to_string(), issue["iid"].as_i64()?)
                }
                _ => (s(issue, "/repository/full_name"), issue["number"].as_i64()?),
            };
            if repo.is_empty() {
                return None;
            }
            let labels = label_names(issue);
            let sprint = match s(issue, "/iteration/title") {
                title if !title.is_empty() => title,
                _ => s(issue, "/milestone/title"),
            };
            let state = s(issue, "/state");
            Some(Ticket {
                provider: provider.as_str().into(),
                account: host.to_string(),
                project: repo.clone(),
                container_id: repo.clone(),
                id: number,
                key: issues::key_of(&repo, number),
                title: s(issue, "/title"),
                state_category: category_from_name(&state),
                state,
                work_item_type: labels.iter().find(|l| fold(l).contains("bug")).map(|_| "Bug".to_string()).unwrap_or_else(|| "Issue".into()),
                sprint,
                priority: label_priority(&labels),
                url: match provider {
                    BoardProvider::Gitlab => s(issue, "/web_url"),
                    _ => s(issue, "/html_url"),
                },
                updated_at: s(issue, "/updated_at"),
                state_field: String::new(),
            })
        })
        .collect()
}

async fn tracker_assigned(provider: BoardProvider, host: &str, token: &str) -> Result<Vec<Ticket>, String> {
    let tracker = tracker_of(provider);
    let url = match tracker {
        issues::Tracker::GitHub => format!("{}/issues?filter=assigned&state=open&sort=updated&per_page=100", crate::github::api_root(host.trim())),
        issues::Tracker::GitLab => {
            format!("{}/issues?scope=assigned_to_me&state=opened&order_by=updated_at&per_page=100", crate::gitlab::api_root(host.trim()))
        }
    };
    let body = issues::send(tracker, issues::request(tracker, reqwest::Method::GET, &url, token)).await?;
    Ok(parse_tracker_assigned(provider, host, &body))
}

pub fn parse_tracker_comments(provider: BoardProvider, body: &Value) -> Vec<TicketComment> {
    newest_last(
        body.as_array()
            .into_iter()
            .flatten()
            // GitLab's notes include the system's own ("changed the description").
            .filter(|note| !note.get("system").and_then(Value::as_bool).unwrap_or(false))
            .map(|c| TicketComment {
                author: match provider {
                    BoardProvider::Gitlab => s(c, "/author/name"),
                    _ => s(c, "/user/login"),
                },
                created_at: s(c, "/created_at"),
                body_html: text_to_html(&s(c, "/body")),
            })
            .collect(),
    )
}

async fn tracker_detail(ticket: &Ticket, token: &str) -> Result<TicketDetail, String> {
    let provider = ticket.board();
    let tracker = tracker_of(provider);
    let (repo, number) = issues::split_key(&ticket.key).ok_or_else(|| format!("«{}» no es una referencia de issue", ticket.key))?;
    let root = issues::repo_root(tracker, &ticket.account, &repo)?;
    let raw = issues::send(tracker, issues::request(tracker, reqwest::Method::GET, &format!("{root}/issues/{number}"), token)).await?;
    let body = match tracker {
        issues::Tracker::GitHub => s(&raw, "/body"),
        issues::Tracker::GitLab => s(&raw, "/description"),
    };
    let (description_html, acceptance_criteria_html) = markdown_parts(&body);
    let comments_url = match tracker {
        issues::Tracker::GitHub => format!("{root}/issues/{number}/comments?per_page=100"),
        issues::Tracker::GitLab => format!("{root}/issues/{number}/notes?sort=desc&order_by=created_at&per_page=50"),
    };
    let comments = issues::send(tracker, issues::request(tracker, reqwest::Method::GET, &comments_url, token))
        .await
        .map(|v| parse_tracker_comments(provider, &v))
        .unwrap_or_default();
    let mut fresh = ticket.clone();
    fresh.title = s(&raw, "/title");
    fresh.state = s(&raw, "/state");
    fresh.state_category = category_from_name(&fresh.state);
    Ok(TicketDetail { ticket: fresh, description_html, acceptance_criteria_html, comments })
}

// ---------- monday.com ----------

/// The boards worth asking: those with a people column (where "assigned to me" can mean
/// something) — and their status column, which is where an item's state lives.
pub fn monday_board_columns(data: &Value) -> Vec<(String, String, String, String)> {
    data["boards"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|board| {
            let columns = board["columns"].as_array()?;
            let people = columns.iter().find(|c| s(c, "/type") == "people").map(|c| s(c, "/id"))?;
            let status = columns.iter().find(|c| s(c, "/type") == "status").map(|c| s(c, "/id")).unwrap_or_default();
            Some((s(board, "/id"), s(board, "/name"), people, status))
        })
        .collect()
}

pub fn parse_monday_items(slug: &str, board_id: &str, board_name: &str, status_column: &str, data: &Value) -> Vec<Ticket> {
    data["boards"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|board| board.pointer("/items_page/items").and_then(Value::as_array).cloned().unwrap_or_default())
        .filter_map(|item| {
            let id = monday::numeric_id(&s(&item, "/id"));
            let state = item["column_values"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|v| s(v, "/id") == status_column)
                .map(|v| s(v, "/text"))
                .unwrap_or_default();
            let category = category_from_name(&state);
            // monday has no server-side "not done" — a finished item is left out here.
            (category != "done").then(|| Ticket {
                provider: "monday".into(),
                account: slug.to_string(),
                project: board_name.to_string(),
                container_id: board_id.to_string(),
                id,
                key: String::new(),
                title: s(&item, "/name"),
                state,
                state_category: category,
                work_item_type: s(&item, "/group/title"),
                sprint: String::new(),
                priority: String::new(),
                url: monday::item_url(slug, board_id, id),
                updated_at: s(&item, "/updated_at"),
                state_field: status_column.to_string(),
            })
        })
        .collect()
}

/// Boards read per refresh. Each is one request; past this the list is someone's whole account.
const MONDAY_BOARDS: usize = 30;

async fn monday_assigned(slug: &str, auth: &BoardAuth) -> Result<Vec<Ticket>, String> {
    let boards: Value = monday::run(
        "query { boards(limit: 100, state: active) { id name columns(types: [people, status]) { id type } } }",
        json!({}),
        auth,
    )
    .await?;
    let mut out = Vec::new();
    for (board_id, name, people, status) in monday_board_columns(&boards).into_iter().take(MONDAY_BOARDS) {
        let query = format!(
            "query ($ids: [ID!]) {{ boards(ids: $ids) {{ items_page(limit: 100, query_params: {{ rules: [{{ column_id: {}, \
             compare_value: [\"assigned_to_me\"], operator: any_of }}] }}) {{ items {{ id name updated_at group {{ title }} \
             column_values {{ id text }} }} }} }} }}",
            serde_json::to_string(&people).unwrap_or_default()
        );
        // One board this token cannot filter is not a reason to lose the others.
        if let Ok(items) = monday::run::<Value>(&query, json!({ "ids": [board_id] }), auth).await {
            out.extend(parse_monday_items(slug, &board_id, &name, &status, &items));
        }
        if out.len() >= MAX_TICKETS {
            break;
        }
    }
    Ok(out)
}

pub fn parse_monday_updates(data: &Value) -> Vec<TicketComment> {
    newest_last(
        data["items"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|item| item["updates"].as_array().cloned().unwrap_or_default())
            .map(|u| TicketComment { author: s(&u, "/creator/name"), created_at: s(&u, "/created_at"), body_html: s(&u, "/body") })
            .collect(),
    )
}

async fn monday_detail(ticket: &Ticket, auth: &BoardAuth) -> Result<TicketDetail, String> {
    let item = monday::get_item(&ticket.account, ticket.id, auth).await?;
    let updates = monday::run::<Value>(
        &format!("query ($ids: [ID!]) {{ items(ids: $ids) {{ updates(limit: {MAX_COMMENTS}) {{ body created_at creator {{ name }} }} }} }}"),
        json!({ "ids": [ticket.id.to_string()] }),
        auth,
    )
    .await
    .map(|v| parse_monday_updates(&v))
    .unwrap_or_default();
    let mut fresh = ticket.clone();
    fresh.title = item.title;
    Ok(TicketDetail { ticket: fresh, description_html: item.description_html, acceptance_criteria_html: item.acceptance_criteria_html, comments: updates })
}

// ---------- dispatch ----------

/// The tickets assigned to the account `account` on `provider`.
pub async fn list_assigned(provider: BoardProvider, account: &str, auth: &BoardAuth) -> Result<Vec<Ticket>, String> {
    let mut tickets = match provider {
        BoardProvider::Azure => azure_assigned(account, &auth.secret).await?,
        BoardProvider::Jira => jira_assigned(account, auth).await?,
        BoardProvider::Linear => parse_linear_assigned(account, &linear::run(LINEAR_ASSIGNED, json!({}), auth).await?),
        BoardProvider::Github | BoardProvider::Gitlab => tracker_assigned(provider, account, &auth.secret).await?,
        BoardProvider::Monday => monday_assigned(account, auth).await?,
    };
    tickets.truncate(MAX_TICKETS);
    Ok(tickets)
}

/// One ticket whole: description, acceptance criteria, recent comments.
pub async fn get_detail(ticket: &Ticket, auth: &BoardAuth) -> Result<TicketDetail, String> {
    match ticket.board() {
        BoardProvider::Azure => azure_detail(ticket, &auth.secret).await,
        BoardProvider::Jira => jira_detail(ticket, auth).await,
        BoardProvider::Linear => linear_detail(ticket, auth).await,
        BoardProvider::Github | BoardProvider::Gitlab => tracker_detail(ticket, &auth.secret).await,
        BoardProvider::Monday => monday_detail(ticket, auth).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn azure_items_parse_with_sprint_and_priority() {
        let body = json!({ "value": [
            { "id": 4821, "fields": {
                "System.Title": "Totales mal redondeados", "System.State": "Active", "System.WorkItemType": "Bug",
                "System.TeamProject": "Web", "System.IterationPath": "Web\\Release 2\\Sprint 14",
                "Microsoft.VSTS.Common.Priority": 2, "System.ChangedDate": "2026-10-20T10:00:00Z" } },
            null,
            { "id": 7, "fields": { "System.Title": "Root", "System.State": "New", "System.TeamProject": "Web", "System.IterationPath": "Web" } }
        ]});
        let tickets = parse_azure_items("https://dev.azure.com/acme/", &body);
        assert_eq!(tickets.len(), 2);
        let t = &tickets[0];
        assert_eq!((t.account.as_str(), t.id, t.sprint.as_str(), t.priority.as_str()), ("acme", 4821, "Sprint 14", "2"));
        assert_eq!(t.state_category, "doing");
        assert_eq!(t.url, "https://dev.azure.com/acme/_workitems/edit/4821");
        assert_eq!(tickets[1].sprint, "", "the project root is no sprint");
        assert!(azure_wiql().contains("@Me"));
    }

    #[test]
    fn jira_search_parses_cloud_and_server_sprints() {
        let body = json!({ "issues": [
            { "id": "10055", "key": "WEB-55", "fields": {
                "summary": "Login con Google", "status": { "name": "In Review", "statusCategory": { "key": "indeterminate" } },
                "issuetype": { "name": "Story" }, "project": { "key": "WEB", "name": "Web Store" }, "priority": { "name": "High" },
                "updated": "2026-10-21T09:00:00.000+0000",
                "customfield_10020": [ { "name": "Sprint 11", "state": "closed" }, { "name": "Sprint 12", "state": "active" } ] } },
            { "id": "10056", "key": "WEB-56", "fields": { "summary": "x", "status": { "name": "To Do", "statusCategory": { "key": "new" } },
                "customfield_10020": [ "com.atlassian.greenhopper.service.sprint.Sprint@1a[id=3,rapidViewId=1,state=FUTURE,name=Sprint 13,startDate=<null>]" ] } }
        ]});
        let tickets = parse_jira_search("https://acme.atlassian.net", &body, Some("customfield_10020"));
        assert_eq!(tickets[0].key, "WEB-55");
        assert_eq!(tickets[0].id, 10055);
        assert_eq!(tickets[0].sprint, "Sprint 12");
        assert_eq!(tickets[0].state_category, "review");
        assert_eq!(tickets[0].container_id, "WEB");
        assert_eq!(tickets[0].url, "https://acme.atlassian.net/browse/WEB-55");
        assert_eq!(tickets[1].sprint, "Sprint 13");
        assert_eq!(tickets[1].state_category, "todo");
        assert!(JIRA_JQL.contains("currentUser()"));
    }

    #[test]
    fn jira_sprint_field_is_found_by_schema() {
        let fields = json!([{ "id": "summary", "schema": { "type": "string" } }, { "id": "customfield_10020", "schema": { "custom": "com.pyxis.greenhopper.jira:gh-sprint" } }]);
        assert_eq!(find_sprint_field(&fields).as_deref(), Some("customfield_10020"));
        assert_eq!(find_sprint_field(&json!([])), None);
    }

    #[test]
    fn linear_assigned_parses_cycles_and_labels() {
        let data = json!({ "viewer": { "assignedIssues": { "nodes": [
            { "identifier": "ENG-9", "title": "Crash al abrir", "url": "https://linear.app/acme/issue/ENG-9/crash", "priorityLabel": "Urgent",
              "updatedAt": "2026-10-22T00:00:00Z", "state": { "name": "In Progress", "type": "started" },
              "team": { "id": "t1", "key": "ENG", "name": "Engineering" }, "cycle": { "name": null, "number": 42 },
              "labels": { "nodes": [ { "name": "Bug" } ] } }
        ]}}});
        let t = &parse_linear_assigned("acme", &data)[0];
        assert_eq!((t.key.as_str(), t.id, t.sprint.as_str()), ("ENG-9", 9, "Cycle 42"));
        assert_eq!(t.work_item_type, "Bug");
        assert_eq!(t.state_category, "doing");
        assert_eq!(t.container_id, "t1");
        assert!(LINEAR_ASSIGNED.contains("assignedIssues"));
    }

    #[test]
    fn linear_detail_splits_criteria_and_orders_comments() {
        let ticket = Ticket { provider: "linear".into(), key: "ENG-9".into(), ..Default::default() };
        let data = json!({ "issue": { "title": "Crash", "description": "Pasa al abrir.\n\n## Acceptance criteria\n\n1. No crashea",
            "state": { "name": "Todo", "type": "unstarted" },
            "comments": { "nodes": [ { "body": "segundo", "createdAt": "2026-10-22", "user": { "name": "B" } }, { "body": "primero", "createdAt": "2026-10-21", "user": { "name": "A" } } ] } } });
        let detail = parse_linear_detail(&ticket, &data);
        assert!(detail.description_html.contains("Pasa al abrir."));
        assert!(!detail.description_html.contains("No crashea"));
        assert!(detail.acceptance_criteria_html.contains("No crashea"));
        assert_eq!(detail.comments[0].author, "A");
        assert_eq!(detail.ticket.state_category, "todo");
    }

    #[test]
    fn github_and_gitlab_assigned_parse() {
        let github = json!([
            { "number": 12, "title": "Fix login", "state": "open", "html_url": "https://github.com/acme/web/issues/12",
              "labels": [ { "name": "bug" }, { "name": "P1" } ], "milestone": { "title": "v2.3" }, "updated_at": "2026-10-20",
              "repository": { "full_name": "acme/web" } },
            { "number": 13, "title": "a PR", "pull_request": {}, "repository": { "full_name": "acme/web" } }
        ]);
        let tickets = parse_tracker_assigned(BoardProvider::Github, "github.com", &github);
        assert_eq!(tickets.len(), 1);
        let t = &tickets[0];
        assert_eq!((t.key.as_str(), t.sprint.as_str(), t.priority.as_str(), t.work_item_type.as_str()), ("acme/web#12", "v2.3", "P1", "Bug"));
        assert_eq!(t.state_category, "todo");

        let gitlab = json!([
            { "iid": 7, "title": "Docs", "state": "opened", "web_url": "https://gitlab.com/g/p/-/issues/7", "labels": ["priority::high"],
              "milestone": { "title": "M1" }, "iteration": { "title": "Sprint 3" }, "references": { "full": "g/sub/p#7" } }
        ]);
        let t = &parse_tracker_assigned(BoardProvider::Gitlab, "gitlab.com", &gitlab)[0];
        assert_eq!((t.key.as_str(), t.project.as_str(), t.sprint.as_str()), ("g/sub/p#7", "g/sub/p", "Sprint 3"));
        assert_eq!(t.priority, "high");
    }

    #[test]
    fn tracker_comments_drop_system_notes() {
        let notes = json!([
            { "body": "changed the description", "system": true, "created_at": "2026-10-22", "author": { "name": "bot" } },
            { "body": "Listo", "system": false, "created_at": "2026-10-21", "author": { "name": "Ana" } }
        ]);
        let comments = parse_tracker_comments(BoardProvider::Gitlab, &notes);
        assert_eq!(comments.len(), 1);
        assert_eq!(comments[0].author, "Ana");
    }

    #[test]
    fn monday_boards_and_items_parse() {
        let boards = json!({ "boards": [
            { "id": "1", "name": "Sprint", "columns": [ { "id": "person", "type": "people" }, { "id": "status", "type": "status" } ] },
            { "id": "2", "name": "No people", "columns": [ { "id": "status", "type": "status" } ] }
        ]});
        let found = monday_board_columns(&boards);
        assert_eq!(found, vec![("1".into(), "Sprint".into(), "person".into(), "status".into())]);
        let items = json!({ "boards": [ { "items_page": { "items": [
            { "id": "555", "name": "Diseñar", "group": { "title": "Esta semana" }, "column_values": [ { "id": "status", "text": "Working on it" } ] },
            { "id": "556", "name": "Hecho ya", "column_values": [ { "id": "status", "text": "Done" } ] }
        ]}}]});
        let tickets = parse_monday_items("acme", "1", "Sprint", "status", &items);
        assert_eq!(tickets.len(), 1, "finished items are left out");
        assert_eq!(tickets[0].state, "Working on it");
        assert_eq!(tickets[0].state_field, "status");
        assert_eq!(tickets[0].url, "https://acme.monday.com/boards/1/pulses/555");
    }

    #[test]
    fn azure_and_jira_comments_parse() {
        let azure = json!({ "comments": [ { "text": "<p>b</p>", "createdBy": { "displayName": "B" }, "createdDate": "2026-10-22" },
                                          { "text": "<p>a</p>", "createdBy": { "displayName": "A" }, "createdDate": "2026-10-21" } ] });
        let c = parse_azure_comments(&azure);
        assert_eq!((c[0].author.as_str(), c[0].body_html.as_str()), ("A", "<p>a</p>"));
        let jira = json!({ "comments": [ { "author": { "displayName": "Ana" }, "body": "Hola", "created": "2026-10-21" } ] });
        assert!(parse_jira_comments(&jira)[0].body_html.contains("Hola"));
    }

    #[test]
    fn criteria_split_at_their_heading() {
        let (prose, criteria) = split_markdown_criteria("Texto.\n\n## Criterios de aceptación\n\n1. Uno\n2. Dos");
        assert_eq!(prose, "Texto.");
        assert_eq!(criteria, "1. Uno\n2. Dos");
        let (prose, criteria) = split_markdown_criteria("**Acceptance criteria:**\n- a");
        assert_eq!((prose.as_str(), criteria.as_str()), ("", "- a"));
        let (prose, criteria) = split_markdown_criteria("Sin criterios");
        assert_eq!((prose.as_str(), criteria.as_str()), ("Sin criterios", ""));
    }

    #[test]
    fn categories_from_names() {
        assert_eq!(category_from_name("En revisión"), "review");
        assert_eq!(category_from_name("Active"), "doing");
        assert_eq!(category_from_name("opened"), "todo");
        assert_eq!(category_from_name("closed"), "done");
        assert_eq!(category_from_name("Bloqueado"), "");
    }
}
