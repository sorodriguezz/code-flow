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
    /// A table of Flujos' own (`flows::tables`), by name — picked or typed, made on first write.
    FlowTable,
    /// A collection or folder of the API client: `collection:<id>` or `folder:<id>`.
    ApiCollection,
    /// `[{ name, kind }]` — the columns fake data is made of (`nodes::textkit::fake`).
    FakeFields,
    /// `[{ field, check, arg }]` — what each item must satisfy (`nodes::textkit::validate`).
    ValidationRules,
    /// `{ name: value }` — the inputs the called flow declares, filled per item (a custom node).
    SubflowInputs,
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
    // Installed once per set into an environment of their own (`uv` when there is one).
    p("packages", Kind::Strings, "[]").literal(),
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
    p("packages", Kind::Strings, "[]").literal(),
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
    p("body", select(&["none", "json", "form", "text", "binaryBody"]), "\"none\""),
    p("bodyJson", Kind::Code { lang: "json" }, "\"{}\"").when("body", &["json"]),
    p("bodyFile", file("{{ $json.file.path }}"), "\"\"").when("body", &["binaryBody"]),
    p("bodyForm", Kind::KeyValue, "[]").when("body", &["form"]),
    p("bodyText", long_text(""), "\"\"").when("body", &["text"]),
    p("contentType", text("text/plain"), "\"text/plain\"").when("body", &["text"]),
    p("response", select(&["auto", "json", "text"]), "\"auto\""),
    // A binary answer: kept as a file of the run (its reference in the item), or inline as base64.
    p("binaryAs", select(&["binaryFile", "binaryBase64"]), "\"binaryFile\"").literal(),
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
    // `collect` and `takeAll` are the digest: collect across runs, hand everything over at once.
    p("operation", select(&["get", "set", "increment", "delete", "collect", "takeAll"]), "\"get\"").literal(),
    p("key", text("lastId"), "\"\""),
    // A value that forgets itself — a cache, a token, a window: read back as missing once it expires.
    p("ttlSec", COUNT, "0").when("operation", &["set", "increment", "collect"]),
    p("value", text(""), "\"\"").when("operation", &["set", "collect"]),
    p("amount", NUMBER, "1").when("operation", &["increment"]),
    p("fallback", text(""), "\"\"").when("operation", &["get"]),
    p("keepAtMost", COUNT, "1000").literal().when("operation", &["collect"]),
    p("target", text("value"), "\"value\"").when("operation", &["get", "increment", "takeAll"]),
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
    // How many case outputs it has before "other" — its ports (`catalog::output_count`).
    p("caseCount", Kind::Number { min: Some(1.0), max: Some(20.0) }, "3").literal(),
    p("mode", select(&["rules", "expression"]), "\"rules\"").literal(),
    p("rules", Kind::Rules, r#"[{"output":0,"left":"","op":"equals","right":""}]"#).literal().when("mode", &["rules"]),
    p("output", text("{{ $json.priority }}"), "\"\"").when("mode", &["expression"]),
    p("allMatching", Kind::Boolean, "false").literal().when("mode", &["rules"]),
    p("ignoreCase", Kind::Boolean, "false").literal().when("mode", &["rules"]),
];

const MERGE: &[ParamSpec] = &[
    // How many inputs it joins — its ports (`catalog::input_count`).
    p("inputCount", Kind::Number { min: Some(2.0), max: Some(10.0) }, "2").literal(),
    p("mode", select(&["append", "position", "field", "choose"]), "\"append\"").literal(),
    p("field1", text("id"), "\"\"").when("mode", &["field"]),
    p("field2", text("id"), "\"\"").when("mode", &["field"]),
    p("join", select(&["inner", "left", "outer"]), "\"inner\"").literal().when("mode", &["field"]),
    p("prefer", select(&["input1", "input2"]), "\"input2\"").literal().when("mode", &["position", "field"]),
    p("choose", select(&["input1", "input2", "input3", "input4", "input5", "input6", "input7", "input8", "input9", "input10"]), "\"input1\"")
        .literal()
        .when("mode", &["choose"]),
];

const WAIT: &[ParamSpec] = &[
    p("mode", select(&["duration", "until", "webhook", "waitForm"]), "\"duration\"").literal(),
    p("amount", COUNT, "5").when("mode", &["duration"]),
    p("unit", select(&["seconds", "minutes", "hours", "days"]), "\"seconds\"").when("mode", &["duration"]),
    p("until", text("2026-12-31T09:00"), "\"\"").when("mode", &["until"]),
    p("timeoutHours", COUNT, "0").literal().when("mode", &["webhook", "waitForm"]),
    p("formTitle", text("Datos para continuar"), "\"\"").when("mode", &["waitForm"]),
    p("fields", Kind::FormFields, "[]").literal().when("mode", &["waitForm"]),
];

const APPROVAL: &[ParamSpec] = &[
    p("message", long_text("¿Publicar el reporte de {{ $json.fecha }}?"), "\"\""),
    p("timeoutHours", COUNT, "0").literal(),
    p("onTimeout", select(&["reject", "fail"]), "\"reject\"").literal(),
    // Where else the question goes, with links that decide it (through the tunnel when one is up).
    p("approvalVia", Kind::MultiSelect { options: &["viaTelegram", "viaSlack", "viaEmail"] }, "[]").literal(),
    p("approvalCredential", Kind::Credential { kinds: &["bearer", "smtp"] }, "\"\"").literal(),
    p("approvalChat", text("123456789"), "\"\""),
    p("approvalTo", text("jefa@example.com"), "\"\""),
];

const STOP: &[ParamSpec] = &[p("message", text(""), "\"\"")];

// ------------------------------------------------------------------ transform

