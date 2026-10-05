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
    let limit = Duration::from_secs_f64(number(&params, "timeoutMin").unwrap_or(60.0).clamp(1.0, 24.0 * 60.0) * 60.0);
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
            let jobs: Vec<Value> = detail
                .get("jobs")
                .and_then(Value::as_array)
                .map(|jobs| jobs.iter().map(|job| json!({"name": job.get("name"), "status": job.get("status")})).collect())
                .unwrap_or_default();
            let result = json!({"runId": run_id, "url": url, "status": status, "ref": reference, "jobs": jobs});
            if matches!(status.as_str(), "failed" | "cancelled") && flag(&params, "failOnFailure") {
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
