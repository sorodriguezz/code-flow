//! Every node a flow can contain — the one list the canvas, the palette and the validator read.
//!
//! **A node's `type_id` is written into every saved flow**, so it is an identifier and not a
//! label: renaming one orphans every flow that uses it. Names and descriptions live in the
//! translations (`flows.node.<type_id>` and `flows.nodeDesc.<type_id>`), the glyph is a lucide name
//! the frontend maps, and what this file owns is the *shape* — how many ports a node has and what
//! the branching ones are called — because that is what makes a connection legal.
//!
//! The descriptors carry no parameters yet. Parameters arrive with the milestone that makes a node
//! run (`milestone`), and they will be declared here too, so the editor and the engine read one
//! definition.

use serde::Serialize;

/// The palette's nine sections. Serialised lowercase, which is also how the frontend names them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Family {
    Trigger,
    Ai,
    Code,
    Net,
    Data,
    Logic,
    Transform,
    Files,
    App,
}

#[cfg(test)]
impl Family {
    /// The prefix every `type_id` in the family starts with — what the tests hold the ids to.
    fn prefix(self) -> &'static str {
        match self {
            Family::Trigger => "trigger.",
            Family::Ai => "ai.",
            Family::Code => "code.",
            Family::Net => "net.",
            Family::Data => "data.",
            Family::Logic => "logic.",
            Family::Transform => "transform.",
            Family::Files => "files.",
            Family::App => "app.",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeDescriptor {
    pub type_id: &'static str,
    pub family: Family,
    /// A lucide icon name, kebab-case. The frontend owns the mapping to a component.
    pub icon: &'static str,
    /// How many ports a connection may arrive at. Zero for a trigger: nothing starts a starter.
    pub inputs: u8,
    /// How many ports a connection may leave from. Zero for a node that ends its branch.
    pub outputs: u8,
    /// What a node with more than one input calls them; empty when there is one (or none).
    pub input_labels: &'static [&'static str],
    /// What a branching node calls its outputs — translation tokens (`flows.port.<label>`), or
    /// digits, which are shown as they are. Empty when there is a single unnamed output.
    pub output_labels: &'static [&'static str],
    /// The milestone that makes the node run (1–6). Planning information the palette shows.
    pub milestone: u8,
}

/// The node that may close a cycle. Any other loop is refused when a flow is saved.
pub const LOOP_TYPE: &str = "logic.loop";

/// The last milestone whose nodes this build runs. A node from a later one can be drawn and saved,
/// and the engine says which milestone brings it when a run reaches it.
pub const RUNS_THROUGH: u8 = 3;

const fn node(type_id: &'static str, family: Family, icon: &'static str, milestone: u8) -> NodeDescriptor {
    let inputs = if matches!(family, Family::Trigger) { 0 } else { 1 };
    NodeDescriptor {
        type_id,
        family,
        icon,
        inputs,
        outputs: 1,
        input_labels: &[],
        output_labels: &[],
        milestone,
    }
}

/// A node with named outputs — the count is the labels'.
const fn branching(
    type_id: &'static str,
    family: Family,
    icon: &'static str,
    output_labels: &'static [&'static str],
    milestone: u8,
) -> NodeDescriptor {
    NodeDescriptor {
        type_id,
        family,
        icon,
        inputs: 1,
        outputs: output_labels.len() as u8,
        input_labels: &[],
        output_labels,
        milestone,
    }
}

/// A node that ends its branch: it takes data and passes nothing on.
const fn terminal(type_id: &'static str, family: Family, icon: &'static str, milestone: u8) -> NodeDescriptor {
    NodeDescriptor {
        type_id,
        family,
        icon,
        inputs: 1,
        outputs: 0,
        input_labels: &[],
        output_labels: &[],
        milestone,
    }
}

use Family::*;

