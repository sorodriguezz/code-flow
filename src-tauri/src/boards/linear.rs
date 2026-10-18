//! Linear as a board.
//!
//! The slots read as monday's do, for the same reason — one API host for every customer, so the
//! token *is* the identity: the organisation's url key (`acme` for `linear.app/acme`, read from
//! Linear when the key is saved), the **team** a story is filed in, and a **label** in place of a
//! work-item type (empty: none). Issues are addressed by their identifier (`ENG-123`), which Linear
//! accepts wherever it takes an id; the numeric part is what the rows keep as the id.
//!
//! A story's tasks are real sub-issues (`parentId`), its priority maps one to one (1 urgent … 4
//! low, as Azure counts) and its points become the estimate. Prose is Markdown.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{text_to_html, BoardAuth, ExistingItem, ItemRef, NewChildItem, NewWorkItem, WorkItem, WorkItemChild, WorkItemEdit, WorkItemType};

const ENDPOINT: &str = "https://api.linear.app/graphql";
/// Issues a duplicate check reads — Linear pages at most 250 at a time.
const RECENT: usize = 250;

fn client() -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new).clone()
}

/// One query or mutation's `data`. GraphQL reports a failure as HTTP 200 with `errors`, so those
/// are read first — see `monday::run` for the same rule.
async fn run(query: &str, variables: Value, auth: &BoardAuth) -> Result<Value, String> {
    let res = client()
        .post(ENDPOINT)
        // Linear's personal API keys go in bare, with no scheme word.
        .header("Authorization", auth.secret.trim())
        .header("Content-Type", "application/json")
        .json(&json!({ "query": query, "variables": variables }))
        .send()
        .await
        .map_err(|e| format!("no se pudo conectar con Linear: {e}"))?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    let parsed: Value = serde_json::from_str(&text).map_err(|_| format!("Linear respondió {status}: {}", text.chars().take(300).collect::<String>()))?;
    if let Some(errors) = parsed.get("errors").and_then(Value::as_array).filter(|e| !e.is_empty()) {
        let detail: Vec<String> = errors.iter().filter_map(|e| e.get("message").and_then(Value::as_str).map(str::to_string)).collect();
        return Err(format!("Linear rechazó la petición: {}", detail.join("; ")));
    }
    parsed.get("data").cloned().filter(|d| !d.is_null()).ok_or_else(|| format!("Linear respondió {status} sin datos"))
}

/// Who an API key belongs to: the organisation's url key and name.
#[derive(Debug, Clone, Serialize)]
pub struct LinearAccount {
    pub key: String,
    pub name: String,
}

pub async fn whoami(auth: &BoardAuth) -> Result<LinearAccount, String> {
    let data = run("query { viewer { organization { urlKey name } } }", json!({}), auth).await?;
    let org = &data["viewer"]["organization"];
    let key = org["urlKey"].as_str().unwrap_or_default().to_string();
    if key.is_empty() {
        return Err("Linear no dijo a qué organización pertenece esta clave".into());
    }
    Ok(LinearAccount { key, name: org["name"].as_str().unwrap_or_default().to_string() })
}

#[derive(Debug, Clone, Serialize)]
pub struct LinearTeam {
    pub id: String,
    pub key: String,
    pub name: String,
}

pub async fn list_teams(auth: &BoardAuth) -> Result<Vec<LinearTeam>, String> {
    let data = run("query { teams(first: 250) { nodes { id key name } } }", json!({}), auth).await?;
    Ok(data["teams"]["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|team| {
            Some(LinearTeam {
                id: team["id"].as_str()?.to_string(),
                key: team["key"].as_str().unwrap_or_default().to_string(),
                name: team["name"].as_str().unwrap_or_default().to_string(),
            })
        })
        .collect())
}

