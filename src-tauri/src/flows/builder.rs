//! The AI flow builder: a flow described in words, written by a model, shown as changes to accept.
//!
//! **A proposal, never a save.** The model's answer becomes a whole flow document that has passed
//! the save gate ([`spec::validate`]) and goes back to the editor, which draws it on the canvas as
//! changes over the flow as it is — added, changed, removed — for the user to accept or discard.
//! Nothing is written here. An accepted proposal is saved by the editor *without* carrying trust:
//! a command the model wrote is not one the user wrote, so a trusted flow whose commands change
//! this way goes back to "not reviewed" (see `flow_queries::save_spec`).
//!
//! **The model is told what this build has** — every node type with its ports and parameters
//! (kind, default, options), the connectors and their fields, the flow as it stands, and the
//! workspace's credentials by id, name and kind (never a secret). **It writes ids and wires; this
//! side checks them**: what a save would refuse, plus what a save cannot know — a node type this
//! build lacks, a credential id the workspace does not have (cleared rather than guessed), a
//! parameter its type does not declare (dropped). What is wrong is read back to the model once by
//! the caller; what is still wrong after that is said, not drawn.
//!
//! **Parameters travel as a JSON string.** The answer schema has to be strict for the engines that
//! enforce one (every object closed, every key required), and a node's parameters are a different
//! object per type — so the schema says "a string holding a JSON object" and this side parses it.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::{json, Map, Value};

use super::catalog::{Family, CATALOG};
use super::params::{self, Kind, ParamSpec};
use super::spec::{self, Connection, FlowNode, FlowSpec};
use super::{connectors, schema};

/// What the editor asks for.
pub struct BuildRequest<'a> {
    /// The request, in the user's words.
    pub prompt: &'a str,
    /// The flow as it is on the canvas; `None` (or no nodes) is a flow to write from nothing.
    pub current: Option<&'a FlowSpec>,
    pub flow_name: &'a str,
    /// `es` or `en`: what names and the summary are written in.
    pub language: &'a str,
    /// What each node type does, in the app's language — the editor has these, this side does not.
    pub notes: &'a HashMap<String, String>,
    /// The workspace's credentials: `(id, name, kind)`.
    pub credentials: &'a [(String, String, String)],
}

/// A flow the model wrote, checked, with what it says it did.
#[derive(Debug, Clone, Serialize)]
pub struct Proposal {
    pub spec: FlowSpec,
    pub summary: String,
}

/// The answer the model must give — strict enough for the engines that enforce a schema.
pub fn answer_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["summary", "nodes", "connections"],
        "properties": {
            "summary": {"type": "string", "description": "One or two sentences: what the flow does now, or what changed."},
            "nodes": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["id", "type", "name", "x", "y", "params"],
                    "properties": {
                        "id": {"type": "string"},
                        "type": {"type": "string"},
                        "name": {"type": "string"},
                        "x": {"type": "number"},
                        "y": {"type": "number"},
                        "params": {"type": "string", "description": "The node's parameters as a JSON object, written as a string: \"{}\" for all defaults."}
                    }
                }
            },
            "connections": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["from", "out", "to", "in"],
                    "properties": {
                        "from": {"type": "string"},
                        "out": {"type": "integer"},
                        "to": {"type": "string"},
                        "in": {"type": "integer"}
                    }
                }
            }
        }
    })
}

