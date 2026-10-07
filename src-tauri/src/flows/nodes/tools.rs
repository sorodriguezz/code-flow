//! What turns one question into a conversation, for «Modelo por API» and «Modelo local»: other
//! flows as **tools** the model may call, and turns **remembered** between runs under a key.
//!
//! * **A tool is a flow.** Its «Herramienta de IA» trigger — or, failing that, its «Llamado por otro
//!   flujo» trigger — gives the name, the description and the fields the model fills in (the app
//!   reads them: `flows.tools`). A call runs the flow as a sub-run and hands back what its last node
//!   produced (`flows.callTool`). A failed call goes back to the model as an error it can act on;
//!   it fails nothing on its own.
//! * **A budget, then words.** After «Máx. llamadas» calls the model is asked once more with tools
//!   off, so a model that keeps calling ends with an answer instead of a loop.
//! * **Memory is text.** Only what was asked and what was answered is kept — never the tool chatter,
//!   which can be large and holds whatever the flows returned — in the flow's state under
//!   `ai-memory:<node>:<key>`, the last «Turnos» exchanges.
//!
//! The wire shapes differ per provider and live here as plain functions, tested without a server:
//! OpenAI-style (also every compatible server and the local ones), Anthropic, Gemini.

use std::time::Instant;

use serde_json::{json, Map, Value};

use super::{number, strings, text, NodeCtx, NodeError};
use crate::flows::engine::LogStream;

/// What a tool's answer may weigh when it goes back to the model.
const MAX_RESULT_CHARS: usize = 12_000;

#[derive(Debug, Clone, PartialEq)]
pub struct FlowTool {
    pub name: String,
    pub description: String,
    pub schema: Value,
    pub flow_id: String,
    pub node_id: String,
}

/// The node's tool flows, described by their triggers.
pub async fn flow_tools(ctx: &NodeCtx, params: &Value) -> Result<Vec<FlowTool>, NodeError> {
    let ids = strings(params, "toolFlows");
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let listed = ctx
        .run
        .host
        .app_call("flows.tools", json!({ "flowIds": ids }), ctx.cancel.clone())
        .await
        .map_err(NodeError::Failed)?;
    Ok(listed
        .as_array()
        .into_iter()
        .flatten()
        .map(|tool| FlowTool {
            name: text(tool, "name"),
            description: text(tool, "description"),
            schema: tool.get("schema").cloned().unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
            flow_id: text(tool, "flowId"),
            node_id: text(tool, "nodeId"),
        })
        .collect())
}

pub fn max_calls(params: &Value) -> usize {
    number(params, "maxToolCalls").unwrap_or(6.0).clamp(1.0, 50.0) as usize
}

/// One call the model asked for.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

/// What a call gave back, as it goes to the model.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolResult {
    pub call: ToolCall,
    pub text: String,
    pub error: bool,
}

fn cut(text: String) -> String {
    if text.chars().count() <= MAX_RESULT_CHARS {
        return text;
    }
    let mut kept: String = text.chars().take(MAX_RESULT_CHARS).collect();
    kept.push_str("\n… (cut)");
    kept
}

/// Runs one call; `log` collects what the item reports about it.
pub async fn run_call(ctx: &NodeCtx, tools: &[FlowTool], call: ToolCall, log: &mut Vec<Value>) -> ToolResult {
    let started = Instant::now();
    let Some(tool) = tools.iter().find(|tool| tool.name == call.name) else {
        let text = format!("There is no tool called {}", call.name);
        log.push(json!({ "tool": call.name, "arguments": call.arguments, "ok": false, "error": text }));
        return ToolResult { call, text, error: true };
    };
    let args = json!({ "flowId": tool.flow_id, "nodeId": tool.node_id, "arguments": call.arguments });
    let outcome = ctx.run.host.app_call("flows.callTool", args, ctx.cancel.clone()).await;
    let ms = started.elapsed().as_millis() as u64;
    match outcome {
        Ok(answer) => {
            let items = answer.get("items").cloned().unwrap_or_else(|| json!([]));
            let shown = match items.as_array().map(Vec::as_slice) {
                Some([one]) => one.clone(),
                _ => items,
            };
            ctx.log(LogStream::Info, &format!("Tool {} answered ({ms} ms)", tool.name));
            log.push(json!({ "tool": tool.name, "arguments": call.arguments, "ok": true, "durationMs": ms }));
            ToolResult { call, text: cut(serde_json::to_string(&shown).unwrap_or_default()), error: false }
        }
        Err(error) => {
            ctx.log(LogStream::Info, &format!("Tool {} failed: {error}", tool.name));
            log.push(json!({ "tool": tool.name, "arguments": call.arguments, "ok": false, "error": error, "durationMs": ms }));
            ToolResult { call, text: cut(error), error: true }
        }
    }
}

