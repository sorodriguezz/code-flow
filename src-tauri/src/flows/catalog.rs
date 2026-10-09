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
use serde_json::Value;

/// The palette's twelve sections. Serialised lowercase, which is also how the frontend names them.
///
/// **A family is where a node is shown, not part of its identity.** The `type_id` prefix records
/// where a node was first filed (`files.git`, `app.prList`, `ai.prReview`) and stays that way —
/// it is written into every saved flow — while the family is free to follow what the node does:
/// Git, pull requests and CI live together in [`Family::Git`] whatever their prefix says. Nothing
/// reads the prefix to decide a family; the frontend reads `family` from here.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Family {
    Trigger,
    Ai,
    Code,
    Git,
    Net,
    Messaging,
    Apps,
    Data,
    Files,
    Logic,
    Transform,
    App,
}

#[cfg(test)]
const PREFIXES: &[&str] = &["trigger.", "ai.", "code.", "net.", "data.", "logic.", "transform.", "files.", "app."];

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
    /// The milestone that makes the node run. Planning information the palette shows.
    pub milestone: u8,
    /// The sub-heading it sits under inside its family's section of the palette — a translation
    /// token (`flows.group.<group>`), unique across families. Empty in a family with no sub-headings.
    pub group: &'static str,
}

impl NodeDescriptor {
    /// Filed under a palette sub-heading.
    const fn group(mut self, group: &'static str) -> Self {
        self.group = group;
        self
    }

    /// Filed under another family than its prefix's.
    const fn shown_in(mut self, family: Family) -> Self {
        self.family = family;
        self
    }
}

/// The node that may close a cycle. Any other loop is refused when a flow is saved.
pub const LOOP_TYPE: &str = "logic.loop";

/// The last milestone whose nodes this build runs. A node from a later one can be drawn and saved,
/// and the engine says which milestone brings it when a run reaches it.
pub const RUNS_THROUGH: u8 = 12;

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
        group: "",
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
        group: "",
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
        group: "",
    }
}

use Family::*;

