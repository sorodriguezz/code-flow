//! «Tabla de datos»: a workspace's own small tables (`flows::tables`) — rows by key, written,
//! merged, found by conditions, listed. The app keeps them (`table.*` operations); this node only
//! decides which call each item makes.

use std::time::Duration;

use serde_json::{json, Value};

use super::{number, NodeCtx, NodeError};
use crate::flows::engine::LogStream;
use crate::flows::run::{Item, Ports};

async fn call(ctx: &NodeCtx, op: &str, args: Value) -> Result<Value, NodeError> {
    ctx.run.host.app_call(op, args, ctx.cancel.clone()).await.map_err(NodeError::Failed)
}

fn item(ctx: &NodeCtx, index: usize, json: Value) -> Item {
    if ctx.items().is_empty() {
        Item::new(json)
    } else {
        Item::paired(json, index)
    }
}

/// The row's fields from `rowData`: an object, or JSON text of one.
fn row_data(params: &Value) -> Result<Value, NodeError> {
    match params.get("rowData") {
        Some(Value::Object(map)) => Ok(Value::Object(map.clone())),
        Some(Value::String(written)) if written.trim().starts_with('{') => {
            serde_json::from_str::<Value>(written).ok().filter(Value::is_object).ok_or_else(|| NodeError::failed("«Row» is not a JSON object"))
        }
        Some(Value::Null) | None => Ok(json!({})),
        Some(Value::String(written)) if written.trim().is_empty() => Ok(json!({})),
        _ => Err(NodeError::failed("«Row» must be an object of fields — for the whole item: {{ $json }}")),
    }
}

fn key_of(params: &Value) -> Result<String, NodeError> {
    let key = match params.get("rowKey") {
        Some(Value::String(written)) => written.trim().to_string(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    };
    if key.is_empty() {
        return Err(NodeError::failed("The row's key is empty"));
    }
    Ok(key)
}

pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let name = ctx.param_str("tableName");
    let name = name.trim();
    if name.is_empty() {
        return Err(NodeError::failed("Choose the table"));
    }
    let op = ctx.param_str("tableOp");
    let max = number(&ctx.params, "maxRows").unwrap_or(1_000.0).clamp(1.0, 100_000.0) as u64;
    match op.as_str() {
        "tableList" => {
            let listed = call(ctx, "table.list", json!({ "name": name, "limit": max })).await?;
            Ok(vec![listed.as_array().cloned().unwrap_or_default().into_iter().map(Item::new).collect()])
        }
        "tableClear" => {
            let cleared = call(ctx, "table.clear", json!({ "name": name })).await?;
            Ok(vec![vec![Item::new(json!({ "table": name, "cleared": cleared }))]])
        }
        "tableFind" => {
            let rows = call(ctx, "table.list", json!({ "name": name, "limit": 100_000 })).await?;
            let rows = rows.as_array().cloned().unwrap_or_default();
            if rows.is_empty() {
                return Ok(vec![vec![]]);
            }
            let job = json!({
                "kind": "conditions",
                "spec": ctx.params.get("conditions").cloned().unwrap_or(Value::Null),
                "items": rows,
                "context": ctx.js_context(),
            });
            let verdicts = tokio::select! {
                result = ctx.js.run(&job, Duration::from_secs(30)) => result.map_err(NodeError::from)?,
                _ = ctx.cancel.cancelled() => return Err(NodeError::Cancelled),
            };
            let verdicts = verdicts.as_array().cloned().unwrap_or_default();
            let found: Vec<Item> = rows
                .into_iter()
                .zip(verdicts)
                .filter(|(_, verdict)| verdict.as_bool() == Some(true))
                .take(max as usize)
                .map(|(row, _)| Item::new(row))
                .collect();
            Ok(vec![found])
        }
        _ => {
            let resolved = if ctx.param_str("runFor") == "once" { vec![ctx.resolve_once().await?] } else { ctx.resolve_each().await? };
            let mut out = Vec::with_capacity(resolved.len());
            for (index, params) in resolved.iter().enumerate() {
                match op.as_str() {
                    "tableGet" => {
                        let key = key_of(params)?;
                        let found = call(ctx, "table.get", json!({ "name": name, "key": key })).await?;
                        if found.is_null() {
                            ctx.log(LogStream::Info, &format!("No row with the key “{key}” in {name}"));
                        } else {
                            out.push(item(ctx, index, found));
                        }
                    }
                    "tableDelete" => {
                        let key = key_of(params)?;
                        let deleted = call(ctx, "table.delete", json!({ "name": name, "key": key })).await?;
                        out.push(item(ctx, index, json!({ "_key": key, "deleted": deleted.as_bool().unwrap_or(false) })));
                    }
                    write => {
                        let how = match write {
                            "tableInsert" => "insert",
                            "tableUpdate" => "update",
                            _ => "upsert",
                        };
                        let key = if how == "insert" { None } else { Some(key_of(params)?) };
                        let data = row_data(params)?;
                        let written = call(ctx, "table.write", json!({ "name": name, "key": key, "data": data, "how": how })).await?;
                        if written.is_null() {
                            ctx.log(LogStream::Info, &format!("No row with the key “{}” to update in {name}", key.unwrap_or_default()));
                        } else {
                            out.push(item(ctx, index, written));
                        }
                    }
                }
            }
            Ok(vec![out])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_are_read_from_objects_or_json_text() {
        assert_eq!(row_data(&json!({"rowData": {"a": 1}})).unwrap(), json!({"a": 1}));
        assert_eq!(row_data(&json!({"rowData": "{\"a\": 2}"})).unwrap(), json!({"a": 2}));
        assert_eq!(row_data(&json!({"rowData": ""})).unwrap(), json!({}));
        assert!(row_data(&json!({"rowData": [1, 2]})).is_err());
        assert_eq!(key_of(&json!({"rowKey": 42})).unwrap(), "42");
        assert!(key_of(&json!({"rowKey": "  "})).is_err());
    }
}