/// The rules the model works by. English, whatever the app's language: the request and the names
/// it writes are in the user's language, the instructions are for the model.
pub const SYSTEM_PROMPT: &str = "You build automation flows for CodeFlow's \"Flows\" app, an n8n-like node editor. \
You answer with ONE JSON object and nothing else: no prose, no code fence.\n\n\
THE DOCUMENT\n\
- A flow is nodes and the connections between their ports. Return the WHOLE flow: every node it should have, \
the ones you keep included, with the SAME id they have now. A node you leave out is deleted.\n\
- Node ids: short, unique, lowercase (\"hook\", \"fetch\", \"notify\"). Names: unique, short, in the user's language.\n\
- Positions: left to right, about 260 px between columns and 160 px between rows; the trigger at x=0. Keep \
the position of a node you keep unless the layout really needs to change.\n\
- `params` is the node's parameters as a JSON object WRITTEN AS A STRING. Only parameters the node type \
declares; leave one out to take its default (\"{}\" takes every default). Inside it, structured values (a connector's \
`call`, conditions, assignments) are JSON objects and arrays, never strings holding JSON.\n\
- Connections go from an output port (`out`, 0-based) to an input port (`in`, 0-based). Branching nodes \
list their outputs in order (an If: 0 = yes, 1 = no). Every node but a trigger needs an incoming connection.\n\
- Start with exactly one trigger unless asked otherwise: \"trigger.manual\" when nothing says when it runs.\n\n\
VALUES\n\
- A value can be fixed or an expression. An expression is a string starting with \"=\": \
\"={{ $json.total }}\", \"=Pedido {{ $json.id }}\" — the \"=\" is required everywhere, inside conditions and connector \
fields too. Inside {{ }} is JavaScript: $json is the current item, \
$('Node name').item.json an earlier node's item, $now a Luxon DateTime, $vars the workspace variables. \
n8n's helpers work too: \"text\".extractEmail(), .toTitleCase(), .toDateTime(); list.pluck('id'), .unique(), .sum(); \
number.round(2); $jmespath($json, \"orders[?total > `100`].id\").\n\
- Code nodes (code.js) take JavaScript that returns the items: `return items.map((it) => ({ ...it.json, x: 1 }));`.\n\
- NEVER write a secret (token, password, key, webhook URL) into a parameter. A node that signs in uses a \
`credential` parameter: an id from the CREDENTIALS list, or \"\" when none fits — the user picks it later.\n\
- Pickers of other CodeFlow things (repositories, database connections, hosts, notes, agents, services, \
flows) take an id the user picks: leave them \"\".\n\
- Prefer the dedicated node over code: net.http for an API, net.connector for a service listed in CONNECTORS, \
logic.if to branch, transform.set to shape fields.\n\n\
THE SUMMARY\n\
- One or two sentences in the user's language: what the flow does, or what you changed and why.";

/// The ask that goes with the stdin of [`request_text`].
pub const ASK: &str = "Write the flow the REQUEST at the end asks for, as the JSON object described.";

/// How a parameter is filled in, in a few words.
fn kind_text(spec: &ParamSpec) -> String {
    match spec.kind {
        Kind::Text { placeholder, .. } if !placeholder.is_empty() => format!("text, e.g. {placeholder:?}"),
        Kind::Text { .. } => "text".into(),
        Kind::Code { lang } => format!("{lang} source (string)"),
        Kind::Number { .. } => "number".into(),
        Kind::Boolean => "boolean".into(),
        Kind::Select { options, .. } => format!("one of {options:?}"),
        Kind::KeyValue => "[{name, value}]".into(),
        Kind::Conditions => "{combinator: \"and\"|\"or\", ignoreCase: bool, conditions: [{left, op, right}]}; op: equals, notEquals, \
                             contains, notContains, startsWith, endsWith, regex, gt, gte, lt, lte, exists, notExists, empty, notEmpty, \
                             isTrue, isFalse, isNumber, isDate, isArray, isObject"
            .into(),
        Kind::Rules => "[{output: 0-based output, left, op, right}] (ops as in conditions)".into(),
        Kind::Assignments => "[{name, type: auto|string|number|boolean|array|object, value}]".into(),
        Kind::SortKeys => "[{field, order: asc|desc}]".into(),
        Kind::Aggregations => "[{op: count|countUnique|sum|avg|min|max|first|last|concat|list, field, as}]".into(),
        Kind::Strings => "list of strings".into(),
        Kind::Folder => "folder path".into(),
        Kind::File { placeholder, .. } => format!("file path, e.g. {placeholder:?}"),
        Kind::Credential { kinds } => format!("credential id of kind {kinds:?}, or \"\""),
        Kind::MultiSelect { options } => format!("list, any of {options:?}"),
        Kind::Engine => "{} = the automatic engine".into(),
        Kind::Engines => "[] (fallback engines)".into(),
        Kind::OutputFields => "[{name, type: string|number|integer|boolean|array|object, description, required}]".into(),
        Kind::Categories => "[{name, description}]".into(),
        Kind::Connector => "{connector, operation, fields: {name: value}} — see CONNECTORS".into(),
        Kind::ExtractRules => "[{name, selector: CSS, attribute: \"\"=text|\"html\"|an attribute name, all: bool}]".into(),
        Kind::ApiModel { purpose } => format!("model id of the provider ({purpose})"),
        Kind::FormFields => "[{name, label, type: text|longText|number|boolean|select|date, required, default, options: \"a, b\"}] \
                             — what a manual run asks for"
            .into(),
        Kind::Project
        | Kind::Flows { .. }
        | Kind::Service
        | Kind::McpServers
        | Kind::LocalModel
        | Kind::Agent
        | Kind::ChainTemplate
        | Kind::DbConnection { .. }
        | Kind::RemoteHost { .. }
        | Kind::Note
        | Kind::VaultItem
        | Kind::ApiRequest
        | Kind::ApiEnvironment => "an id the user picks: \"\"".into(),
    }
}

