//! The flow document: what one `flows.spec` cell holds, and the rules a saved one keeps.
//!
//! ```json
//! { "schema": 1,
//!   "nodes": [{ "id": "n1", "type": "trigger.schedule", "name": "Cada 15 min", "pos": [30, 70],
//!               "params": {}, "settings": {}, "disabled": false }],
//!   "connections": [{ "from": "n1", "out": 0, "to": "n3", "in": 0 }],
//!   "notes": [{ "id": "s1", "pos": [150, 350], "size": [250, 96], "text": "…" }],
//!   "settings": {} }
//! ```
//!
//! **Node names are unique within a flow, not only ids.** Expressions address other nodes by name —
//! `$('Pagos fallidos').item.json` — the way n8n's do, so two nodes called the same would make an
//! expression mean whichever one the evaluator met first.
//!
//! **A cycle must pass through a loop node.** Everywhere else a flow is a DAG, which is what lets
//! the engine say when a node is ready: all of its connected inputs have finished. Removing every
//! loop node and finding a cycle in what is left is exactly "a cycle that does not go through one".
//!
//! The stored text is kept as the client wrote it once it validates, rather than re-serialised from
//! these structs: a field a newer build adds (a node colour, say) must survive a save from an older
//! one instead of being dropped by a struct that does not know it.

