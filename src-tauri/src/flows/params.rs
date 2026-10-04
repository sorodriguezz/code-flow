//! What each node can be told: its parameters, declared once for the editor and the engine.
//!
//! The editor renders a node's form from this list (served beside the catalogue), and the engine
//! fills in a node's missing parameters from the same defaults before it runs it — so a flow saved
//! before a parameter existed runs with the default the form would have shown, and there is no
//! second copy of "what the default is" to drift.
//!
//! Labels are not here: a parameter's label is the translation `flows.param.<name>`, and the
//! options of a `select` read `flows.opt.<value>` unless they are shown as written (`raw`: HTTP
//! methods, shells). A test reads the translation files to hold both to that.

use serde::{Serialize, Serializer};
use serde_json::{Map, Value};

/// How a parameter is edited. Serialised with a `type` tag the frontend switches on.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Kind {
    /// One line, or several with `multiline`.
    #[serde(rename_all = "camelCase")]
    Text { multiline: bool, placeholder: &'static str },
    /// Source code, highlighted as `lang` (shell, python, javascript, typescript, json).
    Code { lang: &'static str },
    Number { min: Option<f64>, max: Option<f64> },
    Boolean,
    /// One of `options`. `raw` shows them as written instead of translating them.
    Select { options: &'static [&'static str], raw: bool },
    /// `[{ name, value }]` — headers, query strings, environment variables.
    KeyValue,
    /// `{ combinator, ignoreCase, conditions: [{ left, op, right }] }` — If and Filter.
    Conditions,
    /// `[{ output, left, op, right }]` — Switch.
    Rules,
    /// `[{ name, type, value }]` — Edit fields.
    Assignments,
    /// `[{ field, order }]` — Sort.
    SortKeys,
    /// `[{ op, field, as }]` — Aggregate.
    Aggregations,
    /// A list of strings: field names, command arguments.
    Strings,
    /// A directory, typed or picked.
    Folder,
    /// A flow credential of one of these kinds; `""` is none.
    Credential { kinds: &'static [&'static str] },
    /// Any number of `options`, as a list of strings.
    MultiSelect { options: &'static [&'static str] },
    /// A repository of the workspace, by project id.
    Project,
    /// Another flow of the workspace by id — or several, as a list.
    Flows { multiple: bool },
    /// A service of the workspace (the bottom dock's Services), by id.
    Service,
    /// `{ provider, model, account }` — the model picker, bound to the node.
    Engine,
    /// `[{ provider, model, account }]` — engines to fall back on, in order; `provider: "local"` is
    /// the local model.
    Engines,
    /// `[{ name, type, description, required, options }]` — the fields an answer must have.
    OutputFields,
    /// `[{ name, description }]` — what a classifier chooses from.
    Categories,
    /// CodeFlow's own MCP servers of the workspace, by name.
    McpServers,
    /// A model of the node's local server — typed, or picked from what the server lists.
    LocalModel,
    /// An agent of the workspace (the Agents console's roster), by id.
    Agent,
    /// A saved chain template of the workspace, by id.
    ChainTemplate,
}

/// Shown only while another parameter holds one of `values`.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct ShowIf {
    pub param: &'static str,
    pub values: &'static [&'static str],
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamSpec {
    pub name: &'static str,
    pub kind: Kind,
    /// JSON text of the default value — parsed when served and when a node is run.
    #[serde(serialize_with = "as_json")]
    pub default: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub show_if: Option<ShowIf>,
    /// Whether the field can be switched to an expression. Off for the few whose value is itself
    /// code or structure the engine reads (a Code node's source, a condition list).
    pub expr: bool,
}

fn as_json<S: Serializer>(text: &&'static str, serializer: S) -> Result<S::Ok, S::Error> {
    serde_json::from_str::<Value>(text).unwrap_or(Value::Null).serialize(serializer)
}

const fn p(name: &'static str, kind: Kind, default: &'static str) -> ParamSpec {
    ParamSpec { name, kind, default, show_if: None, expr: true }
}

impl ParamSpec {
    const fn when(mut self, param: &'static str, values: &'static [&'static str]) -> Self {
        self.show_if = Some(ShowIf { param, values });
        self
    }

    const fn literal(mut self) -> Self {
        self.expr = false;
        self
    }
}

const fn text(placeholder: &'static str) -> Kind {
    Kind::Text { multiline: false, placeholder }
}

const fn long_text(placeholder: &'static str) -> Kind {
    Kind::Text { multiline: true, placeholder }
}

const fn select(options: &'static [&'static str]) -> Kind {
    Kind::Select { options, raw: false }
}

