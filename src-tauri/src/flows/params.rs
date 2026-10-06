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
    /// A file on this computer: typed or pasted, or picked in the system's dialog — "save as" while
    /// the node's `operation` is one of `save` (`*`: always), an open dialog otherwise.
    File { placeholder: &'static str, save: &'static [&'static str] },
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
    /// A saved connection of the Databases workspace, of one of these engines.
    DbConnection { kinds: &'static [&'static str] },
    /// A host of the Remote workspace, of one of these kinds.
    RemoteHost { kinds: &'static [&'static str] },
    /// A note of the workspace, by id.
    Note,
    /// An item of the Llavero, by id.
    VaultItem,
    /// `{ connector, operation, fields }` — a call to one of `flows::connectors`, its form drawn
    /// from the connector's definition.
    Connector,
    /// `[{ name, label, type, required, default, options }]` — what a manual run asks for before it
    /// starts (`flows::form`).
    FormFields,
    /// A saved request of the API client of the workspace, by id.
    ApiRequest,
    /// An environment of the API client, by id — `""` is the one active there, `"none"` none.
    ApiEnvironment,
    /// `[{ name, selector, attribute, all }]` — what a web page node picks out, by CSS selector.
    ExtractRules,
    /// A provider's model, typed or picked from the list its API gives (`flows_ai_models`):
    /// chat models, or embedding ones.
    ApiModel { purpose: &'static str },
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
    /// A second condition that must hold too — a field of one broker *and* one operation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub also_if: Option<ShowIf>,
    /// Whether the field can be switched to an expression. Off for the few whose value is itself
    /// code or structure the engine reads (a Code node's source, a condition list).
    pub expr: bool,
}

fn as_json<S: Serializer>(text: &&'static str, serializer: S) -> Result<S::Ok, S::Error> {
    serde_json::from_str::<Value>(text).unwrap_or(Value::Null).serialize(serializer)
}

const fn p(name: &'static str, kind: Kind, default: &'static str) -> ParamSpec {
    ParamSpec { name, kind, default, show_if: None, also_if: None, expr: true }
}

