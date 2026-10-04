//! The vocabulary of a run — items, where they came from, a node's settings — and the plan: which
//! nodes a run executes, which it reads from somewhere else, and where it starts.
//!
//! **Items.** Every node takes and gives lists of items, one list per port, and an item is a JSON
//! object (`json`) plus the index of the input item it was made from (`paired`). That index is what
//! lets `$('Pedidos').item` in a later node find *the* order this row came from, not merely the
//! order at the same position — the two differ the moment a Filter or a Split sits in between.
//!
//! **Plans.** Three ways to run, each the answer to a button:
//! - *Ejecutar flujo* runs everything reachable from one trigger.
//! - *Ejecutar hasta aquí* runs only what leads to one node, from a trigger that reaches it.
//! - *Probar paso* runs one node on the input its parents produced last time (or are pinned to).
//!
//! Pinned output stands in for a node in all three: the node is not executed, its pins are what it
//! gave. That is what lets somebody design the rest of a flow without calling a slow API or a
//! schedule's real trigger on every try.

use std::collections::{HashMap, HashSet, VecDeque};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::catalog::{self, Family};
use super::spec::{FlowNode, FlowSpec};

/// One item: the JSON a node works on, and which input item it was made from.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Item {
    pub json: Value,
    /// Index into the producing node's input items (all its input ports, in order, concatenated).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paired: Option<u32>,
}

impl Item {
    pub fn new(json: Value) -> Self {
        Self { json, paired: None }
    }

    pub fn paired(json: Value, index: usize) -> Self {
        Self { json, paired: Some(index as u32) }
    }
}

/// Items per port.
pub type Ports = Vec<Vec<Item>>;

/// Where one input item came from: a node, one of its outputs, a position in that output.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Origin {
    pub node: String,
    pub output: u16,
    pub index: u32,
}

/// What a node does when it fails.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnError {
    /// The run fails here (the default).
    Stop,
    /// The node outputs one item describing the error and the run goes on.
    Continue,
    /// The failing items go out of an extra port, "error", and the rest of the run goes on.
    ErrorOutput,
}

/// A node's `settings`: the part of a node that is about running it rather than what it does.
#[derive(Debug, Clone, PartialEq)]
pub struct NodeSettings {
    pub retry_on_fail: bool,
    pub max_tries: u32,
    pub wait_between: Duration,
    /// Per attempt. `None` is no limit beyond the node's own.
    pub timeout: Option<Duration>,
    pub on_error: OnError,
    /// Only the first input item is processed.
    pub execute_once: bool,
    /// An empty output becomes one empty item, so the branch after it still runs.
    pub always_output: bool,
}

impl NodeSettings {
    pub fn read(settings: &Value) -> Self {
        let flag = |key: &str| settings.get(key).and_then(Value::as_bool).unwrap_or(false);
        let number = |key: &str| settings.get(key).and_then(Value::as_f64);
        let on_error = match settings.get("onError").and_then(Value::as_str) {
            Some("continue") => OnError::Continue,
            Some("errorOutput") => OnError::ErrorOutput,
            _ => OnError::Stop,
        };
        Self {
            retry_on_fail: flag("retryOnFail"),
            max_tries: number("maxTries").map(|n| n.clamp(1.0, 10.0) as u32).unwrap_or(3),
            wait_between: Duration::from_millis(number("waitBetweenTries").map(|n| n.clamp(0.0, 300_000.0) as u64).unwrap_or(1000)),
            timeout: number("timeoutSec").filter(|n| *n > 0.0).map(|n| Duration::from_secs_f64(n.min(86_400.0))),
            on_error,
            execute_once: flag("executeOnce"),
            always_output: flag("alwaysOutputData"),
        }
    }
}

/// How many outputs a node has on the canvas: the catalogue's, plus "error" when it routes failures
/// there. Triggers, Stop and No-op never do — nothing to route, or nowhere to route it from.
pub fn output_count(node: &FlowNode) -> u8 {
    let Some(descriptor) = catalog::find(&node.type_id) else { return 0 };
    descriptor.outputs + u8::from(has_error_output(node))
}

