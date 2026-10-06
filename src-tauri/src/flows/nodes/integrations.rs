//! CodeFlow's own features as nodes: pull requests, pipelines, notes, the Reviewer, opening things,
//! a visible terminal, the clipboard and the Llavero.
//!
//! Each one is the app's own operation (`flows::app_ops`) — a pull request is created by the same
//! command the PR form calls — so the node decides only what to ask and how to read the answer.

use std::time::Duration;

use serde_json::{json, Value};

use super::{flag, number, pairs, text, NodeCtx, NodeError};
use crate::flows::engine::LogStream;
use crate::flows::run::{Item, Ports};
use crate::flows::value::set_path;

pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    match ctx.node.type_id.as_str() {
        "files.pr" => pull_request(ctx).await,
        "files.pipeline" => pipeline(ctx).await,
        "app.note" => note(ctx).await,
        "app.reviewer" => reviewer(ctx).await,
        "app.open" | "app.terminal" => window(ctx).await,
        "app.clipboard" => clipboard(ctx).await,
        "app.vault" => vault(ctx).await,
        "app.apiRequest" => api_request(ctx).await,
        other => Err(NodeError::failed(format!("No executor for {other}"))),
    }
}

fn failure(error: String) -> NodeError {
    if error.starts_with(crate::ai_runs::CANCELLED_MARKER) {
        NodeError::Cancelled
    } else {
        NodeError::Failed(error)
    }
}

async fn call(ctx: &NodeCtx, op: &str, args: Value) -> Result<Value, NodeError> {
    ctx.run.host.app_call(op, args, ctx.cancel.clone()).await.map_err(failure)
}

fn need_project(params: &Value) -> Result<String, NodeError> {
    let project = text(params, "project");
    if project.trim().is_empty() {
        return Err(NodeError::failed("Choose the repository"));
    }
    Ok(project.trim().to_string())
}

fn base(ctx: &NodeCtx, index: usize) -> Value {
    ctx.items().get(index).map(|item| item.json.clone()).filter(Value::is_object).unwrap_or_else(|| json!({}))
}

fn wrap(ctx: &NodeCtx, index: usize, json: Value) -> Item {
    if ctx.items().is_empty() {
        Item::new(json)
    } else {
        Item::paired(json, index)
    }
}

/// The branch a repository has checked out.
fn current_branch(ctx: &NodeCtx, project: &str) -> Option<String> {
    let path = ctx.run.host.project_path(project).ok()?;
    let repo = git2::Repository::open(path).ok()?;
    let head = repo.head().ok()?;
    head.shorthand().map(str::to_string)
}

// ---------------------------------------------------------------------------------- API client

/// A saved request of the API client, per item (or once): its `{{…}}` filled from the node's
/// variables first, sent by the API client itself (`api.request` → the window, `flows::bridge`).
async fn api_request(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let once = text(&ctx.params, "runFor") == "once";
    let resolved = if once { vec![ctx.resolve_once().await?] } else { ctx.resolve_each().await? };
    let mut out = Vec::with_capacity(resolved.len());
    for (index, params) in resolved.iter().enumerate() {
        let request = text(params, "request");
        if request.trim().is_empty() {
            return Err(NodeError::failed("Choose the request"));
        }
        let variables: serde_json::Map<String, Value> = pairs(params, "variables").into_iter().map(|(k, v)| (k, Value::String(v))).collect();
        let answer = call(
            ctx,
            "api.request",
            json!({"requestId": request.trim(), "environmentId": text(params, "environment"), "variables": variables}),
        )
        .await?;
        let status = answer.get("status").and_then(Value::as_u64).unwrap_or(0);
        if flag(params, "failOnStatus") && status >= 400 {
            return Err(NodeError::failed(format!("The request answered {status} {}", answer.get("statusText").and_then(Value::as_str).unwrap_or_default())));
        }
        let failed = answer.get("testsFailed").and_then(Value::as_u64).unwrap_or(0);
        if flag(params, "failOnTests") && failed > 0 {
            return Err(NodeError::failed(format!("{failed} of the request's tests failed")));
        }
        out.push(if once { Item::new(answer) } else { wrap(ctx, index, answer) });
    }
    Ok(vec![out])
}