/// Every node type this build runs, with its ports and parameters.
pub fn catalogue_brief(notes: &HashMap<String, String>) -> String {
    let mut out = String::from("NODE TYPES\n");
    for descriptor in CATALOG {
        out.push_str(&format!("- {}", descriptor.type_id));
        if let Some(note) = notes.get(descriptor.type_id).filter(|note| !note.trim().is_empty()) {
            out.push_str(&format!(" — {}", note.trim()));
        }
        if descriptor.family == Family::Trigger {
            out.push_str(" [trigger]");
        } else if descriptor.type_id == "logic.merge" {
            out.push_str(" [inputs: as many as its `inputCount` param, 2 when unset]");
        } else if descriptor.inputs != 1 {
            out.push_str(&format!(" [inputs: {}]", descriptor.inputs));
        }
        if descriptor.type_id == "logic.switch" {
            out.push_str(" [outputs: one per case — `caseCount` param, 3 when unset — numbered 0.., then other]");
        } else if descriptor.type_id == "ai.classify" {
            out.push_str(" [outputs: 1 (the category in a field); with routing=routeBranch, one per category in order, then other when allowOther]");
        } else if !descriptor.output_labels.is_empty() {
            out.push_str(&format!(" [outputs: {}]", descriptor.output_labels.join(", ")));
        } else if descriptor.outputs == 0 {
            out.push_str(" [no output]");
        }
        out.push('\n');
        for spec in params::for_type(descriptor.type_id) {
            out.push_str(&format!("    {}: {} = {}", spec.name, kind_text(spec), spec.default));
            if let Some(show) = spec.show_if {
                out.push_str(&format!(" (only when {} is {:?}", show.param, show.values));
                if let Some(also) = spec.also_if {
                    out.push_str(&format!(" and {} is {:?}", also.param, also.values));
                }
                out.push(')');
            }
            out.push('\n');
        }
    }
    out
}

/// The connectors and what each action needs (`*` = required).
pub fn connectors_brief() -> String {
    let mut out = String::from("CONNECTORS (net.connector's `call`)\n");
    for connector in connectors::all() {
        let signs_in = match (connector.auth.as_str(), connector.auth_optional) {
            ("none", _) => "no credential".to_string(),
            (_, true) => format!("credential {:?}, optional", connector.credential_kinds()),
            _ => format!("credential {:?}", connector.credential_kinds()),
        };
        out.push_str(&format!("- {} ({signs_in})\n", connector.id));
        for operation in &connector.operations {
            let fields: Vec<String> = connector
                .fields_of(operation)
                .iter()
                .map(|field| format!("{}{}", field.name, if field.required { "*" } else { "" }))
                .collect();
            out.push_str(&format!("    {}: {{{}}} — {}\n", operation.id, fields.join(", "), operation.name.en));
        }
    }
    out
}