/// In palette order within each family — a family's sub-headings in the order their first node
/// appears, the common case first within each. The order of the families themselves is the
/// frontend's (`FAMILIES`).
pub const CATALOG: &[NodeDescriptor] = &[
    // Triggers — what starts a run. No inputs.
    node("trigger.manual", Trigger, "mouse-pointer-click", 1).group("triggerTime"),
    node("trigger.schedule", Trigger, "alarm-clock", 2).group("triggerTime"),
    node("trigger.hotkey", Trigger, "keyboard", 2).group("triggerTime"),
    node("trigger.phone", Trigger, "smartphone", 5).group("triggerTime"),
    node("trigger.link", Trigger, "link-2", 11).group("triggerTime"),
    node("trigger.context", Trigger, "menu", 12).group("triggerTime"),
    node("trigger.webhook", Trigger, "webhook", 2).group("triggerIncoming"),
    node("trigger.listen", Trigger, "radio-tower", 4).group("triggerIncoming"),
    node("trigger.bot", Trigger, "bot-message-square", 11).group("triggerIncoming"),
    node("trigger.email", Trigger, "inbox", 9).group("triggerIncoming"),
    node("trigger.feed", Trigger, "rss", 11).group("triggerIncoming"),
    node("trigger.queue", Trigger, "list-end", 11).group("triggerIncoming"),
    node("trigger.db", Trigger, "database", 11).group("triggerIncoming"),
    node("trigger.remoteFile", Trigger, "folder-sync", 11).group("triggerIncoming"),
    node("trigger.google", Trigger, "calendar-clock", 11).group("triggerIncoming"),
    node("trigger.microsoft", Trigger, "app-window", 12).group("triggerIncoming"),
    node("trigger.connector", Trigger, "blocks", 12).group("triggerIncoming"),
    node("trigger.form", Trigger, "clipboard-pen-line", 12).group("triggerIncoming"),
    node("trigger.repo", Trigger, "git-commit-horizontal", 2).group("triggerRepos"),
    node("trigger.pr", Trigger, "git-pull-request", 2).group("triggerRepos"),
    node("trigger.pipeline", Trigger, "activity", 2).group("triggerRepos"),
    node("trigger.github", Trigger, "git-merge", 9).group("triggerRepos"),
    node("trigger.package", Trigger, "package", 12).group("triggerRepos"),
    node("trigger.container", Trigger, "container", 12).group("triggerInfra"),
    node("trigger.k8s", Trigger, "ship-wheel", 12).group("triggerInfra"),
    node("trigger.logLine", Trigger, "scroll-text", 12).group("triggerInfra"),
    node("trigger.app", Trigger, "layers", 2).group("triggerLocal"),
    node("trigger.file", Trigger, "folder-open", 2).group("triggerLocal"),
    node("trigger.system", Trigger, "monitor-cog", 11).group("triggerLocal"),
    node("trigger.clipboard", Trigger, "clipboard-copy", 12).group("triggerLocal"),
    node("trigger.chat", Trigger, "message-circle", 12).group("triggerLocal"),
    node("trigger.error", Trigger, "triangle-alert", 2).group("triggerLocal"),
    node("trigger.flowDone", Trigger, "circle-check-big", 12).group("triggerLocal"),
    node("trigger.subflow", Trigger, "route", 2).group("triggerLocal"),
    node("trigger.tool", Trigger, "wrench", 11).group("triggerLocal"),
    // AI — subscription CLIs, APIs and local models.
    node("ai.agent", Ai, "bot", 3).group("aiModels"),
    node("ai.local", Ai, "cpu", 3).group("aiModels"),
    node("ai.api", Ai, "brain-circuit", 9).group("aiModels"),
    node("ai.compare", Ai, "columns-3", 12).group("aiModels"),
    node("ai.classify", Ai, "list-checks", 3).group("aiTasks"),
    node("ai.extract", Ai, "file-braces", 3).group("aiTasks"),
    node("ai.summarize", Ai, "message-square-text", 3).group("aiTasks"),
    node("ai.vision", Ai, "scan-search", 11).group("aiTasks"),
    node("ai.transcribe", Ai, "audio-lines", 11).group("aiTasks"),
    node("ai.image", Ai, "image-plus", 12).group("aiTasks"),
    node("ai.speech", Ai, "volume-2", 12).group("aiTasks"),
    branching("ai.guard", Ai, "shield-alert", &["pass", "blocked"], 12).group("aiTasks"),
    node("ai.transform", Ai, "wand-sparkles", 12).group("aiTasks"),
    node("ai.chat", Ai, "messages-square", 7).group("aiTasks"),
    node("ai.embed", Ai, "binary", 9).group("aiRag"),
    node("ai.vectors", Ai, "database-zap", 9).group("aiRag"),
    // Code — processes and the embedded JavaScript sandbox.
    node("code.shell", Code, "square-terminal", 1),
    node("code.python", Code, "file-code", 1),
    node("code.node", Code, "code-xml", 1),
    node("code.js", Code, "square-function", 1),
    node("code.command", Code, "terminal", 1),
    node("code.script", Code, "folder-git-2", 1),
    node("code.osascript", Code, "command", 11),
    node("code.notebook", Code, "notebook-pen", 6),
    node("code.docker", Code, "container", 4),
    node("code.ssh", Code, "server", 4),
    node("code.container", Code, "box", 12),
    node("code.k8s", Code, "ship-wheel", 12),
    // Git, pull requests and CI — wherever their prefix says they were first filed.
    node("files.git", Files, "git-branch", 4).shown_in(Git).group("gitRepo"),
    node("ai.commit", Ai, "pencil", 3).shown_in(Git).group("gitRepo"),
    node("ai.review", Ai, "eye", 3).shown_in(Git).group("gitRepo"),
    node("files.version", Files, "tag", 12).shown_in(Git).group("gitRepo"),
    node("app.search", App, "file-search", 12).shown_in(Git).group("gitRepo"),
    node("app.audit", App, "shield-half", 12).shown_in(Git).group("gitRepo"),
    node("app.prList", App, "git-pull-request-arrow", 10).shown_in(Git).group("gitPrs"),
    node("files.pr", Files, "git-pull-request", 4).shown_in(Git).group("gitPrs"),
    node("app.prComments", App, "message-square-reply", 10).shown_in(Git).group("gitPrs"),
    node("ai.prReview", Ai, "scan-eye", 7).shown_in(Git).group("gitPrs"),
    node("ai.prFix", Ai, "wand", 10).shown_in(Git).group("gitPrs"),
    node("ai.prReply", Ai, "reply", 10).shown_in(Git).group("gitPrs"),
    node("app.prDecide", App, "gavel", 10).shown_in(Git).group("gitPrs"),
    node("app.prMemory", App, "book-marked", 10).shown_in(Git).group("gitPrs"),
    node("files.pipeline", Files, "play", 4).shown_in(Git).group("gitCi"),
    node("app.reviewer", App, "shield-check", 4).shown_in(Git).group("gitCi"),
    // Network — the API client's transports, and the web.
    node("net.http", Net, "globe", 1).group("netApis"),
    node("net.graphql", Net, "braces", 4).group("netApis"),
    node("net.grpc", Net, "network", 4).group("netApis"),
    node("net.respond", Net, "arrow-right", 2).group("netApis"),
    node("net.soap", Net, "file-code", 12).group("netApis"),
    node("net.aws", Net, "cloud", 12).group("netApis"),
    node("net.websocket", Net, "cable", 4).group("netRealtime"),
    node("net.socketio", Net, "plug", 4).group("netRealtime"),
    node("net.sse", Net, "radio-receiver", 4).group("netRealtime"),
    node("net.webPage", Net, "scan-text", 8).group("netWeb"),
    node("net.feed", Net, "newspaper", 11).group("netWeb"),
    node("net.check", Net, "radar", 8).group("netWeb"),
    node("net.search", Net, "search", 12).group("netWeb"),
    node("net.browser", Net, "app-window-mac", 12).group("netWeb"),
    node("net.wol", Net, "power", 12).group("netWeb"),
    // Messaging — mail and brokers.
    node("net.email", Net, "mail", 4).shown_in(Messaging),
    node("net.imap", Net, "mails", 9).shown_in(Messaging),
    node("net.queue", Net, "list-end", 9).shown_in(Messaging),
    node("net.mqtt", Net, "radio", 4).shown_in(Messaging),
    // Apps — one palette entry per service (`lib/flows/paletteEntries`), not per node.
    node("net.connector", Net, "blocks", 6).shown_in(Apps),
    node("net.google", Net, "layout-grid", 9).shown_in(Apps).group("appsGoogle"),
    node("net.microsoft", Net, "app-window", 11).shown_in(Apps).group("appsMicrosoft"),
    // Data — the database workspace's connections, and the flow's own memory.
    node("data.database", Data, "table-properties", 12).group("dataDatabases"),
    node("data.sql", Data, "database", 4).group("dataDatabases"),
    node("data.mongo", Data, "boxes", 4).group("dataDatabases"),
    node("data.redis", Data, "box", 4).group("dataDatabases"),
    node("data.dbml", Data, "table-2", 7).group("dataDatabases"),
    node("data.schemaDiff", Data, "git-compare-arrows", 12).group("dataDatabases"),
    node("data.state", Data, "archive", 1).group("dataMemory"),
    node("data.vars", Data, "variable", 1).group("dataMemory"),
    node("data.table", Data, "table", 12).group("dataMemory"),
    node("data.fake", Data, "dices", 12).group("dataGenerate"),
    // Files — on this computer, documents, and elsewhere.
    node("files.file", Files, "file-text", 4).group("filesLocal"),
    node("files.list", Files, "folder", 4).group("filesLocal"),
    node("files.move", Files, "trash-2", 4).group("filesLocal"),
    node("files.pdf", Files, "file-type", 8).group("filesDocuments"),
    node("files.image", Files, "image", 8).group("filesDocuments"),
    node("files.media", Files, "film", 12).group("filesDocuments"),
    node("files.docx", Files, "file-pen", 12).group("filesDocuments"),
    node("files.ics", Files, "calendar-days", 12).group("filesDocuments"),
    node("data.sheet", Data, "file-spreadsheet", 4).shown_in(Files).group("filesDocuments"),
    node("transform.compress", Transform, "file-archive", 4).shown_in(Files).group("filesDocuments"),
    node("net.download", Net, "download", 4).shown_in(Files).group("filesRemote"),
    node("net.transfer", Net, "hard-drive", 4).shown_in(Files).group("filesRemote"),
    node("net.storage", Net, "cloud-upload", 4).shown_in(Files).group("filesRemote"),
    // Logic — branching, joining, waiting.
    branching("logic.if", Logic, "split", &["yes", "no"], 1),
    // Four ports as drawn here; how many it really has is its `outputs` setting (`output_count`).
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
        group: "",
    },
    branching(LOOP_TYPE, Logic, "repeat", &["loop", "done"], 5),
    node("logic.wait", Logic, "hourglass", 1),
    branching("logic.approval", Logic, "user-check", &["approved", "rejected"], 5),
    node("logic.subflow", Logic, "link", 2),
    terminal("logic.stop", Logic, "octagon-x", 1),
    node("logic.ratelimit", Logic, "gauge", 4),
    node("logic.until", Logic, "timer", 8),
    branching("logic.businessHours", Logic, "briefcase-business", &["inHours", "outHours"], 12),
    node("logic.assert", Logic, "badge-check", 12),
    terminal("logic.noop", Logic, "circle-dashed", 1),
    // Transform — the list of items, and the values in them.
    node("transform.set", Transform, "rectangle-ellipsis", 1).group("transformItems"),
    node("transform.filter", Transform, "funnel", 1).group("transformItems"),
    node("transform.sort", Transform, "arrow-down-up", 1).group("transformItems"),
    node("transform.split", Transform, "scissors", 1).group("transformItems"),
    node("transform.aggregate", Transform, "sigma", 1).group("transformItems"),
    node("transform.dedupe", Transform, "copy", 1).group("transformItems"),
    node("transform.limit", Transform, "list-start", 12).group("transformItems"),
    branching("transform.validate", Transform, "list-checks", &["valid", "invalid"], 12).group("transformItems"),
    NodeDescriptor {
        type_id: "transform.compare",
        family: Transform,
        icon: "git-compare",
        inputs: 2,
        outputs: 4,
        input_labels: &["A", "B"],
        output_labels: &["onlyA", "same", "changed", "onlyB"],
        milestone: 4,
        group: "transformItems",
    },
    node("transform.sql", Transform, "sheet", 8).group("transformItems"),
    branching("transform.changes", Transform, "diff", &["changed", "same"], 8).group("transformItems"),
    node("transform.date", Transform, "calendar", 1).group("transformValues"),
    node("transform.text", Transform, "regex", 1).group("transformValues"),
    node("transform.template", Transform, "scroll-text", 8).group("transformValues"),
    node("transform.json", Transform, "file-json", 8).group("transformValues"),
    node("transform.convert", Transform, "shuffle", 4).group("transformValues"),
    node("transform.crypto", Transform, "key", 4).group("transformValues"),
    node("transform.redact", Transform, "eye-off", 11).group("transformValues"),
    node("transform.number", Transform, "hash", 12).group("transformValues"),
    node("transform.chatFormat", Transform, "message-square-code", 12).group("transformValues"),
    // CodeFlow itself.
    node("app.notify", App, "bell", 1),
    node("app.say", App, "speech", 12),
    node("app.note", App, "notebook-pen", 4),
    node("app.agent", App, "bot", 3),
    node("app.open", App, "external-link", 4),
    node("app.terminal", App, "monitor", 4),
    node("app.clipboard", App, "clipboard-list", 4),
    node("app.vault", App, "key-round", 4),
    node("app.apiRequest", App, "send", 7),
    node("app.apiCollection", App, "library", 12),
    node("app.diagram", App, "workflow", 12),
    node("app.story", App, "book-open-text", 12),
    node("app.aiUsage", App, "gauge", 12),
    node("app.process", App, "activity", 12),
    node("app.runData", App, "tags", 12),
    node("code.service", Code, "circle-play", 2).shown_in(App),
];