pub fn has_error_output(node: &FlowNode) -> bool {
    let Some(descriptor) = catalog::find(&node.type_id) else { return false };
    descriptor.family != Family::Trigger
        && !matches!(node.type_id.as_str(), "logic.stop" | "logic.noop")
        && node.settings.get("onError").and_then(Value::as_str) == Some("errorOutput")
}

// ------------------------------------------------------------------------------------------ plans

/// Which button was pressed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RunMode {
    /// Everything reachable from a trigger.
    Full,
    /// What leads to `node`, and `node`.
    UpTo { node: String },
    /// `node` alone, on its parents' last output.
    Step { node: String },
}

impl RunMode {
    pub fn label(&self) -> &'static str {
        match self {
            RunMode::Full => "manual",
            RunMode::UpTo { .. } => "partial",
            RunMode::Step { .. } => "step",
        }
    }

    pub fn target(&self) -> Option<&str> {
        match self {
            RunMode::Full => None,
            RunMode::UpTo { node } | RunMode::Step { node } => Some(node),
        }
    }
}

/// What a run will do.
#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    /// The trigger it starts from; `None` for a step run, which starts from its seeds.
    pub trigger: Option<String>,
    /// The nodes it may execute.
    pub active: HashSet<String>,
    /// Nodes whose output is already known — pinned, or reused from an earlier run — keyed by id,
    /// with whether each was pinned (as opposed to reused).
    pub seeds: HashMap<String, (Ports, bool)>,
    /// What the trigger emitted when something outside fired it — a webhook's request, a file
    /// that appeared. `None` for a run started by hand, where the trigger makes its own item.
    pub trigger_output: Option<Ports>,
}

fn is_trigger(node: &FlowNode) -> bool {
    catalog::find(&node.type_id).is_some_and(|d| d.family == Family::Trigger)
}

fn downstream(spec: &FlowSpec, from: &str) -> HashSet<String> {
    let mut seen = HashSet::from([from.to_string()]);
    let mut queue = VecDeque::from([from.to_string()]);
    while let Some(id) = queue.pop_front() {
        for wire in spec.connections.iter().filter(|w| w.from == id) {
            if seen.insert(wire.to.clone()) {
                queue.push_back(wire.to.clone());
            }
        }
    }
    seen
}

fn upstream(spec: &FlowSpec, to: &str) -> HashSet<String> {
    let mut seen = HashSet::from([to.to_string()]);
    let mut queue = VecDeque::from([to.to_string()]);
    while let Some(id) = queue.pop_front() {
        for wire in spec.connections.iter().filter(|w| w.to == id) {
            if seen.insert(wire.from.clone()) {
                queue.push_back(wire.from.clone());
            }
        }
    }
    seen
}

/// The trigger a run starts from when none was named: a manual one if there is one (it is what the
/// button means), else the first trigger on the canvas, reading left to right.
fn default_trigger<'a>(spec: &'a FlowSpec, among: Option<&HashSet<String>>) -> Option<&'a FlowNode> {
    let mut triggers: Vec<&FlowNode> = spec
        .nodes
        .iter()
        .filter(|node| is_trigger(node) && !node.disabled)
        .filter(|node| among.is_none_or(|set| set.contains(&node.id)))
        .collect();
    triggers.sort_by(|a, b| {
        let manual = |n: &FlowNode| u8::from(n.type_id != "trigger.manual");
        manual(a).cmp(&manual(b)).then(a.pos[0].total_cmp(&b.pos[0])).then(a.pos[1].total_cmp(&b.pos[1]))
    });
    triggers.first().copied()
}

