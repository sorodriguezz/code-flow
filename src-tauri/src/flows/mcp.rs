//! Flows as tools for AI agents: an MCP server on the webhook port.
//!
//! A flow whose trigger is **«Herramienta de IA (MCP)»** (`trigger.tool`) is, while it is active,
//! a tool any MCP client can call — Claude Code or Codex in a terminal, the Chat, an Agente CLI
//! node in another flow. The tool's name and description are the node's; its input is the node's
//! form fields, as a JSON schema; its answer is what the flow's last node produced.
//!
//! **Streamable HTTP at `/mcp`**, answered as plain JSON (the transport allows a single JSON
//! response per request; nothing here streams), so a client is pointed at
//! `http://127.0.0.1:<port>/mcp` and needs nothing installed.
//!
//! **Every request carries the bearer token** (`token`), kept in the keychain and shown in the
//! Programación pane: a tool can run anything the flow runs, and any process on this machine can
//! reach 127.0.0.1. Only active flows are tools, and an active flow is a trusted one — the same
//! gate every other way of starting a flow passes.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::Response;
use serde_json::{json, Map, Value};
use tauri::AppHandle;

use super::form::{self, FormField};
use super::run::Item;
use super::spec::FlowNode;

const TOKEN_KEY: &str = "flows-mcp-token";
/// The newest protocol revision this server speaks; an older one a client asks for is echoed back.
const PROTOCOL: &str = "2025-06-18";
const SUPPORTED: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];
/// How long a tool call may take before the client is told it timed out (the run carries on).
const CALL_LIMIT: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Clone)]
struct ToolEntry {
    flow_id: String,
    node_id: String,
    flow_name: String,
    description: String,
    fields: Vec<FormField>,
}

static TOOLS: LazyLock<Mutex<HashMap<String, ToolEntry>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn text(params: &Value, key: &str) -> String {
    params.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string()
}

/// The tool's name: the node's own, or one made from the node's name — `[A-Za-z0-9_-]`, which is what
/// every client accepts in a tool name.
fn name_of(node: &FlowNode, params: &Value) -> Result<String, String> {
    let given = text(params, "toolName");
    let raw = if given.is_empty() { node.name.clone() } else { given };
    let cleaned: String = raw
        .trim()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c.to_ascii_lowercase() } else { '_' })
        .collect::<String>()
        .trim_matches('_')
        .to_string();
    if cleaned.is_empty() || cleaned.len() > 64 {
        return Err("the tool needs a name of letters, digits, - and _ (up to 64)".into());
    }
    Ok(cleaned)
}

/// Whether a tool node could be registered: its name free (or its own flow's).
pub fn check(flow_id: &str, node: &FlowNode, params: &Value) -> Result<(), String> {
    let name = name_of(node, params)?;
    if text(params, "toolDescription").is_empty() {
        return Err("describe what the tool does — the model chooses tools by their description".into());
    }
    let tools = TOOLS.lock().map_err(|e| e.to_string())?;
    match tools.get(&name) {
        Some(entry) if entry.flow_id != flow_id => Err(format!("another flow already offers a tool called {name}")),
        _ => Ok(()),
    }
}

/// Offers a tool node's flow as a tool. Returns the tool's name.
pub fn register(flow_id: &str, flow_name: &str, node: &FlowNode, params: &Value) -> Result<String, String> {
    check(flow_id, node, params)?;
    let name = name_of(node, params)?;
    TOOLS.lock().map_err(|e| e.to_string())?.insert(
        name.clone(),
        ToolEntry {
            flow_id: flow_id.to_string(),
            node_id: node.id.clone(),
            flow_name: flow_name.to_string(),
            description: text(params, "toolDescription"),
            fields: form::fields_of(params),
        },
    );
    Ok(name)
}

pub fn forget_flow(flow_id: &str) {
    if let Ok(mut tools) = TOOLS.lock() {
        tools.retain(|_, entry| entry.flow_id != flow_id);
    }
}

/// A form field as JSON schema.
fn schema_of(field: &FormField) -> Value {
    let mut schema = match field.kind.as_str() {
        "number" => json!({"type": "number"}),
        "boolean" => json!({"type": "boolean"}),
        "select" => json!({"type": "string", "enum": field.options}),
        "date" => json!({"type": "string", "format": "date"}),
        _ => json!({"type": "string"}),
    };
    if !field.label.trim().is_empty() {
        schema["description"] = json!(field.label);
    }
    if !field.default.is_null() && field.default != json!("") {
        schema["default"] = field.default.clone();
    }
    schema
}

