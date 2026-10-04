//! Triggers that find out by looking: a repository's branches and tags, a host's pull requests and
//! pipelines, and the Services supervisor.
//!
//! **The first look only learns.** Every poller seeds what it has seen on its first pass and fires
//! from the second on, so arming a flow on a repository with forty open pull requests does not run
//! it forty times. The hosts are asked no more often than every minute — the same respect for rate
//! limits the Pipelines tab keeps — and a failed look is noted on the trigger and retried later.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio_util::sync::CancellationToken;

use super::{note_problem, TriggerView};
use crate::db::Db;
use crate::flows::run::Item;
use crate::flows::spec::FlowNode;

fn text(params: &Value, key: &str) -> String {
    params.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string()
}

fn every(params: &Value, floor: u64) -> Duration {
    Duration::from_secs(params.get("intervalSec").and_then(Value::as_f64).unwrap_or(floor as f64).max(floor as f64) as u64)
}

/// What the repository poller remembers between looks.
#[derive(Default)]
struct RepoMemory {
    tip: Option<String>,
    branch: Option<String>,
    tags: Option<HashSet<String>>,
}

fn repo_items(path: &str, project: &str, event: &str, branch_filter: &str, memory: &mut RepoMemory) -> Result<Vec<Value>, String> {
    let repo = git2::Repository::open(path).map_err(|e| format!("cannot open the repository: {e}"))?;
    match event {
        "branch" => {
            let head = repo.head().ok().and_then(|h| h.shorthand().map(str::to_string)).unwrap_or_else(|| "HEAD".into());
            let before = memory.branch.replace(head.clone());
            Ok(match before {
                Some(previous) if previous != head => vec![json!({"project": project, "event": "branch", "from": previous, "to": head})],
                _ => vec![],
            })
        }
        "tag" => {
            let names: HashSet<String> =
                repo.tag_names(None).map_err(|e| e.to_string())?.iter().flatten().map(str::to_string).collect();
            let before = memory.tags.replace(names.clone());
            Ok(match before {
                Some(previous) => {
                    let mut new: Vec<&String> = names.difference(&previous).collect();
                    new.sort();
                    new.into_iter().map(|tag| json!({"project": project, "event": "tag", "tag": tag})).collect()
                }
                None => vec![],
            })
        }
        _ => {
            let branch = if branch_filter.is_empty() {
                repo.head().ok().and_then(|h| h.shorthand().map(str::to_string)).unwrap_or_else(|| "HEAD".into())
            } else {
                branch_filter.to_string()
            };
            let reference = repo
                .find_reference(&format!("refs/heads/{branch}"))
                .or_else(|_| repo.head())
                .map_err(|e| format!("no branch {branch}: {e}"))?;
            let Some(tip) = reference.target() else { return Ok(vec![]) };
            let before = memory.tip.replace(tip.to_string());
            let Some(previous) = before else { return Ok(vec![]) };
            if previous == tip.to_string() {
                return Ok(vec![]);
            }
            let mut walk = repo.revwalk().map_err(|e| e.to_string())?;
            walk.push(tip).map_err(|e| e.to_string())?;
            if let Ok(old) = git2::Oid::from_str(&previous) {
                let _ = walk.hide(old);
            }
            let commits: Vec<Value> = walk
                .flatten()
                .take(50)
                .filter_map(|oid| repo.find_commit(oid).ok())
                .map(|commit| {
                    json!({
                        "sha": commit.id().to_string(),
                        "summary": commit.summary().unwrap_or_default(),
                        "author": commit.author().name().unwrap_or_default(),
                        "time": chrono::DateTime::from_timestamp(commit.time().seconds(), 0).map(|t| t.to_rfc3339()),
                    })
                })
                .collect();
            Ok(vec![json!({"project": project, "event": "commit", "branch": branch, "before": previous, "after": tip.to_string(), "commits": commits})])
        }
    }
}

