//! Tool-call conformance: whether a model calls tools the way the agent needs, asked of the server
//! directly so the agent's own repairs (`written_calls`, nudges) do not hide what the model does.
//!
//! A server that lists `tools` in its capabilities says it *accepts* tools; these cases say whether
//! the model behind it picks the right one, fills nested arguments, stays quiet when no tool is
//! needed, reads a result and recovers from an error. The verdict is what
//! [`crate::model_registry`] records as the model's *verified* tool support.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::hybrid::local_llm::{self, ConverseOutcome, ConverseRequest, Endpoint};

/// One case's result.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct CaseResult {
    pub id: String,
    pub passed: bool,
    /// The call came back as a real tool call, not JSON written into the text.
    pub native: bool,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Conformance {
    pub cases: Vec<CaseResult>,
    pub passed: usize,
    pub total: usize,
    /// Several calls in one answer — reported apart: the agent works without it.
    pub parallel: bool,
}

impl Conformance {
    /// Whether the agent may rely on this model's tool calls: every case but the parallel one, at
    /// most one miss.
    pub fn verified(&self) -> bool {
        let core: Vec<&CaseResult> = self.cases.iter().filter(|c| c.id != PARALLEL).collect();
        let passed = core.iter().filter(|c| c.passed).count();
        !core.is_empty() && passed + 1 >= core.len()
    }
}

const PARALLEL: &str = "parallel-calls";

fn tool(name: &str, description: &str, parameters: Value) -> Value {
    json!({ "type": "function", "function": { "name": name, "description": description, "parameters": parameters } })
}

fn weather() -> Value {
    tool(
        "get_weather",
        "Current weather for a city.",
        json!({ "type": "object", "properties": { "city": { "type": "string" } }, "required": ["city"] }),
    )
}

fn files() -> Vec<Value> {
    vec![
        tool("read_file", "Read a file of the project.", json!({ "type": "object", "properties": { "path": { "type": "string" } }, "required": ["path"] })),
        tool("search", "Search the project's text.", json!({ "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"] })),
        tool("list_files", "List a folder of the project.", json!({ "type": "object", "properties": { "dir": { "type": "string" } }, "required": ["dir"] })),
    ]
}

fn issue() -> Value {
    tool(
        "create_issue",
        "Open an issue in the tracker.",
        json!({
            "type": "object",
            "properties": {
                "title": { "type": "string" },
                "labels": { "type": "array", "items": { "type": "string" } },
                "assignee": {
                    "type": "object",
                    "properties": { "name": { "type": "string" }, "email": { "type": "string" } },
                    "required": ["name", "email"]
                }
            },
            "required": ["title", "labels", "assignee"]
        }),
    )
}

const SYSTEM: &str = "You are an assistant with tools. Call a tool when the request needs one; otherwise answer directly.";

struct Case {
    id: &'static str,
    tools: fn() -> Vec<Value>,
    messages: fn() -> Vec<Value>,
    judge: fn(&ConverseOutcome, &[Value]) -> Result<(), String>,
}

fn user(text: &str) -> Value {
    json!({ "role": "user", "content": text })
}

fn first_call<'a>(calls: &'a [Value], name: &str) -> Option<&'a Value> {
    calls.iter().find(|c| c.get("name").and_then(Value::as_str) == Some(name))
}

fn arg<'a>(call: &'a Value, key: &str) -> Option<&'a Value> {
    call.get("arguments").and_then(|a| a.get(key))
}