// ------------------------------------------------------------------------------------ pull request

async fn pull_request(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let resolved = ctx.resolve_each().await?;
    let mut out = Vec::new();
    for (index, params) in resolved.iter().enumerate() {
        let project = need_project(params)?;
        let answer = match text(params, "operation").as_str() {
            "comment" => call(ctx, "pr.comment", json!({"projectId": project, "prId": params.get("prId"), "body": text(params, "body")})).await?,
            "merge" => {
                let method = text(params, "mergeMethod");
                call(
                    ctx,
                    "pr.merge",
                    json!({
                        "projectId": project,
                        "prId": params.get("prId"),
                        "method": if method.is_empty() { "merge".into() } else { method },
                        "deleteSourceBranch": flag(params, "deleteSourceBranch"),
                    }),
                )
                .await?
            }
            _ => {
                let title = text(params, "title");
                if title.trim().is_empty() {
                    return Err(NodeError::failed("Write the pull request's title"));
                }
                let source = {
                    let written = text(params, "sourceBranch");
                    if written.trim().is_empty() {
                        current_branch(ctx, &project).ok_or_else(|| NodeError::failed("Write the source branch"))?
                    } else {
                        written.trim().to_string()
                    }
                };
                let target = {
                    let written = text(params, "targetBranch");
                    if written.trim().is_empty() { "main".to_string() } else { written.trim().to_string() }
                };
                let created = call(
                    ctx,
                    "pr.create",
                    json!({
                        "projectId": project,
                        "title": title.trim(),
                        "description": text(params, "description"),
                        "source": source,
                        "target": target,
                        "draft": flag(params, "draft"),
                    }),
                )
                .await?;
                ctx.log(LogStream::Info, &format!("Pull request opened: {source} → {target}"));
                created
            }
        };
        out.push(wrap(ctx, index, answer));
    }
    Ok(vec![out])
}

// ---------------------------------------------------------------------------------------- pipeline

fn still_moving(status: &str) -> bool {
    matches!(status, "queued" | "running")
}

async fn pipeline(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let params = ctx.resolve_once().await?;
    let project = need_project(&params)?;
    match text(&params, "operation").as_str() {
        "" | "launch" => start_pipeline(ctx, &params, &project).await,
        operation => {
            let run_id = text(&params, "runId").trim().to_string();
            if run_id.is_empty() {
                return Err(NodeError::failed("Say which run — its id, as the start or the pipeline trigger gave it"));
            }
            match operation {
                "status" => {
                    let detail = call(ctx, "pipeline.detail", json!({"projectId": project, "runId": run_id})).await?;
                    Ok(vec![vec![Item::new(run_summary(&run_id, &detail))]])
                }
                "waitRun" => wait_for_run(ctx, &params, &project, &run_id, Value::Null, None).await,
                "jobLogs" => job_logs(ctx, &params, &project, &run_id).await,
                "artifacts" => artifacts(ctx, &params, &project, &run_id).await,
                other => Err(NodeError::failed(format!("Unknown operation {other}"))),
            }
        }
    }
}

