//! n8n workflows into flows.
//!
//! **The core nodes, mapped; everything else kept and said.** A webhook, a schedule, an HTTP
//! request, Code, Set, IF, Switch, Merge, Wait, Loop over items, Filter, Sort, Execute Command,
//! Respond to Webhook and a few more become their counterparts here, parameters and all. A node with
//! no counterpart (a SaaS integration, a LangChain node) stays in place as a switched-off pass-through
//! named as it was, so the shape of the workflow survives and the user can see what to rebuild; the
//! import lists them.
//!
//! **Expressions pass through.** n8n writes `={{ $json.x }}`, `$('Node').item.json` and
//! `$node["Node"].json` — the same language this engine evaluates. Credentials do not: they are
//! n8n's, and the user picks theirs.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Map, Value};

use super::spec::{self, Connection, FlowNode, FlowSpec, StickyNote};

/// What a conversion gave and what it could not map.
pub struct Converted {
    pub spec: FlowSpec,
    pub name: String,
    /// `Name (type)` of every node kept as a placeholder.
    pub unmapped: Vec<String>,
}

/// Whether `value` is an n8n workflow export.
pub fn is_n8n(value: &Value) -> bool {
    let typed = value.get("nodes").and_then(Value::as_array).is_some_and(|nodes| {
        nodes.iter().any(|node| {
            node.get("type").and_then(Value::as_str).is_some_and(|t| t.starts_with("n8n-nodes-base.") || t.starts_with("@n8n/"))
        })
    });
    typed && value.get("connections").is_some_and(Value::is_object)
}

fn text(params: &Value, key: &str) -> String {
    match params.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

fn pairs(list: Option<&Value>) -> Value {
    let rows: Vec<Value> = list
        .and_then(Value::as_array)
        .map(|rows| rows.iter().map(|row| json!({"name": text(row, "name"), "value": text(row, "value")})).collect())
        .unwrap_or_default();
    Value::Array(rows)
}

/// n8n's condition operators, by their v1 and v2 names, as this engine's.
fn operator(name: &str) -> &'static str {
    match name {
        "equal" | "equals" | "is" => "equals",
        "notEqual" | "notEquals" | "isNot" => "notEquals",
        "contains" => "contains",
        "notContains" => "notContains",
        "startsWith" => "startsWith",
        "notStartsWith" => "notStartsWith",
        "endsWith" => "endsWith",
        "notEndsWith" => "notEndsWith",
        "regex" => "regex",
        "notRegex" => "notRegex",
        "larger" | "gt" | "after" => "gt",
        "largerEqual" | "gte" | "afterOrEquals" => "gte",
        "smaller" | "lt" | "before" => "lt",
        "smallerEqual" | "lte" | "beforeOrEquals" => "lte",
        "isEmpty" | "empty" => "empty",
        "isNotEmpty" | "notEmpty" => "notEmpty",
        "exists" => "exists",
        "notExists" => "notExists",
        "true" => "isTrue",
        "false" => "isFalse",
        "lengthEquals" => "lengthEquals",
        "lengthGt" => "lengthGt",
        "lengthLt" => "lengthLt",
        _ => "equals",
    }
}

/// An IF/Filter condition block of either generation as `{ combinator, ignoreCase, conditions }`.
fn conditions(params: &Value) -> Value {
    let mut rows = Vec::new();
    let mut combinator = "and";
    if let Some(v2) = params.get("conditions").and_then(|c| c.get("conditions")).and_then(Value::as_array) {
        // IF v2: `{ conditions: [{ leftValue, rightValue, operator: { operation } }], combinator }`.
        for row in v2 {
            let op = row.get("operator").and_then(|o| o.get("operation")).and_then(Value::as_str).unwrap_or("equals");
            rows.push(json!({"left": text(row, "leftValue"), "op": operator(op), "right": text(row, "rightValue")}));
        }
        if params.get("conditions").and_then(|c| c.get("combinator")).and_then(Value::as_str) == Some("or") {
            combinator = "or";
        }
    } else if let Some(v1) = params.get("conditions").and_then(Value::as_object) {
        // IF v1: `{ string: [...], number: [...], boolean: [...] }` with `combineOperation`.
        for list in v1.values().filter_map(Value::as_array) {
            for row in list {
                rows.push(json!({"left": text(row, "value1"), "op": operator(&text(row, "operation")), "right": text(row, "value2")}));
            }
        }
        if text(params, "combineOperation") == "any" {
            combinator = "or";
        }
    }
    json!({"combinator": combinator, "ignoreCase": false, "conditions": rows})
}

