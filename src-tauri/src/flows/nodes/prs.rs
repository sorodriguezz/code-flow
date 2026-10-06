//! The PR analyzer's nodes: read pull requests, decide on one, work its comment threads, and its
//! review memory. `flows::pr_ops` does the work, through the analyzer's own commands — a decision
//! taken here is filed in Activity and a finding marked here is remembered by the next review,
//! exactly as when a person does it in the PR panel.

use serde_json::{json, Value};

use super::{flag, number, text, NodeCtx, NodeError};
use crate::flows::engine::LogStream;
use crate::flows::pr_ops::ids_of;
use crate::flows::run::{Item, Ports};

pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    match ctx.node.type_id.as_str() {
        "app.prList" => list(ctx).await,
        "app.prDecide" => decide(ctx).await,
        "app.prComments" => comments(ctx).await,
        _ => memory(ctx).await,
    }
}

fn failure(error: String) -> NodeError {
    if error.contains(crate::ai_runs::CANCELLED_MARKER) {
        NodeError::Cancelled
    } else {
        NodeError::Failed(error)
    }
}

async fn call(ctx: &NodeCtx, op: &str, args: Value) -> Result<Value, NodeError> {
    ctx.run.host.app_call(op, args, ctx.cancel.clone()).await.map_err(failure)
}

fn project(params: &Value) -> Result<String, NodeError> {
    let project = text(params, "project");
    if project.trim().is_empty() {
        return Err(NodeError::failed("Choose the repository"));
    }
    Ok(project.trim().to_string())
}

fn pr_id(params: &Value) -> Result<Value, NodeError> {
    let written = text(params, "prId");
    if written.trim().is_empty() {
        return Err(NodeError::failed("Say which pull request — its number"));
    }
    Ok(params.get("prId").cloned().unwrap_or(Value::Null))
}

fn wrap(ctx: &NodeCtx, index: usize, json: Value) -> Item {
    if ctx.items().is_empty() {
        Item::new(json)
    } else {
        Item::paired(json, index)
    }
}

fn each(answer: Value) -> Vec<Value> {
    match answer {
        Value::Array(list) => list,
        Value::Null => Vec::new(),
        other => vec![other],
    }
}

/// A comment thread with what a flow reads first: where it is, who opened it and what they said,
/// who spoke last.
pub fn thread_item(thread: &Value, pr_id: &Value) -> Value {
    let comments = thread["comments"].as_array().cloned().unwrap_or_default();
    let file = thread["file_path"].as_str();
    let start = thread["start_line"].as_i64();
    let end = thread["end_line"].as_i64();
    let location = match (file, start) {
        (Some(file), Some(start)) => Some(match end {
            Some(end) if end != start => format!("{file}:{start}-{end}"),
            _ => format!("{file}:{start}"),
        }),
        (Some(file), None) => Some(file.to_string()),
        _ => None,
    };
    let first = comments.first().cloned().unwrap_or(Value::Null);
    let last = comments.last().cloned().unwrap_or(Value::Null);
    json!({
        "id": thread["id"],
        "prId": pr_id,
        "file": file,
        "startLine": start,
        "endLine": end,
        "location": location,
        "author": first["author"],
        "text": first["content"],
        "lastAuthor": last["author"],
        "lastText": last["content"],
        "replies": comments.len().saturating_sub(1),
        "comments": comments,
    })
}

async fn list(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    if ctx.param_str("prOp") != "prGet" {
        let params = ctx.resolve_once().await?;
        let args = json!({
            "projectId": project(&params)?,
            "scope": text(&params, "prState"),
            "max": number(&params, "maxResults").map(|n| n.max(1.0) as u64).unwrap_or(20),
        });
        let prs = each(call(ctx, "pr.list", args).await?);
        ctx.log(LogStream::Info, &format!("{} pull request(s)", prs.len()));
        return Ok(vec![prs.into_iter().map(Item::new).collect()]);
    }
    let resolved = ctx.resolve_each().await?;
    let mut out = Vec::new();
    for (index, params) in resolved.iter().enumerate() {
        let answer = call(ctx, "pr.get", json!({"projectId": project(params)?, "prId": pr_id(params)?})).await?;
        out.push(wrap(ctx, index, answer));
    }
    Ok(vec![out])
}