use std::collections::{HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::catalog::{self, Family, LOOP_TYPE};

/// The document version this build writes and reads.
pub const SCHEMA: u32 = 1;

/// A bound, not a target: past this a canvas stops being something a person reads, and a pasted
/// document of that size is far more likely to be a mistake than a flow.
pub const MAX_NODES: usize = 500;

/// The longest node name. Names appear in expressions and on the canvas, both of which want short.
pub const MAX_NAME: usize = 120;

fn empty_object() -> Value {
    Value::Object(Default::default())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FlowSpec {
    pub schema: u32,
    #[serde(default)]
    pub nodes: Vec<FlowNode>,
    #[serde(default)]
    pub connections: Vec<Connection>,
    #[serde(default)]
    pub notes: Vec<StickyNote>,
    #[serde(default = "empty_object")]
    pub settings: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FlowNode {
    pub id: String,
    #[serde(rename = "type")]
    pub type_id: String,
    pub name: String,
    pub pos: [f64; 2],
    #[serde(default = "empty_object")]
    pub params: Value,
    #[serde(default = "empty_object")]
    pub settings: Value,
    #[serde(default)]
    pub disabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Connection {
    pub from: String,
    #[serde(default)]
    pub out: u8,
    pub to: String,
    #[serde(rename = "in", default)]
    pub input: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StickyNote {
    pub id: String,
    pub pos: [f64; 2],
    pub size: [f64; 2],
    #[serde(default)]
    pub text: String,
    /// `#rrggbb` from the app's palette; empty is the default yellow. Only the canvas reads it.
    #[serde(default, deserialize_with = "lenient_text", skip_serializing_if = "String::is_empty")]
    pub color: String,
}

/// A value that should be text and is not (a newer build's, a hand edit) reads as empty instead of
/// failing the whole document over a note's colour.
fn lenient_text<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    Ok(match Value::deserialize(deserializer)? {
        Value::String(text) => text,
        _ => String::new(),
    })
}

/// The spec a new flow starts with.
pub fn empty() -> FlowSpec {
    FlowSpec { schema: SCHEMA, nodes: vec![], connections: vec![], notes: vec![], settings: empty_object() }
}

/// [`empty`], as the text a row stores.
pub fn empty_text() -> String {
    serde_json::to_string(&empty()).unwrap_or_else(|_| format!("{{\"schema\":{SCHEMA}}}"))
}

/// Reads and validates a stored or submitted document. The error starts with a code the frontend
/// can branch on (`invalid-spec:`, `newer-spec:`); the rest is the sentence a log wants.
pub fn parse(text: &str) -> Result<FlowSpec, String> {
    let spec: FlowSpec = serde_json::from_str(text).map_err(|e| format!("invalid-spec: {e}"))?;
    validate(&spec)?;
    Ok(spec)
}

pub fn validate(spec: &FlowSpec) -> Result<(), String> {
    let invalid = |detail: String| Err(format!("invalid-spec: {detail}"));
    if spec.schema > SCHEMA {
        return Err(format!(
            "newer-spec: this flow was saved by a newer CodeFlow (schema {}, this build reads {SCHEMA})",
            spec.schema
        ));
    }
    if spec.schema == 0 {
        return invalid("schema 0".into());
    }
    if spec.nodes.len() > MAX_NODES {
        return invalid(format!("{} nodes, the limit is {MAX_NODES}", spec.nodes.len()));
    }

    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    let mut nodes: HashMap<&str, &catalog::NodeDescriptor> = HashMap::new();
    // Ports per node — a Merge's inputs and a Switch's outputs are settings — the error port
    // included when a node routes its failures there.
    let mut outputs: HashMap<&str, u8> = HashMap::new();
    let mut inputs: HashMap<&str, u8> = HashMap::new();
    for node in &spec.nodes {
        if node.id.trim().is_empty() {
            return invalid("a node without an id".into());
        }
        if !ids.insert(node.id.as_str()) {
            return invalid(format!("two nodes share the id {}", node.id));
        }
        let name = node.name.trim();
        if name.is_empty() {
            return invalid(format!("node {} has no name", node.id));
        }
        if name.chars().count() > MAX_NAME {
            return invalid(format!("node {} has a name longer than {MAX_NAME} characters", node.id));
        }
        if !names.insert(name) {
            return invalid(format!("two nodes are called {name}"));
        }
        if !node.pos.iter().all(|v| v.is_finite()) {
            return invalid(format!("node {} has no position", node.id));
        }
        let Some(descriptor) = catalog::find(&node.type_id) else {
            return invalid(format!("node {} has an unknown type {}", node.id, node.type_id));
        };
        nodes.insert(node.id.as_str(), descriptor);
        outputs.insert(node.id.as_str(), super::run::output_count(node));
        inputs.insert(node.id.as_str(), catalog::input_count(&node.type_id, &node.params));
    }

    let mut wires = HashSet::new();
    for wire in &spec.connections {
        let (Some(from), Some(to)) = (nodes.get(wire.from.as_str()), nodes.get(wire.to.as_str())) else {
            return invalid(format!("a connection from {} to {} names a missing node", wire.from, wire.to));
        };
        if wire.from == wire.to {
            return invalid(format!("node {} is connected to itself", wire.from));
        }
        if wire.out >= outputs.get(wire.from.as_str()).copied().unwrap_or(from.outputs) {
            return invalid(format!("{} has no output {}", wire.from, wire.out));
        }
        if wire.input >= inputs.get(wire.to.as_str()).copied().unwrap_or(to.inputs) {
            return invalid(format!("{} has no input {}", wire.to, wire.input));
        }
        if !wires.insert((wire.from.as_str(), wire.out, wire.to.as_str(), wire.input)) {
            return invalid(format!("{} → {} is connected twice", wire.from, wire.to));
        }
    }

    let mut note_ids = HashSet::new();
    for note in &spec.notes {
        if note.id.trim().is_empty() || !note_ids.insert(note.id.as_str()) {
            return invalid("a sticky note without a unique id".into());
        }
        let finite = note.pos.iter().chain(note.size.iter()).all(|v| v.is_finite());
        if !finite || note.size[0] <= 0.0 || note.size[1] <= 0.0 {
            return invalid(format!("sticky note {} has no size", note.id));
        }
    }

    if has_cycle_outside_loops(spec, &nodes) {
        return invalid("a cycle that does not pass through a loop node".into());
    }
    Ok(())
}

/// Kahn's algorithm over the graph with every loop node removed: whatever cannot be peeled off sits
/// on a cycle, and a cycle that survives the removal is one no loop node closes.
fn has_cycle_outside_loops(spec: &FlowSpec, nodes: &HashMap<&str, &catalog::NodeDescriptor>) -> bool {
    let kept: HashSet<&str> = nodes
        .iter()
        .filter(|(_, descriptor)| descriptor.type_id != LOOP_TYPE)
        .map(|(id, _)| *id)
        .collect();
    let mut indegree: HashMap<&str, usize> = kept.iter().map(|id| (*id, 0)).collect();
    let mut next: HashMap<&str, Vec<&str>> = HashMap::new();
    for wire in &spec.connections {
        let (from, to) = (wire.from.as_str(), wire.to.as_str());
        if kept.contains(from) && kept.contains(to) {
            next.entry(from).or_default().push(to);
            *indegree.entry(to).or_default() += 1;
        }
    }
    let mut queue: VecDeque<&str> = indegree.iter().filter(|(_, d)| **d == 0).map(|(id, _)| *id).collect();
    let mut peeled = 0;
    while let Some(id) = queue.pop_front() {
        peeled += 1;
        for to in next.get(id).map(Vec::as_slice).unwrap_or_default() {
            let degree = indegree.get_mut(to).expect("every target is kept");
            *degree -= 1;
            if *degree == 0 {
                queue.push_back(to);
            }
        }
    }
    peeled < kept.len()
}

/// The columns a row derives from its document, so the explorer can draw a flow without its spec.
#[derive(Debug, Clone, PartialEq)]
pub struct Derived {
    pub node_count: i64,
    /// The trigger types the flow starts from, in canvas order, deduplicated — the explorer draws the
    /// first one's glyph. Stored as a JSON array.
    pub trigger_types: Vec<String>,
    /// [`executable_hash`] of the document; empty when nothing in it runs code.
    pub exec_hash: String,
}

/// The node types whose parameters are code or commands — a script, a shell line, an SSH or Docker
/// command, a terminal command, a database statement, an agent's instructions. Trust is about these:
/// a flow somebody else wrote is reviewed for what it would *run*, not for its URLs or field names.
pub const EXECUTABLE_TYPES: &[&str] = &[
    "code.shell",
    "code.python",
    "code.node",
    "code.command",
    "code.script",
    "code.js",
    "code.ssh",
    "code.docker",
    "app.terminal",
    "app.agent",
    "ai.agent",
    "data.sql",
    "data.mongo",
    "data.redis",
    // Added with milestone 12 — the first two had been missing since they were built: a notebook runs
    // its cells and a shortcut / AppleScript runs whatever it says. `migrations::rehash_flow_trust`
    // carries the trust already given across the change.
    "code.notebook",
    "code.osascript",
    "code.container",
    "code.k8s",
    "ai.transform",
    "app.process",
    "net.browser",
];

/// The nodes of `spec` that run code, in id order.
pub fn executable_nodes(spec: &FlowSpec) -> Vec<&FlowNode> {
    let mut nodes: Vec<&FlowNode> = spec.nodes.iter().filter(|n| EXECUTABLE_TYPES.contains(&n.type_id.as_str())).collect();
    nodes.sort_by(|a, b| a.id.cmp(&b.id));
    nodes
}

/// A value with every object's keys in order, so two equal documents hash alike whatever order
/// their keys were written in.
fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            Value::Object(keys.into_iter().map(|key| (key.clone(), canonical(&map[key]))).collect())
        }
        Value::Array(list) => Value::Array(list.iter().map(canonical).collect()),
        other => other.clone(),
    }
}

/// SHA-256 over what the flow would run — each executable node's id, type, parameters and whether it
/// is switched off — or `""` when it runs nothing. A flow is trusted when this equals the hash the
/// user trusted; see `flow_queries` for how that hash is kept.
pub fn executable_hash(spec: &FlowSpec) -> String {
    use sha2::Digest as _;
    let nodes = executable_nodes(spec);
    if nodes.is_empty() {
        return String::new();
    }
    let document: Vec<Value> = nodes
        .iter()
        .map(|node| serde_json::json!([node.id, node.type_id, canonical(&node.params), node.disabled]))
        .collect();
    hex::encode(sha2::Sha256::digest(Value::Array(document).to_string().as_bytes()))
}

pub fn derive(spec: &FlowSpec) -> Derived {
    let mut trigger_types: Vec<String> = Vec::new();
    for node in &spec.nodes {
        let is_trigger = catalog::find(&node.type_id).is_some_and(|d| d.family == Family::Trigger);
        if is_trigger && !node.disabled && !trigger_types.contains(&node.type_id) {
            trigger_types.push(node.type_id.clone());
        }
    }
    Derived { node_count: spec.nodes.len() as i64, trigger_types, exec_hash: executable_hash(spec) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, type_id: &str, name: &str) -> FlowNode {
        FlowNode {
            id: id.into(),
            type_id: type_id.into(),
            name: name.into(),
            pos: [0.0, 0.0],
            params: empty_object(),
            settings: empty_object(),
            disabled: false,
        }
    }

    fn wire(from: &str, out: u8, to: &str, input: u8) -> Connection {
        Connection { from: from.into(), out, to: to.into(), input }
    }

    fn spec(nodes: Vec<FlowNode>, connections: Vec<Connection>) -> FlowSpec {
        FlowSpec { nodes, connections, ..empty() }
    }

    #[test]
    fn the_empty_flow_round_trips() {
        let text = empty_text();
        assert_eq!(parse(&text).unwrap(), empty());
        // The minimal document a client could send is enough.
        assert_eq!(parse(r#"{"schema":1}"#).unwrap(), empty());
    }

    #[test]
    fn a_flow_from_the_prototype_is_valid() {
        let flow = spec(
            vec![
                node("n1", "trigger.schedule", "Cada 15 min"),
                node("n2", "trigger.webhook", "Alerta de pagos"),
                node("n3", "net.http", "Pagos fallidos"),
                node("n4", "logic.if", "¿Supera el umbral?"),
                node("n5", "code.python", "Agrupar errores"),
                node("n6", "net.graphql", "Despliegues de hoy"),
                node("n8", "logic.merge", "Unir"),
                node("n9", "ai.agent", "Diagnóstico"),
            ],
            vec![
                wire("n1", 0, "n3", 0),
                wire("n2", 0, "n3", 0),
                wire("n3", 0, "n4", 0),
                wire("n4", 0, "n5", 0),
                wire("n4", 0, "n6", 0),
                wire("n5", 0, "n8", 0),
                wire("n6", 0, "n8", 1),
                wire("n8", 0, "n9", 0),
            ],
        );
        validate(&flow).unwrap();
        let derived = derive(&flow);
        assert_eq!(derived.node_count, 8);
        assert_eq!(derived.trigger_types, vec!["trigger.schedule", "trigger.webhook"]);
    }

    #[test]
    fn identity_and_names_are_unique() {
        let twins = spec(vec![node("a", "net.http", "X"), node("a", "net.http", "Y")], vec![]);
        assert!(validate(&twins).unwrap_err().contains("id a"));
        let namesakes = spec(vec![node("a", "net.http", "X"), node("b", "net.http", " X ")], vec![]);
        assert!(validate(&namesakes).unwrap_err().contains("called X"));
        let nameless = spec(vec![node("a", "net.http", "  ")], vec![]);
        assert!(validate(&nameless).is_err());
    }

    #[test]
    fn unknown_types_and_newer_documents_are_refused() {
        let unknown = spec(vec![node("a", "net.carrier-pigeon", "X")], vec![]);
        assert!(validate(&unknown).unwrap_err().starts_with("invalid-spec:"));
        let newer = FlowSpec { schema: SCHEMA + 1, ..empty() };
        assert!(validate(&newer).unwrap_err().starts_with("newer-spec:"));
    }

    #[test]
    fn connections_respect_the_ports() {
        let nodes = || vec![node("t", "trigger.manual", "T"), node("h", "net.http", "H"), node("i", "logic.if", "I")];
        // Into a trigger: it has no inputs.
        assert!(validate(&spec(nodes(), vec![wire("h", 0, "t", 0)])).is_err());
        // Out of the If's second output is fine; a third does not exist.
        assert!(validate(&spec(nodes(), vec![wire("t", 0, "i", 0), wire("i", 1, "h", 0)])).is_ok());
        assert!(validate(&spec(nodes(), vec![wire("i", 2, "h", 0)])).is_err());
        // Missing node, self loop, duplicate.
        assert!(validate(&spec(nodes(), vec![wire("t", 0, "ghost", 0)])).is_err());
        assert!(validate(&spec(nodes(), vec![wire("h", 0, "h", 0)])).is_err());
        assert!(validate(&spec(nodes(), vec![wire("t", 0, "h", 0), wire("t", 0, "h", 0)])).is_err());
        // A terminal node has no output to leave from.
        let stop = spec(vec![node("s", "logic.stop", "S"), node("h", "net.http", "H")], vec![wire("s", 0, "h", 0)]);
        assert!(validate(&stop).is_err());
    }

    #[test]
    fn only_a_loop_node_may_close_a_cycle() {
        let plain = spec(
            vec![node("a", "net.http", "A"), node("b", "transform.set", "B")],
            vec![wire("a", 0, "b", 0), wire("b", 0, "a", 0)],
        );
        assert!(validate(&plain).unwrap_err().contains("cycle"));

        let looped = spec(
            vec![node("t", "trigger.manual", "T"), node("l", LOOP_TYPE, "Lotes"), node("h", "net.http", "Cada uno")],
            vec![wire("t", 0, "l", 0), wire("l", 0, "h", 0), wire("h", 0, "l", 0)],
        );
        validate(&looped).unwrap();
    }

    #[test]
    fn sticky_notes_need_a_size() {
        let mut flow = empty();
        flow.notes.push(StickyNote { id: "s".into(), pos: [0.0, 0.0], size: [0.0, 40.0], text: String::new(), color: String::new() });
        assert!(validate(&flow).is_err());
        flow.notes[0].size = [200.0, 80.0];
        assert!(validate(&flow).is_ok());
    }

    #[test]
    fn a_note_keeps_its_colour_and_a_strange_one_does_not_break_the_flow() {
        let painted = r##"{"schema":1,"notes":[{"id":"s","pos":[0,0],"size":[200,80],"text":"","color":"#3b82f6"}]}"##;
        let flow = parse(painted).unwrap();
        assert_eq!(flow.notes[0].color, "#3b82f6");
        assert!(serde_json::to_string(&flow).unwrap().contains(r##""color":"#3b82f6""##));
        let plain = parse(r#"{"schema":1,"notes":[{"id":"s","pos":[0,0],"size":[200,80]}]}"#).unwrap();
        assert!(!serde_json::to_string(&plain).unwrap().contains("color"), "the default is not written");
        let odd = parse(r#"{"schema":1,"notes":[{"id":"s","pos":[0,0],"size":[200,80],"color":7}]}"#).unwrap();
        assert_eq!(odd.notes[0].color, "");
    }

    #[test]
    fn disabled_triggers_do_not_count_as_starters() {
        let mut off = node("t", "trigger.webhook", "W");
        off.disabled = true;
        let flow = spec(vec![off, node("m", "trigger.manual", "M")], vec![]);
        assert_eq!(derive(&flow).trigger_types, vec!["trigger.manual"]);
    }

    #[test]
    fn the_executable_hash_sees_only_what_runs() {
        let doc = |script: &str, url: &str, x: i64, key_order: bool| {
            let params = if key_order {
                serde_json::json!({"script": script, "shell": "auto"})
            } else {
                serde_json::json!({"shell": "auto", "script": script})
            };
            let text = serde_json::json!({
                "schema": 1,
                "nodes": [
                    {"id": "h", "type": "net.http", "name": "HTTP", "pos": [0, 0], "params": {"url": url}},
                    {"id": "s", "type": "code.shell", "name": "Shell", "pos": [x, 0], "params": params},
                ],
            })
            .to_string();
            executable_hash(&parse(&text).unwrap())
        };
        let base = doc("echo hola", "https://example.com/a", 0, true);
        assert_eq!(base.len(), 64);
        assert_eq!(base, doc("echo hola", "https://example.com/b", 500, false), "a URL, a position, key order: not what runs");
        assert_ne!(base, doc("echo adios", "https://example.com/a", 0, true));
        assert_eq!(executable_hash(&parse(&empty_text()).unwrap()), "");
    }
}