/// One n8n node as `(type, params)` here, or `None` when there is no counterpart.
fn map_node(kind: &str, version: f64, params: &Value) -> Option<(&'static str, Value)> {
    let short = kind.rsplit('.').next().unwrap_or(kind);
    Some(match short {
        "manualTrigger" => ("trigger.manual", json!({})),
        "scheduleTrigger" | "cron" => {
            let rule = params.get("rule").and_then(|r| r.get("interval")).and_then(Value::as_array).and_then(|list| list.first());
            match rule {
                Some(rule) if text(rule, "field") == "cronExpression" => {
                    ("trigger.schedule", json!({"mode": "cron", "cron": text(rule, "expression")}))
                }
                Some(rule) => {
                    let field = text(rule, "field");
                    let (unit, key) = match field.as_str() {
                        "hours" => ("hours", "hoursInterval"),
                        "days" => ("days", "daysInterval"),
                        "seconds" | "minutes" => ("minutes", "minutesInterval"),
                        _ => ("minutes", "minutesInterval"),
                    };
                    let every = rule.get(key).and_then(Value::as_f64).unwrap_or(1.0).max(1.0);
                    ("trigger.schedule", json!({"mode": "interval", "every": every, "unit": unit}))
                }
                None => ("trigger.schedule", json!({"mode": "interval", "every": 15, "unit": "minutes"})),
            }
        }
        "webhook" => {
            let respond = match text(params, "responseMode").as_str() {
                "lastNode" => "lastNode",
                "responseNode" => "respondNode",
                _ => "immediately",
            };
            let method = text(params, "httpMethod");
            (
                "trigger.webhook",
                json!({"method": if method.is_empty() { "GET".to_string() } else { method }, "hookPath": text(params, "path"), "auth": "none", "respond": respond}),
            )
        }
        "respondToWebhook" => {
            let body = match text(params, "respondWith").as_str() {
                "text" => text(params, "responseBody"),
                "json" => text(params, "responseBody"),
                _ => "={{ JSON.stringify($json) }}".to_string(),
            };
            ("net.respond", json!({"status": params.get("options").and_then(|o| o.get("responseCode")).cloned().unwrap_or(json!(200)), "body": body}))
        }
        "httpRequest" => {
            let method = {
                let m = text(params, "method");
                if m.is_empty() {
                    let older = text(params, "requestMethod");
                    if older.is_empty() { "GET".to_string() } else { older }
                } else {
                    m
                }
            };
            let query = pairs(params.get("queryParameters").and_then(|q| q.get("parameters")));
            let headers = pairs(params.get("headerParameters").and_then(|q| q.get("parameters")));
            let mut out = json!({"method": method, "url": text(params, "url"), "query": query, "headers": headers, "body": "none"});
            if params.get("sendBody").and_then(Value::as_bool) == Some(true) {
                if text(params, "specifyBody") == "json" {
                    out["body"] = json!("json");
                    out["bodyJson"] = json!(text(params, "jsonBody"));
                } else if text(params, "contentType") == "form-urlencoded" {
                    out["body"] = json!("form");
                    out["bodyForm"] = pairs(params.get("bodyParameters").and_then(|b| b.get("parameters")));
                } else {
                    let fields: Map<String, Value> = params
                        .get("bodyParameters")
                        .and_then(|b| b.get("parameters"))
                        .and_then(Value::as_array)
                        .map(|rows| rows.iter().map(|row| (text(row, "name"), json!(text(row, "value")))).collect())
                        .unwrap_or_default();
                    out["body"] = json!("json");
                    out["bodyJson"] = json!(Value::Object(fields).to_string());
                }
            }
            ("net.http", out)
        }
        "code" => {
            let each = text(params, "mode") == "runOnceForEachItem";
            let code = text(params, "jsCode");
            ("code.js", json!({"mode": if each { "each" } else { "all" }, "code": if code.is_empty() { "return $input.all();".to_string() } else { code }}))
        }
        "function" => ("code.js", json!({"mode": "all", "code": text(params, "functionCode")})),
        "functionItem" => ("code.js", json!({"mode": "each", "code": text(params, "functionCode")})),
        "set" => {
            let mut assignments = Vec::new();
            let include;
            if let Some(list) = params.get("assignments").and_then(|a| a.get("assignments")).and_then(Value::as_array) {
                for row in list {
                    assignments.push(json!({"name": text(row, "name"), "type": text(row, "type"), "value": row.get("value").cloned().unwrap_or(Value::Null)}));
                }
                include = if params.get("includeOtherFields").and_then(Value::as_bool) == Some(true) { "all" } else { "none" };
            } else {
                for (kind, rows) in params.get("values").and_then(Value::as_object).into_iter().flatten() {
                    for row in rows.as_array().into_iter().flatten() {
                        assignments.push(json!({"name": text(row, "name"), "type": if kind == "boolean" { "boolean" } else if kind == "number" { "number" } else { "string" }, "value": row.get("value").cloned().unwrap_or(Value::Null)}));
                    }
                }
                include = if params.get("keepOnlySet").and_then(Value::as_bool) == Some(true) { "none" } else { "all" };
            }
            ("transform.set", json!({"mode": "manual", "assignments": assignments, "include": include}))
        }
        "if" => ("logic.if", json!({"conditions": conditions(params)})),
        "filter" => ("transform.filter", json!({"conditions": conditions(params)})),
        "switch" => {
            let mut rules = Vec::new();
            for (index, rule) in params.get("rules").and_then(|r| r.get("values")).and_then(Value::as_array).into_iter().flatten().enumerate() {
                let block = conditions(rule);
                if let Some(first) = block["conditions"].get(0) {
                    rules.push(json!({"output": index.min(2), "left": first["left"], "op": first["op"], "right": first["right"]}));
                }
            }
            ("logic.switch", json!({"mode": "rules", "rules": rules}))
        }
        "merge" => {
            let mode = match text(params, "mode").as_str() {
                "combine" | "mergeByKey" => "field",
                "mergeByIndex" | "combineByPosition" => "position",
                "chooseBranch" => "choose",
                _ => "append",
            };
            ("logic.merge", json!({"mode": mode}))
        }
        "wait" => match text(params, "resume").as_str() {
            "webhook" => ("logic.wait", json!({"mode": "webhook"})),
            "specificTime" => ("logic.wait", json!({"mode": "until", "until": text(params, "dateTime")})),
            _ => {
                let unit = match text(params, "unit").as_str() {
                    "minutes" => "minutes",
                    "hours" => "hours",
                    "days" => "days",
                    _ => "seconds",
                };
                ("logic.wait", json!({"mode": "duration", "amount": params.get("amount").cloned().unwrap_or(json!(1)), "unit": unit}))
            }
        },
        "splitInBatches" => ("logic.loop", json!({"batchSize": params.get("batchSize").cloned().unwrap_or(json!(10))})),
        "sort" => {
            let keys: Vec<Value> = params
                .get("sortFieldsUi")
                .and_then(|s| s.get("sortField"))
                .and_then(Value::as_array)
                .map(|rows| rows.iter().map(|row| json!({"field": text(row, "fieldName"), "order": if text(row, "order") == "descending" { "desc" } else { "asc" }})).collect())
                .unwrap_or_default();
            ("transform.sort", json!({"mode": "fields", "keys": keys}))
        }
        "removeDuplicates" => ("transform.dedupe", json!({})),
        "splitOut" | "itemLists" => ("transform.split", json!({"field": text(params, "fieldToSplitOut")})),
        "aggregate" => ("transform.aggregate", json!({})),
        "noOp" => ("transform.set", json!({})),
        "stopAndError" => ("logic.stop", json!({"message": text(params, "errorMessage")})),
        "executeCommand" => ("code.shell", json!({"shell": "auto", "script": text(params, "command"), "output": "auto"})),
        "executeWorkflow" => ("logic.subflow", json!({"flow": "", "mode": "wait"})),
        "executeWorkflowTrigger" => ("trigger.subflow", json!({})),
        "errorTrigger" => ("trigger.error", json!({})),
        "emailSend" => (
            "net.email",
            json!({"to": text(params, "toEmail"), "from": text(params, "fromEmail"), "subject": text(params, "subject"), "body": text(params, "text")}),
        ),
        "readWriteFile" => {
            let write = text(params, "operation") == "write";
            ("files.file", json!({"operation": if write { "write" } else { "read" }, "path": text(params, "fileName")}))
        }
        _ => {
            let _ = version;
            return None;
        }
    })
}