async fn decide(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let resolved = ctx.resolve_each().await?;
    let mut done: Vec<(String, Value)> = Vec::new();
    let mut out = Vec::new();
    for (index, params) in resolved.iter().enumerate() {
        let args = json!({
            "projectId": project(params)?,
            "prId": pr_id(params)?,
            "decision": text(params, "prDecision"),
            "note": text(params, "decisionNote"),
            "postSummary": flag(params, "postSummary"),
        });
        // The same decision on the same pull request twice in one run is one decision.
        let key = args.to_string();
        if let Some((_, answer)) = done.iter().find(|(seen, _)| *seen == key) {
            out.push(wrap(ctx, index, answer.clone()));
            continue;
        }
        let answer = call(ctx, "pr.decide", args).await?;
        ctx.log(
            LogStream::Info,
            &format!("Pull request #{}: {}", answer["prId"], answer["decision"].as_str().unwrap_or_default()),
        );
        if let Some(error) = answer["summaryError"].as_str() {
            ctx.log(LogStream::Stderr, &format!("The decision stands, but its summary was not posted: {error}"));
        }
        done.push((key, answer.clone()));
        out.push(wrap(ctx, index, answer));
    }
    Ok(vec![out])
}

async fn comments(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let resolved = ctx.resolve_each().await?;
    let mut out = Vec::new();
    for (index, params) in resolved.iter().enumerate() {
        let project = project(params)?;
        let pr = pr_id(params)?;
        if ctx.param_str("threadOp") == "resolveThread" {
            let ids = ids_of(params.get("threadIds"));
            if ids.is_empty() {
                return Err(NodeError::failed("Write the threads' ids (the \"id\" a list of comments gives)"));
            }
            for id in ids {
                let mut answer = call(
                    ctx,
                    "pr.threadResolve",
                    json!({"projectId": project, "prId": pr, "threadId": id, "reply": text(params, "reply"), "wontFix": flag(params, "wontFix")}),
                )
                .await?;
                answer["threadId"] = json!(id);
                answer["prId"] = pr.clone();
                out.push(wrap(ctx, index, answer));
            }
            continue;
        }
        for thread in each(call(ctx, "pr.threads", json!({"projectId": project, "prId": pr})).await?) {
            out.push(wrap(ctx, index, thread_item(&thread, &pr)));
        }
    }
    Ok(vec![out])
}

async fn memory(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let op = ctx.param_str("memoryOp");
    if op == "memoryRuns" || op == "memoryRules" || op.is_empty() {
        let params = ctx.resolve_once().await?;
        let args = json!({"projectId": project(&params)?, "prId": params.get("prId").cloned().unwrap_or(Value::Null)});
        let answer = call(ctx, if op == "memoryRules" { "pr.memoryRules" } else { "pr.memoryRuns" }, args).await?;
        return Ok(vec![each(answer).into_iter().map(Item::new).collect()]);
    }
    let resolved = ctx.resolve_each().await?;
    let mut out = Vec::new();
    for (index, params) in resolved.iter().enumerate() {
        let mut args = json!({"projectId": project(params)?, "prId": pr_id(params)?, "runId": text(params, "runId")});
        let answer = if op == "memoryMark" {
            args["findingIds"] = params.get("findingIds").cloned().unwrap_or(Value::Null);
            args["markAs"] = json!(text(params, "markAs"));
            args["reason"] = json!(text(params, "reason"));
            args["wholeRepo"] = json!(flag(params, "wholeRepo"));
            args["notifyPr"] = json!(flag(params, "notifyPr"));
            call(ctx, "pr.findingMark", args).await?
        } else {
            args["state"] = json!(text(params, "findingState"));
            call(ctx, "pr.memoryFindings", args).await?
        };
        out.extend(each(answer).into_iter().map(|json| wrap(ctx, index, json)));
    }
    Ok(vec![out])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_thread_reads_as_its_place_its_opener_and_its_last_word() {
        let thread = json!({
            "id": 41, "file_path": "src/app.ts", "start_line": 12, "end_line": 14,
            "comments": [
                {"author": "Ana", "content": "¿Por qué no validas aquí?", "published_date": "2026-10-06"},
                {"author": "Bruno", "content": "Lo agrego.", "published_date": "2026-10-06"}
            ]
        });
        let item = thread_item(&thread, &json!(7));
        assert_eq!(item["location"], "src/app.ts:12-14");
        assert_eq!((item["author"].as_str(), item["lastAuthor"].as_str(), item["replies"].as_u64()), (Some("Ana"), Some("Bruno"), Some(1)));
        let general = thread_item(&json!({"id": 1, "file_path": null, "start_line": null, "end_line": null, "comments": []}), &json!(7));
        assert_eq!((general["location"].clone(), general["replies"].as_u64()), (Value::Null, Some(0)));
    }
}