const fn raw_select(options: &'static [&'static str]) -> Kind {
    Kind::Select { options, raw: true }
}

const NUMBER: Kind = Kind::Number { min: None, max: None };
const COUNT: Kind = Kind::Number { min: Some(0.0), max: None };

// ------------------------------------------------------------------ shared by the process nodes

const RUN_FOR: ParamSpec = p("runFor", select(&["once", "each"]), "\"once\"");
const OUTPUT: ParamSpec = p("output", select(&["auto", "text", "json", "lines"]), "\"auto\"");
const FAIL_ON_EXIT: ParamSpec = p("failOnExit", Kind::Boolean, "true");
const CWD: ParamSpec = p("cwd", Kind::Folder, "\"\"");
const ENV: ParamSpec = p("env", Kind::KeyValue, "[]");

const SHELL: &[ParamSpec] = &[
    p("shell", raw_select(&["auto", "bash", "sh", "zsh", "fish", "pwsh", "powershell", "cmd"]), "\"auto\""),
    p("script", Kind::Code { lang: "shell" }, "\"\""),
    CWD,
    ENV,
    RUN_FOR,
    OUTPUT,
    FAIL_ON_EXIT,
];

const PYTHON: &[ParamSpec] = &[
    p("code", Kind::Code { lang: "python" }, "\"\""),
    p("interpreter", text("python3"), "\"\""),
    CWD,
    ENV,
    RUN_FOR,
    OUTPUT,
    FAIL_ON_EXIT,
];

const NODE: &[ParamSpec] = &[
    p("runtime", raw_select(&["node", "deno", "bun"]), "\"node\""),
    p("language", select(&["javascript", "typescript"]), "\"javascript\""),
    p("code", Kind::Code { lang: "javascript" }, "\"\""),
    CWD,
    ENV,
    RUN_FOR,
    OUTPUT,
    FAIL_ON_EXIT,
];

const JS: &[ParamSpec] = &[
    p("mode", select(&["all", "each"]), "\"all\"").literal(),
    p("code", Kind::Code { lang: "javascript" }, "\"return $input.all();\"").literal(),
];

const COMMAND: &[ParamSpec] = &[
    p("program", text("git"), "\"\""),
    p("args", Kind::Strings, "[]"),
    p("stdin", select(&["none", "json"]), "\"none\""),
    CWD,
    ENV,
    RUN_FOR,
    OUTPUT,
    FAIL_ON_EXIT,
];

const SCRIPT: &[ParamSpec] = &[
    p("source", select(&["npm", "make", "mise", "file"]), "\"npm\""),
    p("name", text("build"), "\"\"").when("source", &["npm", "make", "mise"]),
    p("path", text("scripts/deploy.sh"), "\"\"").when("source", &["file"]),
    p("args", Kind::Strings, "[]"),
    CWD,
    ENV,
    OUTPUT,
    FAIL_ON_EXIT,
];

// ------------------------------------------------------------------ network

