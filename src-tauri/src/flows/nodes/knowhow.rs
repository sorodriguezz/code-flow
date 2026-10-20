//! What CodeFlow knows, as nodes: the repository's code map («Mapa del código»), the knowledge index
//! («Buscar en el conocimiento»), the memories the user approved («Memoria») and a terminal's recent
//! output («Salida de terminal») — what an agent reaches with `cf` or over MCP, for a flow.
//!
//! The code map is read here (it is a pure read of the repository's files); the rest goes through
//! the app's operations (`app_ops`: `knowledge.search`, `memory.recall`, `memory.propose`,
//! `terminal.output`), which hold the database, the index and the terminals.

use serde_json::{json, Value};

use super::{number, text, NodeCtx, NodeError};
use crate::flows::run::{Item, Ports};

pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    match ctx.node.type_id.as_str() {
        "app.codemap" => codemap(ctx).await,
        "app.knowledge" => knowledge(ctx).await,
        "app.memory" => memory(ctx).await,
        "app.terminalOutput" => terminal_output(ctx).await,
        other => Err(NodeError::failed(format!("No executor for {other}"))),
    }
}

/// An output item for input `index` — paired to it, or on its own for a node that ran on nothing.
fn item(ctx: &NodeCtx, index: usize, json: Value) -> Item {
    if ctx.items().is_empty() {
        Item::new(json)
    } else {
        Item::paired(json, index)
    }
}

async fn call(ctx: &NodeCtx, op: &str, args: Value) -> Result<Value, NodeError> {
    ctx.run.host.app_call(op, args, ctx.cancel.clone()).await.map_err(NodeError::Failed)
}

fn need_project(params: &Value) -> Result<String, NodeError> {
    let project = text(params, "project");
    if project.trim().is_empty() {
        return Err(NodeError::failed("Choose the repository"));
    }
    Ok(project.trim().to_string())
}

/// «Mapa del código»: where a symbol is declared, who uses it, a file's outline or the project's map,
/// as the text the AI agents are given.
async fn codemap(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let resolved = ctx.resolve_each().await?;
    let mut out = Vec::new();
    for (index, params) in resolved.iter().enumerate() {
        let project = need_project(params)?;
        let root = ctx.run.host.project_path(&project).map_err(NodeError::Failed)?;
        let operation = text(params, "codemapOp");
        let symbol = text(params, "symbolName").trim().to_string();
        let path = text(params, "outlinePath").trim().trim_start_matches(['/', '\\']).to_string();
        let (tool, args, query) = match operation.as_str() {
            "mapUsages" if symbol.is_empty() => return Err(NodeError::failed("Write the symbol's name")),
            "mapUsages" => ("find_usages", json!({ "name": symbol }), symbol),
            "mapOutline" if path.is_empty() => return Err(NodeError::failed("Write the file's path, relative to the repository")),
            "mapOutline" => ("file_outline", json!({ "path": path }), path),
            "mapProject" => ("project_map", json!({}), String::new()),
            _ if symbol.is_empty() => return Err(NodeError::failed("Write the symbol's name")),
            _ => ("find_symbol", json!({ "name": symbol }), symbol),
        };
        let answer = tokio::select! {
            answer = crate::codemap::mcp::call_tool(&root, tool, &args) => answer.map_err(NodeError::Failed)?,
            _ = ctx.cancel.cancelled() => return Err(NodeError::Cancelled),
        };
        out.push(item(ctx, index, json!({ "operation": operation, "query": query, "text": answer })));
    }
    Ok(vec![out])
}

/// «Buscar en el conocimiento»: one item per passage, best first, with its file and lines.
async fn knowledge(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let resolved = ctx.resolve_each().await?;
    let mut out = Vec::new();
    for (index, params) in resolved.iter().enumerate() {
        let project = need_project(params)?;
        let query = text(params, "knowledgeQuery");
        if query.trim().is_empty() {
            return Err(NodeError::failed("Write the question"));
        }
        let limit = number(params, "maxResults").unwrap_or(8.0).clamp(1.0, 50.0) as u64;
        let found = call(ctx, "knowledge.search", json!({ "projectId": project, "query": query.trim(), "limit": limit })).await?;
        for (rank, hit) in found.as_array().cloned().unwrap_or_default().into_iter().enumerate() {
            let mut json = hit;
            if let Value::Object(map) = &mut json {
                map.insert("rank".into(), json!(rank + 1));
                map.insert("query".into(), json!(query.trim()));
            }
            out.push(item(ctx, index, json));
        }
    }
    Ok(vec![out])
}

/// «Memoria»: the approved memories for a project (one item each), or a fact proposed as a memory —
/// a candidate no model reads until the user approves it in Settings.
async fn memory(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let resolved = ctx.resolve_each().await?;
    let mut out = Vec::new();
    for (index, params) in resolved.iter().enumerate() {
        let project = text(params, "project").trim().to_string();
        let workspace = ctx.run.workspace_id.clone();
        if text(params, "memoryOp") == "memoryPropose" {
            let fact = text(params, "memoryFact");
            if fact.trim().is_empty() {
                return Err(NodeError::failed("Write what to remember"));
            }
            let memory = call(ctx, "memory.propose", json!({ "projectId": project, "workspaceId": workspace, "fact": fact.trim() })).await?;
            out.push(item(ctx, index, json!({ "memory": memory })));
            continue;
        }
        let topic = text(params, "memoryTopic");
        let found = call(ctx, "memory.recall", json!({ "projectId": project, "workspaceId": workspace, "topic": topic.trim() })).await?;
        for memory in found.as_array().cloned().unwrap_or_default() {
            out.push(item(ctx, index, memory));
        }
    }
    Ok(vec![out])
}

/// «Salida de terminal»: the last lines of a terminal of the agents panel, by title or number — or,
/// with no name, one item per terminal of the flow's workspace.
async fn terminal_output(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let resolved = ctx.resolve_each().await?;
    let mut out = Vec::new();
    for (index, params) in resolved.iter().enumerate() {
        let terminal = text(params, "terminalName");
        let lines = number(params, "lines").unwrap_or(100.0).clamp(1.0, 5_000.0) as u64;
        let answer = call(
            ctx,
            "terminal.output",
            json!({ "workspaceId": ctx.run.workspace_id, "terminal": terminal.trim(), "lines": lines }),
        )
        .await?;
        match answer {
            Value::Array(terminals) => out.extend(terminals.into_iter().map(|t| item(ctx, index, t))),
            one => out.push(item(ctx, index, one)),
        }
    }
    Ok(vec![out])
}