/// The answer for a call past the budget — the model is about to be asked without tools.
pub fn over_budget(call: ToolCall) -> ToolResult {
    ToolResult { call, text: "The limit of tool calls for this question was reached — answer with what you have.".into(), error: true }
}

// ------------------------------------------------------------------------------------------ memory

/// One remembered exchange's half.
#[derive(Debug, Clone, PartialEq)]
pub struct Turn {
    pub role: String,
    pub text: String,
}

/// Where this item's conversation is kept — `None` when the node remembers nothing.
pub fn memory_key(ctx: &NodeCtx, params: &Value) -> Option<String> {
    let key = text(params, "memoryKey");
    let key = key.trim();
    (!key.is_empty()).then(|| format!("ai-memory:{}:{key}", ctx.node.id))
}

pub fn recall(ctx: &NodeCtx, key: &str) -> Vec<Turn> {
    let stored = ctx.run.host.state_get(key).ok().flatten().unwrap_or(Value::Null);
    stored
        .get("turns")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|turn| {
            let role = text(turn, "role");
            let said = text(turn, "text");
            (matches!(role.as_str(), "user" | "assistant") && !said.trim().is_empty()).then_some(Turn { role, text: said })
        })
        .collect()
}

/// Adds an exchange and keeps the last `turns` of them.
pub fn remember(ctx: &NodeCtx, key: &str, mut history: Vec<Turn>, asked: &str, answered: &str, params: &Value) {
    let turns = number(params, "memoryTurns").unwrap_or(10.0).clamp(1.0, 100.0) as usize;
    history.push(Turn { role: "user".into(), text: asked.to_string() });
    history.push(Turn { role: "assistant".into(), text: answered.to_string() });
    let skip = history.len().saturating_sub(turns * 2);
    let kept: Vec<Value> = history[skip..].iter().map(|turn| json!({ "role": turn.role, "text": turn.text })).collect();
    let stored = json!({ "turns": kept, "at": chrono::Utc::now().to_rfc3339() });
    if let Err(error) = ctx.run.host.state_set(key, Some(&stored)) {
        ctx.log(LogStream::Info, &format!("The conversation could not be remembered: {error}"));
    }
}

// ------------------------------------------------------------------------------------ wire shapes

/// The conversation's first messages: the remembered turns, then the question. Anthropic needs
/// them to start with the user and alternate, so a leading answer is dropped and neighbours of the
/// same role are joined.
pub fn opening(provider: &str, history: &[Turn], prompt: &str) -> Vec<Value> {
    let mut turns: Vec<(String, String)> = Vec::new();
    for turn in history.iter().chain(std::iter::once(&Turn { role: "user".into(), text: prompt.to_string() })) {
        match turns.last_mut() {
            Some((role, said)) if *role == turn.role => {
                said.push_str("\n\n");
                said.push_str(&turn.text);
            }
            _ => turns.push((turn.role.clone(), turn.text.clone())),
        }
    }
    if turns.first().is_some_and(|(role, _)| role == "assistant") {
        turns.remove(0);
    }
    turns
        .into_iter()
        .map(|(role, said)| match provider {
            "gemini" => json!({ "role": if role == "assistant" { "model" } else { "user" }, "parts": [{ "text": said }] }),
            _ => json!({ "role": role, "content": said }),
        })
        .collect()
}

