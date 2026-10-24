//! Moving a ticket between states — «Mover a…» in the detail pane, and the two moves CodeFlow makes
//! on its own (to review when the pull request opens, to done when it merges; see
//! `commands::tickets_cmd`).
//!
//! Every board has an API for it, and each says it differently:
//!
//! - **Azure Boards** — `System.State` is a field; the type's states come from
//!   `workitemtypes/{type}/states`, each with a category (Proposed, InProgress, Resolved, Completed).
//! - **Jira** — a workflow: the issue offers *transitions*, and a move is a POST of one of them. The
//!   list is per issue and per current status, so it is always read fresh.
//! - **Linear** — the team's workflow states, each with a type; a move is `issueUpdate(stateId)`.
//! - **GitHub / GitLab** — open or closed, nothing between: no review state is offered, and none is
//!   invented from labels (a label nobody on the team set up would be noise on every issue).
//! - **monday.com** — the item's status column, by label; the labels come from the column's settings.
//!
//! A move is addressed by the *name* of the state the ticket should end in — that is what the
//! configuration stores, what undo puts back, and what survives a Jira transition id changing.

use serde_json::{json, Value};

use super::tickets::{fold, Ticket, TicketState};
use super::{issues, jira, linear, monday, BoardAuth, BoardProvider};
use crate::ado::{auth_header, client as ado_client, encode_segment, get_json as ado_get_json, normalize_org, API_VERSION};

fn s(value: &Value, pointer: &str) -> String {
    value.pointer(pointer).and_then(Value::as_str).unwrap_or_default().to_string()
}

pub fn parse_azure_states(body: &Value) -> Vec<TicketState> {
    body["value"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|state| {
            let name = s(state, "/name");
            TicketState {
                id: name.clone(),
                category: match s(state, "/category").as_str() {
                    "Proposed" => "todo",
                    "InProgress" => "doing",
                    "Resolved" => "review",
                    "Completed" | "Removed" => "done",
                    _ => "",
                }
                .into(),
                name,
            }
        })
        .collect()
}

/// Jira's transitions, named for the status each one leads to — "Start progress" is how a workflow
/// author named the arrow, "In Progress" is where it goes, and only the second is what people mean.
pub fn parse_jira_transitions(body: &Value) -> Vec<TicketState> {
    let mut out: Vec<TicketState> = Vec::new();
    for transition in body["transitions"].as_array().into_iter().flatten() {
        let to = s(transition, "/to/name");
        let name = if to.is_empty() { s(transition, "/name") } else { to };
        if name.is_empty() || out.iter().any(|state| state.name == name) {
            continue;
        }
        out.push(TicketState {
            id: s(transition, "/id"),
            category: match s(transition, "/to/statusCategory/key").as_str() {
                "new" => "todo",
                "indeterminate" if super::assigned::category_from_name(&name) == "review" => "review",
                "indeterminate" => "doing",
                "done" => "done",
                _ => "",
            }
            .into(),
            name,
        });
    }
    out
}

pub fn parse_linear_states(data: &Value) -> Vec<TicketState> {
    let mut states: Vec<(f64, TicketState)> = data
        .pointer("/issue/team/states/nodes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|node| {
            let name = s(node, "/name");
            let category = match s(node, "/type").as_str() {
                "backlog" | "unstarted" | "triage" => "todo",
                "started" if super::assigned::category_from_name(&name) == "review" => "review",
                "started" => "doing",
                "completed" | "canceled" => "done",
                _ => "",
            };
            (node["position"].as_f64().unwrap_or(0.0), TicketState { id: s(node, "/id"), name, category: category.into() })
        })
        .collect();
    states.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    states.into_iter().map(|(_, state)| state).collect()
}

/// A status column's labels, from its `settings_str` (`{"labels":{"0":"Working on it",…}}`), in
/// index order.
pub fn parse_monday_labels(settings: &str) -> Vec<TicketState> {
    let parsed: Value = serde_json::from_str(settings).unwrap_or(Value::Null);
    let Some(labels) = parsed["labels"].as_object() else { return Vec::new() };
    let mut pairs: Vec<(i64, String)> = labels
        .iter()
        .filter_map(|(index, label)| Some((index.parse().ok()?, label.as_str()?.to_string())))
        .filter(|(_, label)| !label.trim().is_empty())
        .collect();
    pairs.sort();
    pairs
        .into_iter()
        .map(|(_, name)| TicketState { id: name.clone(), category: super::assigned::category_from_name(&name), name })
        .collect()
}