/// In palette order: family by family, the common case first within each.
pub const CATALOG: &[NodeDescriptor] = &[
    // Triggers — what starts a run. No inputs.
    node("trigger.manual", Trigger, "mouse-pointer-click", 1),
    node("trigger.schedule", Trigger, "alarm-clock", 2),
    node("trigger.webhook", Trigger, "webhook", 2),
    node("trigger.file", Trigger, "folder-open", 2),
    node("trigger.repo", Trigger, "git-commit-horizontal", 2),
    node("trigger.pr", Trigger, "git-pull-request", 2),
    node("trigger.pipeline", Trigger, "activity", 2),
    node("trigger.app", Trigger, "layers", 2),
    node("trigger.listen", Trigger, "radio-tower", 4),
    node("trigger.hotkey", Trigger, "keyboard", 2),
    node("trigger.subflow", Trigger, "route", 2),
    node("trigger.error", Trigger, "triangle-alert", 2),
    node("trigger.phone", Trigger, "smartphone", 5),
    // AI — subscription CLIs and local models.
    node("ai.agent", Ai, "bot", 3),
    node("ai.local", Ai, "cpu", 3),
    node("ai.classify", Ai, "list-checks", 3),
    node("ai.extract", Ai, "file-braces", 3),
    node("ai.summarize", Ai, "message-square-text", 3),
    node("ai.review", Ai, "eye", 3),
    node("ai.commit", Ai, "pencil", 3),
    // Code — processes and the embedded JavaScript sandbox.
    node("code.shell", Code, "square-terminal", 1),
    node("code.python", Code, "file-code", 1),
    node("code.node", Code, "code-xml", 1),
    node("code.js", Code, "square-function", 1),
    node("code.command", Code, "terminal", 1),
    node("code.script", Code, "folder-git-2", 1),
    node("code.docker", Code, "container", 4),
    node("code.ssh", Code, "server", 4),
    node("code.service", Code, "circle-play", 2),
    node("code.notebook", Code, "notebook-pen", 6),
    // Network — the API client's transports.
    node("net.http", Net, "globe", 1),
    node("net.graphql", Net, "braces", 4),
    node("net.websocket", Net, "cable", 4),
    node("net.socketio", Net, "plug", 4),
    node("net.grpc", Net, "network", 4),
    node("net.mqtt", Net, "radio", 4),
    node("net.sse", Net, "rss", 4),
    node("net.respond", Net, "arrow-right", 2),
    node("net.download", Net, "download", 4),
    node("net.transfer", Net, "hard-drive", 4),
    node("net.storage", Net, "cloud-upload", 4),
    node("net.email", Net, "mail", 4),
    // Data — the database workspace's connections, and the flow's own memory.
    node("data.sql", Data, "database", 4),
    node("data.mongo", Data, "boxes", 4),
    node("data.redis", Data, "box", 4),
    node("data.sheet", Data, "file-spreadsheet", 4),
    node("data.state", Data, "archive", 1),
    node("data.vars", Data, "variable", 1),
    // Logic — branching, joining, waiting.
    branching("logic.if", Logic, "split", &["yes", "no"], 1),
    branching("logic.switch", Logic, "git-fork", &["1", "2", "3", "other"], 1),
    NodeDescriptor {
        type_id: "logic.merge",
        family: Logic,
        icon: "merge",
        inputs: 2,
        outputs: 1,
        input_labels: &["1", "2"],
        output_labels: &[],
        milestone: 1,
    },
    branching(LOOP_TYPE, Logic, "repeat", &["loop", "done"], 5),
    node("logic.wait", Logic, "hourglass", 1),
    branching("logic.approval", Logic, "user-check", &["approved", "rejected"], 5),
    node("logic.subflow", Logic, "link", 2),
    terminal("logic.stop", Logic, "octagon-x", 1),
    node("logic.ratelimit", Logic, "gauge", 4),
    terminal("logic.noop", Logic, "circle-dashed", 1),
    // Transform — reshaping items.
    node("transform.set", Transform, "rectangle-ellipsis", 1),
    node("transform.filter", Transform, "funnel", 1),
    node("transform.sort", Transform, "arrow-down-up", 1),
    node("transform.split", Transform, "scissors", 1),
    node("transform.aggregate", Transform, "sigma", 1),
    node("transform.dedupe", Transform, "copy", 1),
    node("transform.date", Transform, "calendar", 1),
    node("transform.text", Transform, "regex", 1),
    node("transform.convert", Transform, "shuffle", 4),
    node("transform.crypto", Transform, "key", 4),
    node("transform.compress", Transform, "file-archive", 4),
    NodeDescriptor {
        type_id: "transform.compare",
        family: Transform,
        icon: "git-compare",
        inputs: 2,
        outputs: 4,
        input_labels: &["A", "B"],
        output_labels: &["onlyA", "same", "changed", "onlyB"],
        milestone: 4,
    },
    // Files and git.
    node("files.file", Files, "file-text", 4),
    node("files.list", Files, "folder", 4),
    node("files.move", Files, "trash-2", 4),
    node("files.git", Files, "git-branch", 4),
    node("files.pr", Files, "git-pull-request", 4),
    node("files.pipeline", Files, "play", 4),
    // CodeFlow itself.
    node("app.notify", App, "bell", 1),
    node("app.note", App, "notebook-pen", 4),
    node("app.agent", App, "bot", 3),
    node("app.reviewer", App, "shield-check", 4),
    node("app.open", App, "external-link", 4),
    node("app.terminal", App, "monitor", 4),
    node("app.clipboard", App, "clipboard-list", 4),
    node("app.vault", App, "key-round", 4),
];