pub fn spawn(app: &AppHandle, flow_id: &str, node: &FlowNode, params: &Value, view: Arc<Mutex<TriggerView>>, cancel: CancellationToken) {
    let app = app.clone();
    let flow_id = flow_id.to_string();
    let node_id = node.id.clone();
    let type_id = node.type_id.clone();
    let params = params.clone();
    tauri::async_runtime::spawn(async move {
        let project_id = text(&params, "project");
        let event = text(&params, "event");
        let interval = match type_id.as_str() {
            "trigger.repo" => every(&params, 10),
            _ => every(&params, 60),
        };
        let mut repo_memory = RepoMemory::default();
        let mut seen: Option<HashSet<String>> = None;
        loop {
            let project = {
                let db = app.state::<Db>();
                let conn = db.0.lock();
                conn.ok().and_then(|conn| crate::db::queries::get_project(&conn, &project_id).ok().flatten())
            };
            let Some(project) = project else {
                note_problem(&view, Some("the repository is no longer in the workspace".into()));
                return;
            };
            let found: Result<Vec<Value>, String> = match type_id.as_str() {
                "trigger.repo" => {
                    let path = project.local_path.clone();
                    let name = project.name.clone();
                    let branch = text(&params, "branch");
                    let event = event.clone();
                    let mut memory = std::mem::take(&mut repo_memory);
                    let (memory, result) = tokio::task::spawn_blocking(move || {
                        let result = repo_items(&path, &name, &event, &branch, &mut memory);
                        (memory, result)
                    })
                    .await
                    .unwrap_or_else(|e| (RepoMemory::default(), Err(e.to_string())));
                    repo_memory = memory;
                    result
                }
                "trigger.pr" => pull_requests(&app, &project_id, &event, &mut seen).await,
                _ => pipelines(&app, &project_id, &event, &text(&params, "branch"), &mut seen).await,
            };
            match found {
                Ok(items) => {
                    note_problem(&view, None);
                    for item in items {
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
}

/// New pull requests (or newly merged ones) since the last look; the first look only seeds.
async fn pull_requests(app: &AppHandle, project_id: &str, event: &str, seen: &mut Option<HashSet<String>>) -> Result<Vec<Value>, String> {
    let db = app.state::<Db>();
    let list = if event == "merged" {
        crate::commands::ado_cmd::list_pull_requests_page(db, project_id.to_string(), Some("closed".into()), Some(1)).await?.items
    } else {
        crate::commands::ado_cmd::list_pull_requests(db, project_id.to_string()).await?
    };
    let relevant: Vec<_> = list.into_iter().filter(|pr| event != "merged" || pr.status == "merged").collect();
    let ids: HashSet<String> = relevant.iter().map(|pr| pr.id.to_string()).collect();
    let Some(previous) = seen.replace(ids.clone()) else { return Ok(vec![]) };
    Ok(relevant
        .into_iter()
        .filter(|pr| !previous.contains(&pr.id.to_string()))
        .map(|pr| serde_json::to_value(&pr).unwrap_or(Value::Null))
        .collect())
}

/// Pipeline runs that finished since the last look, matching the event; the first look only seeds.
async fn pipelines(app: &AppHandle, project_id: &str, event: &str, branch: &str, seen: &mut Option<HashSet<String>>) -> Result<Vec<Value>, String> {
    let db = app.state::<Db>();
    let branch = (!branch.is_empty()).then(|| branch.to_string());
    let runs = crate::commands::ci_cmd::list_pipeline_runs(db, project_id.to_string(), branch, 20).await?;
    let finished: Vec<_> = runs.into_iter().filter(|run| !crate::ci::is_live(&run.status)).collect();
    let ids: HashSet<String> = finished.iter().map(|run| run.id.clone()).collect();
    let Some(previous) = seen.replace(ids) else { return Ok(vec![]) };
    Ok(finished
        .into_iter()
        .filter(|run| !previous.contains(&run.id))
        .filter(|run| match event {
            "failed" => run.status == crate::ci::status::FAILED,
            "succeeded" => run.status == crate::ci::status::SUCCESS || run.status == crate::ci::status::WARNING,
            _ => true,
        })
        .map(|run| serde_json::to_value(&run).unwrap_or(Value::Null))
        .collect())
}

/// CodeFlow's own services: a service that became ready, failed or stopped.
pub fn spawn_services(app: &AppHandle, flow_id: &str, node_id: &str, params: &Value, view: Arc<Mutex<TriggerView>>, cancel: CancellationToken) {
    let app = app.clone();
    let flow_id = flow_id.to_string();
    let node_id = node_id.to_string();
    let event = text(params, "event");
    let only = text(params, "service").to_lowercase();
    tauri::async_runtime::spawn(async move {
        use crate::services::supervisor::{Status, Supervisor};
        let supervisor = Supervisor::of(&app);
        let mut last: HashMap<String, Status> = supervisor.snapshot().into_iter().map(|s| (s.id.clone(), s.status)).collect();
        loop {
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(2)) => {}
                _ = cancel.cancelled() => return,
            }
            for state in supervisor.snapshot() {
                let before = last.insert(state.id.clone(), state.status);
                if before == Some(state.status) {
                    continue;
                }
                if !only.is_empty() && state.name.to_lowercase() != only {
                    continue;
                }
                let hit = match event.as_str() {
                    "serviceReady" => state.status == Status::Ready,
                    "serviceFailed" => state.status == Status::Failed,
                    "serviceStopped" => state.status == Status::Stopped && before.is_some(),
                    _ => false,
                };
                if hit {
                    let item = json!({
                        "event": event,
                        "service": state.name,
                        "id": state.id,
                        "status": serde_json::to_value(state.status).unwrap_or(Value::Null),
                        "ports": state.ports,
                        "error": state.error,
                    });
                    if let Err(error) = super::fire(&app, &flow_id, &node_id, vec![Item::new(item)]) {
                        note_problem(&view, Some(error));
                    }
                }
            }
        }
    });
}