/// The team's labels (and the workspace's), after "no label" — the "type" picker.
pub async fn list_labels(team_id: &str, auth: &BoardAuth) -> Result<Vec<WorkItemType>, String> {
    let data = run(
        "query ($team: String!) { team(id: $team) { labels(first: 250) { nodes { id name color description } } } }",
        json!({ "team": team_id.trim() }),
        auth,
    )
    .await?;
    let mut types = vec![WorkItemType { name: "Issue".into(), reference_name: String::new(), description: String::new(), color: String::new(), subtask: false }];
    for label in data["team"]["labels"]["nodes"].as_array().into_iter().flatten() {
        let (Some(id), Some(name)) = (label["id"].as_str(), label["name"].as_str()) else { continue };
        types.push(WorkItemType {
            name: name.to_string(),
            reference_name: id.to_string(),
            description: label["description"].as_str().unwrap_or_default().to_string(),
            color: label["color"].as_str().unwrap_or_default().trim_start_matches('#').to_string(),
            subtask: false,
        });
    }
    Ok(types)
}

/// `ENG-123` → 123: what the rows keep as an id.
fn number_of(identifier: &str) -> i64 {
    identifier.rsplit('-').next().and_then(|n| n.parse().ok()).unwrap_or(0)
}

fn item_ref(issue: &Value) -> ItemRef {
    let identifier = issue["identifier"].as_str().unwrap_or_default().to_string();
    ItemRef { id: number_of(&identifier), url: issue["url"].as_str().unwrap_or_default().to_string(), key: identifier }
}

pub async fn create_issue(team_id: &str, label_id: &str, item: &NewWorkItem<'_>, auth: &BoardAuth) -> Result<ItemRef, String> {
    if item.title.trim().is_empty() {
        return Err("La historia no tiene título".to_string());
    }
    let mut input = serde_json::Map::new();
    input.insert("teamId".into(), json!(team_id.trim()));
    input.insert("title".into(), json!(item.title.trim()));
    input.insert("description".into(), json!(super::issues::compose_body(item.narrative, item.description, item.acceptance_criteria)));
    if !label_id.trim().is_empty() {
        input.insert("labelIds".into(), json!([label_id.trim()]));
    }
    if (1..=4).contains(&item.priority) {
        input.insert("priority".into(), json!(item.priority));
    }
    if item.story_points > 0.0 {
        input.insert("estimate".into(), json!(item.story_points.round() as i64));
    }
    let data = run(
        "mutation ($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }",
        json!({ "input": Value::Object(input) }),
        auth,
    )
    .await?;
    Ok(item_ref(&data["issueCreate"]["issue"]))
}

pub async fn create_subissue(team_id: &str, parent_key: &str, task: &NewChildItem<'_>, auth: &BoardAuth) -> Result<ItemRef, String> {
    if task.title.trim().is_empty() {
        return Err("Esa tarea no tiene título".to_string());
    }
    // The parent by its UUID: `parentId` takes no identifier.
    let parent = run("query ($id: String!) { issue(id: $id) { id } }", json!({ "id": parent_key.trim() }), auth).await?;
    let parent_id = parent["issue"]["id"].as_str().ok_or("No se encontró la historia en Linear")?.to_string();
    let data = run(
        "mutation ($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier url } } }",
        json!({ "input": { "teamId": team_id.trim(), "parentId": parent_id, "title": task.title.trim(), "description": task.detail.trim() } }),
        auth,
    )
    .await?;
    Ok(item_ref(&data["issueCreate"]["issue"]))
}

pub async fn update_issue(key: &str, edit: &WorkItemEdit, auth: &BoardAuth) -> Result<ItemRef, String> {
    let mut input = serde_json::Map::new();
    if let Some(title) = &edit.title {
        input.insert("title".into(), json!(title.trim()));
    }
    if edit.description.is_some() || edit.acceptance_criteria.is_some() {
        let prose = edit.description.clone().unwrap_or_default();
        let prose = if edit.prose_is_html { super::html_to_text(&prose) } else { prose };
        input.insert("description".into(), json!(super::issues::compose_body("", &prose, edit.acceptance_criteria.as_deref().unwrap_or_default())));
    }
    if let Some(effort) = edit.effort {
        input.insert("estimate".into(), if effort > 0.0 { json!(effort.round() as i64) } else { Value::Null });
    }
    let data = run(
        "mutation ($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { identifier url } } }",
        json!({ "id": key.trim(), "input": Value::Object(input) }),
        auth,
    )
    .await?;
    Ok(item_ref(&data["issueUpdate"]["issue"]))
}