/// What goes on stdin: the catalogue, the credentials, the flow as it is, and the request.
pub fn request_text(request: &BuildRequest) -> String {
    let mut out = catalogue_brief(request.notes);
    out.push('\n');
    out.push_str(&connectors_brief());
    out.push_str("\nCREDENTIALS (id — name — kind)\n");
    if request.credentials.is_empty() {
        out.push_str("(none yet)\n");
    }
    for (id, name, kind) in request.credentials {
        out.push_str(&format!("- {id} — {name} — {kind}\n"));
    }
    let language = if request.language == "es" { "Spanish" } else { "English" };
    out.push_str(&format!("\nFLOW NAME: {}\nLANGUAGE FOR NAMES AND THE SUMMARY: {language}\n", request.flow_name));
    match request.current.filter(|spec| !spec.nodes.is_empty()) {
        Some(spec) => {
            let nodes: Vec<Value> = spec
                .nodes
                .iter()
                .map(|node| {
                    json!({"id": node.id, "type": node.type_id, "name": node.name, "x": node.pos[0], "y": node.pos[1],
                           "params": node.params, "disabled": node.disabled})
                })
                .collect();
            let current = json!({"nodes": nodes, "connections": spec.connections});
            out.push_str(&format!("\nTHE FLOW AS IT IS NOW (change it as asked; keep what is not mentioned)\n{current}\n"));
        }
        None => out.push_str("\nTHE FLOW IS EMPTY: write it from nothing.\n"),
    }
    out.push_str(&format!("\nREQUEST\n{}\n", request.prompt.trim()));
    out
}

/// The model's answer, checked and turned into a flow — or what is wrong with it, to be read back.
pub fn proposal(answer: &str, request: &BuildRequest) -> Result<Proposal, Vec<String>> {
    let Some(mut object) = schema::answer_object(answer) else {
        return Err(vec!["the answer is not a JSON object".into()]);
    };
    // A model that wrote the parameters as an object rather than a string meant the same thing.
    if let Some(nodes) = object.get_mut("nodes").and_then(Value::as_array_mut) {
        for node in nodes {
            if let Some(params) = node.get_mut("params").filter(|p| p.is_object()) {
                *params = Value::String(params.to_string());
            }
        }
    }
    let answer_schema = answer_schema();
    schema::prune(&mut object, &answer_schema);
    let problems = schema::validate(&object, &answer_schema);
    if !problems.is_empty() {
        return Err(problems);
    }

    let current = request.current;
    let known_credentials: Vec<&str> = request.credentials.iter().map(|(id, _, _)| id.as_str()).collect();
    let mut problems = Vec::new();
    let mut nodes = Vec::new();
    for node in object["nodes"].as_array().into_iter().flatten() {
        let text_of = |key: &str| node.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string();
        let (id, type_id, name) = (text_of("id"), text_of("type"), text_of("name"));
        if super::catalog::find(&type_id).is_none() {
            problems.push(format!("node \"{id}\" has type \"{type_id}\", which does not exist"));
            continue;
        }
        let written: Map<String, Value> = match serde_json::from_str::<Value>(&text_of("params")) {
            Ok(Value::Object(map)) => map,
            Ok(_) | Err(_) if text_of("params").is_empty() => Map::new(),
            Ok(_) => {
                problems.push(format!("the params of \"{id}\" are not a JSON object"));
                continue;
            }
            Err(error) => {
                problems.push(format!("the params of \"{id}\" are not valid JSON: {error}"));
                continue;
            }
        };
        let declared = params::for_type(&type_id);
        let mut kept = Map::new();
        for (key, value) in written {
            let Some(spec) = declared.iter().find(|spec| spec.name == key) else { continue };
            // A credential the workspace does not have is a guess: the user picks it instead.
            let value = match (spec.kind, &value) {
                (Kind::Credential { .. }, Value::String(id)) if !known_credentials.contains(&id.as_str()) => Value::String(String::new()),
                // Source code is the user's to write as it likes, braces included.
                (Kind::Code { .. }, _) => value,
                _ => marked(structured(spec, value)),
            };
            kept.insert(key, value);
        }
        let before = current.and_then(|spec| spec.nodes.iter().find(|n| n.id == id && n.type_id == type_id));
        let number = |key: &str| node.get(key).and_then(Value::as_f64).unwrap_or(0.0);
        nodes.push(FlowNode {
            id,
            type_id,
            name,
            pos: [number("x").round(), number("y").round()],
            params: Value::Object(kept),
            settings: before.map(|n| n.settings.clone()).unwrap_or_else(|| json!({})),
            disabled: before.is_some_and(|n| n.disabled),
        });
    }
    let connections: Vec<Connection> = object["connections"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|wire| Connection {
            from: wire.get("from").and_then(Value::as_str).unwrap_or_default().to_string(),
            out: wire.get("out").and_then(Value::as_u64).unwrap_or(0).min(u8::MAX as u64) as u8,
            to: wire.get("to").and_then(Value::as_str).unwrap_or_default().to_string(),
            input: wire.get("in").and_then(Value::as_u64).unwrap_or(0).min(u8::MAX as u64) as u8,
        })
        .collect();
    if nodes.is_empty() && problems.is_empty() {
        problems.push("the flow has no nodes".into());
    }
    if !problems.is_empty() {
        return Err(problems);
    }
    let spec = FlowSpec {
        schema: spec::SCHEMA,
        nodes,
        connections,
        notes: current.map(|spec| spec.notes.clone()).unwrap_or_default(),
        settings: current.map(|spec| spec.settings.clone()).unwrap_or_else(|| json!({})),
    };
    if let Err(error) = spec::validate(&spec) {
        return Err(vec![error.trim_start_matches("invalid-spec: ").to_string()]);
    }
    let summary = object.get("summary").and_then(Value::as_str).unwrap_or_default().trim().to_string();
    Ok(Proposal { spec, summary })
}

