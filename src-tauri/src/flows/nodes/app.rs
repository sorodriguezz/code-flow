//! Notify, Flow state and Variables — the nodes that talk to CodeFlow itself.

use serde_json::{json, Value};

use super::{flag, number, text, NodeCtx, NodeError};
use crate::flows::run::{Item, Ports};
use crate::flows::value::{set_path, to_number};

pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    match ctx.node.type_id.as_str() {
        "app.notify" => notify(ctx).await,
        "data.state" => state(ctx).await,
        "data.vars" => vars(ctx).await,
        "net.respond" => respond(ctx).await,
        "code.service" => service(ctx).await,
        other => Err(NodeError::failed(format!("{other} is not an app node"))),
    }
}

/// Respond to webhook: the answer the request that started this run is waiting for. Evaluated
/// against the first item; the items pass through. A run nobody is waiting on — started by hand,
/// or by a webhook that answered straight away — logs that and carries on.
async fn respond(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let params = ctx.resolve_once().await?;
    let status = number(&params, "status").map(|n| n as u16).filter(|n| (100..600).contains(n)).unwrap_or(200);
    let mut headers: Vec<(String, String)> = super::pairs(&params, "headers");
    let body = params.get("body").cloned().unwrap_or(Value::Null);
    let first = ctx.items().first().map(|item| item.json.clone()).unwrap_or(json!({}));
    let (bytes, guessed) = match &body {
        Value::String(text) if text.is_empty() => {
            let all: Vec<Value> = ctx.items().iter().map(|item| item.json.clone()).collect();
            let value = if all.len() == 1 { first } else { Value::Array(all) };
            (value.to_string().into_bytes(), "application/json")
        }
        Value::String(text) => (text.clone().into_bytes(), "text/plain; charset=utf-8"),
        other => (other.to_string().into_bytes(), "application/json"),
    };
    let declared = text(&params, "contentType");
    let content_type = if declared.trim().is_empty() { guessed.to_string() } else { declared };
    headers.retain(|(name, _)| !name.eq_ignore_ascii_case("content-type"));
    let sender = ctx.run.respond.lock().ok().and_then(|mut slot| slot.take());
    match sender {
        Some(sender) => {
            let _ = sender.send(crate::flows::engine::Reply { status, headers, content_type, body: bytes });
            ctx.log(crate::flows::engine::LogStream::Info, &format!("Answered the webhook with {status}"));
        }
        None => ctx.log(crate::flows::engine::LogStream::Info, "No webhook is waiting for an answer in this run"),
    }
    Ok(vec![ctx.passthrough()])
}

/// Service: start, stop or restart one of the workspace's services (the dock's), or read its state.
async fn service(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let id = text(&ctx.params, "service");
    if id.trim().is_empty() {
        return Err(NodeError::failed("Choose a service"));
    }
    let action = text(&ctx.params, "action");
    let wait = ctx.params.get("wait").is_none() || flag(&ctx.params, "wait");
    let timeout = std::time::Duration::from_secs_f64(number(&ctx.params, "timeoutSec").unwrap_or(120.0).clamp(1.0, 3600.0));
    let work = ctx.run.host.service(id.trim(), if action.is_empty() { "start" } else { &action }, wait, timeout);
    let state = tokio::select! {
        result = work => result.map_err(NodeError::failed)?,
        _ = ctx.cancel.cancelled() => return Err(NodeError::Cancelled),
    };
    Ok(vec![vec![Item::new(state)]])
}

/// One notification for the node — or one per item, when asked — and the items pass through.
async fn notify(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let per_item = flag(&ctx.params, "perItem");
    let resolved = if per_item { ctx.resolve_each().await? } else { vec![ctx.resolve_once().await?] };
    for params in &resolved {
        let title = text(params, "title");
        let title = if title.trim().is_empty() { ctx.run.flow_name.clone() } else { title };
        ctx.run.host.notify(&title, &text(params, "body"));
    }
    Ok(vec![ctx.passthrough()])
}

/// The value `params` names, with the item it was read for written back.
fn with_field(json: &Value, target: &str, value: Value) -> Value {
    let mut out = if json.is_object() { json.clone() } else { json!({}) };
    let target = if target.trim().is_empty() { "value" } else { target.trim() };
    set_path(&mut out, target, value);
    out
}

async fn state(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let resolved = ctx.resolve_each().await?;
    let operation = text(&ctx.params, "operation");
    let items = ctx.items();
    let mut out = Vec::new();
    for index in 0..items.len().max(1) {
        let params = &resolved[index.min(resolved.len() - 1)];
        let key = text(params, "key").trim().to_string();
        if key.is_empty() {
            return Err(NodeError::failed("Name the key to keep the value under"));
        }
        if key.starts_with("__") {
            return Err(NodeError::failed("Keys starting with __ are reserved"));
        }
        let json = items.get(index).map(|item| item.json.clone()).unwrap_or(json!({}));
        let host = &ctx.run.host;
        let produced = match operation.as_str() {
            "set" => {
                let value = params.get("value").cloned().unwrap_or(Value::Null);
                host.state_set(&key, Some(&value)).map_err(NodeError::failed)?;
                json
            }
            "increment" => {
                let current = host.state_get(&key).map_err(NodeError::failed)?.as_ref().and_then(to_number).unwrap_or(0.0);
                let next = crate::flows::value::number(current + number(params, "amount").unwrap_or(1.0));
                host.state_set(&key, Some(&next)).map_err(NodeError::failed)?;
                with_field(&json, &text(params, "target"), next)
            }
            "delete" => {
                host.state_set(&key, None).map_err(NodeError::failed)?;
                json
            }
            _ => {
                let value = host.state_get(&key).map_err(NodeError::failed)?.unwrap_or_else(|| {
                    params.get("fallback").cloned().filter(|v| v != "").unwrap_or(Value::Null)
                });
                with_field(&json, &text(params, "target"), value)
            }
        };
        out.push(if items.is_empty() { Item::new(produced) } else { Item::paired(produced, index) });
    }
    Ok(vec![out])
}

async fn vars(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let resolved = ctx.resolve_each().await?;
    let operation = text(&ctx.params, "operation");
    let items = ctx.items();
    let mut out = Vec::new();
    for index in 0..items.len().max(1) {
        let params = &resolved[index.min(resolved.len() - 1)];
        let name = text(params, "name").trim().to_string();
        if name.is_empty() {
            return Err(NodeError::failed("Name the variable"));
        }
        if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(NodeError::failed(format!("\"{name}\" is not a variable name: letters, digits and _ only")));
        }
        let json = items.get(index).map(|item| item.json.clone()).unwrap_or(json!({}));
        let produced = match operation.as_str() {
            "set" => {
                ctx.run.host.var_set(&name, Some(&text(params, "value"))).map_err(NodeError::failed)?;
                json
            }
            "delete" => {
                ctx.run.host.var_set(&name, None).map_err(NodeError::failed)?;
                json
            }
            _ => {
                let value = ctx.run.host.var_get(&name).map_err(NodeError::failed)?.map(Value::String).unwrap_or(Value::Null);
                with_field(&json, &text(params, "target"), value)
            }
        };
        out.push(if items.is_empty() { Item::new(produced) } else { Item::paired(produced, index) });
    }
    Ok(vec![out])
}