const HTTP: &[ParamSpec] = &[
    p("method", raw_select(&["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]), "\"GET\""),
    p("url", text("https://api.example.com/items"), "\"\""),
    p("credential", Kind::Credential { kinds: &["bearer", "basic", "header", "query"] }, "\"\"").literal(),
    p("query", Kind::KeyValue, "[]"),
    p("headers", Kind::KeyValue, "[]"),
    p("body", select(&["none", "json", "form", "text"]), "\"none\""),
    p("bodyJson", Kind::Code { lang: "json" }, "\"{}\"").when("body", &["json"]),
    p("bodyForm", Kind::KeyValue, "[]").when("body", &["form"]),
    p("bodyText", long_text(""), "\"\"").when("body", &["text"]),
    p("contentType", text("text/plain"), "\"text/plain\"").when("body", &["text"]),
    p("response", select(&["auto", "json", "text"]), "\"auto\""),
    p("splitArrays", Kind::Boolean, "true"),
    p("fullResponse", Kind::Boolean, "false"),
    p("neverError", Kind::Boolean, "false"),
    p("timeoutMs", COUNT, "30000"),
    p("followRedirects", Kind::Boolean, "true"),
    p("verifySsl", Kind::Boolean, "true"),
];

// ------------------------------------------------------------------ data

const STATE: &[ParamSpec] = &[
    p("operation", select(&["get", "set", "increment", "delete"]), "\"get\"").literal(),
    p("key", text("lastId"), "\"\""),
    p("value", text(""), "\"\"").when("operation", &["set"]),
    p("amount", NUMBER, "1").when("operation", &["increment"]),
    p("fallback", text(""), "\"\"").when("operation", &["get"]),
    p("target", text("value"), "\"value\"").when("operation", &["get", "increment"]),
];

const VARS: &[ParamSpec] = &[
    p("operation", select(&["get", "set", "delete"]), "\"get\"").literal(),
    p("name", text("API_BASE"), "\"\""),
    p("value", text(""), "\"\"").when("operation", &["set"]),
    p("target", text("value"), "\"value\"").when("operation", &["get"]),
];

// ------------------------------------------------------------------ logic

const IF: &[ParamSpec] = &[p(
    "conditions",
    Kind::Conditions,
    r#"{"combinator":"and","ignoreCase":false,"conditions":[{"left":"","op":"equals","right":""}]}"#,
)
.literal()];

const SWITCH: &[ParamSpec] = &[
    p("mode", select(&["rules", "expression"]), "\"rules\"").literal(),
    p("rules", Kind::Rules, r#"[{"output":0,"left":"","op":"equals","right":""}]"#).literal().when("mode", &["rules"]),
    p("output", text("{{ $json.priority }}"), "\"\"").when("mode", &["expression"]),
    p("allMatching", Kind::Boolean, "false").literal().when("mode", &["rules"]),
    p("ignoreCase", Kind::Boolean, "false").literal().when("mode", &["rules"]),
];

const MERGE: &[ParamSpec] = &[
    p("mode", select(&["append", "position", "field", "choose"]), "\"append\"").literal(),
    p("field1", text("id"), "\"\"").when("mode", &["field"]),
    p("field2", text("id"), "\"\"").when("mode", &["field"]),
    p("join", select(&["inner", "left", "outer"]), "\"inner\"").literal().when("mode", &["field"]),
    p("prefer", select(&["input1", "input2"]), "\"input2\"").literal().when("mode", &["position", "field"]),
    p("choose", select(&["input1", "input2"]), "\"input1\"").literal().when("mode", &["choose"]),
];

const WAIT: &[ParamSpec] = &[
    p("mode", select(&["duration", "until"]), "\"duration\"").literal(),
    p("amount", COUNT, "5").when("mode", &["duration"]),
    p("unit", select(&["seconds", "minutes", "hours", "days"]), "\"seconds\"").when("mode", &["duration"]),
    p("until", text("2026-12-31T09:00"), "\"\"").when("mode", &["until"]),
];

const STOP: &[ParamSpec] = &[p("message", text(""), "\"\"")];

// ------------------------------------------------------------------ transform

const SET: &[ParamSpec] = &[
    p("mode", select(&["manual", "json"]), "\"manual\"").literal(),
    p("assignments", Kind::Assignments, "[]").literal().when("mode", &["manual"]),
    p("json", Kind::Code { lang: "json" }, "\"{}\"").when("mode", &["json"]),
    p("include", select(&["all", "none", "selected", "except"]), "\"all\"").literal(),
    p("fields", Kind::Strings, "[]").literal().when("include", &["selected", "except"]),
    p("dotNotation", Kind::Boolean, "true").literal(),
];

const FILTER: &[ParamSpec] = &[p(
    "conditions",
    Kind::Conditions,
    r#"{"combinator":"and","ignoreCase":false,"conditions":[{"left":"","op":"equals","right":""}]}"#,
)
.literal()];

const SORT: &[ParamSpec] = &[
    p("mode", select(&["fields", "random", "reverse"]), "\"fields\"").literal(),
    p("keys", Kind::SortKeys, r#"[{"field":"","order":"asc"}]"#).literal().when("mode", &["fields"]),
    p("limit", COUNT, "0"),
];

const SPLIT: &[ParamSpec] = &[
    p("field", text("items"), "\"\"").literal(),
    p("include", select(&["none", "all"]), "\"none\"").literal(),
    p("destination", text(""), "\"\"").literal(),
];

const AGGREGATE: &[ParamSpec] = &[
    p("mode", select(&["summarize", "all", "fields"]), "\"summarize\"").literal(),
    p("groupBy", Kind::Strings, "[]").literal().when("mode", &["summarize"]),
    p("aggregations", Kind::Aggregations, r#"[{"op":"count","field":"","as":"count"}]"#).literal().when("mode", &["summarize"]),
    p("fields", Kind::Strings, "[]").literal().when("mode", &["fields"]),
    p("destination", text("data"), "\"data\"").literal().when("mode", &["all"]),
];

const DEDUPE: &[ParamSpec] = &[
    p("compare", select(&["all", "fields", "except"]), "\"all\"").literal(),
    p("fields", Kind::Strings, "[]").literal().when("compare", &["fields", "except"]),
    p("scope", select(&["run", "history"]), "\"run\"").literal(),
    p("historySize", COUNT, "10000").literal().when("scope", &["history"]),
];

const DATE_OPS: &[&str] = &["format", "add", "subtract", "startOf", "endOf", "diff", "setZone", "extract", "now"];
const DATE: &[ParamSpec] = &[
    p("operation", select(DATE_OPS), "\"format\"").literal(),
    p("value", text("{{ $json.date }}"), "\"\""),
    p("fromFormat", text("dd/MM/yyyy"), "\"\""),
    p("zone", text("America/Santiago"), "\"\""),
    p("amount", NUMBER, "1").when("operation", &["add", "subtract"]),
    p("unit", select(&["years", "quarters", "months", "weeks", "days", "hours", "minutes", "seconds", "milliseconds"]), "\"days\"")
        .when("operation", &["add", "subtract", "startOf", "endOf", "diff"]),
    p("other", text("{{ $json.otherDate }}"), "\"\"").when("operation", &["diff"]),
    p("toZone", text("UTC"), "\"UTC\"").when("operation", &["setZone"]),
    p(
        "part",
        select(&["year", "quarter", "month", "monthName", "weekNumber", "day", "weekday", "weekdayName", "hour", "minute", "second"]),
        "\"year\"",
    )
    .when("operation", &["extract"]),
    p("format", select(&["iso", "date", "unixMillis", "unixSeconds", "sql", "http", "relative", "custom"]), "\"iso\"")
        .when("operation", &["format", "add", "subtract", "startOf", "endOf", "setZone", "now"]),
    p("customFormat", text("yyyy-MM-dd HH:mm"), "\"yyyy-MM-dd HH:mm\"").when("format", &["custom"]),
    p("target", text("date"), "\"date\""),
];

const TEXT_OPS: &[&str] = &["replace", "extract", "split", "join", "case", "trim", "truncate", "length"];
const TEXT: &[ParamSpec] = &[
    p("operation", select(TEXT_OPS), "\"replace\"").literal(),
    p("value", text("{{ $json.title }}"), "\"\""),
    p("find", text(""), "\"\"").when("operation", &["replace"]),
    p("replaceWith", text(""), "\"\"").when("operation", &["replace"]),
    p("replaceAll", Kind::Boolean, "true").when("operation", &["replace"]),
    p("pattern", text("(\\d+)"), "\"\"").when("operation", &["extract"]),
    p("group", text("0"), "\"0\"").when("operation", &["extract"]),
    p("allMatches", Kind::Boolean, "false").when("operation", &["extract"]),
    p("useRegex", Kind::Boolean, "false").when("operation", &["replace", "split"]),
    p("separator", text(","), "\",\"").when("operation", &["split", "join"]),
    p("style", select(&["lower", "upper", "title", "sentence", "camel", "snake", "kebab", "slug"]), "\"lower\"")
        .when("operation", &["case"]),
    p("length", COUNT, "100").when("operation", &["truncate"]),
    p("ellipsis", text("…"), "\"…\"").when("operation", &["truncate"]),
    p("ignoreCase", Kind::Boolean, "false").when("operation", &["replace", "extract", "split"]),
    p("target", text("text"), "\"text\""),
];

// ------------------------------------------------------------------ app

const NOTIFY: &[ParamSpec] = &[
    p("title", text(""), "\"\""),
    p("body", long_text(""), "\"\""),
    p("perItem", Kind::Boolean, "false").literal(),
];

// ------------------------------------------------------------------ triggers (milestone 2)

const SCHEDULE: &[ParamSpec] = &[
    p("mode", select(&["interval", "times", "cron"]), "\"interval\"").literal(),
    p("every", Kind::Number { min: Some(1.0), max: None }, "15").literal().when("mode", &["interval"]),
    p("unit", select(&["minutes", "hours", "days"]), "\"minutes\"").literal().when("mode", &["interval"]),
    p("at", Kind::Strings, "[\"09:00\"]").literal().when("mode", &["times"]),
    p("days", Kind::MultiSelect { options: &["mon", "tue", "wed", "thu", "fri", "sat", "sun"] }, r#"["mon","tue","wed","thu","fri"]"#)
        .literal()
        .when("mode", &["times"]),
    p("cron", text("*/15 8-19 * * 1-5"), "\"\"").literal().when("mode", &["cron"]),
    p("timezone", text("America/Santiago"), "\"\"").literal(),
    p("catchUp", Kind::Boolean, "true").literal(),
];

const WEBHOOK: &[ParamSpec] = &[
    p("method", raw_select(&["POST", "GET", "PUT", "PATCH", "DELETE", "ANY"]), "\"POST\"").literal(),
    p("hookPath", text("pagos/alerta"), "\"\"").literal(),
    p("auth", select(&["none", "bearer", "header", "hmac"]), "\"none\"").literal(),
    p("credential", Kind::Credential { kinds: &["bearer", "header", "hmac"] }, "\"\"").literal().when("auth", &["bearer", "header", "hmac"]),
    p("signatureHeader", text("X-Signature-256"), "\"X-Signature-256\"").literal().when("auth", &["hmac"]),
    p("respond", select(&["immediately", "lastNode", "respondNode"]), "\"immediately\"").literal(),
];

const FILE: &[ParamSpec] = &[
    p("watchPath", Kind::Folder, "\"\"").literal(),
    p("events", Kind::MultiSelect { options: &["created", "modified", "deleted"] }, r#"["created"]"#).literal(),
    p("pattern", text("*.csv"), "\"\"").literal(),
    p("recursive", Kind::Boolean, "false").literal(),
    p("debounceMs", COUNT, "500").literal(),
];

const REPO: &[ParamSpec] = &[
    p("project", Kind::Project, "\"\"").literal(),
    p("event", select(&["commit", "branch", "tag"]), "\"commit\"").literal(),
    p("branch", text("main"), "\"\"").literal().when("event", &["commit"]),
    p("intervalSec", Kind::Number { min: Some(10.0), max: None }, "30").literal(),
];

const PR: &[ParamSpec] = &[
    p("project", Kind::Project, "\"\"").literal(),
    p("event", select(&["opened", "merged"]), "\"opened\"").literal(),
    p("intervalSec", Kind::Number { min: Some(60.0), max: None }, "120").literal(),
];

const PIPELINE: &[ParamSpec] = &[
    p("project", Kind::Project, "\"\"").literal(),
    p("event", select(&["finished", "failed", "succeeded"]), "\"failed\"").literal(),
    p("branch", text("main"), "\"\"").literal(),
    p("intervalSec", Kind::Number { min: Some(60.0), max: None }, "120").literal(),
];

const APP_EVENT: &[ParamSpec] = &[
    p("event", select(&["appStart", "serviceReady", "serviceFailed", "serviceStopped"]), "\"appStart\"").literal(),
    p("service", text("api"), "\"\"").literal().when("event", &["serviceReady", "serviceFailed", "serviceStopped"]),
];

const HOTKEY: &[ParamSpec] = &[p("accelerator", text("CmdOrCtrl+Alt+F"), "\"\"").literal()];

const ERROR_TRIGGER: &[ParamSpec] = &[
    p("which", select(&["all", "selected"]), "\"all\"").literal(),
    p("flows", Kind::Flows { multiple: true }, "[]").literal().when("which", &["selected"]),
];

const SUBFLOW: &[ParamSpec] = &[
    p("flow", Kind::Flows { multiple: false }, "\"\"").literal(),
    p("mode", select(&["wait", "fire"]), "\"wait\"").literal(),
];

const RESPOND: &[ParamSpec] = &[
    p("status", Kind::Number { min: Some(100.0), max: Some(599.0) }, "200"),
    p("body", long_text("{{ $json }}"), "\"\""),
    p("contentType", text("application/json"), "\"\""),
    p("headers", Kind::KeyValue, "[]"),
];

const SERVICE: &[ParamSpec] = &[
    p("service", Kind::Service, "\"\"").literal(),
    p("action", select(&["start", "stop", "restart", "status"]), "\"start\"").literal(),
    p("wait", Kind::Boolean, "true").literal().when("action", &["start", "restart"]),
    p("timeoutSec", COUNT, "120").literal().when("action", &["start", "restart"]),
];

// ------------------------------------------------------------------ AI (milestone 3)

const ENGINE: ParamSpec = p("engine", Kind::Engine, "{}").literal();
const FALLBACK_ENGINES: ParamSpec = p("fallbackEngines", Kind::Engines, "[]").literal();
const ANSWER_FIELDS: ParamSpec =
    p("schemaFields", Kind::OutputFields, r#"[{"name":"","type":"string","description":"","required":true}]"#).literal();
const ANSWER_SCHEMA: ParamSpec = p(
    "schemaJson",
    Kind::Code { lang: "json" },
    r#""{\n  \"type\": \"object\",\n  \"properties\": {\n    \"answer\": { \"type\": \"string\" }\n  },\n  \"required\": [\"answer\"],\n  \"additionalProperties\": false\n}""#,
)
.literal();
const AI_RUN_FOR: ParamSpec = p("runFor", select(&["each", "once"]), "\"each\"").literal();
const SUBJECT: ParamSpec = p("text", long_text("{{ $json.text }}"), "\"={{ $json.text }}\"");
const INSTRUCTIONS: ParamSpec = p("instructions", long_text(""), "\"\"");

const AGENT: &[ParamSpec] = &[
    ENGINE,
    p("prompt", long_text("Revisa los errores de hoy y dime cuáles son nuevos"), "\"\""),
    p("data", long_text("{{ JSON.stringify($json, null, 2) }}"), "\"\""),
    p("system", long_text(""), "\"\""),
    p("workIn", select(&["temp", "project", "path"]), "\"temp\"").literal(),
    p("project", Kind::Project, "\"\"").literal().when("workIn", &["project"]),
    p("subfolder", text("packages/api"), "\"\"").literal().when("workIn", &["project"]),
    p("workDir", Kind::Folder, "\"\"").literal().when("workIn", &["path"]),
    p("access", select(&["readOnly", "edit"]), "\"readOnly\"").literal(),
    p("mcp", Kind::McpServers, "[]").literal().when("access", &["edit"]),
    p("output", select(&["text", "json", "schema"]), "\"text\"").literal(),
    ANSWER_FIELDS.when("output", &["json"]),
    ANSWER_SCHEMA.when("output", &["schema"]),
    p("session", select(&["new", "continue"]), "\"new\"").literal(),
    p("effort", select(&["default", "low", "medium", "high", "max"]), "\"default\"").literal(),
    FALLBACK_ENGINES,
    AI_RUN_FOR,
];

const LOCAL: &[ParamSpec] = &[
    p("server", select(&["auto", "bundled", "ollama", "openai"]), "\"auto\"").literal(),
    p("url", text("http://127.0.0.1:11434"), "\"\"").when("server", &["ollama", "openai"]),
    p("model", Kind::LocalModel, "\"\""),
    p("credential", Kind::Credential { kinds: &["bearer"] }, "\"\"").literal().when("server", &["openai"]),
    p("system", long_text(""), "\"\""),
    p("prompt", long_text("Resume este texto en una línea"), "\"\""),
    p("output", select(&["text", "json", "schema"]), "\"text\"").literal(),
    ANSWER_FIELDS.when("output", &["json"]),
    ANSWER_SCHEMA.when("output", &["schema"]),
    p("temperature", Kind::Number { min: Some(0.0), max: Some(2.0) }, "0.2"),
    p("maxTokens", Kind::Number { min: Some(16.0), max: None }, "1024"),
    p("contextSize", COUNT, "0"),
    AI_RUN_FOR,
];

const CLASSIFY: &[ParamSpec] = &[
    ENGINE,
    SUBJECT,
    p("categories", Kind::Categories, r#"[{"name":"","description":""}]"#).literal(),
    p("multiple", Kind::Boolean, "false").literal(),
    p("allowOther", Kind::Boolean, "true").literal(),
    INSTRUCTIONS,
    p("target", text("category"), "\"\"").literal(),
    FALLBACK_ENGINES,
];

const EXTRACT: &[ParamSpec] = &[
    ENGINE,
    SUBJECT,
    ANSWER_FIELDS,
    INSTRUCTIONS,
    p("target", text("data"), "\"data\"").literal(),
    FALLBACK_ENGINES,
];

const SUMMARIZE: &[ParamSpec] = &[
    ENGINE,
    SUBJECT,
    p("summaryLength", select(&["brief", "standard", "detailed"]), "\"brief\"").literal(),
    p("summaryStyle", select(&["paragraph", "bullets"]), "\"paragraph\"").literal(),
    p("answerLanguage", select(&["auto", "es", "en"]), "\"auto\"").literal(),
    INSTRUCTIONS,
    p("target", text("summary"), "\"summary\"").literal(),
    FALLBACK_ENGINES,
];

const REVIEW: &[ParamSpec] = &[
    ENGINE,
    p("diffSource", select(&["working", "staged", "branchDiff", "diffText"]), "\"working\"").literal(),
    p("project", Kind::Project, "\"\"").literal().when("diffSource", &["working", "staged", "branchDiff"]),
    p("base", text("main"), "\"main\"").when("diffSource", &["branchDiff"]),
    p("diff", long_text("{{ $json.diff }}"), "\"\"").when("diffSource", &["diffText"]),
    INSTRUCTIONS,
    FALLBACK_ENGINES,
];

const COMMIT: &[ParamSpec] = &[
    ENGINE,
    p("writeWhat", select(&["commitMessage", "prDescription"]), "\"commitMessage\"").literal(),
    p("diffSource", select(&["staged", "working", "branchDiff", "diffText"]), "\"staged\"").literal(),
    p("project", Kind::Project, "\"\"").literal().when("diffSource", &["staged", "working", "branchDiff"]),
    p("base", text("main"), "\"main\"").when("diffSource", &["branchDiff"]),
    p("diff", long_text("{{ $json.diff }}"), "\"\"").when("diffSource", &["diffText"]),
    FALLBACK_ENGINES,
];

const AGENT_TASK: &[ParamSpec] = &[
    p("mode", select(&["agent", "template"]), "\"agent\"").literal(),
    p("agent", Kind::Agent, "\"\"").literal().when("mode", &["agent"]),
    p("template", Kind::ChainTemplate, "\"\"").literal().when("mode", &["template"]),
    p("project", Kind::Project, "\"\"").literal(),
    p("instruction", long_text("Corrige el test que falla en la rama actual"), "\"\""),
    p("title", text(""), "\"\""),
    p("waitEnd", Kind::Boolean, "true").literal(),
];

/// The parameters of a node type; empty for a type that has none (or none yet).
pub fn for_type(type_id: &str) -> &'static [ParamSpec] {
    match type_id {
        "code.shell" => SHELL,
        "code.python" => PYTHON,
        "code.node" => NODE,
        "code.js" => JS,
        "code.command" => COMMAND,
        "code.script" => SCRIPT,
        "net.http" => HTTP,
        "data.state" => STATE,
        "data.vars" => VARS,
        "logic.if" => IF,
        "logic.switch" => SWITCH,
        "logic.merge" => MERGE,
        "logic.wait" => WAIT,
        "logic.stop" => STOP,
        "transform.set" => SET,
        "transform.filter" => FILTER,
        "transform.sort" => SORT,
        "transform.split" => SPLIT,
        "transform.aggregate" => AGGREGATE,
        "transform.dedupe" => DEDUPE,
        "transform.date" => DATE,
        "transform.text" => TEXT,
        "app.notify" => NOTIFY,
        "trigger.schedule" => SCHEDULE,
        "trigger.webhook" => WEBHOOK,
        "trigger.file" => FILE,
        "trigger.repo" => REPO,
        "trigger.pr" => PR,
        "trigger.pipeline" => PIPELINE,
        "trigger.app" => APP_EVENT,
        "trigger.hotkey" => HOTKEY,
        "trigger.error" => ERROR_TRIGGER,
        "logic.subflow" => SUBFLOW,
        "net.respond" => RESPOND,
        "code.service" => SERVICE,
        "ai.agent" => AGENT,
        "ai.local" => LOCAL,
        "ai.classify" => CLASSIFY,
        "ai.extract" => EXTRACT,
        "ai.summarize" => SUMMARIZE,
        "ai.review" => REVIEW,
        "ai.commit" => COMMIT,
        "app.agent" => AGENT_TASK,
        _ => &[],
    }
}

/// A node's parameters with every missing one filled in from its default. Keys the node holds that
/// the type no longer declares are kept: a parameter removed in a later version should not erase
/// what somebody typed into it.
pub fn with_defaults(type_id: &str, params: &Value) -> Value {
    let mut out = match params {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    for spec in for_type(type_id) {
        if !out.contains_key(spec.name) {
            out.insert(spec.name.to_string(), serde_json::from_str(spec.default).unwrap_or(Value::Null));
        }
    }
    Value::Object(out)
}

/// The parameters the JavaScript must hand back untouched when it resolves the rest: condition
/// lists and switch rules, which hold expressions it evaluates per row later (with the operator in
/// between), and the Code node's source, which is code rather than a template. Everything else —
/// assignments included — is resolved, nested values and all.
pub fn literal_names(type_id: &str) -> Vec<&'static str> {
    for_type(type_id)
        .iter()
        .filter(|spec| {
            matches!(
                spec.kind,
                Kind::Conditions | Kind::Rules | Kind::Engine | Kind::Engines | Kind::OutputFields | Kind::Categories
            ) || (type_id == "code.js" && spec.name == "code")
        })
        .map(|spec| spec.name)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::flows::catalog::CATALOG;

    #[test]
    fn every_default_is_json_and_every_show_if_names_a_sibling() {
        for descriptor in CATALOG {
            let specs = for_type(descriptor.type_id);
            for spec in specs {
                assert!(
                    serde_json::from_str::<Value>(spec.default).is_ok(),
                    "{}.{} has a default that is not JSON: {}",
                    descriptor.type_id,
                    spec.name,
                    spec.default
                );
                if let Some(show) = spec.show_if {
                    assert!(
                        specs.iter().any(|other| other.name == show.param),
                        "{}.{} depends on {}, which the node does not have",
                        descriptor.type_id,
                        spec.name,
                        show.param
                    );
                }
            }
            let mut names: Vec<&str> = specs.iter().map(|spec| spec.name).collect();
            names.sort_unstable();
            names.dedup();
            assert_eq!(names.len(), specs.len(), "{} declares a parameter twice", descriptor.type_id);
        }
    }

    /// Nothing that does not run yet has parameters — a form for a node the engine refuses would be
    /// a promise it cannot keep.
    #[test]
    fn parameters_arrive_with_the_milestone() {
        for descriptor in CATALOG {
            if descriptor.milestone > crate::flows::catalog::RUNS_THROUGH {
                assert!(for_type(descriptor.type_id).is_empty(), "{} runs later", descriptor.type_id);
            }
        }
    }

    /// The labels live in the translations; a parameter or option without one would show its key.
    #[test]
    fn every_label_is_translated_in_both_languages() {
        let english = include_str!("../../../src/lib/i18n/translations.ts");
        let spanish = include_str!("../../../src/lib/i18n/translations.es.ts");
        let mut missing = Vec::new();
        for descriptor in CATALOG {
            for spec in for_type(descriptor.type_id) {
                let mut keys = vec![format!("\"flows.param.{}\"", spec.name)];
                if let Kind::Select { options, raw: false } | Kind::MultiSelect { options } = spec.kind {
                    keys.extend(options.iter().map(|option| format!("\"flows.opt.{option}\"")));
                }
                for key in keys {
                    for (language, text) in [("en", english), ("es", spanish)] {
                        if !text.contains(&key) {
                            missing.push(format!("{language} {key}"));
                        }
                    }
                }
            }
        }
        missing.sort();
        missing.dedup();
        assert!(missing.is_empty(), "untranslated: {missing:?}");
    }

    #[test]
    fn defaults_fill_only_what_is_missing() {
        let filled = with_defaults("net.http", &serde_json::json!({"url": "https://example.com", "legacy": 1}));
        assert_eq!(filled["url"], "https://example.com");
        assert_eq!(filled["method"], "GET");
        assert_eq!(filled["timeoutMs"], 30000);
        assert_eq!(filled["legacy"], 1);
        assert_eq!(literal_names("code.js"), vec!["code"]);
        assert_eq!(literal_names("logic.switch"), vec!["rules"]);
        assert!(literal_names("transform.set").is_empty(), "assignments are resolved");
    }
}