/// A run as the flow reads it: where it is, and its jobs.
fn run_summary(run_id: &str, detail: &Value) -> Value {
    let jobs: Vec<Value> = detail
        .get("jobs")
        .and_then(Value::as_array)
        .map(|jobs| {
            jobs.iter()
                .map(|job| {
                    json!({
                        "id": job.get("id"),
                        "name": job.get("name"),
                        "stage": job.get("stage"),
                        "status": job.get("status"),
                        "startedAt": job.get("started_at"),
                        "finishedAt": job.get("finished_at"),
                        "url": job.get("web_url"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    json!({
        "runId": run_id,
        "status": detail.pointer("/run/status"),
        "url": detail.pointer("/run/web_url"),
        "ref": detail.pointer("/run/branch"),
        "jobs": jobs,
    })
}

/// The log of each job — the failed ones, or all — one item per job, ready for a model to read.
async fn job_logs(ctx: &NodeCtx, params: &Value, project: &str, run_id: &str) -> Result<Ports, NodeError> {
    let detail = call(ctx, "pipeline.detail", json!({"projectId": project, "runId": run_id})).await?;
    let only_failed = text(params, "jobs") != "allJobs";
    let max = number(params, "maxChars").unwrap_or(20_000.0).max(500.0) as u64;
    let mut out = Vec::new();
    for job in detail.get("jobs").and_then(Value::as_array).into_iter().flatten() {
        let status = job.get("status").and_then(Value::as_str).unwrap_or_default();
        if only_failed && status != "failed" {
            continue;
        }
        let log = call(
            ctx,
            "pipeline.log",
            json!({"projectId": project, "runId": run_id, "jobId": job.get("id"), "logRef": job.get("log_ref"), "maxChars": max}),
        )
        .await?;
        out.push(Item::new(json!({
            "runId": run_id,
            "jobId": job.get("id"),
            "job": job.get("name"),
            "status": status,
            "log": log.get("text"),
            "truncated": log.get("truncated"),
        })));
    }
    if out.is_empty() {
        ctx.log(LogStream::Info, if only_failed { "No job of the run failed" } else { "The run has no jobs" });
    }
    Ok(vec![out])
}

/// A run's artifacts — listed, and with `download`, saved as the zips the host serves.
async fn artifacts(ctx: &NodeCtx, params: &Value, project: &str, run_id: &str) -> Result<Ports, NodeError> {
    let list = call(ctx, "pipeline.artifacts", json!({"projectId": project, "runId": run_id})).await?;
    let download = flag(params, "download");
    let folder = text(params, "folder");
    if download && folder.trim().is_empty() {
        return Err(NodeError::failed("Choose the folder to save the artifacts in"));
    }
    let dir = super::expand_path(folder.trim());
    if download {
        std::fs::create_dir_all(&dir).map_err(|e| NodeError::failed(format!("{}: {e}", dir.display())))?;
    }
    let mut out = Vec::new();
    for artifact in list.as_array().into_iter().flatten() {
        let name = artifact.get("name").and_then(Value::as_str).unwrap_or("artifact");
        let mut item = json!({
            "runId": run_id,
            "id": artifact.get("id"),
            "name": name,
            "sizeBytes": artifact.get("size_bytes"),
            "expiresAt": artifact.get("expires_at"),
        });
        if download {
            let path = dir.join(crate::ci::artifact_file_name(name));
            let saved = call(
                ctx,
                "pipeline.artifactDownload",
                json!({"projectId": project, "runId": run_id, "artifactId": artifact.get("id"), "destination": path.to_string_lossy()}),
            )
            .await?;
            item["path"] = json!(path.to_string_lossy());
            item["bytes"] = saved.get("bytes").cloned().unwrap_or(Value::Null);
        }
        out.push(Item::new(item));
    }
    Ok(vec![out])
}

async fn start_pipeline(ctx: &NodeCtx, params: &Value, project: &str) -> Result<Ports, NodeError> {
    let params = params.clone();
    let project = project.to_string();
    let reference = {
        let written = text(&params, "ref");
        if written.trim().is_empty() { current_branch(ctx, &project).unwrap_or_else(|| "main".into()) } else { written.trim().to_string() }
    };
    let inputs: serde_json::Map<String, Value> = pairs(&params, "inputs").into_iter().map(|(k, v)| (k, Value::String(v))).collect();
    let variables: Vec<Value> = pairs(&params, "variables").into_iter().map(|(key, value)| json!({"key": key, "value": value})).collect();
    let started = call(
        ctx,
        "pipeline.start",
        json!({"projectId": project, "definitionId": text(&params, "definitionId"), "ref": reference, "inputs": inputs, "variables": variables}),
    )
    .await?;
    let run_id = started.get("run_id").and_then(Value::as_str).map(str::to_string);
    let url = started.get("web_url").cloned().unwrap_or(Value::Null);
    ctx.log(LogStream::Info, &format!("Pipeline started on {reference}"));
    let first = || -> Vec<Vec<Item>> { vec![vec![Item::new(json!({"runId": run_id, "url": url, "status": "queued", "ref": reference}))]] };
    if !flag(&params, "waitEnd") {
        return Ok(first());
    }
    let Some(run_id) = run_id.clone() else {
        ctx.log(LogStream::Info, "The host did not say which run it started, so the node cannot wait for it");
        return Ok(first());
    };
    wait_for_run(ctx, &params, &project, &run_id, url, Some(reference)).await
}

/// Follows a run until it ends (or the node's time limit), every 15 s.
async fn wait_for_run(ctx: &NodeCtx, params: &Value, project: &str, run_id: &str, url: Value, reference: Option<String>) -> Result<Ports, NodeError> {
    let limit = Duration::from_secs_f64(number(params, "timeoutMin").unwrap_or(60.0).clamp(1.0, 24.0 * 60.0) * 60.0);
    let deadline = tokio::time::Instant::now() + limit;
    let mut last_status = String::new();
    loop {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(15)) => {}
            _ = ctx.cancel.cancelled() => return Err(NodeError::Cancelled),
        }
        let detail = call(ctx, "pipeline.detail", json!({"projectId": project, "runId": run_id})).await?;
        let status = detail.pointer("/run/status").and_then(Value::as_str).unwrap_or_default().to_string();
        if status != last_status {
            ctx.log(LogStream::Info, &format!("Pipeline {status}"));
            last_status = status.clone();
        }
        if !still_moving(&status) {
            let mut result = run_summary(run_id, &detail);
            if !url.is_null() {
                result["url"] = url.clone();
            }
            if let Some(reference) = &reference {
                result["ref"] = json!(reference);
            }
            if matches!(status.as_str(), "failed" | "cancelled") && flag(params, "failOnFailure") {
                return Err(NodeError::failed(format!("The pipeline ended {status}")));
            }
            return Ok(vec![vec![Item::new(result)]]);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(NodeError::failed(format!("The pipeline was still {status} after the time limit")));
        }
    }
}

// -------------------------------------------------------------------------------------------- note

async fn note(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let resolved = ctx.resolve_each().await?;
    let mut out = Vec::new();
    for (index, params) in resolved.iter().enumerate() {
        let content = text(params, "content");
        let answer = if text(params, "operation") == "addToEnd" {
            let note = text(params, "note");
            if note.trim().is_empty() {
                return Err(NodeError::failed("Choose the note to add to"));
            }
            call(ctx, "note.append", json!({"noteId": note.trim(), "content": content})).await?
        } else {
            let english = ctx.run.locale.starts_with("en");
            let title = text(params, "title");
            let title = if title.trim().is_empty() { if english { "Note from a flow" } else { "Nota de un flujo" }.to_string() } else { title };
            call(
                ctx,
                "note.create",
                json!({"title": title, "content": content, "tags": note_tags(&text(params, "tags")), "bookName": if english { "Flows" } else { "Flujos" }}),
            )
            .await?
        };
        let mut json = base(ctx, index);
        set_path(&mut json, "note", answer);
        out.push(wrap(ctx, index, json));
    }
    Ok(vec![out])
}

/// Comma-separated tags as the notes table stores them: a JSON array, each one trimmed, without a
/// leading `#`, lower-cased and hyphenated — what `lib/notes/tags.ts` writes.
fn note_tags(raw: &str) -> String {
    let mut tags: Vec<String> = Vec::new();
    for tag in raw.split(',') {
        let tag = tag.trim().trim_start_matches('#').trim().to_lowercase();
        let tag = tag.split_whitespace().collect::<Vec<_>>().join("-");
        let tag = tag.trim_matches('-').to_string();
        if !tag.is_empty() && !tags.contains(&tag) {
            tags.push(tag);
        }
    }
    serde_json::to_string(&tags).unwrap_or_else(|_| "[]".into())
}

// ---------------------------------------------------------------------------------------- reviewer

async fn reviewer(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let params = ctx.resolve_once().await?;
    let project = need_project(&params)?;
    let answer = call(
        ctx,
        "reviewer.run",
        json!({
            "projectId": project,
            "nodeId": ctx.node.id,
            "prepare": text(&params, "prepare"),
            "build": text(&params, "build"),
            "test": text(&params, "test"),
            "exclusions": text(&params, "exclusions"),
        }),
    )
    .await?;
    if flag(&params, "failOnGate") {
        let gate = answer.pointer("/summary/gate").or_else(|| answer.pointer("/summary/qualityGate")).and_then(Value::as_str).unwrap_or_default();
        if matches!(gate.to_ascii_lowercase().as_str(), "error" | "failed" | "red") {
            return Err(NodeError::failed("The Quality Gate failed"));
        }
    }
    Ok(vec![vec![Item::new(answer)]])
}

// ------------------------------------------------------------------------------ open and terminal

async fn window(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let params = ctx.resolve_once().await?;
    let op = if ctx.node.type_id == "app.open" { "app.open" } else { "app.terminal" };
    let args = if op == "app.open" {
        let target = text(&params, "openTarget");
        if target.trim().is_empty() {
            return Err(NodeError::failed("Write what to open"));
        }
        json!({"kind": text(&params, "openKind"), "target": target.trim()})
    } else {
        let command = text(&params, "command");
        let project = text(&params, "project");
        let folder = if project.trim().is_empty() {
            super::files::expand(&text(&params, "cwd")).to_string_lossy().into_owned()
        } else {
            ctx.run.host.project_path(project.trim()).map_err(NodeError::Failed)?
        };
        json!({"command": command, "cwd": folder, "projectId": project.trim(), "title": ctx.node.name})
    };
    call(ctx, op, args).await?;
    Ok(vec![ctx.passthrough()])
}

// --------------------------------------------------------------------------------------- clipboard

/// Writes `text` to the system clipboard with the platform's own tool.
fn copy_to_clipboard(content: &str) -> Result<(), String> {
    use std::io::Write as _;
    let candidates: &[(&str, &[&str])] = if cfg!(target_os = "macos") {
        &[("pbcopy", &[])]
    } else if cfg!(windows) {
        &[("clip", &[])]
    } else {
        &[("wl-copy", &[]), ("xclip", &["-selection", "clipboard"]), ("xsel", &["--clipboard", "--input"])]
    };
    let mut last = String::from("No clipboard tool was found");
    for (program, args) in candidates {
        let mut command = crate::proc::std_command(program);
        command.args(*args).stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
        let Ok(mut child) = command.spawn() else {
            last = format!("{program} is not available");
            continue;
        };
        let bytes: Vec<u8> = if cfg!(windows) {
            // `clip` reads UTF-16 with a byte-order mark; anything else turns accents into noise.
            let mut wide = vec![0xFF, 0xFE];
            for unit in content.encode_utf16() {
                wide.extend_from_slice(&unit.to_le_bytes());
            }
            wide
        } else {
            content.as_bytes().to_vec()
        };
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(&bytes).map_err(|e| e.to_string())?;
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        if status.success() {
            return Ok(());
        }
        last = format!("{program} failed");
    }
    Err(last)
}

async fn clipboard(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let params = ctx.resolve_once().await?;
    let content = match params.get("text") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => serde_json::to_string_pretty(other).unwrap_or_default(),
    };
    let length = content.chars().count();
    tokio::task::spawn_blocking(move || copy_to_clipboard(&content))
        .await
        .map_err(|e| NodeError::failed(e.to_string()))?
        .map_err(NodeError::Failed)?;
    ctx.log(LogStream::Info, &format!("Copied {length} characters"));
    Ok(vec![ctx.passthrough()])
}

// ------------------------------------------------------------------------------------------- vault

async fn vault(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let item = ctx.param_str("item");
    if item.trim().is_empty() {
        return Err(NodeError::failed("Choose the Llavero item"));
    }
    let answer = call(ctx, "vault.read", json!({"itemId": item.trim(), "field": ctx.param_str("itemField")})).await?;
    let value = answer.get("value").cloned().unwrap_or(Value::Null);
    if let Value::String(secret) = &value {
        // Kept out of everything this run stores — its data files and its log.
        ctx.run.host.secret_used(secret);
    }
    let target = {
        let written = ctx.param_str("target");
        if written.trim().is_empty() { "secret".to_string() } else { written.trim().to_string() }
    };
    let count = ctx.items().len().max(1);
    let mut out = Vec::with_capacity(count);
    for index in 0..count {
        let mut json = base(ctx, index);
        set_path(&mut json, &target, value.clone());
        out.push(wrap(ctx, index, json));
    }
    Ok(vec![out])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tags_are_stored_the_way_the_notes_app_writes_them() {
        assert_eq!(note_tags("Deploy, #code review ,deploy,, "), r#"["deploy","code-review"]"#);
        assert_eq!(note_tags(""), "[]");
    }
}