/// A JSON schema as Gemini's function declarations take it — its OpenAPI subset.
pub fn gemini_schema(schema: &Value) -> Value {
    let Value::Object(map) = schema else { return schema.clone() };
    let mut out = Map::new();
    for (key, value) in map {
        match key.as_str() {
            "type" | "description" | "required" | "enum" | "nullable" => {
                out.insert(key.clone(), value.clone());
            }
            "format" if matches!(value.as_str(), Some("date-time") | Some("enum")) => {
                out.insert(key.clone(), value.clone());
            }
            "format" => {
                let note = format!("Format: {}", value.as_str().unwrap_or_default());
                let description = match out.get("description").and_then(Value::as_str).or(map.get("description").and_then(Value::as_str)) {
                    Some(said) if !said.is_empty() => format!("{said} ({note})"),
                    _ => note,
                };
                out.insert("description".into(), json!(description));
            }
            "properties" => {
                let properties: Map<String, Value> =
                    value.as_object().into_iter().flatten().map(|(name, inner)| (name.clone(), gemini_schema(inner))).collect();
                out.insert(key.clone(), Value::Object(properties));
            }
            "items" => {
                out.insert(key.clone(), gemini_schema(value));
            }
            _ => {}
        }
    }
    // An object with no properties is refused by Gemini as a parameter list: it gets none at all.
    if out.get("type").and_then(Value::as_str) == Some("object") && out.get("properties").and_then(Value::as_object).is_some_and(Map::is_empty) {
        out.remove("properties");
        out.remove("required");
    }
    Value::Object(out)
}

/// The tools as the provider declares them.
pub fn declarations(provider: &str, tools: &[FlowTool]) -> Value {
    match provider {
        "anthropic" => Value::Array(
            tools.iter().map(|tool| json!({ "name": tool.name, "description": tool.description, "input_schema": tool.schema })).collect(),
        ),
        "gemini" => {
            let functions: Vec<Value> = tools
                .iter()
                .map(|tool| {
                    let mut declaration = json!({ "name": tool.name, "description": tool.description });
                    let parameters = gemini_schema(&tool.schema);
                    if parameters.get("properties").is_some() {
                        declaration["parameters"] = parameters;
                    }
                    declaration
                })
                .collect();
            json!([{ "functionDeclarations": functions }])
        }
        _ => Value::Array(
            tools
                .iter()
                .map(|tool| json!({ "type": "function", "function": { "name": tool.name, "description": tool.description, "parameters": tool.schema } }))
                .collect(),
        ),
    }
}

/// What one answer asks for, and the message that puts it back in the conversation.
pub fn calls_in(provider: &str, answer: &Value) -> (Vec<ToolCall>, Value) {
    match provider {
        "anthropic" => {
            let content = answer.get("content").cloned().unwrap_or_else(|| json!([]));
            let calls = content
                .as_array()
                .into_iter()
                .flatten()
                .filter(|part| part["type"] == "tool_use")
                .map(|part| ToolCall { id: text(part, "id"), name: text(part, "name"), arguments: part.get("input").cloned().unwrap_or_else(|| json!({})) })
                .collect();
            (calls, json!({ "role": "assistant", "content": content }))
        }
        "gemini" => {
            let content = answer.pointer("/candidates/0/content").cloned().unwrap_or_else(|| json!({ "role": "model", "parts": [] }));
            let calls = content
                .get("parts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|part| part.get("functionCall"))
                .enumerate()
                .map(|(index, call)| ToolCall {
                    id: call.get("id").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("call_{index}")),
                    name: text(call, "name"),
                    arguments: call.get("args").cloned().unwrap_or_else(|| json!({})),
                })
                .collect();
            (calls, content)
        }
        _ => {
            let mut message = answer.pointer("/choices/0/message").cloned().unwrap_or_else(|| json!({ "role": "assistant", "content": "" }));
            let calls: Vec<ToolCall> = message
                .get("tool_calls")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .enumerate()
                .map(|(index, call)| ToolCall {
                    id: call.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()).map(str::to_string).unwrap_or_else(|| format!("call_{index}")),
                    name: call.pointer("/function/name").and_then(Value::as_str).unwrap_or_default().to_string(),
                    arguments: match call.pointer("/function/arguments") {
                        Some(Value::String(said)) => serde_json::from_str::<Value>(said).ok().filter(Value::is_object).unwrap_or_else(|| json!({})),
                        Some(other @ Value::Object(_)) => other.clone(),
                        _ => json!({}),
                    },
                })
                .collect();
            // A server that sent no ids gets the ones made up here written into its turn: each result
            // answers an id, and that id has to be in the turn the server is shown again.
            if let Some(Value::Array(sent)) = message.get_mut("tool_calls") {
                for (entry, call) in sent.iter_mut().zip(&calls) {
                    if let Value::Object(entry) = entry {
                        if entry.get("id").and_then(Value::as_str).is_none_or(str::is_empty) {
                            entry.insert("id".into(), json!(call.id));
                        }
                    }
                }
            }
            (calls, message)
        }
    }
}