/// A structured parameter (a connector call, a condition list) that came back as a string holding
/// it — the parameters travel as a JSON string, and models then tend to encode what is inside them
/// a second time. Taken parsed when the string is that same shape; anything else (an expression,
/// plain text) is left as written.
fn structured(spec: &ParamSpec, value: Value) -> Value {
    let default: Value = serde_json::from_str(spec.default).unwrap_or(Value::Null);
    let Value::String(text) = &value else { return value };
    if !(default.is_object() || default.is_array()) {
        return value;
    }
    match serde_json::from_str::<Value>(text.trim()) {
        Ok(parsed) if parsed.is_object() == default.is_object() && parsed.is_array() == default.is_array() => parsed,
        _ => value,
    }
}

/// Strings that use an expression without saying so, marked: `{{ $json.x }}` becomes
/// `={{ $json.x }}`, as the editor does the moment `{{` is typed. Only where the braces reference
/// the expression scope (`$…`), so a Docker format string like `{{.Names}}` stays literal.
fn marked(value: Value) -> Value {
    match value {
        Value::String(text) if !text.starts_with('=') && references_scope(&text) => Value::String(format!("={text}")),
        Value::Array(list) => Value::Array(list.into_iter().map(marked).collect()),
        Value::Object(map) => Value::Object(map.into_iter().map(|(key, value)| (key, marked(value))).collect()),
        other => other,
    }
}

fn references_scope(text: &str) -> bool {
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        let Some(end) = rest[start..].find("}}") else { return false };
        if rest[start + 2..start + end].contains('$') {
            return true;
        }
        rest = &rest[start + end + 2..];
    }
    false
}