const SET: &[ParamSpec] = &[
    p("mode", select(&["manual", "json", "rename"]), "\"manual\"").literal(),
    p("assignments", Kind::Assignments, "[]").literal().when("mode", &["manual"]),
    p("json", Kind::Code { lang: "json" }, "\"{}\"").when("mode", &["json"]),
    p("renames", Kind::KeyValue, "[]").literal().when("mode", &["rename"]),
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
    p("mode", select(&["summarize", "all", "fields", "chunks"]), "\"summarize\"").literal(),
    p("groupBy", Kind::Strings, "[]").literal().when("mode", &["summarize"]),
    p("aggregations", Kind::Aggregations, r#"[{"op":"count","field":"","as":"count"}]"#).literal().when("mode", &["summarize"]),
    p("fields", Kind::Strings, "[]").literal().when("mode", &["fields"]),
    p("destination", text("data"), "\"data\"").literal().when("mode", &["all", "chunks"]),
    p("groupSize", Kind::Number { min: Some(1.0), max: None }, "10").literal().when("mode", &["chunks"]),
];

const DEDUPE: &[ParamSpec] = &[
    p("compare", select(&["all", "fields", "except"]), "\"all\"").literal(),
    p("fields", Kind::Strings, "[]").literal().when("compare", &["fields", "except"]),
    p("scope", select(&["run", "history"]), "\"run\"").literal(),
    p("historySize", COUNT, "10000").literal().when("scope", &["history"]),
];

const DATE_OPS: &[&str] = &[
    "format",
    "add",
    "subtract",
    "startOf",
    "endOf",
    "diff",
    "setZone",
    "extract",
    "now",
    "addBusinessDays",
    "isBusinessDay",
    "businessDaysBetween",
    "nextBusinessDay",
];
const DATE: &[ParamSpec] = &[
    p("operation", select(DATE_OPS), "\"format\"").literal(),
    p("value", text("{{ $json.date }}"), "\"\""),
    p("fromFormat", text("dd/MM/yyyy"), "\"\""),
    p("zone", text("America/Santiago"), "\"\""),
    p("amount", NUMBER, "1").when("operation", &["add", "subtract", "addBusinessDays"]),
    p("unit", select(&["years", "quarters", "months", "weeks", "days", "hours", "minutes", "seconds", "milliseconds"]), "\"days\"")
        .when("operation", &["add", "subtract", "startOf", "endOf", "diff"]),
    p("other", text("{{ $json.otherDate }}"), "\"\"").when("operation", &["diff", "businessDaysBetween"]),
    p("holidayCountry", text("CL"), "\"CL\"").literal().when("operation", &["addBusinessDays", "isBusinessDay", "businessDaysBetween", "nextBusinessDay"]),
    p("extraHolidays", Kind::Strings, "[]").when("operation", &["addBusinessDays", "isBusinessDay", "businessDaysBetween", "nextBusinessDay"]),
    p("toZone", text("UTC"), "\"UTC\"").when("operation", &["setZone"]),
    p(
        "part",
        select(&["year", "quarter", "month", "monthName", "weekNumber", "day", "weekday", "weekdayName", "hour", "minute", "second"]),
        "\"year\"",
    )
    .when("operation", &["extract"]),
    p("format", select(&["iso", "date", "unixMillis", "unixSeconds", "sql", "http", "relative", "custom"]), "\"iso\"")
        .when("operation", &["format", "add", "subtract", "startOf", "endOf", "setZone", "now", "addBusinessDays", "nextBusinessDay"]),
    p("customFormat", text("yyyy-MM-dd HH:mm"), "\"yyyy-MM-dd HH:mm\"").when("format", &["custom"]),
    p("target", text("date"), "\"date\""),
];

const TEXT_OPS: &[&str] = &["replace", "extract", "split", "join", "case", "trim", "truncate", "length", "textDiff"];
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
    p("diffWith", long_text("{{ $json.before }}"), "\"\"").when("operation", &["textDiff"]),
    p("diffFormat", select(&["unifiedDiff", "lineChanges"]), "\"unifiedDiff\"").literal().when("operation", &["textDiff"]),
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
    p("mode", select(&["interval", "times", "cron", "once"]), "\"interval\"").literal(),
    p("every", Kind::Number { min: Some(1.0), max: None }, "15").literal().when("mode", &["interval"]),
    p("unit", select(&["minutes", "hours", "days"]), "\"minutes\"").literal().when("mode", &["interval"]),
    p("at", Kind::Strings, "[\"09:00\"]").literal().when("mode", &["times"]),
    p("days", Kind::MultiSelect { options: &["mon", "tue", "wed", "thu", "fri", "sat", "sun"] }, r#"["mon","tue","wed","thu","fri"]"#)
        .literal()
        .when("mode", &["times"]),
    p("cron", text("*/15 8-19 * * 1-5"), "\"\"").literal().when("mode", &["cron"]),
    p("onceAt", text("2026-12-24 09:00"), "\"\"").literal().when("mode", &["once"]),
    p("timezone", text("America/Santiago"), "\"\"").literal(),
    p("catchUp", Kind::Boolean, "true").literal(),
    p("skipHolidays", Kind::Boolean, "false").literal().when("mode", &["interval", "times", "cron"]),
    p("holidayCountry", text("CL"), "\"CL\"").literal().when("skipHolidays", &["true"]),
];

const WEBHOOK: &[ParamSpec] = &[
    p("method", raw_select(&["POST", "GET", "PUT", "PATCH", "DELETE", "ANY"]), "\"POST\"").literal(),
    p("hookPath", text("pagos/alerta"), "\"\"").literal(),
    // The senders' own signature schemes, so a GitHub, Stripe, Slack or Shopify webhook is checked
    // the way they sign — the HMAC secret is the credential either way.
    p("auth", select(&["none", "bearer", "header", "hmac", "githubSig", "stripeSig", "slackSig", "shopifySig"]), "\"none\"").literal(),
    p("credential", Kind::Credential { kinds: &["bearer", "header", "hmac"] }, "\"\"")
        .literal()
        .when("auth", &["bearer", "header", "hmac", "githubSig", "stripeSig", "slackSig", "shopifySig"]),
    p("signatureHeader", text("X-Signature-256"), "\"X-Signature-256\"").literal().when("auth", &["hmac"]),
    p("hmacAlgorithm", raw_select(&["sha256", "sha1", "sha512"]), "\"sha256\"").literal().when("auth", &["hmac"]),
    p("hmacEncoding", select(&["hex", "base64"]), "\"hex\"").literal().when("auth", &["hmac"]),
    p("toleranceSec", COUNT, "300").literal().when("auth", &["stripeSig", "slackSig"]),
    // A header naming each delivery: a sender's retry of one already run is answered, not run again.
    p("dedupeHeader", text("X-GitHub-Delivery"), "\"\"").literal(),
    // The handshake a service makes before it sends anything: Meta's `hub.challenge`, Slack's
    // `url_verification`, Microsoft Graph's `validationToken` — answered here, never run.
    p("verify", select(&["noVerify", "metaVerify", "slackChallenge", "graphValidation"]), "\"noVerify\"").literal(),
    p("verifyToken", text("mi-token-de-verificacion"), "\"\"").literal().when("verify", &["metaVerify"]),
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
    p(
        "event",
        select(&["opened", "prUpdated", "prCommented", "reviewRequested", "prChecksFailed", "prChecksPassed", "merged", "prClosed"]),
        "\"opened\"",
    )
    .literal(),
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

const APP_EVENTS: &[&str] = &[
    "appStart",
    "serviceReady",
    "serviceFailed",
    "serviceStopped",
    "gitCommitted",
    "gitPushed",
    "branchSwitched",
    "terminalExited",
    "agentChainFinished",
    "reviewerPassed",
    "reviewerFailed",
    "prReviewFinished",
    "aiQuotaHigh",
    "aiQuotaReset",
    "noteSaved",
];
const APP_EVENT: &[ParamSpec] = &[
    p("event", select(APP_EVENTS), "\"appStart\"").literal(),
    p("service", text("api"), "\"\"").literal().when("event", &["serviceReady", "serviceFailed", "serviceStopped"]),
    // Which repository's commits, pushes, switches, Revisor runs or analyses — empty is any.
    p("project", Kind::Project, "\"\"")
        .literal()
        .when("event", &["gitCommitted", "gitPushed", "branchSwitched", "reviewerPassed", "reviewerFailed", "prReviewFinished"]),
    p("branch", text("main"), "\"\"").literal().when("event", &["gitCommitted", "gitPushed", "branchSwitched"]),
    // A terminal that ran at least this long: the build you left running, not every `ls`.
    p("minSeconds", COUNT, "60").literal().when("event", &["terminalExited"]),
    p("threshold", Kind::Number { min: Some(1.0), max: Some(100.0) }, "80").literal().when("event", &["aiQuotaHigh"]),
    p("noteTag", text("publicar"), "\"\"").literal().when("event", &["noteSaved"]),
];

const HOTKEY: &[ParamSpec] = &[p("accelerator", text("CmdOrCtrl+Alt+F"), "\"\"").literal()];

const ERROR_TRIGGER: &[ParamSpec] = &[
    p("which", select(&["all", "selected"]), "\"all\"").literal(),
    p("flows", Kind::Flows { multiple: true }, "[]").literal().when("which", &["selected"]),
];

const SUBFLOW: &[ParamSpec] = &[
    p("flow", Kind::Flows { multiple: false }, "\"\"").literal(),
    p("mode", select(&["wait", "fire"]), "\"wait\"").literal(),
    // What the called flow gets: the items as they come, or the inputs it declares, filled per item.
    p("subflowInput", select(&["sendItems", "sendInputs"]), "\"sendItems\"").literal(),
    p("inputs", Kind::SubflowInputs, "{}").when("subflowInput", &["sendInputs"]),
];

/// "Llamado por otro flujo", which may declare the inputs it takes — and, published, become a node
/// of its own in the palette (a custom node: a `logic.subflow` preset on this flow).
const SUBFLOW_TRIGGER: &[ParamSpec] = &[
    p("fields", Kind::FormFields, "[]").literal(),
    p("publishAsNode", Kind::Boolean, "false").literal(),
    p("nodeIcon", raw_select(&["box", "package", "wrench", "rocket", "send", "database", "globe", "file-text", "git-branch", "bot", "bell", "sparkles"]), "\"box\"")
        .literal()
        .when("publishAsNode", &["true"]),
    p("nodeDescription", long_text("Crea el ticket y avisa al equipo"), "\"\"").literal().when("publishAsNode", &["true"]),
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
    MEMORY_KEY.when("session", &["continue"]),
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
    TOOL_FLOWS,
    MAX_TOOL_CALLS,
    MEMORY_KEY,
    MEMORY_TURNS,
    AI_RUN_FOR,
];

const CLASSIFY: &[ParamSpec] = &[
    ENGINE,
    SUBJECT,
    p("categories", Kind::Categories, r#"[{"name":"","description":""}]"#).literal(),
    // Into a field (one output), or out of the category's own port (`catalog::output_count`).
    p("routing", select(&["routeField", "routeBranch"]), "\"routeField\"").literal(),
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
    p("check", select(&["httpCheck", "tlsCheck", "dnsCheck", "portCheck", "pingCheck", "domainExpiry", "publicIp"]), "\"httpCheck\"").literal(),
    p("siteTarget", text("https://example.com"), "\"\"").when("check", &["httpCheck", "tlsCheck", "dnsCheck", "portCheck", "pingCheck", "domainExpiry"]),
    p("pingCount", Kind::Number { min: Some(1.0), max: Some(10.0) }, "3").literal().when("check", &["pingCheck"]),
    p("expectStatus", text("200-399"), "\"\"").when("check", &["httpCheck"]),
    p("port", COUNT, "443").when("check", &["tlsCheck", "portCheck"]),
    p("warnDays", COUNT, "14").literal().when("check", &["tlsCheck", "domainExpiry"]),
    p("recordType", raw_select(&["A", "AAAA", "CNAME", "MX", "TXT", "NS"]), "\"A\"").literal().when("check", &["dnsCheck"]),
    p("timeoutMs", COUNT, "10000").literal(),
];

const UNTIL: &[ParamSpec] = &[
    p("check", select(&["httpUntil", "commandUntil", "fileUntil", "portUntil", "sqlUntil"]), "\"httpUntil\"").literal(),
    p("untilPath", text("~/Descargas/reporte.csv"), "\"\"").when("check", &["fileUntil"]),
    p("untilGone", Kind::Boolean, "false").when("check", &["fileUntil"]),
    p("host", text("localhost"), "\"localhost\"").when("check", &["portUntil"]),
    p("port", COUNT, "5432").when("check", &["portUntil"]),
    p("connection", Kind::DbConnection { kinds: SQL_ENGINES }, "\"\"").literal().when("check", &["sqlUntil"]),
    p("untilQuery", Kind::Code { lang: "sql" }, "\"SELECT 1 FROM pedidos WHERE estado = 'listo'\"").when("check", &["sqlUntil"]),
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
    p("template", Kind::Code { lang: "markdown" }, "\"Hola {{ $json.nombre }}\"").literal(),
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
    p(
        "operation",
        select(&["imageInfo", "resize", "convertImage", "crop", "rotate", "qrCreate", "qrRead", "stripMetadata", "watermark", "imageCompare"]),
        "\"resize\"",
    )
    .literal(),
    p("path", file("{{ $json.path }}"), "\"\"")
        .when("operation", &["imageInfo", "resize", "convertImage", "crop", "rotate", "qrRead", "stripMetadata", "watermark", "imageCompare"]),
    p("watermarkImage", file("~/Imágenes/logo.png"), "\"\"").when("operation", &["watermark"]),
    p("watermarkText", text("© Mi empresa"), "\"\"").when("operation", &["watermark"]),
    p("watermarkPosition", select(&["posBottomRight", "posBottomLeft", "posTopRight", "posTopLeft", "posCenter"]), "\"posBottomRight\"")
        .literal()
        .when("operation", &["watermark"]),
    p("watermarkOpacity", Kind::Number { min: Some(0.0), max: Some(100.0) }, "50").when("operation", &["watermark"]),
    p("comparePath", file("{{ $json.baseline }}"), "\"\"").when("operation", &["imageCompare"]),
    p("diffThreshold", Kind::Number { min: Some(0.0), max: Some(255.0) }, "16").when("operation", &["imageCompare"]),
    p("qrText", text("https://example.com"), "\"\"").when("operation", &["qrCreate"]),
    p("qrSize", COUNT, "512").literal().when("operation", &["qrCreate"]),
    p("width", COUNT, "800").when("operation", &["resize", "crop"]),
    p("height", COUNT, "0").when("operation", &["resize", "crop"]),
    p("x", COUNT, "0").when("operation", &["crop"]),
    p("y", COUNT, "0").when("operation", &["crop"]),
    p("degrees", raw_select(&["90", "180", "270"]), "\"90\"").literal().when("operation", &["rotate"]),
    p("savePath", file_to_write("~/Imágenes/salida.png", &["*"]), "\"\"")
        .when("operation", &["resize", "convertImage", "crop", "rotate", "qrCreate", "stripMetadata", "watermark", "imageCompare"]),
    p("quality", COUNT, "85").literal().when("operation", &["resize", "convertImage", "crop", "rotate", "watermark"]),
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
    p("olderThanDays", COUNT, "0"),
    p("listOutput", select(&["listEntries", "listSummary"]), "\"listEntries\"").literal(),
];

const MOVE: &[ParamSpec] = &[
    p("operation", select(&["move", "copy", "rename", "trash"]), "\"move\"").literal(),
    p("source", file("{{ $json.file.path }}"), "\"\""),
    p("destPath", text("~/Documentos/procesados/"), "\"\"").when("operation", &["move", "copy"]),
    p("newName", text(""), "\"\"").when("operation", &["rename"]),
    p("overwrite", Kind::Boolean, "false").when("operation", &["move", "copy", "rename"]),
];

const GIT_OPS: &[&str] = &[
    "status",
    "makeCommit",
    "pull",
    "push",
    "fetch",
    "checkout",
    "createTag",
    "diff",
    "log",
    "clone",
    "mergeBranch",
    "rebaseOnto",
    "stashPush",
    "stashPop",
    "cherryPick",
    "revertCommit",
    "branches",
    "deleteBranch",
    "tags",
];
const GIT: &[ParamSpec] = &[
    p("project", Kind::Project, "\"\"").literal(),
    p("repoPath", Kind::Folder, "\"\"").literal(),
    p("operation", select(GIT_OPS), "\"status\"").literal(),
    p("message", text(""), "\"\"").when("operation", &["makeCommit", "createTag", "stashPush"]),
    p("stageAll", Kind::Boolean, "true").when("operation", &["makeCommit"]),
    p("remote", text("origin"), "\"origin\"").when("operation", &["pull", "push", "fetch"]),
    p("branch", text(""), "\"\"").when("operation", &["push", "checkout", "clone", "mergeBranch", "rebaseOnto", "deleteBranch"]),
    p("create", Kind::Boolean, "false").when("operation", &["checkout"]),
    p("pushTags", Kind::Boolean, "false").when("operation", &["push"]),
    p("tag", text("v1.0.0"), "\"\"").when("operation", &["createTag"]),
    p("base", text("main"), "\"\"").when("operation", &["diff"]),
    p("maxCount", COUNT, "20").when("operation", &["log", "tags"]),
    p("logRange", text("v1.2.0..HEAD"), "\"\"").when("operation", &["log"]),
    p("cloneUrl", text("https://github.com/org/repo.git"), "\"\"").when("operation", &["clone"]),
    p("cloneInto", Kind::Folder, "\"\"").when("operation", &["clone"]),
    p("depth", COUNT, "0").when("operation", &["clone"]),
    p("ffOnly", Kind::Boolean, "false").when("operation", &["mergeBranch"]),
    p("shas", text("{{ $json.sha }}"), "\"\"").when("operation", &["cherryPick", "revertCommit"]),
    p("deleteRemote", Kind::Boolean, "false").when("operation", &["deleteBranch"]),
    p("forceDelete", Kind::Boolean, "false").when("operation", &["deleteBranch"]),
    p("mergedInto", text("main"), "\"\"").when("operation", &["branches"]),
    p("staleDays", COUNT, "0").when("operation", &["branches"]),
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
    p("operation", select(&["create", "addToEnd", "noteRead", "noteSearch", "noteReplace"]), "\"create\"").literal(),
    p("title", text(""), "\"\"").when("operation", &["create"]),
    p("tags", text(""), "\"\"").when("operation", &["create"]),
    p("note", Kind::Note, "\"\"").literal().when("operation", &["addToEnd", "noteRead", "noteReplace"]),
    p("noteQuery", text("despliegue"), "\"\"").when("operation", &["noteSearch"]),
    p("noteTagFilter", text("publicar"), "\"\"").when("operation", &["noteSearch"]),
    p("maxResults", COUNT, "20").when("operation", &["noteSearch"]),
    p("content", long_text(""), "\"\"").when("operation", &["create", "addToEnd", "noteReplace"]),
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
    // A field as stored, or the item's current 2FA code (never its secret).
    p("vaultValue", select(&["vaultField", "vaultTotp"]), "\"vaultField\"").literal(),
    p("itemField", text("password"), "\"password\"").literal().when("vaultValue", &["vaultField"]),
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
    TOOL_FLOWS,
    MAX_TOOL_CALLS,
    MEMORY_KEY,
    MEMORY_TURNS,
    AI_RUN_FOR,
];

/// Other flows the model may call — their "llamado por otro flujo" or "herramienta para IA" trigger
/// says what each takes (`flows::nodes::llm::tools`).
const TOOL_FLOWS: ParamSpec = p("toolFlows", Kind::Flows { multiple: true }, "[]").literal();
const MAX_TOOL_CALLS: ParamSpec = p("maxToolCalls", Kind::Number { min: Some(1.0), max: Some(50.0) }, "6").literal();
/// One conversation per key — a Telegram chat, a customer — remembered across runs.
const MEMORY_KEY: ParamSpec = p("memoryKey", text("{{ $json.chatId }}"), "\"\"");
const MEMORY_TURNS: ParamSpec = p("memoryTurns", Kind::Number { min: Some(1.0), max: Some(100.0) }, "10").literal();

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
    p("broker", select(&["rabbitmq", "kafka", "sqs", "nats", "azureServiceBus"]), "\"rabbitmq\"").literal(),
    p("queueOp", select(&["queuePublish", "queueReceive"]), "\"queuePublish\"").literal(),
    p("natsUrl", text("nats://localhost:4222"), "\"\"").literal().when("broker", &["nats"]),
    p("natsSubject", text("pedidos.nuevos"), "\"\"").when("broker", &["nats"]),
    p("sbNamespace", text("mi-namespace"), "\"\"").literal().when("broker", &["azureServiceBus"]),
    p("sbEntity", text("pedidos"), "\"\"").when("broker", &["azureServiceBus"]),
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
    p("leaveInQueue", Kind::Boolean, "false").when("broker", &["rabbitmq", "sqs", "azureServiceBus"]).and_when("queueOp", &["queueReceive"]),
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

/// Outlook, Outlook Calendar, OneDrive and Excel (`nodes::microsoft`) — the Google node's twin: the
/// same field names where the meaning is the same, so their labels are too.
const MICROSOFT: &[ParamSpec] = &[
    p("credential", Kind::Credential { kinds: &["oauth2"] }, "\"\"").literal(),
    p("service", select(&["outlook", "calendar", "onedrive", "excel"]), "\"outlook\"").literal(),
    p("outlookOp", select(&["outlookSend", "outlookSearch", "outlookGet", "outlookMarkRead", "outlookMove"]), "\"outlookSend\"").literal().when("service", &["outlook"]),
    p("to", text("equipo@example.com"), "\"\"").when("outlookOp", &["outlookSend"]),
    p("cc", text(""), "\"\"").when("outlookOp", &["outlookSend"]),
    p("bcc", text(""), "\"\"").when("outlookOp", &["outlookSend"]),
    p("subject", text(""), "\"\"").when("outlookOp", &["outlookSend"]),
    p("body", long_text(""), "\"\"").when("outlookOp", &["outlookSend"]),
    p("html", Kind::Boolean, "false").when("outlookOp", &["outlookSend"]),
    p("attachments", Kind::Strings, "[]").when("outlookOp", &["outlookSend"]),
    p("outlookQuery", text("from:facturas@example.com"), "\"\"").when("outlookOp", &["outlookSearch"]),
    p("outlookFolder", text("inbox"), "\"\"").when("outlookOp", &["outlookSearch"]),
    p("unreadOnly", Kind::Boolean, "false").when("outlookOp", &["outlookSearch"]),
    p("maxResults", COUNT, "10").when("outlookOp", &["outlookSearch"]),
    p("messageId", text("{{ $json.id }}"), "\"\"").when("outlookOp", &["outlookGet", "outlookMarkRead", "outlookMove"]),
    p("targetMailbox", text("archive"), "\"\"").when("outlookOp", &["outlookMove"]),
    p("attachmentsFolder", Kind::Folder, "\"\"").when("outlookOp", &["outlookSearch", "outlookGet"]),
    p("calendarOp", select(&["calendarList", "calendarCreate"]), "\"calendarList\"").literal().when("service", &["calendar"]),
    p("calendarId", text(""), "\"\"").when("service", &["calendar"]),
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
    p("onlineMeeting", Kind::Boolean, "false").when("calendarOp", &["calendarCreate"]),
    p("onedriveOp", select(&["driveList", "driveUpload", "driveDownload"]), "\"driveList\"").literal().when("service", &["onedrive"]),
    p("onedriveFolder", text("Documentos/Informes"), "\"\"").when("onedriveOp", &["driveList", "driveUpload"]),
    p("onedriveSearch", text("informe"), "\"\"").when("onedriveOp", &["driveList"]),
    p("fileLimit", COUNT, "50").when("onedriveOp", &["driveList"]),
    p("filePath", file("~/Documentos/informe.pdf"), "\"\"").when("onedriveOp", &["driveUpload"]),
    p("onedriveFile", text("Documentos/informe.pdf"), "\"\"").when("onedriveOp", &["driveDownload"]),
    p("folder", Kind::Folder, "\"\"").when("onedriveOp", &["driveDownload"]),
    p("fileName", text(""), "\"\"").when("onedriveOp", &["driveUpload", "driveDownload"]),
    p("overwrite", Kind::Boolean, "false").when("onedriveOp", &["driveUpload", "driveDownload"]),
    p("excelOp", select(&["excelRead", "excelAppend", "excelUpdate"]), "\"excelRead\"").literal().when("service", &["excel"]),
    p("workbook", text("Documentos/Ventas.xlsx"), "\"\"").when("service", &["excel"]),
    p("worksheet", text("Hoja1"), "\"Hoja1\"").when("service", &["excel"]),
    p("header", Kind::Boolean, "true").literal().when("excelOp", &["excelRead"]),
    p("rowLimit", COUNT, "0").when("excelOp", &["excelRead"]),
    p("columns", Kind::KeyValue, "[]").when("excelOp", &["excelAppend", "excelUpdate"]),
    p("matchColumn", text("id"), "\"\"").literal().when("excelOp", &["excelUpdate"]),
    p("matchValue", text(""), "\"\"").when("excelOp", &["excelUpdate"]),
    p("ifMissing", select(&["skipRow", "appendRow"]), "\"skipRow\"").literal().when("excelOp", &["excelUpdate"]),
    EACH,
];

/// «Ver una imagen» (`nodes::vision`): an image or a PDF described, transcribed or read into fields
/// — by an AI CLI, a provider's API, a local model or this computer's own OCR.
const VISION: &[ParamSpec] = &[
    p("imagePath", file("{{ $json.path }}"), "\"\""),
    p("visionTask", select(&["visionOcr", "visionDescribe", "visionExtract", "visionAsk"]), "\"visionOcr\"").literal(),
    p("question", long_text("¿Qué total aparece en la factura?"), "\"\"").when("visionTask", &["visionAsk"]),
    ANSWER_FIELDS.when("visionTask", &["visionExtract"]),
    p("visionEngine", select(&["visionCli", "visionApi", "visionLocal", "visionSystem"]), "\"visionCli\"").literal(),
    ENGINE.when("visionEngine", &["visionCli"]),
    p("apiProvider", select(&["openaiApi", "anthropic", "gemini", "compatible"]), "\"openaiApi\"").literal().when("visionEngine", &["visionApi"]),
    p("baseUrl", text("https://api.example.com/v1"), "\"\"").literal().when("visionEngine", &["visionApi"]).and_when("apiProvider", &["compatible"]),
    p("credential", Kind::Credential { kinds: &["bearer"] }, "\"\"").literal().when("visionEngine", &["visionApi"]),
    p("apiModel", Kind::ApiModel { purpose: "chat" }, "\"\"").literal().when("visionEngine", &["visionApi"]),
    p("server", select(&["ollama", "openai"]), "\"ollama\"").literal().when("visionEngine", &["visionLocal"]),
    p("url", text("http://127.0.0.1:11434"), "\"\"").when("visionEngine", &["visionLocal"]),
    p("model", Kind::LocalModel, "\"\"").when("visionEngine", &["visionLocal"]),
    p("ocrLanguages", text("es-ES, en-US"), "\"\"").when("visionEngine", &["visionSystem"]),
    INSTRUCTIONS,
    p("target", text("vision"), "\"vision\"").literal(),
];

/// «Transcribir audio» (`nodes::transcribe`): speech to text by OpenAI's or a compatible API (Groq…),
/// Gemini, or Whisper on this computer (whisper.cpp or OpenAI's Python CLI).
const TRANSCRIBE: &[ParamSpec] = &[
    p("audioPath", file("{{ $json.path }}"), "\"\""),
    p("transcribeEngine", select(&["openaiApi", "compatible", "gemini", "whisperLocal"]), "\"openaiApi\"").literal(),
    p("baseUrl", text("https://api.groq.com/openai/v1"), "\"\"").literal().when("transcribeEngine", &["compatible"]),
    p("credential", Kind::Credential { kinds: &["bearer"] }, "\"\"").literal().when("transcribeEngine", &["openaiApi", "compatible", "gemini"]),
    p("transcribeModel", text("whisper-1"), "\"\"").literal().when("transcribeEngine", &["openaiApi", "compatible", "gemini"]),
    p("whisperModel", text("base"), "\"\"").literal().when("transcribeEngine", &["whisperLocal"]),
    p("audioLanguage", text("es"), "\"\""),
    p("audioPrompt", long_text("CodeFlow, Supabase, Vercel"), "\"\""),
    p("timestamps", Kind::Boolean, "false").literal(),
    p("target", text("transcript"), "\"transcript\"").literal(),
];

/// «Ocultar datos sensibles» (`nodes::redact`): emails, phones, RUTs, cards, IBANs, IPs and secrets
/// found in the items' text, replaced before they reach a model, a log or a message.
const REDACT: &[ParamSpec] = &[
    p("redactFields", Kind::Strings, "[]"),
    p(
        "detect",
        Kind::MultiSelect { options: &["piiEmail", "piiPhone", "piiRut", "piiCard", "piiIban", "piiIp", "piiSecret"] },
        r#"["piiEmail","piiPhone","piiRut","piiCard","piiIban","piiSecret"]"#,
    )
    .literal(),
    p("customPatterns", Kind::Strings, "[]").literal(),
    p("redactMode", select(&["redactPlaceholder", "redactMask", "redactHash", "redactRemove"]), "\"redactPlaceholder\"").literal(),
    p("reportField", text("_redacted"), "\"\"").literal(),
];

/// «Atajo o AppleScript» (`nodes::process`, macOS): a Shortcuts shortcut by name, AppleScript or
/// JavaScript for Automation — the item's JSON as the script's argument.
const OSASCRIPT: &[ParamSpec] = &[
    p("osaKind", select(&["shortcut", "applescript", "jxa"]), "\"shortcut\"").literal(),
    p("shortcutName", text("Modo concentración"), "\"\"").when("osaKind", &["shortcut"]),
    p("shortcutInput", long_text("{{ $json.text }}"), "\"\"").when("osaKind", &["shortcut"]),
    p("appleScript", Kind::Code { lang: "applescript" }, "\"\"").when("osaKind", &["applescript"]),
    p("jxaScript", Kind::Code { lang: "javascript" }, "\"\"").when("osaKind", &["jxa"]),
    RUN_FOR,
    OUTPUT,
    FAIL_ON_EXIT,
];

const PHONE: &[ParamSpec] = &[p("label", text("Publicar el reporte"), "\"\"").literal()];

/// «Leer feed»: an RSS/Atom feed's entries (`nodes::feed`).
const FEED_READ: &[ParamSpec] = &[
    p("feedUrl", text("https://example.com/feed.xml"), "\"\""),
    p("entryLimit", COUNT, "20").literal(),
];

/// «Nuevo en un feed» (`triggers::watchers::feed`).
const FEED_TRIGGER: &[ParamSpec] = &[
    p("feedUrl", text("https://example.com/feed.xml"), "\"\"").literal(),
    p("intervalMin", Kind::Number { min: Some(5.0), max: None }, "15").literal(),
];

/// «Mensaje en cola» (`triggers::queue`): the Cola de mensajes node's connection fields, consumed.
const QUEUE_TRIGGER: &[ParamSpec] = &[
    p("broker", select(&["rabbitmq", "kafka", "sqs"]), "\"rabbitmq\"").literal(),
    p("credential", Kind::Credential { kinds: &["basic", "aws"] }, "\"\"").literal(),
    p("amqpUrl", text("amqp://rabbit.example.com:5672/%2f"), "\"\"").literal().when("broker", &["rabbitmq"]),
    p("queueName", text("pedidos"), "\"\"").literal().when("broker", &["rabbitmq"]),
    p("brokers", text("kafka.example.com:9092"), "\"\"").literal().when("broker", &["kafka"]),
    p("topic", text("pedidos"), "\"\"").literal().when("broker", &["kafka"]),
    p("partition", COUNT, "0").literal().when("broker", &["kafka"]),
    p("tls", Kind::Boolean, "false").literal().when("broker", &["kafka"]),
    p("saslMechanism", select(&["plain", "scramSha256", "scramSha512"]), "\"plain\"").literal().when("broker", &["kafka"]),
    p("startFrom", select(&["continue", "earliest"]), "\"continue\"").literal().when("broker", &["kafka"]),
    p("queueUrl", text("https://sqs.us-east-1.amazonaws.com/123456789012/pedidos"), "\"\"").literal().when("broker", &["sqs"]),
    p("ackOnSuccess", Kind::Boolean, "false").literal(),
];

/// «Evento de base de datos» (`triggers::watchers::database`).
const DB_TRIGGER: &[ParamSpec] = &[
    p("dbEvent", select(&["pgNotify", "redisChannel", "newRow"]), "\"newRow\"").literal(),
    p("connection", Kind::DbConnection { kinds: DB_TRIGGER_ENGINES }, "\"\"").literal(),
    p("channels", text("pedidos_nuevos"), "\"\"").literal().when("dbEvent", &["pgNotify", "redisChannel"]),
    p("table", text("public.pedidos"), "\"\"").literal().when("dbEvent", &["newRow"]),
    p("watermark", text("id"), "\"id\"").literal().when("dbEvent", &["newRow"]),
    p("intervalSec", Kind::Number { min: Some(10.0), max: None }, "30").literal().when("dbEvent", &["newRow"]),
];
const DB_TRIGGER_ENGINES: &[&str] = &["postgres", "supabase", "sqlserver", "iris", "mysql", "mariadb", "sqlite", "oracle", "jdbc", "redis"];

/// «Archivo remoto» (`triggers::watchers::remote_file`).
const REMOTE_FILE: &[ParamSpec] = &[
    p("host", Kind::RemoteHost { kinds: ALL_FILE_HOSTS }, "\"\"").literal(),
    p("remotePath", text("/srv/entrada"), "\"\"").literal(),
    p("pattern", text("*.csv"), "\"\"").literal(),
    p("events", Kind::MultiSelect { options: &["created", "modified"] }, r#"["created"]"#).literal(),
    p("intervalSec", Kind::Number { min: Some(30.0), max: None }, "60").literal(),
];
const ALL_FILE_HOSTS: &[&str] = &["ssh", "sftp", "ftp", "ftps", "smb", "s3", "azure", "azure_blob", "azure_files"];

/// «Evento de Google» (`triggers::watchers::google`).
const GOOGLE_TRIGGER: &[ParamSpec] = &[
    p("credential", Kind::Credential { kinds: &["oauth2"] }, "\"\"").literal(),
    p("googleEvent", select(&["calendarSoon", "sheetsNewRow", "gmailNew", "driveNew"]), "\"calendarSoon\"").literal(),
    p("gmailQuery", text("from:facturas@example.com"), "\"\"").literal().when("googleEvent", &["gmailNew"]),
    p("driveFolder", text(""), "\"\"").literal().when("googleEvent", &["driveNew"]),
    p("driveQuery", text("name contains 'informe'"), "\"\"").literal().when("googleEvent", &["driveNew"]),
    p("calendarId", text("primary"), "\"primary\"").literal().when("googleEvent", &["calendarSoon"]),
    p("leadMinutes", COUNT, "10").literal().when("googleEvent", &["calendarSoon"]),
    p("spreadsheetId", text("1AbC…"), "\"\"").literal().when("googleEvent", &["sheetsNewRow"]),
    p("sheetRange", text("Hoja1!A:Z"), "\"\"").literal().when("googleEvent", &["sheetsNewRow"]),
    p("intervalSec", Kind::Number { min: Some(60.0), max: None }, "120").literal(),
];

/// «Evento del sistema» (`triggers::watchers::system`).
const SYSTEM_TRIGGER: &[ParamSpec] = &[
    p(
        "systemEvent",
        select(&[
            "wake",
            "networkChange",
            "powerPlugged",
            "powerUnplugged",
            "batteryLow",
            "diskLow",
            "screenLocked",
            "screenUnlocked",
            "wifiChanged",
            "userIdle",
            "userBack",
        ]),
        "\"wake\"",
    )
    .literal(),
    p("batteryBelow", Kind::Number { min: Some(1.0), max: Some(99.0) }, "20").literal().when("systemEvent", &["batteryLow"]),
    p("diskBelowGb", Kind::Number { min: Some(1.0), max: None }, "10").literal().when("systemEvent", &["diskLow"]),
    p("diskPath", text("/"), "\"/\"").literal().when("systemEvent", &["diskLow"]),
    p("wifiName", text("Oficina"), "\"\"").literal().when("systemEvent", &["wifiChanged"]),
    p("idleMinutes", Kind::Number { min: Some(1.0), max: None }, "10").literal().when("systemEvent", &["userIdle", "userBack"]),
];

/// «Enlace o terminal» (`triggers::watchers::open_link`): the name `codeflow --flow <name>` uses, and
/// whether the window asks before running it.
const LINK_TRIGGER: &[ParamSpec] = &[
    p("linkName", text("deploy"), "\"\"").literal(),
    p("askFirst", Kind::Boolean, "true").literal(),
];

/// A flow offered as a tool to AI agents (`flows::mcp`): its name, what it does (the model picks
/// tools by this), and its input as form fields.
const TOOL: &[ParamSpec] = &[
    p("toolName", text("crear_ticket"), "\"\"").literal(),
    p("toolDescription", long_text("Crea un ticket en Jira con el título y la prioridad que se le den"), "\"\"").literal(),
    p("fields", Kind::FormFields, "[]").literal(),
];

/// A bot with no public URL (`triggers::bots`): Telegram long polling, Slack Socket Mode, Discord
/// Gateway. The credential is a bearer: the bot token (Telegram, Discord) or the app-level `xapp-`
/// token (Slack).
const BOT: &[ParamSpec] = &[
    p("platform", select(&["botTelegram", "botSlack", "botDiscord"]), "\"botTelegram\"").literal(),
    p("credential", Kind::Credential { kinds: &["bearer"] }, "\"\"").literal(),
    p("chats", text("123456789, -1001234567890"), "\"\"").literal(),
    p("textFilter", text("deploy"), "\"\"").literal(),
    p("commandsOnly", Kind::Boolean, "false").literal(),
];

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

// ------------------------------------------------------------------ milestone 12

const ENGINE_KINDS: &[&str] = &["docker", "podman", "nerdctl"];
const ENGINE_KIND: ParamSpec = p("engineKind", select(ENGINE_KINDS), "\"docker\"").literal();
const CONTAINER_CONTEXT: ParamSpec = p("containerContext", text("orbstack"), "\"\"").literal();
const KUBE_CONTEXT: ParamSpec = p("kubeContext", text("orbstack"), "\"\"").literal();
const KUBE_KINDS: &[&str] = &[
    "pods",
    "deployments",
    "statefulsets",
    "daemonsets",
    "jobs",
    "cronjobs",
    "services",
    "ingresses",
    "configmaps",
    "secrets",
    "persistentvolumeclaims",
    "events",
    "nodes",
    "namespaces",
];

/// «Contenedor»: Docker, Podman or containerd (`nerdctl`), through their own CLIs.
const CONTAINER: &[ParamSpec] = &[
    ENGINE_KIND,
    CONTAINER_CONTEXT,
    p(
        "containerOp",
        select(&[
            "ctrList",
            "ctrStart",
            "ctrStop",
            "ctrRestart",
            "ctrRemove",
            "ctrLogs",
            "ctrExec",
            "ctrInspect",
            "ctrStats",
            "ctrPull",
            "ctrRun",
            "composeUp",
            "composeDown",
            "composeRestart",
            "composePs",
        ]),
        "\"ctrList\"",
    )
    .literal(),
    p("ctrState", select(&["allStates", "runningOnly", "stoppedOnly"]), "\"allStates\"").when("containerOp", &["ctrList"]),
    p("nameFilter", text("api-*"), "\"\"").when("containerOp", &["ctrList"]),
    p("container", text("{{ $json.name }}"), "\"\"")
        .when("containerOp", &["ctrStart", "ctrStop", "ctrRestart", "ctrRemove", "ctrLogs", "ctrExec", "ctrInspect", "ctrStats"]),
    p("lines", COUNT, "200").when("containerOp", &["ctrLogs"]),
    p("logsSince", text("10m"), "\"\"").when("containerOp", &["ctrLogs"]),
    p("command", Kind::Code { lang: "shell" }, "\"\"").when("containerOp", &["ctrExec"]),
    p("removeVolumes", Kind::Boolean, "false").when("containerOp", &["ctrRemove"]),
    p("image", text("nginx:alpine"), "\"\"").when("containerOp", &["ctrPull", "ctrRun"]),
    p("ctrName", text("web"), "\"\"").when("containerOp", &["ctrRun"]),
    p("publishPorts", Kind::Strings, "[]").when("containerOp", &["ctrRun"]),
    p("env", Kind::KeyValue, "[]").when("containerOp", &["ctrRun"]),
    p("volumes", Kind::KeyValue, "[]").when("containerOp", &["ctrRun"]),
    p("args", Kind::Strings, "[]").when("containerOp", &["ctrRun"]),
    p("detach", Kind::Boolean, "true").when("containerOp", &["ctrRun"]),
    p("remove", Kind::Boolean, "false").when("containerOp", &["ctrRun"]),
    p("composeFile", file("~/proyectos/api/compose.yaml"), "\"\"").when("containerOp", &["composeUp", "composeDown", "composeRestart", "composePs"]),
    p("composeProject", text("api"), "\"\"").when("containerOp", &["composeUp", "composeDown", "composeRestart", "composePs"]),
    FAIL_ON_EXIT.when("containerOp", &["ctrExec"]),
    p("runFor", select(&["each", "once"]), "\"each\"").literal(),
];

/// «Kubernetes», through `kubectl` — the user's kubeconfig, a context named or the current one.
const K8S: &[ParamSpec] = &[
    KUBE_CONTEXT,
    p("namespace", text("default"), "\"\""),
    p(
        "k8sOp",
        select(&["k8sGet", "k8sDescribe", "k8sLogs", "k8sExec", "k8sScale", "k8sRestart", "k8sRolloutStatus", "k8sDelete", "k8sApply"]),
        "\"k8sGet\"",
    )
    .literal(),
    p("k8sKind", raw_select(KUBE_KINDS), "\"pods\"").when("k8sOp", &["k8sGet", "k8sDescribe", "k8sScale", "k8sRestart", "k8sRolloutStatus", "k8sDelete"]),
    p("k8sName", text("api"), "\"\"").when("k8sOp", &["k8sGet", "k8sDescribe", "k8sLogs", "k8sExec", "k8sScale", "k8sRestart", "k8sRolloutStatus", "k8sDelete"]),
    p("labelSelector", text("app=api"), "\"\"").when("k8sOp", &["k8sGet"]),
    p("container", text("api"), "\"\"").when("k8sOp", &["k8sLogs", "k8sExec"]),
    p("lines", COUNT, "200").when("k8sOp", &["k8sLogs"]),
    p("previous", Kind::Boolean, "false").when("k8sOp", &["k8sLogs"]),
    p("command", Kind::Code { lang: "shell" }, "\"\"").when("k8sOp", &["k8sExec"]),
    p("replicas", COUNT, "2").when("k8sOp", &["k8sScale"]),
    p("timeoutSec", COUNT, "300").literal().when("k8sOp", &["k8sRolloutStatus"]),
    p("manifest", Kind::Code { lang: "yaml" }, "\"\"").when("k8sOp", &["k8sApply"]),
    FAIL_ON_EXIT.when("k8sOp", &["k8sExec"]),
    p("runFor", select(&["each", "once"]), "\"once\"").literal(),
];

/// «Evento de contenedor»: the engine's own event stream (`docker events`).
const CONTAINER_TRIGGER: &[ParamSpec] = &[
    ENGINE_KIND,
    CONTAINER_CONTEXT,
    p(
        "ctrEvents",
        Kind::MultiSelect { options: &["evDie", "evStart", "evStop", "evRestart", "evUnhealthy", "evHealthy", "evOom", "evCreate", "evDestroy"] },
        r#"["evDie","evUnhealthy","evOom"]"#,
    )
    .literal(),
    p("nameFilter", text("api-*"), "\"\"").literal(),
    p("imageFilter", text("postgres*"), "\"\"").literal(),
    p("composeProject", text("api"), "\"\"").literal(),
    p("ignoreExitZero", Kind::Boolean, "true").literal(),
];

/// «Evento de Kubernetes»: pods that crash, restart or fail, rollouts that degrade, nodes going away.
const K8S_TRIGGER: &[ParamSpec] = &[
    KUBE_CONTEXT,
    p("namespace", text("default"), "\"\"").literal(),
    p(
        "k8sEvents",
        Kind::MultiSelect { options: &["podCrashLoop", "podFailed", "podRestarted", "podNotReady", "podPending", "deployDegraded", "nodeNotReady", "warningEvent"] },
        r#"["podCrashLoop","podFailed","podRestarted"]"#,
    )
    .literal(),
    p("labelSelector", text("app=api"), "\"\"").literal(),
    p("intervalSec", Kind::Number { min: Some(10.0), max: None }, "30").literal(),
];

/// «Línea en un log»: a file followed as it grows, or a container's or pod's output.
const LOG_LINE: &[ParamSpec] = &[
    p("logSource", select(&["logFile", "logContainer", "logPod"]), "\"logFile\"").literal(),
    p("logPath", file("/var/log/app/app.log"), "\"\"").literal().when("logSource", &["logFile"]),
    ENGINE_KIND.when("logSource", &["logContainer"]),
    CONTAINER_CONTEXT.when("logSource", &["logContainer"]),
    p("container", text("api"), "\"\"").literal().when("logSource", &["logContainer", "logPod"]),
    KUBE_CONTEXT.when("logSource", &["logPod"]),
    p("namespace", text("default"), "\"\"").literal().when("logSource", &["logPod"]),
    p("k8sName", text("api-7d9f8"), "\"\"").literal().when("logSource", &["logPod"]),
    p("pattern", text("ERROR|Exception"), "\"\"").literal(),
    p("regex", Kind::Boolean, "true").literal(),
    p("contextLines", COUNT, "0").literal(),
    p("maxPerMinute", COUNT, "30").literal(),
];

/// «Nuevo en un servicio»: any connector's list, looked at again and again.
const CONNECTOR_TRIGGER: &[ParamSpec] = &[
    p("call", Kind::Connector, r#"{"connector":"github","operation":"listIssues","fields":{}}"#).literal(),
    p("credential", Kind::Credential { kinds: &["bearer", "basic", "webhook", "oauth2"] }, "\"\"").literal(),
    p("idField", text("id"), "\"id\"").literal(),
    p("changeMode", select(&["newItems", "newOrChanged"]), "\"newItems\"").literal(),
    p("watchFields", Kind::Strings, "[]").literal().when("changeMode", &["newOrChanged"]),
    p("intervalSec", Kind::Number { min: Some(30.0), max: None }, "120").literal(),
];

/// «Formulario web»: a page on the flows' server that runs the flow with what is sent.
const FORM_TRIGGER: &[ParamSpec] = &[
    p("formPath", text("contacto"), "\"\"").literal(),
    p("formTitle", text("Solicitud de acceso"), "\"\"").literal(),
    p("formDescription", long_text("Completa los datos y te avisamos."), "\"\"").literal(),
    p("fields", Kind::FormFields, r#"[{"name":"nombre","label":"Nombre","type":"text","required":true}]"#).literal(),
    p("submitLabel", text("Enviar"), "\"\"").literal(),
    p("respond", select(&["immediately", "lastNode", "respondNode"]), "\"immediately\"").literal(),
    p("thanksMessage", long_text("¡Gracias! Recibimos tus datos."), "\"\"").literal().when("respond", &["immediately"]),
    p("formAccess", select(&["formOpen", "formPassword"]), "\"formOpen\"").literal(),
    p("credential", Kind::Credential { kinds: &["bearer"] }, "\"\"").literal().when("formAccess", &["formPassword"]),
];

/// «Asistente en el Chat»: the flow is offered as an assistant in CodeFlow's Chat.
const CHAT_TRIGGER: &[ParamSpec] = &[
    p("assistantName", text("Asistente de despliegues"), "\"\"").literal(),
    p("assistantDescription", long_text("Responde sobre el estado de los despliegues"), "\"\"").literal(),
    p("historyTurns", Kind::Number { min: Some(0.0), max: Some(100.0) }, "10").literal(),
];

/// «Desde el menú contextual»: an entry in CodeFlow's right-click menus.
const CONTEXT_TRIGGER: &[ParamSpec] = &[
    p(
        "contextPlaces",
        Kind::MultiSelect { options: &["placeFile", "placeFolder", "placeSelection", "placeCommit", "placePr"] },
        r#"["placeFile"]"#,
    )
    .literal(),
    p("menuLabel", text("Subir a S3"), "\"\"").literal(),
    p("fileGlob", text("*.csv"), "\"\"").literal(),
    p("askFirst", Kind::Boolean, "false").literal(),
];

/// «Portapapeles»: something copied that looks like what the flow wants.
const CLIPBOARD_TRIGGER: &[ParamSpec] = &[
    p("clipKind", select(&["clipAny", "clipUrl", "clipJson", "clipPath"]), "\"clipAny\"").literal(),
    p("pattern", text("[A-Z]+-\\d+"), "\"\"").literal(),
    p("regex", Kind::Boolean, "true").literal(),
    p("minLength", COUNT, "1").literal(),
];

/// «Evento de Microsoft»: Outlook, OneDrive, Excel and the calendar, by Graph.
const MICROSOFT_TRIGGER: &[ParamSpec] = &[
    p("credential", Kind::Credential { kinds: &["oauth2"] }, "\"\"").literal(),
    p("msEvent", select(&["outlookNew", "onedriveNew", "excelNewRow", "msCalendarSoon"]), "\"outlookNew\"").literal(),
    p("outlookFolder", text("inbox"), "\"inbox\"").literal().when("msEvent", &["outlookNew"]),
    p("outlookQuery", text("factura"), "\"\"").literal().when("msEvent", &["outlookNew"]),
    p("unreadOnly", Kind::Boolean, "true").literal().when("msEvent", &["outlookNew"]),
    p("onedriveFolder", text("Documentos/Entrada"), "\"\"").literal().when("msEvent", &["onedriveNew"]),
    p("workbook", text("Documentos/Ventas.xlsx"), "\"\"").literal().when("msEvent", &["excelNewRow"]),
    p("worksheet", text("Hoja1"), "\"Hoja1\"").literal().when("msEvent", &["excelNewRow"]),
    p("calendarId", text(""), "\"\"").literal().when("msEvent", &["msCalendarSoon"]),
    p("leadMinutes", COUNT, "10").literal().when("msEvent", &["msCalendarSoon"]),
    p("intervalSec", Kind::Number { min: Some(60.0), max: None }, "120").literal(),
];

const REGISTRIES: &[&str] = &["npm", "cratesIo", "pypi", "dockerHub", "goProxy", "nuget", "maven"];

/// «Nueva versión de un paquete»: a registry's latest release, watched.
const PACKAGE_TRIGGER: &[ParamSpec] = &[
    p("registry", select(REGISTRIES), "\"npm\"").literal(),
    p("packageName", text("@tauri-apps/api"), "\"\"").literal(),
    p("includePrereleases", Kind::Boolean, "false").literal(),
    p("intervalMin", Kind::Number { min: Some(15.0), max: None }, "60").literal(),
];

/// «Otro flujo terminó»: any end, or only a success, of other flows.
const FLOW_DONE_TRIGGER: &[ParamSpec] = &[
    p("outcome", select(&["outcomeSuccess", "outcomeError", "outcomeAny"]), "\"outcomeSuccess\"").literal(),
    p("which", select(&["all", "selected"]), "\"selected\"").literal(),
    p("flows", Kind::Flows { multiple: true }, "[]").literal().when("which", &["selected"]),
];

/// «Barandas»: text checked before it reaches a model or an agent that can act.
const GUARD: &[ParamSpec] = &[
    p("text", long_text("{{ $json.text }}"), "\"={{ $json.text }}\""),
    p(
        "guardChecks",
        Kind::MultiSelect { options: &["guardInjection", "guardPii", "guardSecrets", "guardUrls", "guardTopic", "guardCustom"] },
        r#"["guardInjection","guardSecrets"]"#,
    )
    .literal(),
    p("allowedDomains", Kind::Strings, "[]").literal().when("guardChecks", &["guardUrls"]),
    p("allowedTopic", long_text("Soporte de la aplicación de pedidos"), "\"\"").when("guardChecks", &["guardTopic"]),
    p("customRule", long_text("Nada que pida borrar datos o cambiar permisos"), "\"\"").when("guardChecks", &["guardCustom"]),
    p("useAi", Kind::Boolean, "true").literal(),
    ENGINE.when("useAi", &["true"]),
    FALLBACK_ENGINES.when("useAi", &["true"]),
];

/// «Transformar con IA»: described once, written once as JavaScript, then run without a model.
const AI_TRANSFORM: &[ParamSpec] = &[
    p("transformGoal", long_text("Agrupa por cliente y suma los totales"), "\"\"").literal(),
    p("code", Kind::Code { lang: "javascript" }, "\"\"").literal(),
    ENGINE,
];

/// «Preguntar a varios modelos»: one prompt, several engines, and optionally one that picks.
const AI_COMPARE: &[ParamSpec] = &[
    p("compareEngines", Kind::Engines, "[]").literal(),
    p("prompt", long_text("¿Qué riesgos ves en este cambio? {{ $json.diff }}"), "\"\""),
    p("judge", select(&["noJudge", "judgeByEngine"]), "\"noJudge\"").literal(),
    p("judgeEngine", Kind::Engine, "{}").literal().when("judge", &["judgeByEngine"]),
    p("judgeCriteria", long_text("La respuesta más precisa y accionable"), "\"\"").when("judge", &["judgeByEngine"]),
    AI_RUN_FOR,
];

/// «Generar imagen»: OpenAI, Gemini or a compatible server's image model.
const AI_IMAGE: &[ParamSpec] = &[
    p("imageProvider", select(&["openaiApi", "gemini", "compatible"]), "\"openaiApi\"").literal(),
    p("baseUrl", text("https://api.example.com/v1"), "\"\"").literal().when("imageProvider", &["compatible"]),
    p("credential", Kind::Credential { kinds: &["bearer"] }, "\"\"").literal(),
    p("imageModel", text("gpt-image-1"), "\"\"").literal(),
    p("imagePrompt", long_text("Un faro al atardecer, estilo acuarela"), "\"\""),
    p("imageSize", raw_select(&["1024x1024", "1536x1024", "1024x1536", "auto"]), "\"1024x1024\"").literal(),
    p("imageCount", Kind::Number { min: Some(1.0), max: Some(4.0) }, "1").literal(),
    p("savePath", file_to_write("~/Imágenes/generada.png", &["*"]), "\"\""),
    AI_RUN_FOR,
];

/// «Texto a voz»: OpenAI, ElevenLabs or this computer's own voice.
const AI_SPEECH: &[ParamSpec] = &[
    p("speechEngine", select(&["openaiApi", "elevenlabs", "systemVoice"]), "\"systemVoice\"").literal(),
    p("credential", Kind::Credential { kinds: &["bearer"] }, "\"\"").literal().when("speechEngine", &["openaiApi", "elevenlabs"]),
    p("speechText", long_text("{{ $json.text }}"), "\"={{ $json.text }}\""),
    p("voice", text("alloy"), "\"\""),
    p("speechModel", text("gpt-4o-mini-tts"), "\"\"").literal().when("speechEngine", &["openaiApi", "elevenlabs"]),
    p("savePath", file_to_write("~/Música/aviso.mp3", &["*"]), "\"\""),
    p("speakNow", Kind::Boolean, "false").literal(),
    AI_RUN_FOR,
];

/// «Buscar en internet».
const WEB_SEARCH: &[ParamSpec] = &[
    p("searchProvider", select(&["brave", "tavily", "searxng", "serper", "duckduckgo"]), "\"duckduckgo\"").literal(),
    p("credential", Kind::Credential { kinds: &["bearer", "header"] }, "\"\"").literal().when("searchProvider", &["brave", "tavily", "serper"]),
    p("searxUrl", text("http://localhost:8888"), "\"\"").literal().when("searchProvider", &["searxng"]),
    p("searchQuery", text("{{ $json.question }}"), "\"\""),
    p("maxResults", COUNT, "5"),
    p("searchFreshness", select(&["anyTime", "pastDay", "pastWeek", "pastMonth"]), "\"anyTime\"").literal(),
    p("searchLanguage", text("es"), "\"\"").literal(),
    p("fetchPages", COUNT, "0").literal(),
    EACH,
];

/// «Navegador»: a page rendered by a real (headless) browser.
const BROWSER: &[ParamSpec] = &[
    p("browserOp", select(&["browserShot", "browserPdf", "browserHtml", "browserText", "browserRun"]), "\"browserShot\"").literal(),
    p("url", text("https://example.com"), "\"\""),
    p("browserSteps", Kind::Code { lang: "json" }, r##""[\n  { \"action\": \"click\", \"selector\": \"#aceptar\" }\n]""##).when("browserOp", &["browserRun"]),
    p("waitFor", text("main"), "\"\""),
    p("waitMs", COUNT, "0").literal(),
    p("fullPage", Kind::Boolean, "true").literal().when("browserOp", &["browserShot"]),
    p("viewportWidth", COUNT, "1280").literal(),
    p("viewportHeight", COUNT, "800").literal(),
    p("savePath", file_to_write("~/Imágenes/pagina.png", &["*"]), "\"\"").when("browserOp", &["browserShot", "browserPdf"]),
    p("browserPath", file(""), "\"\"").literal(),
    p("timeoutMs", COUNT, "30000").literal(),
    EACH,
];

/// «SOAP».
const SOAP: &[ParamSpec] = &[
    p("wsdlUrl", text("https://servicio.example.com/ws?wsdl"), "\"\""),
    p("soapOperation", text("ObtenerCliente"), "\"\""),
    p("soapBodyMode", select(&["soapJson", "soapXml"]), "\"soapJson\"").literal(),
    p("soapBody", Kind::Code { lang: "json" }, "\"{}\"").when("soapBodyMode", &["soapJson"]),
    p("soapRaw", Kind::Code { lang: "xml" }, "\"\"").when("soapBodyMode", &["soapXml"]),
    p("soapVersion", raw_select(&["1.1", "1.2"]), "\"1.1\"").literal(),
    p("endpoint", text(""), "\"\""),
    HTTP_CREDENTIAL,
    HEADERS,
    TIMEOUT_MS,
    VERIFY_SSL,
    EACH,
];

/// «AWS»: any AWS API, signed with Signature Version 4.
const AWS: &[ParamSpec] = &[
    p("credential", Kind::Credential { kinds: &["aws"] }, "\"\"").literal(),
    p("awsService", text("lambda"), "\"\""),
    p("awsRegion", text("us-east-1"), "\"us-east-1\""),
    p("method", raw_select(&["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]), "\"POST\""),
    p("awsPath", text("/2015-03-31/functions/mi-funcion/invocations"), "\"/\""),
    p("query", Kind::KeyValue, "[]"),
    HEADERS,
    p("awsTarget", text("DynamoDB_20120810.Scan"), "\"\""),
    p("body", long_text("{{ JSON.stringify($json) }}"), "\"\""),
    p("awsHost", text(""), "\"\"").literal(),
    TIMEOUT_MS,
    EACH,
];

/// «Encender un equipo» (Wake-on-LAN).
const WOL: &[ParamSpec] = &[
    p("macAddress", text("AA:BB:CC:DD:EE:FF"), "\"\""),
    p("broadcast", text("255.255.255.255"), "\"255.255.255.255\"").literal(),
    p("wolPort", Kind::Number { min: Some(1.0), max: Some(65535.0) }, "9").literal(),
];

/// «Versión del proyecto»: semver read, bumped or set across the project's manifests.
const VERSION: &[ParamSpec] = &[
    p("versionOp", select(&["versionRead", "versionBump", "versionSet", "versionCompare", "versionLatest"]), "\"versionRead\"").literal(),
    p("project", Kind::Project, "\"\"").literal().when("versionOp", &["versionRead", "versionBump", "versionSet"]),
    p("repoPath", Kind::Folder, "\"\"").literal().when("versionOp", &["versionRead", "versionBump", "versionSet"]),
    p("versionFiles", Kind::Strings, "[]").literal().when("versionOp", &["versionRead", "versionBump", "versionSet"]),
    p("bumpPart", select(&["patch", "minor", "major", "prepatch", "preminor", "premajor", "prerelease"]), "\"patch\"").when("versionOp", &["versionBump"]),
    p("preid", text("beta"), "\"beta\"").when("versionOp", &["versionBump"]),
    p("newVersion", text("2.1.0"), "\"\"").when("versionOp", &["versionSet"]),
    p("versionA", text("{{ $json.version }}"), "\"\"").when("versionOp", &["versionCompare"]),
    p("versionB", text("2.0.0"), "\"\"").when("versionOp", &["versionCompare"]),
    p("versionRange", text("^2.0.0"), "\"\"").when("versionOp", &["versionCompare"]),
    p("registry", select(REGISTRIES), "\"npm\"").literal().when("versionOp", &["versionLatest"]),
    p("packageName", text("@tauri-apps/api"), "\"\"").when("versionOp", &["versionLatest"]),
    p("includePrereleases", Kind::Boolean, "false").when("versionOp", &["versionLatest"]),
];

/// «Buscar en el código»: the editor's search in files, over a repository.
const CODE_SEARCH: &[ParamSpec] = &[
    p("project", Kind::Project, "\"\"").literal(),
    p("searchText", text("TODO|FIXME"), "\"\""),
    p("regex", Kind::Boolean, "true").literal(),
    p("caseSensitive", Kind::Boolean, "false").literal(),
    p("wholeWord", Kind::Boolean, "false").literal(),
    p("includeGlobs", text("src/**, *.ts"), "\"\"").literal(),
    p("excludeGlobs", text("*.test.ts"), "\"\"").literal(),
    p("maxResults", COUNT, "500").literal(),
    p("searchOutput", select(&["perMatch", "perFile"]), "\"perMatch\"").literal(),
];

/// «Vulnerabilidades de dependencias»: the project's lockfiles against OSV.dev.
const AUDIT: &[ParamSpec] = &[
    p("project", Kind::Project, "\"\"").literal(),
    p("repoPath", Kind::Folder, "\"\"").literal(),
    p("lockfiles", Kind::Strings, "[]").literal(),
    p("auditSeverity", select(&["sevAll", "sevModerate", "sevHigh", "sevCritical"]), "\"sevAll\"").literal(),
    p("auditOutput", select(&["perVulnerability", "summaryOnly"]), "\"perVulnerability\"").literal(),
];

/// «Tabla de Flujos»: rows of the flows' own tables.
const TABLE: &[ParamSpec] = &[
    p("tableName", Kind::FlowTable, "\"\"").literal(),
    p(
        "tableOp",
        select(&["tableInsert", "tableUpsert", "tableGet", "tableFind", "tableUpdate", "tableDelete", "tableList", "tableClear"]),
        "\"tableUpsert\"",
    )
    .literal(),
    p("rowKey", text("{{ $json.id }}"), "\"={{ $json.id }}\"").when("tableOp", &["tableUpsert", "tableGet", "tableUpdate", "tableDelete"]),
    p("rowData", text("{{ $json }}"), "\"={{ $json }}\"").when("tableOp", &["tableInsert", "tableUpsert", "tableUpdate"]),
    p(
        "conditions",
        Kind::Conditions,
        r#"{"combinator":"and","ignoreCase":false,"conditions":[{"left":"","op":"equals","right":""}]}"#,
    )
    .literal()
    .when("tableOp", &["tableFind"]),
    p("maxRows", COUNT, "1000").literal().when("tableOp", &["tableFind", "tableList"]),
    p("runFor", select(&["each", "once"]), "\"each\"").literal(),
];

/// «Datos de prueba».
const FAKE: &[ParamSpec] = &[
    p("fakeCount", Kind::Number { min: Some(1.0), max: Some(10000.0) }, "10").literal(),
    p("fakeLocale", select(&["localeCl", "localeEs", "localeEn"]), "\"localeCl\"").literal(),
    p(
        "fakeFields",
        Kind::FakeFields,
        r#"[{"name":"nombre","kind":"fullName"},{"name":"email","kind":"email"},{"name":"rut","kind":"rut"},{"name":"ciudad","kind":"city"}]"#,
    )
    .literal(),
    p("fakeSeed", text("42"), "\"\"").literal(),
];

/// «Comparar esquemas»: two databases, their differences and the DDL that closes them.
const SCHEMA_DIFF: &[ParamSpec] = &[
    p("connection", Kind::DbConnection { kinds: SQL_ENGINES }, "\"\"").literal(),
    p("database", text(""), "\"\"").literal(),
    p("schema", text("public"), "\"\"").literal(),
    p("connectionB", Kind::DbConnection { kinds: SQL_ENGINES }, "\"\"").literal(),
    p("databaseB", text(""), "\"\"").literal(),
    p("schemaB", text("public"), "\"\"").literal(),
    p("diffOutput", select(&["diffChanges", "diffDdl", "diffSummary"]), "\"diffChanges\"").literal(),
    p("sqlDialect", select(&["dialectPostgres", "dialectMysql", "dialectSqlserver", "dialectSqlite"]), "\"dialectPostgres\"").literal(),
];

/// «Audio y video»: ffmpeg's common jobs.
const MEDIA: &[ParamSpec] = &[
    p(
        "mediaOp",
        select(&["mediaInfo", "extractAudio", "mediaConvert", "mediaTrim", "mediaSplit", "mediaThumbnail", "mediaCompress"]),
        "\"extractAudio\"",
    )
    .literal(),
    p("mediaPath", file("{{ $json.path }}"), "\"\""),
    p("audioFormat", raw_select(&["mp3", "m4a", "wav", "ogg", "flac"]), "\"mp3\"").when("mediaOp", &["extractAudio"]),
    p("trimStart", text("00:00:10"), "\"\"").when("mediaOp", &["mediaTrim"]),
    p("trimDuration", text("00:01:00"), "\"\"").when("mediaOp", &["mediaTrim"]),
    p("splitMinutes", Kind::Number { min: Some(0.0), max: None }, "10").when("mediaOp", &["mediaSplit"]),
    p("splitMaxMb", Kind::Number { min: Some(0.0), max: None }, "24").when("mediaOp", &["mediaSplit"]),
    p("thumbAt", text("00:00:05"), "\"00:00:01\"").when("mediaOp", &["mediaThumbnail"]),
    p("crf", Kind::Number { min: Some(18.0), max: Some(40.0) }, "28").when("mediaOp", &["mediaCompress"]),
    p("savePath", file_to_write("~/Música/salida.mp3", &["*"]), "\"\"").when("mediaOp", &["extractAudio", "mediaConvert", "mediaTrim", "mediaSplit", "mediaThumbnail", "mediaCompress"]),
    EACH,
];

/// «Documento Word».
const DOCX: &[ParamSpec] = &[
    p("docxOp", select(&["docxRead", "docxFill", "docxCreate"]), "\"docxRead\"").literal(),
    p("path", file("~/Documentos/plantilla.docx"), "\"\"").when("docxOp", &["docxRead", "docxFill"]),
    p("docxReadAs", select(&["asMarkdown", "asText"]), "\"asMarkdown\"").literal().when("docxOp", &["docxRead"]),
    p("fillFrom", select(&["fillItem", "fillPairs"]), "\"fillItem\"").literal().when("docxOp", &["docxFill"]),
    p("docxValues", Kind::KeyValue, "[]").when("fillFrom", &["fillPairs"]).and_when("docxOp", &["docxFill"]),
    p("markdown", long_text("# Informe\n\n{{ $json.resumen }}"), "\"\"").when("docxOp", &["docxCreate"]),
    p("savePath", file_to_write("~/Documentos/salida.docx", &["*"]), "\"\"").when("docxOp", &["docxFill", "docxCreate"]),
    EACH,
];

/// «Calendario .ics».
const ICS: &[ParamSpec] = &[
    p("icsOp", select(&["icsRead", "icsCreate"]), "\"icsRead\"").literal(),
    p("icsSource", text("https://calendar.example.com/feriados.ics"), "\"\"").when("icsOp", &["icsRead"]),
    p("rangeStart", text("{{ $now.toISODate() }}"), "\"\"").when("icsOp", &["icsRead"]),
    p("rangeEnd", text(""), "\"\"").when("icsOp", &["icsRead"]),
    p("eventTitle", text("Revisión del despliegue"), "\"\"").when("icsOp", &["icsCreate"]),
    p("startTime", text("2026-10-05 09:30"), "\"\"").when("icsOp", &["icsCreate"]),
    p("endTime", text(""), "\"\"").when("icsOp", &["icsCreate"]),
    p("allDay", Kind::Boolean, "false").when("icsOp", &["icsCreate"]),
    p("description", long_text(""), "\"\"").when("icsOp", &["icsCreate"]),
    p("eventLocation", text(""), "\"\"").when("icsOp", &["icsCreate"]),
    p("organizer", text("yo@example.com"), "\"\"").when("icsOp", &["icsCreate"]),
    p("attendees", Kind::Strings, "[]").when("icsOp", &["icsCreate"]),
    p("savePath", file_to_write("~/Documentos/evento.ics", &["*"]), "\"\"").when("icsOp", &["icsCreate"]),
    EACH,
];

/// «¿Horario hábil?».
const BUSINESS_HOURS: &[ParamSpec] = &[
    p("days", Kind::MultiSelect { options: &["mon", "tue", "wed", "thu", "fri", "sat", "sun"] }, r#"["mon","tue","wed","thu","fri"]"#).literal(),
    p("workFrom", text("09:00"), "\"09:00\"").literal(),
    p("workTo", text("18:00"), "\"18:00\"").literal(),
    p("timezone", text("America/Santiago"), "\"\"").literal(),
    p("skipHolidays", Kind::Boolean, "true").literal(),
    p("holidayCountry", text("CL"), "\"CL\"").literal().when("skipHolidays", &["true"]),
    p("atTime", text("{{ $json.createdAt }}"), "\"\""),
];

/// «Comprobar»: conditions every item must meet, or the run fails with the message.
const ASSERT: &[ParamSpec] = &[
    p(
        "conditions",
        Kind::Conditions,
        r#"{"combinator":"and","ignoreCase":false,"conditions":[{"left":"","op":"equals","right":""}]}"#,
    )
    .literal(),
    p("assertMessage", text("El total no cuadra"), "\"\""),
];

/// «Validar datos».
const VALIDATE: &[ParamSpec] = &[
    p("validationRules", Kind::ValidationRules, r#"[{"field":"email","check":"isEmail","arg":""}]"#).literal(),
    p("normalize", Kind::MultiSelect { options: &["normTrim", "normLowerEmail", "normRut", "normPhone"] }, r#"["normTrim"]"#).literal(),
    p("phoneCountry", text("56"), "\"56\"").literal(),
    p("errorsField", text("_errors"), "\"_errors\"").literal(),
];

/// «Limitar».
const LIMIT: &[ParamSpec] = &[
    p("limitMode", select(&["firstN", "lastN", "skipN", "pageN"]), "\"firstN\"").literal(),
    p("keepCount", COUNT, "10"),
    p("skipCount", COUNT, "0").when("limitMode", &["pageN"]),
];

/// «Números».
const NUMBER_TOOL: &[ParamSpec] = &[
    p("numberOp", select(&["numFormat", "numParse", "numRound", "numBytes", "numConvert", "numRandom", "numPercent"]), "\"numFormat\"").literal(),
    p("value", text("{{ $json.total }}"), "\"\"").when("numberOp", &["numFormat", "numParse", "numRound", "numBytes", "numConvert", "numPercent"]),
    p("numLocale", text("es-CL"), "\"es-CL\"").when("numberOp", &["numFormat", "numParse"]),
    p("numStyle", select(&["styleDecimal", "styleCurrency", "stylePercent"]), "\"styleDecimal\"").when("numberOp", &["numFormat"]),
    p("currency", text("CLP"), "\"CLP\"").when("numStyle", &["styleCurrency"]),
    p("decimals", Kind::Number { min: Some(0.0), max: Some(10.0) }, "0").when("numberOp", &["numFormat", "numRound", "numBytes", "numConvert", "numPercent"]),
    p("roundMode", select(&["roundHalf", "roundUp", "roundDown"]), "\"roundHalf\"").when("numberOp", &["numRound"]),
    p("fromUnit", text("km"), "\"\"").when("numberOp", &["numConvert"]),
    p("toUnit", text("mi"), "\"\"").when("numberOp", &["numConvert"]),
    p("minValue", NUMBER, "1").when("numberOp", &["numRandom"]),
    p("maxValue", NUMBER, "100").when("numberOp", &["numRandom"]),
    p("integerOnly", Kind::Boolean, "true").when("numberOp", &["numRandom"]),
    p("baseValue", text("{{ $json.previous }}"), "\"\"").when("numberOp", &["numPercent"]),
    p("target", text("number"), "\"number\""),
];

/// «Formato para chat».
const CHAT_FORMAT: &[ParamSpec] = &[
    p("text", long_text("{{ $json.text }}"), "\"={{ $json.text }}\""),
    p("chatTarget", select(&["fmtSlack", "fmtTelegram", "fmtTelegramHtml", "fmtWhatsapp", "fmtDiscord", "fmtTeams", "fmtHtml", "fmtPlain"]), "\"fmtSlack\"").literal(),
    p("target", text("text"), "\"text\""),
];

/// «Colección del cliente API».
const API_COLLECTION: &[ParamSpec] = &[
    p("apiCollection", Kind::ApiCollection, "\"\"").literal(),
    p("environment", Kind::ApiEnvironment, "\"\"").literal(),
    p("variables", Kind::KeyValue, "[]"),
    p("stopOnFailure", Kind::Boolean, "false").literal(),
    p("delayMs", COUNT, "0").literal(),
    p("collectionOutput", select(&["perRequest", "collectionSummary"]), "\"perRequest\"").literal(),
];

/// «Diagrama».
const DIAGRAM: &[ParamSpec] = &[
    p("diagramOp", select(&["diagramSave", "diagramRead"]), "\"diagramSave\"").literal(),
    p("title", text("Arquitectura"), "\"\""),
    p("diagramFormat", select(&["fmtDbml", "fmtDrawio", "fmtExcalidraw"]), "\"fmtDbml\"").literal().when("diagramOp", &["diagramSave"]),
    p("content", long_text("Table usuarios {\n  id int [pk]\n}"), "\"\"").when("diagramOp", &["diagramSave"]),
];

/// «Historia o Wiki».
const STORY: &[ParamSpec] = &[
    p("storyOp", select(&["storyReview", "docGenerate", "docPublish"]), "\"storyReview\"").literal(),
    p("reviewStage", select(&["stageAnalyze", "stageDescription", "stageCriteria", "stageTasks", "stageTasksQa"]), "\"stageAnalyze\"")
        .literal()
        .when("storyOp", &["storyReview"]),
    p("workItemKind", select(&["kindStory", "kindBug"]), "\"kindStory\"").literal().when("storyOp", &["storyReview"]),
    p("storyText", long_text("Como cliente quiero pagar con transferencia…"), "\"\"").when("storyOp", &["storyReview"]),
    p("docTitle", text("Arquitectura del API"), "\"\"").when("storyOp", &["docGenerate", "docPublish"]),
    p("docScope", select(&["scopeRepo", "scopeWorkspace"]), "\"scopeRepo\"").literal().when("storyOp", &["docGenerate"]),
    p("project", Kind::Project, "\"\"").literal().when("storyOp", &["storyReview", "docGenerate"]),
    p("instructions", long_text(""), "\"\"").when("storyOp", &["docGenerate"]),
    p("useContext", Kind::Boolean, "false").literal().when("storyOp", &["storyReview", "docGenerate"]),
    p("overwrite", Kind::Boolean, "false").literal().when("storyOp", &["docPublish"]),
    ENGINE.when("storyOp", &["storyReview", "docGenerate"]),
];

/// «Uso de IA».
const AI_USAGE: &[ParamSpec] = &[
    p("usagePeriod", select(&["today", "last7", "last30", "thisMonth"]), "\"last7\"").literal(),
    p("usageGroup", select(&["byProvider", "byModel", "byTask"]), "\"byProvider\"").literal(),
    p("includeQuota", Kind::Boolean, "true").literal(),
];

/// «Procesos y puertos».
const PROCESS: &[ParamSpec] = &[
    p("processOp", select(&["listPorts", "whoUsesPort", "freePort", "listProcesses", "killProcess", "systemInfo"]), "\"whoUsesPort\"").literal(),
    p("port", COUNT, "3000").when("processOp", &["whoUsesPort", "freePort"]),
    p("processName", text("node"), "\"\"").when("processOp", &["listProcesses", "killProcess"]),
    p("pid", COUNT, "0").when("processOp", &["killProcess"]),
    p("sortProcesses", select(&["byCpu", "byMemory", "byName"]), "\"byCpu\"").literal().when("processOp", &["listProcesses"]),
    p("maxResults", COUNT, "20").when("processOp", &["listProcesses", "listPorts"]),
];

/// «Datos de la ejecución»: key/values filed on the run, to find it by them in Ejecuciones.
const RUN_DATA: &[ParamSpec] = &[p("runFields", Kind::KeyValue, r#"[{"name":"pedido","value":"={{ $json.id }}"}]"#)];

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
        "trigger.bot" => BOT,
        "trigger.tool" => TOOL,
        "trigger.subflow" => SUBFLOW_TRIGGER,
        "trigger.container" => CONTAINER_TRIGGER,
        "trigger.k8s" => K8S_TRIGGER,
        "trigger.logLine" => LOG_LINE,
        "trigger.connector" => CONNECTOR_TRIGGER,
        "trigger.form" => FORM_TRIGGER,
        "trigger.chat" => CHAT_TRIGGER,
        "trigger.context" => CONTEXT_TRIGGER,
        "trigger.clipboard" => CLIPBOARD_TRIGGER,
        "trigger.microsoft" => MICROSOFT_TRIGGER,
        "trigger.package" => PACKAGE_TRIGGER,
        "trigger.flowDone" => FLOW_DONE_TRIGGER,
        "code.container" => CONTAINER,
        "code.k8s" => K8S,
        "ai.guard" => GUARD,
        "ai.transform" => AI_TRANSFORM,
        "ai.compare" => AI_COMPARE,
        "ai.image" => AI_IMAGE,
        "ai.speech" => AI_SPEECH,
        "net.search" => WEB_SEARCH,
        "net.browser" => BROWSER,
        "net.soap" => SOAP,
        "net.aws" => AWS,
        "net.wol" => WOL,
        "files.version" => VERSION,
        "app.search" => CODE_SEARCH,
        "app.audit" => AUDIT,
        "data.table" => TABLE,
        "data.fake" => FAKE,
        "data.schemaDiff" => SCHEMA_DIFF,
        "files.media" => MEDIA,
        "files.docx" => DOCX,
        "files.ics" => ICS,
        "logic.businessHours" => BUSINESS_HOURS,
        "logic.assert" => ASSERT,
        "transform.validate" => VALIDATE,
        "transform.limit" => LIMIT,
        "transform.number" => NUMBER_TOOL,
        "transform.chatFormat" => CHAT_FORMAT,
        "app.apiCollection" => API_COLLECTION,
        "app.diagram" => DIAGRAM,
        "app.story" => STORY,
        "app.aiUsage" => AI_USAGE,
        "app.process" => PROCESS,
        "app.runData" => RUN_DATA,
        "trigger.feed" => FEED_TRIGGER,
        "net.feed" => FEED_READ,
        "trigger.queue" => QUEUE_TRIGGER,
        "trigger.db" => DB_TRIGGER,
        "trigger.remoteFile" => REMOTE_FILE,
        "trigger.google" => GOOGLE_TRIGGER,
        "trigger.system" => SYSTEM_TRIGGER,
        "trigger.link" => LINK_TRIGGER,
        "net.connector" => CONNECTOR,
        "net.google" => GOOGLE,
        "net.microsoft" => MICROSOFT,
        "ai.vision" => VISION,
        "ai.transcribe" => TRANSCRIBE,
        "transform.redact" => REDACT,
        "code.osascript" => OSASCRIPT,
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