fn tracker_states() -> Vec<TicketState> {
    vec![
        TicketState { id: "open".into(), name: "open".into(), category: "todo".into() },
        TicketState { id: "closed".into(), name: "closed".into(), category: "done".into() },
    ]
}

/// The states this ticket can be moved to now.
pub async fn list_states(ticket: &Ticket, auth: &BoardAuth) -> Result<Vec<TicketState>, String> {
    match ticket.board() {
        BoardProvider::Azure => {
            let org = encode_segment(&normalize_org(&ticket.account));
            let project = encode_segment(if ticket.container_id.is_empty() { &ticket.project } else { &ticket.container_id });
            let url = format!(
                "https://dev.azure.com/{org}/{project}/_apis/wit/workitemtypes/{}/states?api-version={API_VERSION}",
                encode_segment(&ticket.work_item_type)
            );
            Ok(parse_azure_states(&ado_get_json::<Value>(&url, &auth.secret).await?))
        }
        BoardProvider::Jira => {
            let site = jira::normalize_site(&ticket.account);
            let url = format!("{site}/rest/api/2/issue/{}/transitions", jira::encode_segment(&ticket.key));
            Ok(parse_jira_transitions(&jira::get_json::<Value>(&url, auth).await?))
        }
        BoardProvider::Linear => {
            let data = linear::run(
                "query ($id: String!) { issue(id: $id) { team { states { nodes { id name type position } } } } }",
                json!({ "id": ticket.key.trim() }),
                auth,
            )
            .await?;
            Ok(parse_linear_states(&data))
        }
        BoardProvider::Github | BoardProvider::Gitlab => Ok(tracker_states()),
        BoardProvider::Monday => {
            if ticket.state_field.is_empty() {
                return Err("Este tablero de monday.com no tiene columna de estado".into());
            }
            let data: Value = monday::run(
                "query ($ids: [ID!]) { boards(ids: $ids) { columns { id settings_str } } }",
                json!({ "ids": [ticket.container_id] }),
                auth,
            )
            .await?;
            let settings = data.pointer("/boards/0/columns").and_then(Value::as_array).into_iter().flatten()
                .find(|c| s(c, "/id") == ticket.state_field)
                .map(|c| s(c, "/settings_str"))
                .unwrap_or_default();
            Ok(parse_monday_labels(&settings))
        }
    }
}

/// Moves the ticket to the state named `state_name`, read fresh from the board so a Jira
/// transition is the one its workflow offers *now*. Returns the state it landed in.
pub async fn move_to(ticket: &Ticket, state_name: &str, auth: &BoardAuth) -> Result<TicketState, String> {
    let states = list_states(ticket, auth).await?;
    let state = states
        .iter()
        .find(|s| fold(&s.name) == fold(state_name.trim()))
        .cloned()
        .ok_or_else(|| format!("«{}» no se puede mover a «{state_name}» desde «{}»", ticket.title, ticket.state))?;
    apply(ticket, &state, auth).await?;
    Ok(state)
}