/// The second ask: the first answer and what was wrong with it.
pub fn retry_text(first: &str, problems: &[String]) -> String {
    let previous: String = first.chars().take(6_000).collect();
    format!(
        "Your previous answer could not be used:\n- {}\n\nPrevious answer:\n{previous}\n\nAnswer again with the corrected JSON object only.",
        problems.join("\n- ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request<'a>(current: Option<&'a FlowSpec>, notes: &'a HashMap<String, String>, credentials: &'a [(String, String, String)]) -> BuildRequest<'a> {
        BuildRequest { prompt: "avisa por Slack cuando llegue un pedido", current, flow_name: "Pedidos", language: "es", notes, credentials }
    }

    #[test]
    fn the_brief_covers_every_node_and_connector() {
        let notes = HashMap::from([("net.http".to_string(), "Llama a una API HTTP.".to_string())]);
        let brief = catalogue_brief(&notes);
        for descriptor in CATALOG {
            assert!(brief.contains(&format!("- {}", descriptor.type_id)), "{} missing", descriptor.type_id);
        }
        assert!(brief.contains("- net.http — Llama a una API HTTP."));
        assert!(brief.contains("- logic.if [outputs: yes, no]"));
        assert!(brief.contains("    method: one of"));
        let connectors = connectors_brief();
        assert!(connectors.contains("- discord (credential [\"webhook\"])"));
        assert!(connectors.contains("    postMessage: {channel*, text*, thread_ts}"));
        assert!(connectors.contains("    search: {site*, jql*, maxResults}"));
    }

    #[test]
    fn an_answer_becomes_a_checked_flow_keeping_what_the_editor_owns() {
        let current: FlowSpec = serde_json::from_value(json!({
            "schema": 1,
            "nodes": [{"id": "hook", "type": "trigger.webhook", "name": "Pedido", "pos": [0, 0], "params": {"hookPath": "pedidos"},
                       "settings": {"retries": 2}, "disabled": false}],
            "connections": [],
            "notes": [{"id": "n1", "pos": [0, 200], "size": [200, 80], "text": "nota"}],
            "settings": {"timezone": "America/Santiago"}
        }))
        .unwrap();
        let notes = HashMap::new();
        let credentials = vec![("cred-slack".to_string(), "Bot".to_string(), "bearer".to_string())];
        let answer = json!({
            "summary": "Avisa en #ventas cada pedido.",
            "nodes": [
                {"id": "hook", "type": "trigger.webhook", "name": "Pedido", "x": 0, "y": 0, "params": "{\"hookPath\": \"pedidos\", \"invented\": 1}"},
                {"id": "slack", "type": "net.connector", "name": "Avisar", "x": 260.4, "y": 0,
                 "params": {"call": {"connector": "slack", "operation": "postMessage", "fields": {"channel": "#ventas", "text": "={{ $json.body.id }}"}}, "credential": "cred-slack"}},
                {"id": "fetch", "type": "net.http", "name": "Cliente", "x": 520, "y": 0, "params": "{\"url\": \"https://api.example.com\", \"credential\": \"made-up\"}"}
            ],
            "connections": [{"from": "hook", "out": 0, "to": "slack", "in": 0}, {"from": "slack", "out": 0, "to": "fetch", "in": 0}]
        });
        let proposal = proposal(&answer.to_string(), &request(Some(&current), &notes, &credentials)).unwrap();
        assert_eq!(proposal.summary, "Avisa en #ventas cada pedido.");
        let doubled = json!({"summary": "", "nodes": [{"id": "s", "type": "net.connector", "name": "S", "x": 0, "y": 0,
            "params": "{\"call\": \"{\\\"connector\\\":\\\"slack\\\",\\\"operation\\\":\\\"history\\\"}\", \"timeoutMs\": \"=5000\"}"}], "connections": []});
        let undone = super::proposal(&doubled.to_string(), &request(None, &notes, &credentials)).unwrap();
        assert_eq!(undone.spec.nodes[0].params["call"]["connector"], "slack", "a structured parameter encoded twice is read once more");
        assert_eq!(undone.spec.nodes[0].params["timeoutMs"], "=5000", "an expression stays as written");

        let unmarked = json!({"summary": "", "nodes": [
            {"id": "go", "type": "trigger.manual", "name": "Go", "x": 0, "y": 0, "params": "{}"},
            {"id": "check", "type": "logic.if", "name": "Check", "x": 260, "y": 0, "params": json!({"conditions": {"combinator": "and", "ignoreCase": false,
                "conditions": [{"left": "{{ $json.status }}", "op": "notEquals", "right": "ok"}]}}).to_string()},
            {"id": "list", "type": "code.shell", "name": "List", "x": 520, "y": 0, "params": json!({"script": "docker ps --format '{{.Names}} {{ $HOME }}'"}).to_string()},
            {"id": "say", "type": "app.notify", "name": "Say", "x": 780, "y": 0, "params": json!({"title": "Total {{ $json.total }}", "body": "{{.Names}}"}).to_string()}
        ], "connections": [{"from": "go", "out": 0, "to": "check", "in": 0}, {"from": "check", "out": 0, "to": "list", "in": 0}, {"from": "list", "out": 0, "to": "say", "in": 0}]});
        let spec = super::proposal(&unmarked.to_string(), &request(None, &notes, &credentials)).unwrap().spec;
        assert_eq!(spec.nodes[1].params["conditions"]["conditions"][0]["left"], "={{ $json.status }}", "marked as the editor would");
        assert_eq!(spec.nodes[1].params["conditions"]["conditions"][0]["right"], "ok");
        assert_eq!(spec.nodes[2].params["script"], "docker ps --format '{{.Names}} {{ $HOME }}'", "code is never touched");
        assert_eq!(spec.nodes[3].params["title"], "=Total {{ $json.total }}");
        assert_eq!(spec.nodes[3].params["body"], "{{.Names}}", "braces without the scope are text");
        let spec = &proposal.spec;
        assert_eq!(spec.nodes[0].params, json!({"hookPath": "pedidos"}), "undeclared parameters are dropped");
        assert_eq!(spec.nodes[0].settings, json!({"retries": 2}), "a kept node keeps its settings");
        assert_eq!(spec.nodes[1].pos, [260.0, 0.0]);
        assert_eq!(spec.nodes[1].params["credential"], "cred-slack");
        assert_eq!(spec.nodes[2].params["credential"], "", "an invented credential id is cleared");
        assert_eq!(spec.notes.len(), 1, "sticky notes are the editor's");
        assert_eq!(spec.settings["timezone"], "America/Santiago");
    }

    #[test]
    fn what_cannot_be_drawn_is_said() {
        let notes = HashMap::new();
        let none: Vec<(String, String, String)> = Vec::new();
        let problems = proposal("no tengo idea", &request(None, &notes, &none)).unwrap_err();
        assert_eq!(problems, vec!["the answer is not a JSON object"]);

        let unknown = json!({"summary": "", "nodes": [{"id": "a", "type": "net.ftp", "name": "A", "x": 0, "y": 0, "params": "{}"}], "connections": []});
        let problems = proposal(&unknown.to_string(), &request(None, &notes, &none)).unwrap_err();
        assert!(problems[0].contains("\"net.ftp\", which does not exist"), "{problems:?}");

        let dangling = json!({"summary": "", "nodes": [{"id": "a", "type": "trigger.manual", "name": "A", "x": 0, "y": 0, "params": "{}"}],
                              "connections": [{"from": "a", "out": 0, "to": "b", "in": 0}]});
        let problems = proposal(&dangling.to_string(), &request(None, &notes, &none)).unwrap_err();
        assert_eq!(problems.len(), 1, "{problems:?}");

        let missing = json!({"summary": "x", "nodes": [{"id": "a", "type": "trigger.manual"}], "connections": []});
        assert!(!proposal(&missing.to_string(), &request(None, &notes, &none)).unwrap_err().is_empty());
        assert!(retry_text("{}", &["a".into(), "b".into()]).contains("- a\n- b"));
    }

    #[test]
    fn the_request_carries_the_flow_the_credentials_and_the_language() {
        let current: FlowSpec = serde_json::from_value(json!({
            "schema": 1, "nodes": [{"id": "go", "type": "trigger.manual", "name": "Inicio", "pos": [0, 0]}], "connections": []
        }))
        .unwrap();
        let notes = HashMap::new();
        let credentials = vec![("c1".to_string(), "Jira equipo".to_string(), "basic".to_string())];
        let text = request_text(&request(Some(&current), &notes, &credentials));
        assert!(text.contains("- c1 — Jira equipo — basic"));
        assert!(text.contains("LANGUAGE FOR NAMES AND THE SUMMARY: Spanish"));
        assert!(text.contains("\"id\":\"go\""));
        assert!(text.ends_with("REQUEST\navisa por Slack cuando llegue un pedido\n"));
        let empty = request_text(&request(None, &notes, &[]));
        assert!(empty.contains("THE FLOW IS EMPTY"));
    }
}

/// A real model builds a flow and then changes it. Spends a little of a plan, so it runs only when
/// asked: `CODEFLOW_LIVE_FLOWS=claude cargo test --lib flows::builder::live -- --ignored --nocapture`.
#[cfg(test)]
mod live {
    use super::*;

    async fn ask(request: &BuildRequest<'_>) -> Proposal {
        let provider = std::env::var("CODEFLOW_LIVE_FLOWS").unwrap_or_else(|_| "claude".into());
        let provider = if provider == "1" || provider == "all" { "claude".to_string() } else { provider };
        let engine = crate::ai::engine_for(&provider);
        let binary = engine.default_binary();
        let model = if provider == "claude" { "claude-haiku-4-5-20251001" } else { "" };
        let data = request_text(request);
        let schema = answer_schema().to_string();
        let first = crate::ai::build_flow(&*engine, binary, model, SYSTEM_PROMPT, ASK, &data, &schema).await.expect("the engine answers");
        match proposal(&first, request) {
            Ok(proposal) => proposal,
            Err(problems) => {
                eprintln!("retrying after: {problems:?}");
                let again = format!("{data}\n{}", retry_text(&first, &problems));
                let second = crate::ai::build_flow(&*engine, binary, model, SYSTEM_PROMPT, ASK, &again, &schema).await.expect("the engine answers");
                proposal(&second, request).unwrap_or_else(|problems| panic!("still unusable: {problems:?}\n{second}"))
            }
        }
    }

    #[tokio::test]
    #[ignore]
    async fn a_model_builds_a_flow_and_then_changes_it() {
        if std::env::var("CODEFLOW_LIVE_FLOWS").is_err() {
            eprintln!("skipped: set CODEFLOW_LIVE_FLOWS");
            return;
        }
        let notes = HashMap::new();
        let credentials = vec![("cred-slack".to_string(), "Bot de ventas".to_string(), "bearer".to_string())];
        let written = ask(&BuildRequest {
            prompt: "Cada día hábil a las 9:00 consulta https://api.example.com/status; si el campo status no es \"ok\", avisa por Slack al canal #ops con el cuerpo de la respuesta.",
            current: None,
            flow_name: "Monitor",
            language: "es",
            notes: &notes,
            credentials: &credentials,
        })
        .await;
        eprintln!("{}\n{}", written.summary, serde_json::to_string_pretty(&written.spec).unwrap());
        let types: Vec<&str> = written.spec.nodes.iter().map(|node| node.type_id.as_str()).collect();
        assert!(types.contains(&"trigger.schedule"), "{types:?}");
        assert!(types.contains(&"net.http"), "{types:?}");
        let slack = written.spec.nodes.iter().find(|node| node.type_id == "net.connector").expect("a Slack connector");
        assert_eq!(slack.params["call"]["connector"], "slack");
        assert_eq!(slack.params["credential"], "cred-slack");

        let changed = ask(&BuildRequest {
            prompt: "Cambia el canal a #alertas.",
            current: Some(&written.spec),
            flow_name: "Monitor",
            language: "es",
            notes: &notes,
            credentials: &credentials,
        })
        .await;
        eprintln!("{}", changed.summary);
        let slack_after = changed.spec.nodes.iter().find(|node| node.id == slack.id).expect("the Slack node keeps its id");
        assert_eq!(slack_after.params["call"]["fields"]["channel"], "#alertas");
        assert_eq!(changed.spec.nodes.len(), written.spec.nodes.len(), "nothing else was added or dropped");
    }
}