/// The descriptor for a type, or `None` for one this build does not know.
pub fn find(type_id: &str) -> Option<&'static NodeDescriptor> {
    CATALOG.iter().find(|descriptor| descriptor.type_id == type_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn every_type_id_is_unique_and_wears_its_family() {
        let mut seen = HashSet::new();
        for descriptor in CATALOG {
            assert!(seen.insert(descriptor.type_id), "duplicate {}", descriptor.type_id);
            assert!(
                descriptor.type_id.starts_with(descriptor.family.prefix()),
                "{} is filed under {:?}",
                descriptor.type_id,
                descriptor.family
            );
            assert!(!descriptor.icon.is_empty(), "{} has no icon", descriptor.type_id);
            assert!((1..=6).contains(&descriptor.milestone), "{} milestone", descriptor.type_id);
        }
    }

    /// The plan promises 84 nodes in nine families; the palette and the plan's catalogue are read
    /// from the same counts.
    #[test]
    fn the_catalogue_has_the_families_the_plan_lists() {
        let count = |family: Family| CATALOG.iter().filter(|d| d.family == family).count();
        assert_eq!(count(Trigger), 13);
        assert_eq!(count(Ai), 7);
        assert_eq!(count(Code), 10);
        assert_eq!(count(Net), 12);
        assert_eq!(count(Data), 6);
        assert_eq!(count(Logic), 10);
        assert_eq!(count(Transform), 12);
        assert_eq!(count(Files), 6);
        assert_eq!(count(App), 8);
        assert_eq!(CATALOG.len(), 84);
    }

    #[test]
    fn ports_agree_with_their_labels() {
        for descriptor in CATALOG {
            if descriptor.family == Trigger {
                assert_eq!(descriptor.inputs, 0, "{} is a trigger with inputs", descriptor.type_id);
            }
            if !descriptor.output_labels.is_empty() {
                assert_eq!(descriptor.output_labels.len(), descriptor.outputs as usize, "{}", descriptor.type_id);
            }
            if !descriptor.input_labels.is_empty() {
                assert_eq!(descriptor.input_labels.len(), descriptor.inputs as usize, "{}", descriptor.type_id);
            }
        }
        assert!(find(LOOP_TYPE).is_some());
        assert!(find("net.http").is_some());
        assert!(find("net.nope").is_none());
    }
}