/// A node id that is valid here and unique: n8n's own when it has one, a counter otherwise.
/// n8n's seven sticky colours (`parameters.color`; 1, or none, is its yellow) as the nearest of the
/// app's palette — its yellow is the default here too.
fn sticky_colour(params: &Value) -> &'static str {
    match params.get("color").and_then(Value::as_u64) {
        Some(2) => "#f97316",
        Some(3) => "#ef4444",
        Some(4) => "#22c55e",
        Some(5) => "#3b82f6",
        Some(6) => "#8b5cf6",
        Some(7) => "#64748b",
        _ => "",
    }
}

fn node_id(raw: Option<&str>, taken: &mut HashSet<String>, counter: &mut usize) -> String {
    let base: String = raw.unwrap_or_default().chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(36).collect();
    let mut id = if base.is_empty() {
        *counter += 1;
        format!("n{counter}")
    } else {
        base
    };
    while !taken.insert(id.clone()) {
        *counter += 1;
        id = format!("n{counter}");
    }
    id
}

pub fn convert(value: &Value) -> Result<Converted, String> {
    let name = value.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
    let mut nodes = Vec::new();
    let mut notes = Vec::new();
    let mut unmapped = Vec::new();
    let mut by_name: HashMap<String, (String, &'static str, f64)> = HashMap::new();
    let mut taken = HashSet::new();
    let mut counter = 0usize;
    for raw in value.get("nodes").and_then(Value::as_array).into_iter().flatten() {
        let kind = raw.get("type").and_then(Value::as_str).unwrap_or_default();
        let params = raw.get("parameters").cloned().unwrap_or_else(|| json!({}));
        let position = raw.get("position").and_then(Value::as_array);
        let pos = [
            position.and_then(|p| p.first()).and_then(Value::as_f64).unwrap_or(0.0),
            position.and_then(|p| p.get(1)).and_then(Value::as_f64).unwrap_or(0.0),
        ];
        let node_name = raw.get("name").and_then(Value::as_str).unwrap_or("Nodo").to_string();
        if kind.ends_with(".stickyNote") {
            let width = params.get("width").and_then(Value::as_f64).unwrap_or(240.0);
            let height = params.get("height").and_then(Value::as_f64).unwrap_or(120.0);
            notes.push(StickyNote {
                id: format!("note{}", notes.len() + 1),
                pos,
                size: [width, height],
                text: text(&params, "content"),
                color: sticky_colour(&params).to_string(),
            });
            continue;
        }
        let version = raw.get("typeVersion").and_then(Value::as_f64).unwrap_or(1.0);
        let id = node_id(raw.get("id").and_then(Value::as_str), &mut taken, &mut counter);
        let (type_id, mapped, disabled) = match map_node(kind, version, &params) {
            Some((type_id, mapped)) => (type_id, mapped, raw.get("disabled").and_then(Value::as_bool).unwrap_or(false)),
            None => {
                unmapped.push(format!("{node_name} ({kind})"));
                // Kept in place, switched off: a switched-off node passes its items through.
                ("transform.set", json!({}), true)
            }
        };
        by_name.insert(node_name.clone(), (id.clone(), type_id, version));
        nodes.push(FlowNode { id, type_id: type_id.to_string(), name: node_name, pos, params: mapped, settings: json!({}), disabled });
    }
    let mut connections = Vec::new();
    for (from_name, outputs) in value.get("connections").and_then(Value::as_object).into_iter().flatten() {
        let Some((from, from_type, version)) = by_name.get(from_name).cloned() else { continue };
        for (out, targets) in outputs.get("main").and_then(Value::as_array).into_iter().flatten().enumerate() {
            // n8n's "Loop Over Items" (v3) puts "done" first and "loop" second; here it is the other way.
            let out = if from_type == "logic.loop" && version >= 3.0 { 1 - out.min(1) } else { out };
            for target in targets.as_array().into_iter().flatten() {
                let Some((to, ..)) = target.get("node").and_then(Value::as_str).and_then(|n| by_name.get(n)) else { continue };
                let input = target.get("index").and_then(Value::as_u64).unwrap_or(0);
                connections.push(Connection { from: from.clone(), out: out as u8, to: to.clone(), input: input as u8 });
            }
        }
    }
    // Wires to ports a counterpart does not have (a fifth Switch output) are dropped rather than refused.
    connections.retain(|wire| {
        let outputs = nodes.iter().find(|n| n.id == wire.from).map(super::run::output_count).unwrap_or(1);
        wire.out < outputs
    });
    let spec = FlowSpec { schema: 1, nodes, connections, notes, settings: json!({}) };
    spec::validate(&spec)?;
    Ok(Converted { spec, name, unmapped })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workflow() -> Value {
        json!({
            "name": "Pedidos a Slack",
            "nodes": [
                {"id": "a1", "name": "Webhook", "type": "n8n-nodes-base.webhook", "typeVersion": 2, "position": [0, 0],
                 "parameters": {"httpMethod": "POST", "path": "pedidos", "responseMode": "lastNode"}},
                {"id": "a2", "name": "Grandes", "type": "n8n-nodes-base.if", "typeVersion": 2, "position": [200, 0],
                 "parameters": {"conditions": {"combinator": "and", "conditions": [{"leftValue": "={{ $json.body.total }}", "rightValue": 100, "operator": {"type": "number", "operation": "gt"}}]}}},
                {"id": "a3", "name": "Marcar", "type": "n8n-nodes-base.set", "typeVersion": 3.4, "position": [400, 0],
                 "parameters": {"assignments": {"assignments": [{"id": "x", "name": "grande", "value": true, "type": "boolean"}]}, "includeOtherFields": true}},
                {"id": "a4", "name": "Slack", "type": "n8n-nodes-base.slack", "typeVersion": 2, "position": [600, 0], "parameters": {"channel": "#ventas"}},
                {"id": "a5", "name": "Lotes", "type": "n8n-nodes-base.splitInBatches", "typeVersion": 3, "position": [400, 200], "parameters": {"batchSize": 5}},
                {"id": "a6", "name": "Llamar", "type": "n8n-nodes-base.httpRequest", "typeVersion": 4.2, "position": [600, 200],
                 "parameters": {"method": "POST", "url": "https://api.example.com/x", "sendBody": true, "specifyBody": "json", "jsonBody": "={{ JSON.stringify($json) }}"}},
                {"id": "a7", "name": "Nota", "type": "n8n-nodes-base.stickyNote", "position": [0, 300], "parameters": {"content": "Hola", "width": 300, "height": 100, "color": 5}},
            ],
            "connections": {
                "Webhook": {"main": [[{"node": "Grandes", "type": "main", "index": 0}]]},
                "Grandes": {"main": [[{"node": "Marcar", "type": "main", "index": 0}], [{"node": "Lotes", "type": "main", "index": 0}]]},
                "Marcar": {"main": [[{"node": "Slack", "type": "main", "index": 0}]]},
                "Lotes": {"main": [[], [{"node": "Llamar", "type": "main", "index": 0}]]},
                "Llamar": {"main": [[{"node": "Lotes", "type": "main", "index": 0}]]},
            },
        })
    }

    #[test]
    fn core_nodes_map_and_the_rest_are_kept_switched_off() {
        let value = workflow();
        assert!(is_n8n(&value));
        let converted = convert(&value).unwrap();
        assert_eq!(converted.name, "Pedidos a Slack");
        assert_eq!(converted.unmapped, vec!["Slack (n8n-nodes-base.slack)"]);
        let node = |name: &str| converted.spec.nodes.iter().find(|n| n.name == name).unwrap().clone();
        assert_eq!(node("Webhook").type_id, "trigger.webhook");
        assert_eq!(node("Webhook").params["respond"], "lastNode");
        assert_eq!(node("Grandes").params["conditions"]["conditions"][0], json!({"left": "={{ $json.body.total }}", "op": "gt", "right": "100"}));
        assert_eq!(node("Marcar").params["include"], "all");
        assert!(node("Slack").disabled);
        assert_eq!(node("Lotes").type_id, "logic.loop");
        assert_eq!(node("Llamar").params["bodyJson"], "={{ JSON.stringify($json) }}");
        assert_eq!(converted.spec.notes.len(), 1);
        assert_eq!(converted.spec.notes[0].color, "#3b82f6", "n8n's blue sticky stays blue");
        // The loop's "loop" output is its first here, n8n's second.
        let wire = converted.spec.connections.iter().find(|w| w.from == node("Lotes").id).unwrap();
        assert_eq!((wire.out, wire.to.clone()), (0, node("Llamar").id));
    }

    #[test]
    fn anything_else_is_not_n8n() {
        assert!(!is_n8n(&json!({"schema": 1, "nodes": []})));
        assert!(!is_n8n(&json!({"nodes": [{"type": "n8n-nodes-base.set"}]})), "no connections object");
    }
}