/// Most ports a Switch or a classifier routes to, and most inputs a Merge joins. Ports are a `u8`
/// on a wire; these keep a node drawable.
pub const MAX_ROUTES: u8 = 20;
pub const MAX_MERGE_INPUTS: u8 = 10;

fn setting(params: &Value, name: &str) -> Option<f64> {
    match params.get(name)? {
        Value::Number(n) => n.as_f64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

/// How many inputs a node has with these parameters: the catalogue's, except for a Merge, which
/// joins as many as its `inputCount` says (2 when unset — every flow saved before it was a setting).
pub fn input_count(type_id: &str, params: &Value) -> u8 {
    let Some(descriptor) = find(type_id) else { return 0 };
    if type_id == "logic.merge" {
        return setting(params, "inputCount").map_or(2, |n| (n.round() as i64).clamp(2, MAX_MERGE_INPUTS as i64) as u8);
    }
    descriptor.inputs
}

/// How many outputs a node has with these parameters, the error port aside: the catalogue's,
/// except for a Switch (its `caseCount` cases plus "other" — 3 + 1 when unset, which is where every
/// flow saved before this left them) and a classifier set to route by category (one output per
/// category, plus "other" when the model may answer none of them).
pub fn output_count(type_id: &str, params: &Value) -> u8 {
    let Some(descriptor) = find(type_id) else { return 0 };
    match type_id {
        "logic.switch" => switch_cases(params) + 1,
        "ai.classify" if routes_by_category(params) => {
            let categories = category_names(params).len().clamp(1, MAX_ROUTES as usize) as u8;
            categories + u8::from(params.get("allowOther").and_then(Value::as_bool).unwrap_or(true))
        }
        _ => descriptor.outputs,
    }
}

/// A Switch's cases — its outputs before "other".
pub fn switch_cases(params: &Value) -> u8 {
    setting(params, "caseCount").map_or(3, |n| (n.round() as i64).clamp(1, MAX_ROUTES as i64) as u8)
}

/// Whether a classifier sends each item out of its category's port rather than writing the
/// category into a field.
pub fn routes_by_category(params: &Value) -> bool {
    params.get("routing").and_then(Value::as_str) == Some("routeBranch")
}

/// A classifier's category names, in order, blank ones left out.
pub fn category_names(params: &Value) -> Vec<String> {
    params
        .get("categories")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|c| c.get("name").and_then(Value::as_str))
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// The descriptor for a type, or `None` for one this build does not know.
pub fn find(type_id: &str) -> Option<&'static NodeDescriptor> {
    CATALOG.iter().find(|descriptor| descriptor.type_id == type_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn every_type_id_is_unique_and_keeps_a_known_prefix() {
        let mut seen = HashSet::new();
        for descriptor in CATALOG {
            assert!(seen.insert(descriptor.type_id), "duplicate {}", descriptor.type_id);
            // The prefix is history, not the family (see `Family`) — but it is one of the nine.
            assert!(PREFIXES.iter().any(|p| descriptor.type_id.starts_with(p)), "{} has no known prefix", descriptor.type_id);
            // A trigger is still always a `trigger.`: the engine and the validator key on the family.
            assert_eq!(descriptor.family == Trigger, descriptor.type_id.starts_with("trigger."), "{}", descriptor.type_id);
            assert!(!descriptor.icon.is_empty(), "{} has no icon", descriptor.type_id);
            assert!((1..=RUNS_THROUGH).contains(&descriptor.milestone), "{} milestone", descriptor.type_id);
        }
    }

    /// A sub-heading belongs to one family, and a family's nodes are listed heading by heading —
    /// the palette draws them in catalogue order and starts a heading each time it changes.
    #[test]
    fn groups_are_contiguous_within_one_family() {
        use std::collections::HashMap;
        let mut owner: HashMap<&str, Family> = HashMap::new();
        let mut closed: HashSet<(Family, &str)> = HashSet::new();
        let mut last: HashMap<Family, &str> = HashMap::new();
        for descriptor in CATALOG {
            if !descriptor.group.is_empty() {
                let first = *owner.entry(descriptor.group).or_insert(descriptor.family);
                assert_eq!(first, descriptor.family, "{} is in two families", descriptor.group);
            }
            if let Some(previous) = last.insert(descriptor.family, descriptor.group) {
                if previous != descriptor.group {
                    closed.insert((descriptor.family, previous));
                    assert!(!closed.contains(&(descriptor.family, descriptor.group)), "{} comes back", descriptor.group);
                }
            }
        }
    }

    /// The palette's sections and their sizes — read from the same counts as the plan's catalogue.
    #[test]
    fn the_catalogue_has_the_families_the_plan_lists() {
        let count = |family: Family| CATALOG.iter().filter(|d| d.family == family).count();
        assert_eq!(count(Trigger), 35);
        assert_eq!(count(Ai), 16);
        assert_eq!(count(Code), 12);
        assert_eq!(count(Git), 16);
        assert_eq!(count(Net), 15);
        assert_eq!(count(Messaging), 4);
        assert_eq!(count(Apps), 3);
        assert_eq!(count(Data), 10);
        assert_eq!(count(Files), 13);
        assert_eq!(count(Logic), 13);
        assert_eq!(count(Transform), 20);
        assert_eq!(count(App), 16);
        assert_eq!(CATALOG.len(), 173);
    }

    #[test]
    fn dynamic_ports_follow_their_settings() {
        use serde_json::json;
        // Unset is what every flow saved before these were settings had.
        assert_eq!(output_count("logic.switch", &json!({})), 4);
        assert_eq!(output_count("logic.switch", &json!({"caseCount": 6})), 7);
        assert_eq!(output_count("logic.switch", &json!({"caseCount": 999})), MAX_ROUTES + 1);
        assert_eq!(input_count("logic.merge", &json!({})), 2);
        assert_eq!(input_count("logic.merge", &json!({"inputCount": 4})), 4);
        assert_eq!(input_count("logic.merge", &json!({"inputCount": 1})), 2);
        let categories = json!([{"name": "ventas"}, {"name": "soporte"}, {"name": " "}]);
        assert_eq!(output_count("ai.classify", &json!({"categories": categories})), 1);
        assert_eq!(output_count("ai.classify", &json!({"routing": "routeBranch", "categories": categories})), 3);
        assert_eq!(output_count("ai.classify", &json!({"routing": "routeBranch", "allowOther": false, "categories": categories})), 2);
        assert_eq!(output_count("net.http", &json!({})), 1);
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