/// Builds the plan for `mode`.
///
/// `pins` is every pinned node's output; `previous` is the output of nodes in the run a step should
/// read from (the newest one that covers the step's parents), and is only consulted for a step.
/// A step whose parents have no output anywhere comes back as `Err("needs-upstream")`, which the
/// caller answers by running up to the node instead.
pub fn plan(
    spec: &FlowSpec,
    mode: &RunMode,
    trigger: Option<&str>,
    pins: &HashMap<String, Ports>,
    previous: &HashMap<String, Ports>,
) -> Result<Plan, String> {
    let node = |id: &str| spec.nodes.iter().find(|n| n.id == id);
    let chosen_trigger = |among: Option<&HashSet<String>>| -> Result<String, String> {
        if let Some(id) = trigger {
            let found = node(id).ok_or_else(|| format!("No node {id} in this flow"))?;
            if !is_trigger(found) {
                return Err(format!("\"{}\" is not a trigger", found.name));
            }
            if found.disabled {
                return Err(format!("\"{}\" is disabled", found.name));
            }
            if among.is_some_and(|set| !set.contains(id)) {
                return Err(format!("\"{}\" does not lead to this node", found.name));
            }
            return Ok(id.to_string());
        }
        default_trigger(spec, among).map(|n| n.id.clone()).ok_or_else(|| "no-trigger".to_string())
    };
    // A pinned trigger is a seed like any other pinned node: its pins are what it emits.
    let seeds_for = |active: &HashSet<String>| -> HashMap<String, (Ports, bool)> {
        active.iter().filter_map(|id| pins.get(id).map(|items| (id.clone(), (items.clone(), true)))).collect()
    };

    match mode {
        RunMode::Full => {
            let start = chosen_trigger(None)?;
            let active = downstream(spec, &start);
            let seeds = seeds_for(&active);
            Ok(Plan { trigger: Some(start), active, seeds, trigger_output: None })
        }
        RunMode::UpTo { node: target } => {
            let target_node = node(target).ok_or_else(|| format!("No node {target} in this flow"))?;
            let leads = upstream(spec, target);
            if is_trigger(target_node) {
                let start = chosen_trigger(Some(&HashSet::from([target.clone()])))?;
                let active = HashSet::from([start.clone()]);
                let seeds = seeds_for(&active);
                return Ok(Plan { trigger: Some(start), active, seeds, trigger_output: None });
            }
            let start = chosen_trigger(Some(&leads))?;
            let active: HashSet<String> = downstream(spec, &start).intersection(&leads).cloned().collect();
            let seeds = seeds_for(&active);
            Ok(Plan { trigger: Some(start), active, seeds, trigger_output: None })
        }
        RunMode::Step { node: target } => {
            let target_node = node(target).ok_or_else(|| format!("No node {target} in this flow"))?;
            if is_trigger(target_node) {
                return plan(spec, &RunMode::UpTo { node: target.clone() }, Some(target), pins, previous);
            }
            let parents: HashSet<String> =
                spec.connections.iter().filter(|w| w.to == *target).map(|w| w.from.clone()).collect();
            if parents.is_empty() {
                return Err(format!("\"{}\" has nothing connected to its input", target_node.name));
            }
            let mut seeds = HashMap::new();
            for parent in &parents {
                if let Some(items) = pins.get(parent) {
                    seeds.insert(parent.clone(), (items.clone(), true));
                } else if let Some(items) = previous.get(parent) {
                    seeds.insert(parent.clone(), (items.clone(), false));
                } else {
                    return Err("needs-upstream".into());
                }
            }
            Ok(Plan { trigger: None, active: HashSet::from([target.clone()]), seeds, trigger_output: None })
        }
    }
}