impl ParamSpec {
    const fn when(mut self, param: &'static str, values: &'static [&'static str]) -> Self {
        self.show_if = Some(ShowIf { param, values });
        self
    }

    const fn and_when(mut self, param: &'static str, values: &'static [&'static str]) -> Self {
        self.also_if = Some(ShowIf { param, values });
        self
    }

    const fn literal(mut self) -> Self {
        self.expr = false;
        self
    }
}

/// A file the node reads.
const fn file(placeholder: &'static str) -> Kind {
    Kind::File { placeholder, save: &[] }
}

/// A file the node writes — in every operation (`*`), or in the ones listed.
const fn file_to_write(placeholder: &'static str, save: &'static [&'static str]) -> Kind {
    Kind::File { placeholder, save }
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
    p("path", file("scripts/deploy.sh"), "\"\"").when("source", &["file"]),
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
    p("credential", Kind::Credential { kinds: &["bearer", "basic", "header", "query", "oauth2"] }, "\"\"").literal(),
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
    // Pagination: every page, its items joined (`nodes::http::paginate`).
    p("pagination", select(&["none", "nextUrl", "pageNumber", "cursor"]), "\"none\"").literal(),
    p("itemsField", text("data"), "\"\"").literal().when("pagination", &["nextUrl", "pageNumber", "cursor"]),
    p("nextField", text("links.next"), "\"\"").literal().when("pagination", &["nextUrl"]),
    p("pageParam", text("page"), "\"page\"").literal().when("pagination", &["pageNumber"]),
    p("startPage", COUNT, "1").literal().when("pagination", &["pageNumber"]),
    p("cursorField", text("meta.next_cursor"), "\"\"").literal().when("pagination", &["cursor"]),
    p("cursorParam", text("cursor"), "\"cursor\"").literal().when("pagination", &["cursor"]),
    p("maxPages", COUNT, "10").literal().when("pagination", &["nextUrl", "pageNumber", "cursor"]),
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
    p("mode", select(&["duration", "until", "webhook"]), "\"duration\"").literal(),
    p("amount", COUNT, "5").when("mode", &["duration"]),
    p("unit", select(&["seconds", "minutes", "hours", "days"]), "\"seconds\"").when("mode", &["duration"]),
    p("until", text("2026-12-31T09:00"), "\"\"").when("mode", &["until"]),
    p("timeoutHours", COUNT, "0").literal().when("mode", &["webhook"]),
];

const APPROVAL: &[ParamSpec] = &[
    p("message", long_text("¿Publicar el reporte de {{ $json.fecha }}?"), "\"\""),
    p("timeoutHours", COUNT, "0").literal(),
    p("onTimeout", select(&["reject", "fail"]), "\"reject\"").literal(),
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

/// A GitHub repository's issues, comments and releases (`triggers::github`): a token is optional for
/// a public repository, but without one GitHub allows 60 looks an hour.
const GITHUB_TRIGGER: &[ParamSpec] = &[
    p("repository", text("octo-org/app"), "\"\"").literal(),
    p("event", select(&["issueOpened", "issueClosed", "issueComment", "release"]), "\"issueOpened\"").literal(),
    p("credential", Kind::Credential { kinds: &["bearer"] }, "\"\"").literal(),
    p("labelFilter", text("bug, urgente"), "\"\"").literal().when("event", &["issueOpened", "issueClosed"]),
    p("intervalSec", Kind::Number { min: Some(60.0), max: None }, "120").literal(),
];

/// A mailbox over IMAP (`triggers::inbox`).
const EMAIL_TRIGGER: &[ParamSpec] = &[
    p("credential", Kind::Credential { kinds: &["imap"] }, "\"\"").literal(),
    p("mailbox", text("INBOX"), "\"INBOX\"").literal(),
    p("imapCriteria", text("UNSEEN FROM \"facturas@example.com\""), "\"UNSEEN\"").literal(),
    p("markRead", Kind::Boolean, "false").literal(),
    p("attachmentsFolder", Kind::Folder, "\"\"").literal(),
    p("intervalSec", Kind::Number { min: Some(30.0), max: None }, "60").literal(),
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

/// The manual trigger: the form a run asks for, when it has fields.
const MANUAL: &[ParamSpec] = &[p("fields", Kind::FormFields, "[]").literal()];

const SERVICE: &[ParamSpec] = &[
    p("service", Kind::Service, "\"\"").literal(),
    p("action", select(&["start", "stop", "restart", "status", "readLog", "waitForLine"]), "\"start\"").literal(),
    p("wait", Kind::Boolean, "true").literal().when("action", &["start", "restart"]),
    p("timeoutSec", COUNT, "120").literal().when("action", &["start", "restart", "waitForLine"]),
    p("lines", COUNT, "100").literal().when("action", &["readLog"]),
    p("waitText", text("listening on"), "\"\"").when("action", &["waitForLine"]),
    p("regex", Kind::Boolean, "false").literal().when("action", &["waitForLine"]),
    p("onlyNew", Kind::Boolean, "true").literal().when("action", &["waitForLine"]),
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

/// CodeFlow's own PR analyzer (`ai.prReview`). The engine follows the "Revisión de PR" routing row
/// while it is left automatic — the analyzer's, not the "Flujos" one.
const PR_REVIEW: &[ParamSpec] = &[
    p("source", select(&["project", "link"]), "\"project\"").literal(),
    p("project", Kind::Project, "\"\"").literal().when("source", &["project"]),
    p("prId", text("{{ $json.number }}"), "\"\"").when("source", &["project"]),
    p("prUrl", text("https://github.com/org/repo/pull/12"), "\"\"").when("source", &["link"]),
    p("level", select(&["basico", "completo", "ultra"]), "\"completo\"").literal(),
    p("force", Kind::Boolean, "false").literal().when("source", &["project"]),
    p("publish", select(&["none", "findings", "findingsAndSummary"]), "\"none\"").literal().when("source", &["project"]),
    p("minSeverity", select(&["critical", "warning", "info"]), "\"warning\"")
        .literal()
        .when("publish", &["findings", "findingsAndSummary"]),
    ENGINE,
];

/// "Resolver con IA" (`ai.prFix`): the PR analyzer's fix, finding by finding or thread by thread,
/// on the pull request's branch.
const PR_FIX: &[ParamSpec] = &[
    p("project", Kind::Project, "\"\"").literal(),
    p("prId", text("{{ $json.prId }}"), "\"\""),
    p("fixSource", select(&["fixFindings", "fixThreads"]), "\"fixFindings\"").literal(),
    p("ids", text("F-001, F-003"), "\"\""),
    p("minSeverity", select(&["critical", "warning", "info"]), "\"warning\"").literal().when("fixSource", &["fixFindings"]),
    INSTRUCTIONS,
    p("switchBranch", Kind::Boolean, "true").literal(),
    ENGINE,
];

/// "Responder con IA" (`ai.prReply`): a reply drafted per comment thread.
const PR_REPLY: &[ParamSpec] = &[
    p("project", Kind::Project, "\"\"").literal(),
    p("prId", text("{{ $json.prId }}"), "\"\""),
    p("ids", text("{{ $json.id }}"), "\"\""),
    p("replyNote", long_text("No aplica: es intencional, lo explica el ADR-12"), "\"\""),
    ENGINE,
];

/// A turn of CodeFlow's Chat (`ai.chat`): in a new thread, in the one titled so (made the first
/// time), or in one by id. The engine is the thread's own for an existing one unless the node names
/// one; a new thread starts on the node's — or, automatic, on the Chat routing row's.
const CHAT: &[ParamSpec] = &[
    p("conversation", select(&["byTitle", "newThread", "byId"]), "\"byTitle\"").literal(),
    p("title", text("Informe diario"), "\"\"").when("conversation", &["byTitle", "newThread"]),
    p("conversationId", text("{{ $json.conversationId }}"), "\"\"").when("conversation", &["byId"]),
    p("message", long_text("Resume esto en tres puntos: {{ $json.text }}"), "\"\""),
    p("project", Kind::Project, "\"\"").literal().when("conversation", &["byTitle", "newThread"]),
    p("waitReply", Kind::Boolean, "true").literal(),
    ENGINE,
];

/// A database's schema as DBML (`data.dbml`) — read from a saved connection, written by the one
/// DBML emitter (the window's), and kept where asked: a diagram of the workspace (made the first
/// time, replaced after) or a `.dbml` file.
const DBML: &[ParamSpec] = &[
    p("connection", Kind::DbConnection { kinds: SQL_ENGINES }, "\"\"").literal(),
    p("database", text(""), "\"\"").literal(),
    p("schema", text("public"), "\"\"").literal(),
    p("saveTo", select(&["noSave", "diagram", "dbmlFile"]), "\"diagram\"").literal(),
    p("title", text("Esquema de producción"), "\"\"").when("saveTo", &["diagram"]),
    p("path", file_to_write("~/esquemas/app.dbml", &["*"]), "\"\"").when("saveTo", &["dbmlFile"]),
];

/// A saved request of the API client (`app.apiRequest`), sent the way the API client sends it — see
/// `lib/api/savedRequest.ts`. `variables` fill the request's `{{…}}` before the environment does.
const API_REQUEST: &[ParamSpec] = &[
    p("request", Kind::ApiRequest, "\"\"").literal(),
    p("environment", Kind::ApiEnvironment, "\"\"").literal(),
    p("variables", Kind::KeyValue, "[]"),
    p("runFor", select(&["each", "once"]), "\"each\"").literal(),
    p("failOnStatus", Kind::Boolean, "false").literal(),
    p("failOnTests", Kind::Boolean, "false").literal(),
];

// ------------------------------------------------------------------ milestone 8: utilities

const WEB_PAGE: &[ParamSpec] = &[
    p("source", select(&["url", "html"]), "\"url\"").literal(),
    p("url", text("https://example.com/blog"), "\"\"").when("source", &["url"]),
    p("pageHtml", long_text("{{ $json.body }}"), "\"\"").when("source", &["html"]),
    p("mode", select(&["markdown", "extract", "pageText", "links"]), "\"markdown\"").literal(),
    p("mainOnly", Kind::Boolean, "true").literal().when("mode", &["markdown", "pageText"]),
    p("fieldsToExtract", Kind::ExtractRules, r#"[{"name":"title","selector":"h1","attribute":"","all":false}]"#).when("mode", &["extract"]),
    p("timeoutMs", COUNT, "20000").literal().when("source", &["url"]),
];

const SITE_CHECK: &[ParamSpec] = &[
    p("check", select(&["httpCheck", "tlsCheck", "dnsCheck", "portCheck"]), "\"httpCheck\"").literal(),
    p("siteTarget", text("https://example.com"), "\"\""),
    p("expectStatus", text("200-399"), "\"\"").when("check", &["httpCheck"]),
    p("port", COUNT, "443").when("check", &["tlsCheck", "portCheck"]),
    p("warnDays", COUNT, "14").literal().when("check", &["tlsCheck"]),
    p("recordType", raw_select(&["A", "AAAA", "CNAME", "MX", "TXT", "NS"]), "\"A\"").literal().when("check", &["dnsCheck"]),
    p("timeoutMs", COUNT, "10000").literal(),
];

const UNTIL: &[ParamSpec] = &[
    p("check", select(&["httpUntil", "commandUntil"]), "\"httpUntil\"").literal(),
    p("url", text("https://example.com/health"), "\"\"").when("check", &["httpUntil"]),
    p("expectStatus", text("200"), "\"200\"").when("check", &["httpUntil"]),
    p("bodyContains", text("\"status\":\"ok\""), "\"\"").when("check", &["httpUntil"]),
    p("command", Kind::Code { lang: "shell" }, "\"\"").when("check", &["commandUntil"]),
    p("outputContains", text("ready"), "\"\"").when("check", &["commandUntil"]),
    p("intervalSec", COUNT, "5").literal(),
    p("timeoutSec", COUNT, "300").literal(),
    p("failOnTimeout", Kind::Boolean, "true").literal(),
];

const CHANGES: &[ParamSpec] = &[
    p("key", text("{{ $json.id }}"), "\"\""),
    p("compare", select(&["wholeItem", "someFields"]), "\"wholeItem\"").literal(),
    p("fields", Kind::Strings, "[]").literal().when("compare", &["someFields"]),
    p("firstRun", select(&["emitAll", "emitNone"]), "\"emitAll\"").literal(),
    p("memory", COUNT, "10000").literal(),
];

const TEMPLATE: &[ParamSpec] = &[
    p("template", Kind::Code { lang: "markdown" }, "\"Hola {{ json.nombre }}\"").literal(),
    p("runFor", select(&["each", "once"]), "\"each\"").literal(),
    p("target", text("text"), "\"text\"").literal(),
];

const JSON_TOOL: &[ParamSpec] = &[
    p("operation", select(&["validate", "jsonPath", "jsonDiff"]), "\"validate\"").literal(),
    p("value", text("{{ $json }}"), "\"={{ $json }}\"").when("operation", &["validate", "jsonPath"]),
    p("schema", Kind::Code { lang: "json" }, r#""{\n  \"type\": \"object\"\n}""#).literal().when("operation", &["validate"]),
    p("jsonPathExpr", text("$.items[*].id"), "\"\"").when("operation", &["jsonPath"]),
    p("left", text("{{ $json.antes }}"), "\"\"").when("operation", &["jsonDiff"]),
    p("right", text("{{ $json.despues }}"), "\"\"").when("operation", &["jsonDiff"]),
    p("target", text(""), "\"\"").literal(),
];

const SQL_ITEMS: &[ParamSpec] = &[p("itemsQuery", Kind::Code { lang: "sql" }, "\"SELECT * FROM items\"").literal()];

const PDF: &[ParamSpec] = &[
    p("operation", select(&["readPdf", "createPdf"]), "\"readPdf\"").literal(),
    p("path", file("~/Documentos/factura.pdf"), "\"\"").when("operation", &["readPdf"]),
    p("markdown", long_text("# Informe\n\n{{ $json.resumen }}"), "\"\"").when("operation", &["createPdf"]),
    p("title", text("Informe"), "\"\"").when("operation", &["createPdf"]),
    p("savePath", file_to_write("~/Documentos/informe.pdf", &["*"]), "\"\"").when("operation", &["createPdf"]),
    p("pageSize", select(&["a4", "letter"]), "\"a4\"").literal().when("operation", &["createPdf"]),
];

const IMAGE: &[ParamSpec] = &[
    p("operation", select(&["imageInfo", "resize", "convertImage", "crop", "rotate", "qrCreate", "qrRead"]), "\"resize\"").literal(),
    p("path", file("{{ $json.path }}"), "\"\"").when("operation", &["imageInfo", "resize", "convertImage", "crop", "rotate", "qrRead"]),
    p("qrText", text("https://example.com"), "\"\"").when("operation", &["qrCreate"]),
    p("qrSize", COUNT, "512").literal().when("operation", &["qrCreate"]),
    p("width", COUNT, "800").when("operation", &["resize", "crop"]),
    p("height", COUNT, "0").when("operation", &["resize", "crop"]),
    p("x", COUNT, "0").when("operation", &["crop"]),
    p("y", COUNT, "0").when("operation", &["crop"]),
    p("degrees", raw_select(&["90", "180", "270"]), "\"90\"").literal().when("operation", &["rotate"]),
    p("savePath", file_to_write("~/Imágenes/salida.png", &["*"]), "\"\"").when("operation", &["resize", "convertImage", "crop", "rotate", "qrCreate"]),
    p("quality", COUNT, "85").literal().when("operation", &["resize", "convertImage", "crop", "rotate"]),
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

// ------------------------------------------------------------------ milestone 4

const EACH: ParamSpec = p("runFor", select(&["each", "once"]), "\"each\"").literal();
const ONCE: ParamSpec = p("runFor", select(&["once", "each"]), "\"once\"").literal();
const HTTP_CREDENTIAL: ParamSpec = p("credential", Kind::Credential { kinds: &["bearer", "basic", "header", "query", "oauth2"] }, "\"\"").literal();
const HEADERS: ParamSpec = p("headers", Kind::KeyValue, "[]");
const VERIFY_SSL: ParamSpec = p("verifySsl", Kind::Boolean, "true");
const TIMEOUT_MS: ParamSpec = p("timeoutMs", COUNT, "30000");
const TIMEOUT_SEC: ParamSpec = p("timeoutSec", Kind::Number { min: Some(0.1), max: None }, "10");
const SQL_ENGINES: &[&str] = &["postgres", "supabase", "sqlserver", "iris", "mysql", "mariadb", "sqlite", "oracle", "jdbc"];
const FILE_HOSTS: &[&str] = &["ssh", "sftp", "ftp", "ftps", "smb"];
const STORAGE_HOSTS: &[&str] = &["s3", "azure", "azure_blob", "azure_files"];

const GRAPHQL: &[ParamSpec] = &[
    p("url", text("https://api.example.com/graphql"), "\"\""),
    HTTP_CREDENTIAL,
    HEADERS,
    p("operation", select(&["query", "introspect"]), "\"query\"").literal(),
    p("queryText", long_text("query Pedidos($estado: String) { pedidos(estado: $estado) { id total } }"), "\"\"").when("operation", &["query"]),
    p("variables", Kind::Code { lang: "json" }, "\"{}\"").when("operation", &["query"]),
    p("operationName", text(""), "\"\"").when("operation", &["query"]),
    p("failOnErrors", Kind::Boolean, "false").literal().when("operation", &["query"]),
    TIMEOUT_MS,
    VERIFY_SSL,
    EACH,
];

const WEBSOCKET: &[ParamSpec] = &[
    p("url", text("wss://example.com/socket"), "\"\""),
    HTTP_CREDENTIAL,
    HEADERS,
    p("subprotocols", Kind::Strings, "[]"),
    p("messages", Kind::Strings, "[]"),
    p("maxMessages", COUNT, "1"),
    p("untilContains", text(""), "\"\""),
    TIMEOUT_SEC,
    p("requireAnswer", Kind::Boolean, "false").literal(),
    VERIFY_SSL,
    EACH,
];

const SOCKETIO: &[ParamSpec] = &[
    p("url", text("https://example.com"), "\"\""),
    p("socketPath", text("/socket.io"), "\"/socket.io\""),
    p("namespace", text("/"), "\"/\""),
    p("version", raw_select(&["v4", "v3"]), "\"v4\"").literal(),
    HTTP_CREDENTIAL,
    HEADERS,
    p("auth", Kind::Code { lang: "json" }, "\"\""),
    p("event", text("pedido:nuevo"), "\"\""),
    p("payload", Kind::Code { lang: "json" }, "\"\""),
    p("waitAck", Kind::Boolean, "false"),
    p("listen", text("pedido:estado"), "\"\""),
    p("maxMessages", COUNT, "0"),
    TIMEOUT_SEC,
    EACH,
];

const GRPC: &[ParamSpec] = &[
    p("endpoint", text("https://api.example.com:443"), "\"\""),
    p("source", select(&["reflection", "proto"]), "\"reflection\"").literal(),
    p("protoPath", file("~/protos/pedidos.proto"), "\"\"").when("source", &["proto"]),
    p("importPaths", Kind::Strings, "[]").when("source", &["proto"]),
    p("service", text("pedidos.v1.Pedidos"), "\"\""),
    p("method", text("Obtener"), "\"\""),
    p("message", Kind::Code { lang: "json" }, "\"{}\""),
    p("metadata", Kind::KeyValue, "[]"),
    p("credential", Kind::Credential { kinds: &["bearer", "header"] }, "\"\"").literal(),
    p("tls", Kind::Boolean, "true"),
    TIMEOUT_MS,
    EACH,
];

const MQTT: &[ParamSpec] = &[
    p("url", text("mqtt://broker.example.com:1883"), "\"\""),
    p("credential", Kind::Credential { kinds: &["basic"] }, "\"\"").literal(),
    p("clientId", text(""), "\"\""),
    p("operation", select(&["publish", "subscribe"]), "\"publish\"").literal(),
    p("topic", text("sensores/temperatura"), "\"\""),
    p("payload", long_text("{{ JSON.stringify($json) }}"), "\"\"").when("operation", &["publish"]),
    p("qos", Kind::Number { min: Some(0.0), max: Some(2.0) }, "0"),
    p("retain", Kind::Boolean, "false").when("operation", &["publish"]),
    p("maxMessages", COUNT, "1").when("operation", &["subscribe"]),
    TIMEOUT_SEC.when("operation", &["subscribe"]),
    EACH,
];

const SSE: &[ParamSpec] = &[
    p("url", text("https://example.com/events"), "\"\""),
    HTTP_CREDENTIAL,
    HEADERS,
    p("eventName", text(""), "\"\""),
    p("untilEvent", text("done"), "\"\""),
    p("maxMessages", COUNT, "10"),
    p("timeoutSec", Kind::Number { min: Some(0.1), max: None }, "30"),
    VERIFY_SSL,
    ONCE,
];

const DOWNLOAD: &[ParamSpec] = &[
    p("url", text("https://example.com/reporte.pdf"), "\"\""),
    HTTP_CREDENTIAL,
    HEADERS,
    p("folder", Kind::Folder, "\"\""),
    p("fileName", text(""), "\"\""),
    p("overwrite", Kind::Boolean, "false"),
    VERIFY_SSL,
    EACH,
];

const EMAIL: &[ParamSpec] = &[
    p("credential", Kind::Credential { kinds: &["smtp"] }, "\"\"").literal(),
    p("from", text("Flujos <flujos@example.com>"), "\"\""),
    p("to", text("equipo@example.com"), "\"\""),
    p("cc", text(""), "\"\""),
    p("bcc", text(""), "\"\""),
    p("replyTo", text(""), "\"\""),
    p("subject", text(""), "\"\""),
    p("body", long_text(""), "\"\""),
    p("html", Kind::Boolean, "false"),
    p("attachments", Kind::Strings, "[]"),
    EACH,
];

const TRANSFER_OPS: &[&str] = &["list", "download", "upload", "rename", "delete", "mkdir"];
const TRANSFER: &[ParamSpec] = &[
    p("host", Kind::RemoteHost { kinds: FILE_HOSTS }, "\"\"").literal(),
    p("operation", select(TRANSFER_OPS), "\"list\"").literal(),
    p("remotePath", text("/srv/exportes"), "\"\""),
    p("prefix", text(""), "\"\"").when("operation", &["list"]),
    p("localPath", file_to_write("~/Descargas/reporte.csv", &["download"]), "\"\"").when("operation", &["download", "upload"]),
    p("overwrite", Kind::Boolean, "false").when("operation", &["download"]),
    p("newPath", text(""), "\"\"").when("operation", &["rename"]),
    p("isFolder", Kind::Boolean, "false").when("operation", &["delete"]),
];

const STORAGE: &[ParamSpec] = &[
    p("host", Kind::RemoteHost { kinds: STORAGE_HOSTS }, "\"\"").literal(),
    p("operation", select(TRANSFER_OPS), "\"list\"").literal(),
    p("remotePath", text("mi-bucket/reportes"), "\"\""),
    p("prefix", text(""), "\"\"").when("operation", &["list"]),
    p("localPath", file_to_write("~/Descargas/reporte.csv", &["download"]), "\"\"").when("operation", &["download", "upload"]),
    p("overwrite", Kind::Boolean, "false").when("operation", &["download"]),
    p("newPath", text(""), "\"\"").when("operation", &["rename"]),
    p("isFolder", Kind::Boolean, "false").when("operation", &["delete"]),
];

const SSH: &[ParamSpec] = &[
    p("host", Kind::RemoteHost { kinds: &["ssh"] }, "\"\"").literal(),
    p("command", Kind::Code { lang: "shell" }, "\"\""),
    ONCE,
    OUTPUT,
    FAIL_ON_EXIT,
];

const DOCKER: &[ParamSpec] = &[
    p("mode", select(&["runImage", "exec", "compose"]), "\"runImage\"").literal(),
    p("image", text("alpine:3"), "\"\"").when("mode", &["runImage"]),
    p("args", Kind::Strings, "[]").when("mode", &["runImage"]),
    p("env", Kind::KeyValue, "[]").when("mode", &["runImage", "exec"]),
    p("volumes", Kind::KeyValue, "[]").when("mode", &["runImage"]),
    p("workdir", text("/app"), "\"\"").when("mode", &["runImage"]),
    p("network", text(""), "\"\"").when("mode", &["runImage"]),
    p("remove", Kind::Boolean, "true").when("mode", &["runImage"]),
    p("container", text("api"), "\"\"").when("mode", &["exec"]),
    p("command", Kind::Code { lang: "shell" }, "\"\"").when("mode", &["exec"]),
    p("composeFile", file("~/proyectos/api/compose.yaml"), "\"\"").when("mode", &["compose"]),
    p("composeAction", select(&["up", "down", "ps", "logs"]), "\"up\"").when("mode", &["compose"]),
    ONCE,
    OUTPUT,
    FAIL_ON_EXIT,
];

const SQL: &[ParamSpec] = &[
    p("connection", Kind::DbConnection { kinds: SQL_ENGINES }, "\"\"").literal(),
    p("database", text(""), "\"\"").literal(),
    p("schema", text(""), "\"\"").literal(),
    p("queryText", Kind::Code { lang: "sql" }, "\"\""),
    p("queryParams", Kind::Strings, "[]"),
    p("maxRows", COUNT, "10000").literal(),
    EACH,
];

const MONGO: &[ParamSpec] = &[
    p("connection", Kind::DbConnection { kinds: &["mongodb"] }, "\"\"").literal(),
    p("database", text(""), "\"\"").literal(),
    p("queryText", Kind::Code { lang: "javascript" }, "\"db.coleccion.find({})\""),
    p("maxRows", COUNT, "10000").literal(),
    EACH,
];

const REDIS: &[ParamSpec] = &[
    p("connection", Kind::DbConnection { kinds: &["redis"] }, "\"\"").literal(),
    p("queryText", Kind::Code { lang: "shell" }, "\"\""),
    EACH,
];

const SHEET: &[ParamSpec] = &[
    p("operation", select(&["read", "write"]), "\"read\"").literal(),
    p("path", file_to_write("~/Documentos/pedidos.xlsx", &["write"]), "\"\""),
    p("fileFormat", select(&["auto", "csv", "tsv", "xlsx"]), "\"auto\"").literal(),
    p("sheet", text(""), "\"\""),
    p("header", Kind::Boolean, "true").literal(),
    p("delimiter", text(","), "\",\"").literal().when("fileFormat", &["auto", "csv"]),
    p("limit", COUNT, "0").when("operation", &["read"]),
    p("createFolders", Kind::Boolean, "true").literal().when("operation", &["write"]),
];

const FILE_RW: &[ParamSpec] = &[
    p("operation", select(&["read", "write", "addToEnd"]), "\"read\"").literal(),
    p("path", file_to_write("~/Documentos/notas.txt", &["write"]), "\"\""),
    p("readAs", select(&["text", "json", "lines", "base64"]), "\"text\"").literal().when("operation", &["read"]),
    p("target", text("content"), "\"content\"").literal().when("operation", &["read"]),
    p("content", long_text("{{ $json.text }}"), "\"\"").when("operation", &["write", "addToEnd"]),
    p("writeAs", select(&["text", "json", "base64"]), "\"text\"").literal().when("operation", &["write", "addToEnd"]),
    p("createFolders", Kind::Boolean, "true").literal().when("operation", &["write", "addToEnd"]),
];

const LIST: &[ParamSpec] = &[
    p("folder", Kind::Folder, "\"\""),
    p("pattern", text("*.csv"), "\"\""),
    p("recursive", Kind::Boolean, "false"),
    p("entryKinds", select(&["files", "folders", "both"]), "\"files\"").literal(),
    p("newerThanMinutes", COUNT, "0"),
    p("sortBy", select(&["name", "modified", "size"]), "\"name\"").literal(),
    p("limit", COUNT, "0"),
];

const MOVE: &[ParamSpec] = &[
    p("operation", select(&["move", "copy", "rename", "trash"]), "\"move\"").literal(),
    p("source", file("{{ $json.file.path }}"), "\"\""),
    p("destPath", text("~/Documentos/procesados/"), "\"\"").when("operation", &["move", "copy"]),
    p("newName", text(""), "\"\"").when("operation", &["rename"]),
    p("overwrite", Kind::Boolean, "false").when("operation", &["move", "copy", "rename"]),
];

const GIT_OPS: &[&str] = &["status", "makeCommit", "pull", "push", "fetch", "checkout", "createTag", "diff", "log"];
const GIT: &[ParamSpec] = &[
    p("project", Kind::Project, "\"\"").literal(),
    p("repoPath", Kind::Folder, "\"\"").literal(),
    p("operation", select(GIT_OPS), "\"status\"").literal(),
    p("message", text(""), "\"\"").when("operation", &["makeCommit", "createTag"]),
    p("stageAll", Kind::Boolean, "true").when("operation", &["makeCommit"]),
    p("remote", text("origin"), "\"origin\"").when("operation", &["pull", "push", "fetch"]),
    p("branch", text(""), "\"\"").when("operation", &["push", "checkout"]),
    p("create", Kind::Boolean, "false").when("operation", &["checkout"]),
    p("pushTags", Kind::Boolean, "false").when("operation", &["push"]),
    p("tag", text("v1.0.0"), "\"\"").when("operation", &["createTag"]),
    p("base", text("main"), "\"\"").when("operation", &["diff"]),
    p("maxCount", COUNT, "20").when("operation", &["log"]),
];

const PULL_REQUEST: &[ParamSpec] = &[
    p("project", Kind::Project, "\"\"").literal(),
    p("operation", select(&["create", "comment", "merge"]), "\"create\"").literal(),
    p("title", text(""), "\"\"").when("operation", &["create"]),
    p("description", long_text(""), "\"\"").when("operation", &["create"]),
    p("sourceBranch", text(""), "\"\"").when("operation", &["create"]),
    p("targetBranch", text("main"), "\"main\"").when("operation", &["create"]),
    p("draft", Kind::Boolean, "false").when("operation", &["create"]),
    p("prId", text("{{ $json.id }}"), "\"\"").when("operation", &["comment", "merge"]),
    p("body", long_text(""), "\"\"").when("operation", &["comment"]),
    p("mergeMethod", select(&["merge", "squash", "rebase"]), "\"merge\"").when("operation", &["merge"]),
    p("deleteSourceBranch", Kind::Boolean, "false").when("operation", &["merge"]),
];

/// A pipeline of a linked repository: started, or a run followed — its status, its end, the logs
/// of its jobs (the failed ones, for an AI to read) and its artifacts. A node saved before the
/// operations existed has none, and starts one, as it always did.
const PIPELINE_RUN: &[ParamSpec] = &[
    p("operation", select(&["launch", "status", "waitRun", "jobLogs", "artifacts"]), "\"launch\"").literal(),
    p("project", Kind::Project, "\"\"").literal(),
    p("definitionId", text("ci.yml"), "\"\"").when("operation", &["launch"]),
    p("ref", text(""), "\"\"").when("operation", &["launch"]),
    p("inputs", Kind::KeyValue, "[]").when("operation", &["launch"]),
    p("variables", Kind::KeyValue, "[]").when("operation", &["launch"]),
    p("runId", text("{{ $json.runId }}"), "\"\"").when("operation", &["status", "waitRun", "jobLogs", "artifacts"]),
    p("waitEnd", Kind::Boolean, "true").literal().when("operation", &["launch"]),
    p("timeoutMin", COUNT, "60").literal().when("operation", &["launch", "waitRun"]),
    p("failOnFailure", Kind::Boolean, "true").literal().when("operation", &["launch", "waitRun"]),
    p("jobs", select(&["failedJobs", "allJobs"]), "\"failedJobs\"").literal().when("operation", &["jobLogs"]),
    p("maxChars", COUNT, "20000").literal().when("operation", &["jobLogs"]),
    p("download", Kind::Boolean, "false").literal().when("operation", &["artifacts"]),
    p("folder", Kind::Folder, "\"\"").when("operation", &["artifacts"]),
];

const NOTE: &[ParamSpec] = &[
    p("operation", select(&["create", "addToEnd"]), "\"create\"").literal(),
    p("title", text(""), "\"\"").when("operation", &["create"]),
    p("tags", text(""), "\"\"").when("operation", &["create"]),
    p("note", Kind::Note, "\"\"").literal().when("operation", &["addToEnd"]),
    p("content", long_text(""), "\"\""),
];

const REVIEWER: &[ParamSpec] = &[
    p("project", Kind::Project, "\"\"").literal(),
    p("prepare", text(""), "\"\"").literal(),
    p("build", text(""), "\"\"").literal(),
    p("test", text(""), "\"\"").literal(),
    p("exclusions", text(""), "\"\"").literal(),
    p("failOnGate", Kind::Boolean, "false").literal(),
];

const OPEN: &[ParamSpec] = &[
    p("openKind", select(&["url", "file", "folder", "view"]), "\"url\"").literal(),
    p("openTarget", text("https://example.com"), "\"\""),
];

const TERMINAL: &[ParamSpec] = &[
    p("project", Kind::Project, "\"\"").literal(),
    p("cwd", Kind::Folder, "\"\""),
    p("command", Kind::Code { lang: "shell" }, "\"\""),
];

const CLIPBOARD: &[ParamSpec] = &[p("text", long_text("{{ $json.text }}"), "\"={{ $json.text }}\"")];

const VAULT: &[ParamSpec] = &[
    p("item", Kind::VaultItem, "\"\"").literal(),
    p("itemField", text("password"), "\"password\"").literal(),
    p("target", text("secret"), "\"secret\"").literal(),
];

const RATE_LIMIT: &[ParamSpec] = &[
    p("amount", Kind::Number { min: Some(1.0), max: None }, "10").literal(),
    p("per", select(&["second", "minute", "hour"]), "\"second\"").literal(),
    p("overflow", select(&["queue", "drop"]), "\"queue\"").literal(),
];

const CONVERT_OPS: &[&str] = &["toCsv", "fromCsv", "toXml", "fromXml", "toYaml", "fromYaml", "markdownToHtml", "toJsonText", "fromJsonText"];
const CONVERT: &[ParamSpec] = &[
    p("operation", select(CONVERT_OPS), "\"toCsv\"").literal(),
    p("inputField", text("data"), "\"\"").literal(),
    p("target", text(""), "\"\"").literal(),
    p("delimiter", text(","), "\",\"").literal().when("operation", &["toCsv", "fromCsv"]),
    p("header", Kind::Boolean, "true").literal().when("operation", &["toCsv", "fromCsv"]),
    p("allItems", Kind::Boolean, "true").literal().when("operation", &["toCsv"]),
    p("xmlRoot", text("root"), "\"\"").literal().when("operation", &["toXml"]),
    p("pretty", Kind::Boolean, "false").literal().when("operation", &["toJsonText"]),
];

const CRYPTO: &[ParamSpec] = &[
    p(
        "operation",
        select(&["hash", "hmac", "uuid", "base64Encode", "base64Decode", "random", "jwtSign", "jwtVerify", "encrypt", "decrypt"]),
        "\"hash\"",
    )
    .literal(),
    p("value", text("{{ $json.text }}"), "\"\"")
        .when("operation", &["hash", "hmac", "base64Encode", "base64Decode", "jwtVerify", "encrypt", "decrypt"]),
    p("algorithm", raw_select(&["sha256", "sha512", "sha1", "md5"]), "\"sha256\"").literal().when("operation", &["hash", "hmac"]),
    p("payload", Kind::Code { lang: "json" }, "\"{}\"").when("operation", &["jwtSign"]),
    p("jwtAlgorithm", raw_select(&["HS256", "HS384", "HS512"]), "\"HS256\"").literal().when("operation", &["jwtSign", "jwtVerify"]),
    p("expiresInSec", COUNT, "3600").when("operation", &["jwtSign"]),
    p("credential", Kind::Credential { kinds: &["hmac"] }, "\"\"")
        .literal()
        .when("operation", &["hmac", "jwtSign", "jwtVerify", "encrypt", "decrypt"]),
    p("secret", text(""), "\"\"").when("operation", &["hmac", "jwtSign", "jwtVerify", "encrypt", "decrypt"]),
    p("encoding", select(&["hex", "base64"]), "\"hex\"").literal().when("operation", &["hash", "hmac", "random"]),
    p("length", COUNT, "16").when("operation", &["random"]),
    p("target", text(""), "\"\"").literal(),
];

const COMPRESS: &[ParamSpec] = &[
    p("operation", select(&["zip", "unzip", "tarGz", "untarGz", "gzip", "gunzip"]), "\"zip\"").literal(),
    p("source", text("{{ $json.file.path }}"), "\"\""),
    p("sources", Kind::Strings, "[]").when("operation", &["zip", "tarGz"]),
    p("destPath", text(""), "\"\""),
    p("target", text(""), "\"\"").literal(),
];

const COMPARE: &[ParamSpec] = &[
    p("keyA", text("id"), "\"id\"").literal(),
    p("keyB", text(""), "\"\"").literal(),
    p("fields", Kind::Strings, "[]").literal(),
];

const NOTEBOOK: &[ParamSpec] = &[
    p("path", file("~/Notebooks/informe.ipynb"), "\"\""),
    p("kernelName", text("python3"), "\"\"").literal(),
    p("notebookParams", Kind::Code { lang: "json" }, "\"{}\""),
    p("saveRun", select(&["none", "overwrite", "saveCopy"]), "\"none\"").literal(),
    p("copyPath", file_to_write("~/Notebooks/informe-ejecutado.ipynb", &["*"]), "\"\"").when("saveRun", &["saveCopy"]),
    RUN_FOR,
];

const CONNECTOR: &[ParamSpec] = &[
    p("call", Kind::Connector, r#"{"connector":"slack","operation":"postMessage","fields":{}}"#).literal(),
    // Narrowed to what the chosen connector takes (`Connector::credential_kinds`) by the form.
    p("credential", Kind::Credential { kinds: &["bearer", "basic", "webhook", "oauth2"] }, "\"\"").literal(),
    TIMEOUT_MS,
    EACH,
];

/// A chat model over its provider's API (`nodes::llm`): OpenAI, Anthropic, Gemini or any
/// OpenAI-compatible server, with an API key.
const API_CHAT: &[ParamSpec] = &[
    p("apiProvider", select(&["openaiApi", "anthropic", "gemini", "compatible"]), "\"openaiApi\"").literal(),
    p("baseUrl", text("https://api.example.com/v1"), "\"\"").literal().when("apiProvider", &["compatible"]),
    p("credential", Kind::Credential { kinds: &["bearer"] }, "\"\"").literal(),
    p("apiModel", Kind::ApiModel { purpose: "chat" }, "\"\"").literal(),
    p("system", long_text(""), "\"\""),
    p("prompt", long_text("Resume este texto en una línea: {{ $json.text }}"), "\"\""),
    p("output", select(&["text", "json", "schema"]), "\"text\"").literal(),
    ANSWER_FIELDS.when("output", &["json"]),
    ANSWER_SCHEMA.when("output", &["schema"]),
    p("temperature", Kind::Number { min: Some(0.0), max: Some(2.0) }, "0.2"),
    p("maxTokens", Kind::Number { min: Some(16.0), max: None }, "1024"),
    AI_RUN_FOR,
];

const EMBED_PROVIDER: ParamSpec = p("embedProvider", select(&["openaiApi", "gemini", "compatible", "ollama"]), "\"openaiApi\"").literal();
const EMBED_URL: ParamSpec = p("embedUrl", text("http://127.0.0.1:11434"), "\"\"").literal().when("embedProvider", &["compatible", "ollama"]);
const EMBED_MODEL: ParamSpec = p("embedModel", Kind::ApiModel { purpose: "embed" }, "\"\"").literal();

/// Text to vectors (`nodes::llm`): one per item, written into the item.
const EMBED: &[ParamSpec] = &[
    EMBED_PROVIDER,
    EMBED_URL,
    p("credential", Kind::Credential { kinds: &["bearer"] }, "\"\"").literal(),
    EMBED_MODEL,
    p("embedText", long_text("{{ $json.text }}"), "\"={{ $json.text }}\""),
    p("targetField", text("embedding"), "\"embedding\"").literal(),
];

/// Store and search documents by meaning (`nodes::llm`): CodeFlow's own store, Qdrant or pgvector,
/// embedding with the model it names.
const VECTORS: &[ParamSpec] = &[
    p("vectorStore", select(&["local", "qdrant", "pgvector"]), "\"local\"").literal(),
    p("vectorOp", select(&["vectorUpsert", "vectorQuery", "vectorDelete"]), "\"vectorUpsert\"").literal(),
    p("collection", text("documentos"), "\"\"").literal(),
    p("qdrantUrl", text("http://localhost:6333"), "\"\"").literal().when("vectorStore", &["qdrant"]),
    p("storeCredential", Kind::Credential { kinds: &["header", "bearer"] }, "\"\"").literal().when("vectorStore", &["qdrant"]),
    p("connection", Kind::DbConnection { kinds: &["postgres", "supabase"] }, "\"\"").literal().when("vectorStore", &["pgvector"]),
    EMBED_PROVIDER.when("vectorOp", &["vectorUpsert", "vectorQuery"]),
    EMBED_URL.and_when("vectorOp", &["vectorUpsert", "vectorQuery"]),
    p("credential", Kind::Credential { kinds: &["bearer"] }, "\"\"").literal().when("vectorOp", &["vectorUpsert", "vectorQuery"]),
    EMBED_MODEL.when("vectorOp", &["vectorUpsert", "vectorQuery"]),
    p("docText", long_text("{{ $json.text }}"), "\"={{ $json.text }}\"").when("vectorOp", &["vectorUpsert"]),
    p("docId", text("{{ $json.path }}"), "\"\"").when("vectorOp", &["vectorUpsert"]),
    p("chunkSize", COUNT, "1000").when("vectorOp", &["vectorUpsert"]),
    p("chunkOverlap", COUNT, "150").when("vectorOp", &["vectorUpsert"]),
    p("keepItem", Kind::Boolean, "true").when("vectorOp", &["vectorUpsert"]),
    p("queryText", long_text("{{ $json.question }}"), "\"={{ $json.question }}\"").when("vectorOp", &["vectorQuery"]),
    p("topK", Kind::Number { min: Some(1.0), max: None }, "4").when("vectorOp", &["vectorQuery"]),
    p("minScore", Kind::Number { min: Some(0.0), max: Some(1.0) }, "0").when("vectorOp", &["vectorQuery"]),
    p("docIds", text("informe.pdf, guia.md"), "\"\"").when("vectorOp", &["vectorDelete"]),
];

/// The PR analyzer's pull requests (`nodes::prs`): a page of them, or one with its checks, the
/// decision already given on it and where its last review stands.
const PR_LIST: &[ParamSpec] = &[
    p("project", Kind::Project, "\"\"").literal(),
    p("prOp", select(&["prList", "prGet"]), "\"prList\"").literal(),
    p("prState", select(&["openPrs", "closedPrs", "allPrs"]), "\"openPrs\"").literal().when("prOp", &["prList"]),
    p("maxResults", COUNT, "20").when("prOp", &["prList"]),
    p("prId", text("{{ $json.id }}"), "\"\"").when("prOp", &["prGet"]),
];

/// Deciding on a pull request (`nodes::prs`) — by hand, or by the gate of its last review.
const PR_DECIDE: &[ParamSpec] = &[
    p("project", Kind::Project, "\"\"").literal(),
    p("prId", text("{{ $json.id }}"), "\"\""),
    p("prDecision", select(&["byReview", "approvePr", "requestChanges", "closePr"]), "\"byReview\"").literal(),
    p("decisionNote", long_text(""), "\"\""),
    p("postSummary", Kind::Boolean, "true").literal(),
];

/// A pull request's comment threads (`nodes::prs`): read, or answered and closed.
const PR_COMMENTS: &[ParamSpec] = &[
    p("project", Kind::Project, "\"\"").literal(),
    p("prId", text("{{ $json.id }}"), "\"\""),
    p("threadOp", select(&["listThreads", "resolveThread"]), "\"listThreads\"").literal(),
    p("threadIds", text("{{ $json.id }}"), "\"\"").when("threadOp", &["resolveThread"]),
    p("reply", long_text("{{ $json.draft }}"), "\"\"").when("threadOp", &["resolveThread"]),
    p("wontFix", Kind::Boolean, "false").when("threadOp", &["resolveThread"]),
];

/// The review memory (`nodes::prs`): saved runs, their findings by state, a finding marked, and
/// the repository's standing false positives.
const PR_MEMORY: &[ParamSpec] = &[
    p("project", Kind::Project, "\"\"").literal(),
    p("memoryOp", select(&["memoryFindings", "memoryMark", "memoryRuns", "memoryRules"]), "\"memoryFindings\"").literal(),
    p("prId", text("{{ $json.id }}"), "\"\"").when("memoryOp", &["memoryFindings", "memoryMark", "memoryRuns"]),
    p("findingState", select(&["activeFindings", "resolvedFindings", "discardedFindings", "allFindings"]), "\"activeFindings\"")
        .literal()
        .when("memoryOp", &["memoryFindings"]),
    p("findingIds", text("{{ $json.id }}"), "\"\"").when("memoryOp", &["memoryMark"]),
    p("markAs", select(&["falsePositive", "ignored", "unmark"]), "\"falsePositive\"").literal().when("memoryOp", &["memoryMark"]),
    p("reason", text("Es intencional"), "\"\"").when("markAs", &["falsePositive", "ignored"]),
    p("wholeRepo", Kind::Boolean, "false").literal().when("markAs", &["falsePositive"]),
    p("notifyPr", Kind::Boolean, "true").literal().when("markAs", &["falsePositive", "ignored"]),
];

/// RabbitMQ, Kafka or SQS (`nodes::queue`): publish, or take messages. A field of one broker and one
/// operation carries both conditions.
const QUEUE: &[ParamSpec] = &[
    p("broker", select(&["rabbitmq", "kafka", "sqs"]), "\"rabbitmq\"").literal(),
    p("queueOp", select(&["queuePublish", "queueReceive"]), "\"queuePublish\"").literal(),
    p("credential", Kind::Credential { kinds: &["basic", "aws"] }, "\"\"").literal(),
    p("amqpUrl", text("amqp://rabbit.example.com:5672/%2f"), "\"\"").literal().when("broker", &["rabbitmq"]),
    p("exchange", text(""), "\"\"").when("broker", &["rabbitmq"]).and_when("queueOp", &["queuePublish"]),
    p("routingKey", text("pedidos"), "\"\"").when("broker", &["rabbitmq"]).and_when("queueOp", &["queuePublish"]),
    p("persistent", Kind::Boolean, "true").when("broker", &["rabbitmq"]).and_when("queueOp", &["queuePublish"]),
    p("queueName", text("pedidos"), "\"\"").when("broker", &["rabbitmq"]).and_when("queueOp", &["queueReceive"]),
    p("brokers", text("kafka.example.com:9092"), "\"\"").literal().when("broker", &["kafka"]),
    p("topic", text("pedidos"), "\"\"").literal().when("broker", &["kafka"]),
    p("partition", COUNT, "0").literal().when("broker", &["kafka"]),
    p("tls", Kind::Boolean, "false").literal().when("broker", &["kafka"]),
    p("saslMechanism", select(&["plain", "scramSha256", "scramSha512"]), "\"plain\"").literal().when("broker", &["kafka"]),
    p("messageKey", text("{{ $json.id }}"), "\"\"").when("broker", &["kafka"]).and_when("queueOp", &["queuePublish"]),
    p("startFrom", select(&["continue", "earliest"]), "\"continue\"").literal().when("broker", &["kafka"]).and_when("queueOp", &["queueReceive"]),
    p("queueUrl", text("https://sqs.us-east-1.amazonaws.com/123456789012/pedidos"), "\"\"").when("broker", &["sqs"]),
    p("messageGroupId", text(""), "\"\"").when("broker", &["sqs"]).and_when("queueOp", &["queuePublish"]),
    p("waitSeconds", Kind::Number { min: Some(0.0), max: Some(20.0) }, "0").when("broker", &["sqs"]).and_when("queueOp", &["queueReceive"]),
    p("message", long_text("{{ JSON.stringify($json) }}"), "\"={{ JSON.stringify($json) }}\"").when("queueOp", &["queuePublish"]),
    p("messageHeaders", Kind::KeyValue, "[]").when("queueOp", &["queuePublish"]),
    p("messageLimit", Kind::Number { min: Some(1.0), max: None }, "10").when("queueOp", &["queueReceive"]),
    p("leaveInQueue", Kind::Boolean, "false").when("broker", &["rabbitmq", "sqs"]).and_when("queueOp", &["queueReceive"]),
    EACH,
];

/// A mailbox over IMAP (`nodes::imap`): read, mark read, move.
const IMAP: &[ParamSpec] = &[
    p("credential", Kind::Credential { kinds: &["imap"] }, "\"\"").literal(),
    p("imapOp", select(&["imapRead", "imapMarkRead", "imapMove"]), "\"imapRead\"").literal(),
    p("mailbox", text("INBOX"), "\"INBOX\""),
    p("imapCriteria", text("UNSEEN FROM \"facturas@example.com\""), "\"UNSEEN\"").when("imapOp", &["imapRead"]),
    p("maxResults", COUNT, "10").when("imapOp", &["imapRead"]),
    p("markRead", Kind::Boolean, "false").when("imapOp", &["imapRead"]),
    p("attachmentsFolder", Kind::Folder, "\"\"").when("imapOp", &["imapRead"]),
    p("uids", text("{{ $json.uid }}"), "\"\"").when("imapOp", &["imapMarkRead", "imapMove"]),
    p("targetMailbox", text("Archivo/Facturas"), "\"\"").when("imapOp", &["imapMove"]),
    EACH,
];

/// Gmail, Sheets, Calendar and Drive (`nodes::google`): one operation picker per service, so each
/// service's fields show only under it.
const GOOGLE: &[ParamSpec] = &[
    p("credential", Kind::Credential { kinds: &["oauth2"] }, "\"\"").literal(),
    p("service", select(&["gmail", "sheets", "calendar", "drive"]), "\"gmail\"").literal(),
    p("gmailOp", select(&["gmailSend", "gmailSearch", "gmailGet", "gmailMarkRead"]), "\"gmailSend\"").literal().when("service", &["gmail"]),
    p("from", text(""), "\"\"").when("gmailOp", &["gmailSend"]),
    p("to", text("equipo@example.com"), "\"\"").when("gmailOp", &["gmailSend"]),
    p("cc", text(""), "\"\"").when("gmailOp", &["gmailSend"]),
    p("bcc", text(""), "\"\"").when("gmailOp", &["gmailSend"]),
    p("subject", text(""), "\"\"").when("gmailOp", &["gmailSend"]),
    p("body", long_text(""), "\"\"").when("gmailOp", &["gmailSend"]),
    p("html", Kind::Boolean, "false").when("gmailOp", &["gmailSend"]),
    p("attachments", Kind::Strings, "[]").when("gmailOp", &["gmailSend"]),
    p("gmailQuery", text("from:facturas@example.com is:unread"), "\"\"").when("gmailOp", &["gmailSearch"]),
    p("maxResults", COUNT, "10").when("gmailOp", &["gmailSearch"]),
    p("messageId", text(""), "\"\"").when("gmailOp", &["gmailGet", "gmailMarkRead"]),
    p("attachmentsFolder", Kind::Folder, "\"\"").when("gmailOp", &["gmailSearch", "gmailGet"]),
    p("sheetsOp", select(&["sheetsRead", "sheetsAppend", "sheetsUpdate"]), "\"sheetsRead\"").literal().when("service", &["sheets"]),
    p("spreadsheetId", text("https://docs.google.com/spreadsheets/d/…"), "\"\"").when("service", &["sheets"]),
    p("sheetRange", text("Hoja1"), "\"Hoja1\"").when("service", &["sheets"]),
    p("header", Kind::Boolean, "true").literal().when("sheetsOp", &["sheetsRead"]),
    p("rowLimit", COUNT, "0").when("sheetsOp", &["sheetsRead"]),
    p("columns", Kind::KeyValue, "[]").when("sheetsOp", &["sheetsAppend", "sheetsUpdate"]),
    p("matchColumn", text("id"), "\"\"").literal().when("sheetsOp", &["sheetsUpdate"]),
    p("matchValue", text(""), "\"\"").when("sheetsOp", &["sheetsUpdate"]),
    p("ifMissing", select(&["skipRow", "appendRow"]), "\"skipRow\"").literal().when("sheetsOp", &["sheetsUpdate"]),
    p("calendarOp", select(&["calendarList", "calendarCreate"]), "\"calendarList\"").literal().when("service", &["calendar"]),
    p("calendarId", text("primary"), "\"\"").when("service", &["calendar"]),
    p("rangeStart", text("2026-10-05"), "\"\"").when("calendarOp", &["calendarList"]),
    p("rangeEnd", text(""), "\"\"").when("calendarOp", &["calendarList"]),
    p("eventSearch", text(""), "\"\"").when("calendarOp", &["calendarList"]),
    p("eventLimit", COUNT, "50").when("calendarOp", &["calendarList"]),
    p("eventTitle", text("Revisión del despliegue"), "\"\"").when("calendarOp", &["calendarCreate"]),
    p("startTime", text("2026-10-05 09:30"), "\"\"").when("calendarOp", &["calendarCreate"]),
    p("endTime", text(""), "\"\"").when("calendarOp", &["calendarCreate"]),
    p("allDay", Kind::Boolean, "false").when("calendarOp", &["calendarCreate"]),
    p("description", long_text(""), "\"\"").when("calendarOp", &["calendarCreate"]),
    p("eventLocation", text(""), "\"\"").when("calendarOp", &["calendarCreate"]),
    p("attendees", Kind::Strings, "[]").when("calendarOp", &["calendarCreate"]),
    p("notifyAttendees", Kind::Boolean, "false").when("calendarOp", &["calendarCreate"]),
    p("driveOp", select(&["driveList", "driveUpload", "driveDownload"]), "\"driveList\"").literal().when("service", &["drive"]),
    p("driveQuery", text("name contains 'informe'"), "\"\"").when("driveOp", &["driveList"]),
    p("driveFolder", text(""), "\"\"").when("driveOp", &["driveList", "driveUpload"]),
    p("fileLimit", COUNT, "50").when("driveOp", &["driveList"]),
    p("filePath", file("~/Documentos/informe.pdf"), "\"\"").when("driveOp", &["driveUpload"]),
    p("fileId", text(""), "\"\"").when("driveOp", &["driveDownload"]),
    p("folder", Kind::Folder, "\"\"").when("driveOp", &["driveDownload"]),
    p("fileName", text(""), "\"\"").when("driveOp", &["driveUpload", "driveDownload"]),
    p("exportAs", select(&["pdf", "docx", "xlsx", "csv", "pptx", "txt", "md", "png"]), "\"pdf\"").literal().when("driveOp", &["driveDownload"]),
    p("overwrite", Kind::Boolean, "false").when("driveOp", &["driveDownload"]),
    EACH,
];

const PHONE: &[ParamSpec] = &[p("label", text("Publicar el reporte"), "\"\"").literal()];

const LOOP: &[ParamSpec] = &[p("batchSize", Kind::Number { min: Some(1.0), max: None }, "10").literal()];

const LISTEN: &[ParamSpec] = &[
    p("transport", select(&["websocket", "socketio", "mqtt", "sse"]), "\"websocket\"").literal(),
    p("url", text("wss://example.com/socket"), "\"\"").literal(),
    p("credential", Kind::Credential { kinds: &["bearer", "basic", "header", "query"] }, "\"\"").literal(),
    p("subscribeMessage", text(""), "\"\"").literal().when("transport", &["websocket"]),
    p("topic", text("sensores/#"), "\"\"").literal().when("transport", &["mqtt"]),
    p("qos", Kind::Number { min: Some(0.0), max: Some(2.0) }, "0").literal().when("transport", &["mqtt"]),
    p("clientId", text(""), "\"\"").literal().when("transport", &["mqtt"]),
    p("socketPath", text("/socket.io"), "\"/socket.io\"").literal().when("transport", &["socketio"]),
    p("namespace", text("/"), "\"/\"").literal().when("transport", &["socketio"]),
    p("version", raw_select(&["v4", "v3"]), "\"v4\"").literal().when("transport", &["socketio"]),
    p("auth", Kind::Code { lang: "json" }, "\"\"").literal().when("transport", &["socketio"]),
    p("event", text(""), "\"\"").literal().when("transport", &["socketio", "sse"]),
    p("reconnect", Kind::Boolean, "true").literal(),
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
        "trigger.github" => GITHUB_TRIGGER,
        "trigger.email" => EMAIL_TRIGGER,
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
        "ai.prReview" => PR_REVIEW,
        "ai.chat" => CHAT,
        "data.dbml" => DBML,
        "app.apiRequest" => API_REQUEST,
        "net.webPage" => WEB_PAGE,
        "net.check" => SITE_CHECK,
        "logic.until" => UNTIL,
        "transform.changes" => CHANGES,
        "transform.template" => TEMPLATE,
        "transform.json" => JSON_TOOL,
        "transform.sql" => SQL_ITEMS,
        "files.pdf" => PDF,
        "files.image" => IMAGE,
        "trigger.manual" => MANUAL,
        "ai.commit" => COMMIT,
        "app.agent" => AGENT_TASK,
        "net.graphql" => GRAPHQL,
        "net.websocket" => WEBSOCKET,
        "net.socketio" => SOCKETIO,
        "net.grpc" => GRPC,
        "net.mqtt" => MQTT,
        "net.sse" => SSE,
        "net.download" => DOWNLOAD,
        "net.email" => EMAIL,
        "net.transfer" => TRANSFER,
        "net.storage" => STORAGE,
        "code.ssh" => SSH,
        "code.docker" => DOCKER,
        "data.sql" => SQL,
        "data.mongo" => MONGO,
        "data.redis" => REDIS,
        "data.sheet" => SHEET,
        "files.file" => FILE_RW,
        "files.list" => LIST,
        "files.move" => MOVE,
        "files.git" => GIT,
        "files.pr" => PULL_REQUEST,
        "files.pipeline" => PIPELINE_RUN,
        "app.note" => NOTE,
        "app.reviewer" => REVIEWER,
        "app.open" => OPEN,
        "app.terminal" => TERMINAL,
        "app.clipboard" => CLIPBOARD,
        "app.vault" => VAULT,
        "logic.ratelimit" => RATE_LIMIT,
        "transform.convert" => CONVERT,
        "transform.crypto" => CRYPTO,
        "transform.compress" => COMPRESS,
        "transform.compare" => COMPARE,
        "trigger.listen" => LISTEN,
        "logic.loop" => LOOP,
        "logic.approval" => APPROVAL,
        "trigger.phone" => PHONE,
        "net.connector" => CONNECTOR,
        "net.google" => GOOGLE,
        "net.imap" => IMAP,
        "net.queue" => QUEUE,
        "ai.api" => API_CHAT,
        "ai.prFix" => PR_FIX,
        "ai.prReply" => PR_REPLY,
        "app.prList" => PR_LIST,
        "app.prDecide" => PR_DECIDE,
        "app.prComments" => PR_COMMENTS,
        "app.prMemory" => PR_MEMORY,
        "ai.embed" => EMBED,
        "ai.vectors" => VECTORS,
        "code.notebook" => NOTEBOOK,
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
                for show in spec.show_if.iter().chain(spec.also_if.iter()) {
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