#[derive(Deserialize)]
struct Node {
    #[serde(default)]
    identifier: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    state: Option<Value>,
    #[serde(default)]
    assignee: Option<Value>,
}

fn state_name(state: &Option<Value>) -> String {
    state.as_ref().and_then(|s| s["name"].as_str()).unwrap_or_default().to_string()
}

pub async fn get_issue(key: &str, auth: &BoardAuth) -> Result<WorkItem, String> {
    let data = run(
        "query ($id: String!) { issue(id: $id) { identifier title url description estimate state { name } team { key name } \
         labels { nodes { name } } children { nodes { identifier title url description state { name } assignee { name } } } } }",
        json!({ "id": key.trim() }),
        auth,
    )
    .await?;
    let issue = &data["issue"];
    let identifier = issue["identifier"].as_str().unwrap_or(key).to_string();
    let children: Vec<Node> = serde_json::from_value(issue["children"]["nodes"].clone()).unwrap_or_default();
    Ok(WorkItem {
        id: number_of(&identifier),
        url: issue["url"].as_str().unwrap_or_default().to_string(),
        key: identifier,
        work_item_type: "Issue".into(),
        title: issue["title"].as_str().unwrap_or_default().to_string(),
        state: issue["state"]["name"].as_str().unwrap_or_default().to_string(),
        team_project: issue["team"]["name"].as_str().unwrap_or_default().to_string(),
        container_id: issue["team"]["key"].as_str().unwrap_or_default().to_string(),
        description_html: text_to_html(issue["description"].as_str().unwrap_or_default()),
        repro_steps_html: String::new(),
        system_info_html: String::new(),
        acceptance_criteria_html: String::new(),
        effort: issue["estimate"].as_f64().unwrap_or(0.0),
        effort_field: "estimate".into(),
        tags: issue["labels"]["nodes"].as_array().into_iter().flatten().filter_map(|l| l["name"].as_str()).collect::<Vec<_>>().join(", "),
        area_path: String::new(),
        iteration_path: String::new(),
        children: children
            .into_iter()
            .map(|child| WorkItemChild {
                id: number_of(&child.identifier),
                url: child.url,
                state: state_name(&child.state),
                key: child.identifier,
                work_item_type: "Issue".into(),
                title: child.title,
                description_html: text_to_html(child.description.as_deref().unwrap_or_default()),
                assigned_to: child.assignee.as_ref().and_then(|a| a["name"].as_str()).unwrap_or_default().to_string(),
            })
            .collect(),
    })
}

pub async fn recent_issues(team_id: &str, auth: &BoardAuth) -> Result<Vec<ExistingItem>, String> {
    let data = run(
        "query ($team: String!, $first: Int!) { team(id: $team) { issues(first: $first, orderBy: createdAt) { nodes { identifier title url state { name } } } } }",
        json!({ "team": team_id.trim(), "first": RECENT }),
        auth,
    )
    .await?;
    let nodes: Vec<Node> = serde_json::from_value(data["team"]["issues"]["nodes"].clone()).unwrap_or_default();
    Ok(nodes
        .into_iter()
        .map(|node| ExistingItem { id: number_of(&node.identifier), state: state_name(&node.state), key: node.identifier, title: node.title, url: node.url })
        .collect())
}

/// `https://linear.app/acme/issue/ENG-123/some-title` → (`acme`, `ENG-123`).
pub fn parse_issue_ref(input: &str) -> Option<(String, String)> {
    let url = reqwest::Url::parse(input.trim()).ok()?;
    if url.host_str()? != "linear.app" {
        return None;
    }
    let segments: Vec<&str> = url.path_segments()?.filter(|s| !s.is_empty()).collect();
    match segments.as_slice() {
        [org, "issue", identifier, ..] if identifier.contains('-') => Some((org.to_string(), identifier.to_ascii_uppercase())),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_linear_link_names_its_organisation_and_issue() {
        assert_eq!(parse_issue_ref("https://linear.app/acme/issue/ENG-123/login-con-google"), Some(("acme".into(), "ENG-123".into())));
        assert_eq!(parse_issue_ref("https://linear.app/acme/project/roadmap"), None);
        assert_eq!(number_of("ENG-123"), 123);
    }
}