/// The parents of a node — what a step run needs output from.
pub fn parents_of(spec: &FlowSpec, node: &str) -> Vec<String> {
    let mut out: Vec<String> = spec.connections.iter().filter(|w| w.to == node).map(|w| w.from.clone()).collect();
    out.sort();
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flows::spec::{Connection, FlowNode};
    use serde_json::json;

    fn node(id: &str, type_id: &str, x: f64) -> FlowNode {
        FlowNode {
            id: id.into(),
            type_id: type_id.into(),
            name: id.to_uppercase(),
            pos: [x, 0.0],
            params: json!({}),
            settings: json!({}),
            disabled: false,
        }
    }

    fn wire(from: &str, to: &str) -> Connection {
        Connection { from: from.into(), out: 0, to: to.into(), input: 0 }
    }

    /// manual → a → b → c, schedule → b; and a stray d.
    fn spec() -> FlowSpec {
        FlowSpec {
            schema: 1,
            nodes: vec![
                node("t", "trigger.manual", 0.0),
                node("s", "trigger.schedule", 0.0),
                node("a", "transform.set", 100.0),
                node("b", "transform.set", 200.0),
                node("c", "transform.set", 300.0),
                node("d", "transform.set", 300.0),
            ],
            connections: vec![wire("t", "a"), wire("a", "b"), wire("s", "b"), wire("b", "c")],
            notes: vec![],
            settings: json!({}),
        }
    }

    fn ids(set: &HashSet<String>) -> Vec<String> {
        let mut out: Vec<String> = set.iter().cloned().collect();
        out.sort();
        out
    }

    #[test]
    fn a_full_run_starts_from_the_manual_trigger_and_reaches_what_it_reaches() {
        let plan = plan(&spec(), &RunMode::Full, None, &HashMap::new(), &HashMap::new()).unwrap();
        assert_eq!(plan.trigger.as_deref(), Some("t"));
        assert_eq!(ids(&plan.active), vec!["a", "b", "c", "t"]);
        let from_schedule = super::plan(&spec(), &RunMode::Full, Some("s"), &HashMap::new(), &HashMap::new()).unwrap();
        assert_eq!(ids(&from_schedule.active), vec!["b", "c", "s"]);
    }

    #[test]
    fn up_to_runs_only_what_leads_to_the_node() {
        let plan = plan(&spec(), &RunMode::UpTo { node: "b".into() }, None, &HashMap::new(), &HashMap::new()).unwrap();
        assert_eq!(ids(&plan.active), vec!["a", "b", "t"]);
        let refused = super::plan(&spec(), &RunMode::UpTo { node: "d".into() }, None, &HashMap::new(), &HashMap::new());
        assert_eq!(refused, Err("no-trigger".into()));
    }

    #[test]
    fn pinned_nodes_are_seeds_not_work() {
        let pins = HashMap::from([("a".to_string(), vec![vec![Item::new(json!({"pinned": true}))]])]);
        let plan = plan(&spec(), &RunMode::Full, None, &pins, &HashMap::new()).unwrap();
        assert!(plan.seeds.contains_key("a"));
        assert!(plan.seeds["a"].1, "marked as pinned");
    }

    #[test]
    fn a_step_reads_its_parents_or_asks_for_upstream() {
        let previous = HashMap::from([("a".to_string(), vec![vec![Item::new(json!({"x": 1}))]])]);
        // b has two parents, a and s; only a has output.
        let missing = plan(&spec(), &RunMode::Step { node: "b".into() }, None, &HashMap::new(), &previous);
        assert_eq!(missing, Err("needs-upstream".into()));
        let previous = HashMap::from([
            ("b".to_string(), vec![vec![Item::new(json!({"x": 1}))]]),
        ]);
        let step = plan(&spec(), &RunMode::Step { node: "c".into() }, None, &HashMap::new(), &previous).unwrap();
        assert_eq!(ids(&step.active), vec!["c"]);
        assert!(step.trigger.is_none());
        assert!(!step.seeds["b"].1, "reused, not pinned");
    }

    #[test]
    fn settings_read_with_bounds() {
        let settings = NodeSettings::read(&json!({"retryOnFail": true, "maxTries": 99, "timeoutSec": 2, "onError": "errorOutput"}));
        assert!(settings.retry_on_fail);
        assert_eq!(settings.max_tries, 10);
        assert_eq!(settings.timeout, Some(Duration::from_secs(2)));
        assert_eq!(settings.on_error, OnError::ErrorOutput);
        assert_eq!(NodeSettings::read(&json!({})).on_error, OnError::Stop);
    }

    #[test]
    fn the_error_port_is_one_past_the_catalogue() {
        let mut http = node("h", "net.http", 0.0);
        assert_eq!(output_count(&http), 1);
        http.settings = json!({"onError": "errorOutput"});
        assert_eq!(output_count(&http), 2);
        let mut stop = node("x", "logic.stop", 0.0);
        stop.settings = json!({"onError": "errorOutput"});
        assert_eq!(output_count(&stop), 0);
    }
}