fn cases() -> Vec<Case> {
    vec![
        Case {
            id: "single-call",
            tools: || vec![weather()],
            messages: || vec![user("What is the weather in Valparaíso right now?")],
            judge: |_, calls| match first_call(calls, "get_weather").and_then(|c| arg(c, "city")).and_then(Value::as_str) {
                Some(city) if city.to_lowercase().contains("valpara") => Ok(()),
                Some(city) => Err(format!("city {city}")),
                None => Err("no get_weather call".to_string()),
            },
        },
        Case {
            id: "pick-right-tool",
            tools: files,
            messages: || vec![user("Open the file src/app.ts and show me what is in it.")],
            judge: |_, calls| match first_call(calls, "read_file").and_then(|c| arg(c, "path")).and_then(Value::as_str) {
                Some(path) if path.trim_start_matches("./") == "src/app.ts" => Ok(()),
                Some(path) => Err(format!("read_file({path})")),
                None => Err(format!("called {:?} instead of read_file", calls.iter().filter_map(|c| c.get("name")).collect::<Vec<_>>())),
            },
        },
        Case {
            id: "nested-args",
            tools: || vec![issue()],
            messages: || vec![user("Open an issue titled \"Checkout returns 500\" with the labels bug and checkout, assigned to Ana Pérez (ana@example.com).")],
            judge: |_, calls| {
                let call = first_call(calls, "create_issue").ok_or("no create_issue call")?;
                let labels: Vec<String> = arg(call, "labels")
                    .and_then(Value::as_array)
                    .map(|l| l.iter().filter_map(Value::as_str).map(str::to_lowercase).collect())
                    .ok_or("labels is not an array")?;
                if !labels.iter().any(|l| l == "bug") || !labels.iter().any(|l| l == "checkout") {
                    return Err(format!("labels {labels:?}"));
                }
                match arg(call, "assignee").and_then(|a| a.get("email")).and_then(Value::as_str) {
                    Some("ana@example.com") => Ok(()),
                    other => Err(format!("assignee.email {other:?}")),
                }
            },
        },
        Case {
            id: "no-tool-needed",
            tools: || vec![weather()],
            messages: || vec![user("How much is 2 + 2? Answer with the number only.")],
            judge: |outcome, calls| {
                if !calls.is_empty() {
                    return Err("called a tool for arithmetic".to_string());
                }
                if outcome.text.contains('4') { Ok(()) } else { Err(format!("answered {:?}", outcome.text.trim())) }
            },
        },
        Case {
            id: "use-result",
            tools: || vec![weather()],
            messages: || {
                vec![
                    user("What is the weather in Lima?"),
                    json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": "call_1", "type": "function", "function": { "name": "get_weather", "arguments": "{\"city\":\"Lima\"}" } }] }),
                    json!({ "role": "tool", "tool_call_id": "call_1", "content": "{\"temp_c\": 17, \"sky\": \"overcast\"}" }),
                ]
            },
            judge: |outcome, calls| {
                if !calls.is_empty() {
                    return Err("called again instead of reading the result".to_string());
                }
                if outcome.text.contains("17") { Ok(()) } else { Err(format!("answered {:?}", super::corpus::clip(&outcome.text))) }
            },
        },
        Case {
            id: "error-recovery",
            tools: files,
            messages: || {
                vec![
                    user("Open src/app.ts."),
                    json!({ "role": "assistant", "content": "", "tool_calls": [{ "id": "call_1", "type": "function", "function": { "name": "read_file", "arguments": "{\"path\":\"src/ap.ts\"}" } }] }),
                    json!({ "role": "tool", "tool_call_id": "call_1", "content": "Error: src/ap.ts does not exist. Did you mean src/app.ts?" }),
                ]
            },
            judge: |_, calls| match first_call(calls, "read_file").and_then(|c| arg(c, "path")).and_then(Value::as_str) {
                Some(path) if path.trim_start_matches("./") == "src/app.ts" => Ok(()),
                Some(path) => Err(format!("retried with {path}")),
                None => Err("did not retry".to_string()),
            },
        },
        Case {
            id: PARALLEL,
            tools: || vec![weather()],
            messages: || vec![user("Give me the weather in Santiago and in Lima.")],
            judge: |_, calls| {
                let cities = calls.iter().filter(|c| c.get("name").and_then(Value::as_str) == Some("get_weather")).count();
                if cities >= 2 { Ok(()) } else { Err(format!("{cities} call(s) in one answer")) }
            },
        },
    ]
}

/// Tool calls the model wrote into its text instead of making them — the shape
/// `local_agent::written_calls` repairs. Counted as a pass (the agent copes) but not as native.
fn written(text: &str, tools: &[Value]) -> Vec<Value> {
    let names: Vec<&str> = tools.iter().filter_map(|t| t.pointer("/function/name").and_then(Value::as_str)).collect();
    crate::local_agent::written_calls(text, &names).1
}