pub async fn apply(ticket: &Ticket, state: &TicketState, auth: &BoardAuth) -> Result<(), String> {
    match ticket.board() {
        BoardProvider::Azure => {
            let org = encode_segment(&normalize_org(&ticket.account));
            let url = format!("https://dev.azure.com/{org}/_apis/wit/workitems/{}?api-version={API_VERSION}", ticket.id);
            let ops = json!([{ "op": "add", "path": "/fields/System.State", "value": state.id }]);
            let res = ado_client()
                .patch(&url)
                .header("Authorization", auth_header(&auth.secret))
                .header("Content-Type", "application/json-patch+json")
                .body(ops.to_string())
                .send()
                .await
                .map_err(|e| format!("couldn't reach Azure DevOps: {e}"))?;
            let status = res.status();
            if !status.is_success() {
                let body = res.text().await.unwrap_or_default();
                return Err(crate::ado::describe_failure(status, &body));
            }
            Ok(())
        }
        BoardProvider::Jira => {
            let site = jira::normalize_site(&ticket.account);
            let url = format!("{site}/rest/api/2/issue/{}/transitions", jira::encode_segment(&ticket.key));
            jira::send_json(reqwest::Method::POST, &url, &json!({ "transition": { "id": state.id } }), auth).await.map(|_| ())
        }
        BoardProvider::Linear => {
            let data = linear::run(
                "mutation ($id: String!, $state: String!) { issueUpdate(id: $id, input: { stateId: $state }) { success } }",
                json!({ "id": ticket.key.trim(), "state": state.id }),
                auth,
            )
            .await?;
            match data.pointer("/issueUpdate/success").and_then(Value::as_bool) {
                Some(true) => Ok(()),
                _ => Err("Linear no confirmó el cambio de estado".into()),
            }
        }
        BoardProvider::Github | BoardProvider::Gitlab => {
            let tracker = match ticket.board() {
                BoardProvider::Gitlab => issues::Tracker::GitLab,
                _ => issues::Tracker::GitHub,
            };
            let (repo, number) = issues::split_key(&ticket.key).ok_or_else(|| format!("«{}» no es una referencia de issue", ticket.key))?;
            let url = format!("{}/issues/{number}", issues::repo_root(tracker, &ticket.account, &repo)?);
            let closing = state.id == "closed";
            let builder = match tracker {
                issues::Tracker::GitHub => issues::request(tracker, reqwest::Method::PATCH, &url, &auth.secret)
                    .json(&json!({ "state": if closing { "closed" } else { "open" } })),
                issues::Tracker::GitLab => issues::request(tracker, reqwest::Method::PUT, &url, &auth.secret)
                    .json(&json!({ "state_event": if closing { "close" } else { "reopen" } })),
            };
            issues::send(tracker, builder).await.map(|_| ())
        }
        BoardProvider::Monday => {
            let data: Value = monday::run(
                "mutation ($board: ID!, $item: ID!, $column: String!, $value: String) { \
                 change_simple_column_value(board_id: $board, item_id: $item, column_id: $column, value: $value) { id } }",
                json!({ "board": ticket.container_id, "item": ticket.id.to_string(), "column": ticket.state_field, "value": state.name }),
                auth,
            )
            .await?;
            let _ = data;
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn azure_states_carry_their_category() {
        let body = json!({ "value": [ { "name": "New", "category": "Proposed" }, { "name": "Active", "category": "InProgress" },
                                      { "name": "Resolved", "category": "Resolved" }, { "name": "Closed", "category": "Completed" } ] });
        let states = parse_azure_states(&body);
        assert_eq!(states.iter().map(|s| s.category.as_str()).collect::<Vec<_>>(), vec!["todo", "doing", "review", "done"]);
        assert_eq!(states[3].id, "Closed");
    }

    #[test]
    fn jira_transitions_are_named_for_where_they_go() {
        let body = json!({ "transitions": [
            { "id": "11", "name": "Start", "to": { "name": "In Progress", "statusCategory": { "key": "indeterminate" } } },
            { "id": "21", "name": "Send to review", "to": { "name": "Code Review", "statusCategory": { "key": "indeterminate" } } },
            { "id": "31", "name": "Finish", "to": { "name": "Done", "statusCategory": { "key": "done" } } },
            { "id": "32", "name": "Finish too", "to": { "name": "Done", "statusCategory": { "key": "done" } } }
        ]});
        let states = parse_jira_transitions(&body);
        assert_eq!(states.len(), 3, "two arrows into one status are one choice");
        assert_eq!((states[1].id.as_str(), states[1].name.as_str(), states[1].category.as_str()), ("21", "Code Review", "review"));
        assert_eq!(super::super::tickets::auto_pick(&states, super::super::tickets::Target::Done).unwrap().id, "31");
    }

    #[test]
    fn linear_states_sort_by_position() {
        let data = json!({ "issue": { "team": { "states": { "nodes": [
            { "id": "d", "name": "Done", "type": "completed", "position": 4 },
            { "id": "r", "name": "In Review", "type": "started", "position": 3 },
            { "id": "t", "name": "Todo", "type": "unstarted", "position": 1 }
        ]}}}});
        let states = parse_linear_states(&data);
        assert_eq!(states.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), vec!["t", "r", "d"]);
        assert_eq!(states[1].category, "review");
    }

    #[test]
    fn monday_labels_come_from_settings() {
        let states = parse_monday_labels(r#"{"labels":{"1":"Done","0":"Working on it","2":"Stuck","5":""}}"#);
        assert_eq!(states.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), vec!["Working on it", "Done", "Stuck"]);
        assert_eq!(states[1].category, "done");
        assert!(parse_monday_labels("not json").is_empty());
    }
}