pub(crate) fn input_schema(fields: &[FormField]) -> Value {
    let properties: Map<String, Value> = fields.iter().map(|f| (f.name.clone(), schema_of(f))).collect();
    let required: Vec<&str> = fields.iter().filter(|f| f.required).map(|f| f.name.as_str()).collect();
    json!({"type": "object", "properties": properties, "required": required, "additionalProperties": false})
}

/// The tools on offer, for the Programación pane and `tools/list`.
pub fn tools() -> Vec<Value> {
    let Ok(tools) = TOOLS.lock() else { return vec![] };
    let mut out: Vec<Value> = tools
        .iter()
        .map(|(name, entry)| {
            json!({
                "name": name,
                "description": entry.description,
                "inputSchema": input_schema(&entry.fields),
                "flowId": entry.flow_id,
                "flowName": entry.flow_name,
            })
        })
        .collect();
    out.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    out
}

/// The bearer token every request must carry — made on first use, kept in the keychain.
pub fn token() -> Result<String, String> {
    if let Some(token) = crate::secrets::get_secret(TOKEN_KEY)? {
        return Ok(token);
    }
    rotate()
}

/// A new token; every client configured with the old one stops being let in.
pub fn rotate() -> Result<String, String> {
    let token = format!("cf_{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
    crate::secrets::set_secret(TOKEN_KEY, &token)?;
    Ok(token)
}

pub fn url() -> String {
    format!("http://127.0.0.1:{}/mcp", super::triggers::webhook::port())
}

fn respond(status: StatusCode, value: Option<Value>) -> Response {
    let mut builder = Response::builder().status(status);
    let body = match value {
        Some(value) => {
            builder = builder.header("content-type", "application/json");
            Body::from(value.to_string())
        }
        None => Body::empty(),
    };
    builder.body(body).unwrap_or_else(|_| Response::new(Body::empty()))
}

fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// One HTTP request to `/mcp`.
pub async fn handle(app: &AppHandle, method: &Method, headers: &HeaderMap, body: &Bytes) -> Response {
    let presented = headers.get("authorization").and_then(|v| v.to_str().ok()).unwrap_or_default();
    let expected = match token() {
        Ok(token) => format!("Bearer {token}"),
        Err(_) => return respond(StatusCode::SERVICE_UNAVAILABLE, Some(json!({"error": "the token is unavailable"}))),
    };
    if !same(presented.trim().as_bytes(), expected.as_bytes()) {
        return respond(StatusCode::UNAUTHORIZED, Some(json!({"error": "a bearer token is required"})));
    }
    if method != Method::POST {
        // No server-to-client stream is offered: every answer comes back on its own request.
        return Response::builder()
            .status(StatusCode::METHOD_NOT_ALLOWED)
            .header("allow", "POST")
            .body(Body::empty())
            .unwrap_or_else(|_| Response::new(Body::empty()));
    }
    let Ok(message) = serde_json::from_slice::<Value>(body) else {
        return respond(StatusCode::BAD_REQUEST, Some(error_reply(Value::Null, -32700, "parse error")));
    };
    match message {
        Value::Array(batch) => {
            let mut replies = Vec::new();
            for one in batch {
                if let Some(reply) = answer(app, one).await {
                    replies.push(reply);
                }
            }
            if replies.is_empty() {
                respond(StatusCode::ACCEPTED, None)
            } else {
                respond(StatusCode::OK, Some(Value::Array(replies)))
            }
        }
        one => match answer(app, one).await {
            Some(reply) => respond(StatusCode::OK, Some(reply)),
            None => respond(StatusCode::ACCEPTED, None),
        },
    }
}

fn error_reply(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

fn result_reply(id: Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

/// One JSON-RPC message; `None` for a notification, which gets no answer.
async fn answer(app: &AppHandle, message: Value) -> Option<Value> {
    let id = message.get("id").cloned();
    let method = message.get("method").and_then(Value::as_str).unwrap_or_default().to_string();
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let id = id?;
    Some(match method.as_str() {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Value::as_str).unwrap_or(PROTOCOL);
            let version = if SUPPORTED.contains(&asked) { asked } else { PROTOCOL };
            result_reply(
                id,
                json!({
                    "protocolVersion": version,
                    "capabilities": {"tools": {"listChanged": false}},
                    "serverInfo": {"name": "codeflow-flujos", "version": app.package_info().version.to_string()},
                    "instructions": "Each tool runs one of the user's CodeFlow flows and answers with what its last step produced.",
                }),
            )
        }
        "ping" => result_reply(id, json!({})),
        "tools/list" => {
            let listed: Vec<Value> = tools()
                .into_iter()
                .map(|tool| json!({"name": tool["name"], "description": tool["description"], "inputSchema": tool["inputSchema"]}))
                .collect();
            result_reply(id, json!({"tools": listed}))
        }
        "tools/call" => call(app, id, &params).await,
        _ => error_reply(id, -32601, &format!("method not found: {method}")),
    })
}

/// Runs the tool's flow with the arguments as its trigger's item, and waits for it to finish.
async fn call(app: &AppHandle, id: Value, params: &Value) -> Value {
    let name = params.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
    let entry = TOOLS.lock().ok().and_then(|tools| tools.get(&name).cloned());
    let Some(entry) = entry else {
        return error_reply(id, -32602, &format!("no tool called {name}"));
    };
    let arguments = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
    let item = match form::coerce(&entry.fields, &arguments) {
        Ok(item) => item,
        Err(error) => return result_reply(id, json!({"content": [{"type": "text", "text": error}], "isError": true})),
    };
    let fired = match super::triggers::fire_with(app, &entry.flow_id, &entry.node_id, vec![Item::new(item)], None, true) {
        Ok(fired) => fired,
        Err(error) => return result_reply(id, json!({"content": [{"type": "text", "text": error}], "isError": true})),
    };
    if fired.held {
        return result_reply(id, json!({"content": [{"type": "text", "text": "The flow is already running and is set not to run twice at once."}], "isError": true}));
    }
    let Some(done) = fired.done else {
        return result_reply(id, json!({"content": [{"type": "text", "text": "The flow started."}]}));
    };
    match tokio::time::timeout(CALL_LIMIT, done).await {
        Ok(Ok(finished)) => {
            let items: Vec<Value> = finished.last_output.iter().map(|item| item.json.clone()).collect();
            if finished.status == "success" {
                let text = serde_json::to_string_pretty(&items).unwrap_or_default();
                result_reply(id, json!({"content": [{"type": "text", "text": text}], "structuredContent": {"items": items}}))
            } else {
                let error = if finished.error.is_empty() { finished.status.clone() } else { finished.error.clone() };
                result_reply(id, json!({"content": [{"type": "text", "text": format!("The flow {}: {error}", entry.flow_name)}], "isError": true}))
            }
        }
        Ok(Err(_)) => result_reply(id, json!({"content": [{"type": "text", "text": "The run ended without a result"}], "isError": true})),
        Err(_) => result_reply(id, json!({"content": [{"type": "text", "text": "The flow is taking longer than 15 minutes; it carries on in CodeFlow."}], "isError": true})),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn form_fields_become_an_input_schema() {
        let fields = form::fields_of(&json!({"fields": [
            {"name": "repo", "label": "Repositorio", "type": "text", "required": true},
            {"name": "count", "type": "number", "default": 3},
            {"name": "env", "type": "select", "options": "dev, prod"},
        ]}));
        let schema = input_schema(&fields);
        assert_eq!(schema["properties"]["repo"]["type"], "string");
        assert_eq!(schema["properties"]["repo"]["description"], "Repositorio");
        assert_eq!(schema["properties"]["count"]["type"], "number");
        assert_eq!(schema["properties"]["env"]["enum"], json!(["dev", "prod"]));
        assert_eq!(schema["required"], json!(["repo"]));
    }

    #[test]
    fn tool_names_are_what_clients_accept() {
        let node = |name: &str| FlowNode {
            id: "n1".into(),
            type_id: "trigger.tool".into(),
            name: name.into(),
            pos: [0.0, 0.0],
            params: json!({}),
            settings: json!({}),
            disabled: false,
        };
        assert_eq!(name_of(&node("Desplegar API"), &json!({})).unwrap(), "desplegar_api");
        assert_eq!(name_of(&node("x"), &json!({"toolName": "Crear-Ticket"})).unwrap(), "crear-ticket");
        assert!(name_of(&node("¿?"), &json!({})).is_err());
    }
}