/// Runs every case against `model` on `endpoint`.
pub async fn run(endpoint: &Endpoint, model: &str, num_ctx: Option<u32>, think: Option<bool>) -> Conformance {
    let mut results = Vec::new();
    for case in cases() {
        let tools = (case.tools)();
        let mut messages = vec![json!({ "role": "system", "content": SYSTEM })];
        messages.extend((case.messages)());
        let request = ConverseRequest {
            model,
            messages: &messages,
            tools: &tools,
            no_more_tools: false,
            num_ctx,
            max_tokens: 512,
            temperature: 0.0,
            keep_alive: None,
            think,
        };
        let result = match local_llm::converse(endpoint, &request, std::future::pending::<()>()).await {
            Err(error) => CaseResult { id: case.id.to_string(), passed: false, native: false, detail: error.sentence() },
            Ok(outcome) => {
                let native = !outcome.tool_calls.is_empty();
                let calls = if native { outcome.tool_calls.clone() } else { written(&outcome.text, &tools) };
                match (case.judge)(&outcome, &calls) {
                    Ok(()) => CaseResult { id: case.id.to_string(), passed: true, native: native || calls.is_empty(), detail: String::new() },
                    Err(detail) => CaseResult { id: case.id.to_string(), passed: false, native, detail },
                }
            }
        };
        results.push(result);
    }
    summarize(results)
}

pub fn summarize(cases: Vec<CaseResult>) -> Conformance {
    let parallel = cases.iter().any(|c| c.id == PARALLEL && c.passed);
    let passed = cases.iter().filter(|c| c.passed).count();
    let total = cases.len();
    Conformance { cases, passed, total, parallel }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn outcome(text: &str) -> ConverseOutcome {
        ConverseOutcome { text: text.to_string(), message: json!({}), tool_calls: Vec::new(), prompt_tokens: None, completion_tokens: None, finish: local_llm::Finish::Stop }
    }

    fn call(name: &str, arguments: Value) -> Value {
        json!({ "id": "c", "name": name, "arguments": arguments })
    }

    fn judge(id: &str) -> fn(&ConverseOutcome, &[Value]) -> Result<(), String> {
        cases().into_iter().find(|c| c.id == id).unwrap().judge
    }

    #[test]
    fn single_call_wants_the_city() {
        assert!(judge("single-call")(&outcome(""), &[call("get_weather", json!({"city": "Valparaíso"}))]).is_ok());
        assert!(judge("single-call")(&outcome(""), &[call("get_weather", json!({"city": "Lima"}))]).is_err());
        assert!(judge("single-call")(&outcome("It is sunny"), &[]).is_err());
    }

    #[test]
    fn nested_args_reads_arrays_and_objects() {
        let good = call("create_issue", json!({"title": "x", "labels": ["bug", "Checkout"], "assignee": {"name": "Ana", "email": "ana@example.com"}}));
        assert!(judge("nested-args")(&outcome(""), &[good]).is_ok());
        let flat = call("create_issue", json!({"title": "x", "labels": "bug, checkout", "assignee": "ana@example.com"}));
        assert!(judge("nested-args")(&outcome(""), &[flat]).is_err());
    }

    #[test]
    fn no_tool_and_use_result_refuse_calls() {
        assert!(judge("no-tool-needed")(&outcome("4"), &[]).is_ok());
        assert!(judge("no-tool-needed")(&outcome(""), &[call("get_weather", json!({"city": "x"}))]).is_err());
        assert!(judge("use-result")(&outcome("In Lima it is 17 °C and overcast."), &[]).is_ok());
    }

    #[test]
    fn verified_allows_one_miss_and_ignores_parallel() {
        let case = |id: &str, passed| CaseResult { id: id.to_string(), passed, native: true, detail: String::new() };
        let mut all: Vec<CaseResult> = cases().iter().map(|c| case(c.id, true)).collect();
        assert!(summarize(all.clone()).verified());
        all[0].passed = false;
        assert!(summarize(all.clone()).verified(), "one miss is tolerated");
        all[1].passed = false;
        assert!(!summarize(all.clone()).verified());
        let only_parallel_fails: Vec<CaseResult> = cases().iter().map(|c| case(c.id, c.id != PARALLEL)).collect();
        let summary = summarize(only_parallel_fails);
        assert!(summary.verified());
        assert!(!summary.parallel);
    }

    #[test]
    fn calls_written_in_text_still_count() {
        let tools = vec![weather()];
        let calls = written("<tool_call>{\"name\": \"get_weather\", \"arguments\": {\"city\": \"Valparaíso\"}}</tool_call>", &tools);
        assert!(judge("single-call")(&outcome(""), &calls).is_ok());
    }
}