/// The calls' results, as the messages that follow the model's.
pub fn result_messages(provider: &str, results: &[ToolResult]) -> Vec<Value> {
    match provider {
        "anthropic" => vec![json!({
            "role": "user",
            "content": results
                .iter()
                .map(|result| json!({ "type": "tool_result", "tool_use_id": result.call.id, "content": result.text, "is_error": result.error }))
                .collect::<Vec<_>>(),
        })],
        "gemini" => vec![json!({
            "role": "user",
            "parts": results
                .iter()
                .map(|result| {
                    let said = serde_json::from_str::<Value>(&result.text).unwrap_or_else(|_| json!(result.text));
                    let response = if result.error { json!({ "error": said }) } else { json!({ "result": said }) };
                    let mut answer = json!({ "name": result.call.name, "response": response });
                    if !result.call.id.starts_with("call_") {
                        answer["id"] = json!(result.call.id);
                    }
                    json!({ "functionResponse": answer })
                })
                .collect::<Vec<_>>(),
        })],
        _ => results.iter().map(|result| json!({ "role": "tool", "tool_call_id": result.call.id, "content": result.text })).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool() -> FlowTool {
        FlowTool {
            name: "crear_ticket".into(),
            description: "Crea un ticket".into(),
            schema: json!({"type": "object", "properties": {"titulo": {"type": "string", "description": "Título"}, "fecha": {"type": "string", "format": "date"}},
                "required": ["titulo"], "additionalProperties": false}),
            flow_id: "f1".into(),
            node_id: "n1".into(),
        }
    }

    #[test]
    fn memory_opens_alternating_and_starting_with_the_user() {
        let history = vec![
            Turn { role: "assistant".into(), text: "¿Hola?".into() },
            Turn { role: "user".into(), text: "uno".into() },
            Turn { role: "assistant".into(), text: "dos".into() },
            Turn { role: "user".into(), text: "tres".into() },
        ];
        let messages = opening("anthropic", &history, "cuatro");
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0], json!({"role": "user", "content": "uno"}));
        assert_eq!(messages[2], json!({"role": "user", "content": "tres\n\ncuatro"}));
        let gemini = opening("gemini", &history[1..3], "tres");
        assert_eq!(gemini[1]["role"], "model");
        assert_eq!(gemini[2]["parts"][0]["text"], "tres");
    }

    #[test]
    fn tools_are_declared_per_provider() {
        let openai = declarations("openaiApi", &[tool()]);
        assert_eq!(openai[0]["function"]["parameters"]["required"], json!(["titulo"]));
        let anthropic = declarations("anthropic", &[tool()]);
        assert_eq!(anthropic[0]["input_schema"]["type"], "object");
        let gemini = declarations("gemini", &[tool()]);
        let parameters = &gemini[0]["functionDeclarations"][0]["parameters"];
        assert!(parameters.get("additionalProperties").is_none(), "Gemini refuses it");
        assert_eq!(parameters["properties"]["fecha"]["description"], "Format: date");
        let bare = FlowTool { schema: json!({"type": "object", "properties": {}, "additionalProperties": false}), ..tool() };
        assert!(declarations("gemini", &[bare])[0]["functionDeclarations"][0].get("parameters").is_none());
    }

    #[test]
    fn calls_are_read_from_each_provider() {
        let openai = json!({"choices": [{"message": {"role": "assistant", "content": null, "tool_calls": [
            {"id": "call_a", "type": "function", "function": {"name": "crear_ticket", "arguments": "{\"titulo\":\"x\"}"}}]}}]});
        let (calls, message) = calls_in("openaiApi", &openai);
        assert_eq!(calls, vec![ToolCall { id: "call_a".into(), name: "crear_ticket".into(), arguments: json!({"titulo": "x"}) }]);
        assert_eq!(message["tool_calls"][0]["id"], "call_a");

        let anthropic = json!({"content": [{"type": "text", "text": "Voy"}, {"type": "tool_use", "id": "toolu_1", "name": "crear_ticket", "input": {"titulo": "x"}}], "stop_reason": "tool_use"});
        let (calls, message) = calls_in("anthropic", &anthropic);
        assert_eq!(calls[0].id, "toolu_1");
        assert_eq!(message["content"][1]["type"], "tool_use");

        let gemini = json!({"candidates": [{"content": {"role": "model", "parts": [{"functionCall": {"name": "crear_ticket", "args": {"titulo": "x"}}, "thoughtSignature": "abc"}]}}]});
        let (calls, message) = calls_in("gemini", &gemini);
        assert_eq!(calls[0].arguments, json!({"titulo": "x"}));
        assert_eq!(message["parts"][0]["thoughtSignature"], "abc", "the model's turn goes back as it came");
    }

    #[test]
    fn ids_made_up_for_a_server_that_sends_none_go_back_in_its_turn() {
        let answer = json!({"choices": [{"message": {"role": "assistant", "content": null, "tool_calls": [
            {"type": "function", "function": {"name": "crear_ticket", "arguments": "{}"}},
            {"id": "", "type": "function", "function": {"name": "crear_ticket", "arguments": "{}"}},
            {"id": "call_x", "type": "function", "function": {"name": "crear_ticket", "arguments": "{}"}}]}}]});
        let (calls, message) = calls_in("compatible", &answer);
        assert_eq!(calls.iter().map(|call| call.id.as_str()).collect::<Vec<_>>(), ["call_0", "call_1", "call_x"]);
        for (index, call) in calls.iter().enumerate() {
            assert_eq!(message["tool_calls"][index]["id"], call.id.as_str(), "every result's id is in the turn sent back");
        }
        let results = result_messages("compatible", &[ToolResult { call: calls[0].clone(), text: "{}".into(), error: false }]);
        assert_eq!(results[0]["tool_call_id"], message["tool_calls"][0]["id"]);
    }

    #[test]
    fn results_follow_in_each_providers_shape() {
        let result = |id: &str, error: bool| ToolResult {
            call: ToolCall { id: id.into(), name: "crear_ticket".into(), arguments: json!({}) },
            text: if error { "no".into() } else { "{\"id\":7}".into() },
            error,
        };
        let openai = result_messages("compatible", &[result("call_a", false), result("call_b", true)]);
        assert_eq!(openai.len(), 2);
        assert_eq!(openai[0], json!({"role": "tool", "tool_call_id": "call_a", "content": "{\"id\":7}"}));
        let anthropic = result_messages("anthropic", &[result("toolu_1", true)]);
        assert_eq!(anthropic[0]["content"][0]["is_error"], true);
        let gemini = result_messages("gemini", &[result("call_0", false)]);
        assert_eq!(gemini[0]["parts"][0]["functionResponse"]["response"]["result"]["id"], 7);
        assert!(gemini[0]["parts"][0]["functionResponse"].get("id").is_none(), "an id we made up is not sent");
    }
}
