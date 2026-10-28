//! What one repository is, what it offers and what it calls — read from its files, **without a model**.
//!
//! The architecture of a system of repositories is mostly *who calls whom*, and that is written in the
//! code: a service declares the routes it exposes, a frontend calls them with `fetch`, a function names
//! the queue it listens on, a client names the Redis it connects to. Asking a model to guess it from a
//! summary of each repository is how an architecture comes out plausible and wrong. So this reads the
//! facts, each with its `path:line`, and [`super::system`] links them; a model only ever names and
//! describes what was found, and never invents a connection.
//!
//! Everything here is bounded (files, bytes) and passed through the secret scrubber by its caller. A
//! `.env` is never opened; an environment variable is recorded **by name only**, never by value.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;

/// Source files read per repository, and the most of each.
const MAX_FILES: usize = 700;
const MAX_FILE_BYTES: u64 = 300_000;
/// Findings kept per repository: a repository with more than this has said what it is already.
const MAX_FINDINGS: usize = 400;

macro_rules! re {
    ($pattern:expr) => {{
        static CELL: OnceLock<Regex> = OnceLock::new();
        CELL.get_or_init(|| Regex::new($pattern).unwrap())
    }};
}

/// What a repository is in the system.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    /// A UI that calls services.
    Frontend,
    /// A server that mostly forwards to other services and keeps no data of its own.
    Bff,
    /// A server with its own persistence, or that others call and that calls little.
    Core,
    /// A serverless function (Azure Functions and the like).
    Function,
    /// Consumes a queue or a schedule and serves nothing over HTTP.
    Worker,
    Library,
    Other,
}

/// What kind of thing is exposed or called.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Channel {
    Http,
    Queue,
    Timer,
}

/// Something this repository offers to the others: a route, a queue it listens on, a schedule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Exposure {
    pub channel: Channel,
    /// `GET`, `POST`… for HTTP; empty otherwise.
    pub method: String,
    /// The route, or the queue/topic name, or the cron expression.
    pub name: String,
    pub file: String,
    pub line: usize,
}

/// Something this repository calls or sends to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Consumption {
    pub channel: Channel,
    pub method: String,
    /// The path called, when the code states one. `None` for a call whose URL is only a variable.
    pub path: Option<String>,
    /// The environment variable the base URL comes from, by name.
    pub env: Option<String>,
    /// A queue or topic name, for a producer.
    pub queue: Option<String>,
    pub file: String,
    pub line: usize,
}

/// A piece of infrastructure this repository uses, from its dependencies.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct Infra {
    /// `redis`, `postgres`, `mongodb`, `sqlserver`, `servicebus`, `storage`, `cosmos`.
    pub kind: String,
    pub file: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RepoCard {
    pub name: String,
    pub path: String,
    pub role: Role,
    /// Why — the signal that decided it, so a wrong guess can be corrected by someone who can see it.
    pub role_reason: String,
    pub exposes: Vec<Exposure>,
    pub consumes: Vec<Consumption>,
    pub infra: Vec<Infra>,
    /// The commit the card was read at (`""` outside git), so a later pull is noticed: the map is
    /// then stale for this repository rather than silently describing code that has moved.
    pub head: String,
}

/// The commit `root` is on, or `""` when it is not a repository or git is not there. Blocking.
pub fn head_of(root: &Path) -> String {
    crate::proc::std_command("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .unwrap_or_default()
}

fn is_source(rel: &str) -> bool {
    matches!(
        rel.rsplit('.').next().unwrap_or_default().to_ascii_lowercase().as_str(),
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "py" | "java" | "kt" | "cs" | "go" | "rs" | "php" | "rb"
    )
}

/// Paths that are generated or someone else's code: not what the repository does.
fn skipped(rel: &str) -> bool {
    let lower = rel.to_ascii_lowercase();
    ["node_modules/", "/dist/", "/build/", "/target/", "/bin/", "/obj/", ".min.", "/vendor/", "/.next/", "/coverage/", ".test.", ".spec.", "__tests__/", "/tests/", "/test/"]
        .iter()
        .any(|part| lower.contains(part) || lower.starts_with(part.trim_start_matches('/')))
}

fn line_of(text: &str, offset: usize) -> usize {
    text[..offset.min(text.len())].bytes().filter(|byte| *byte == b'\n').count() + 1
}

fn read_small(root: &Path, rel: &str) -> Option<String> {
    let path = root.join(rel);
    let meta = std::fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// The path portion of a URL expression, `None` when the expression states none.
///
/// `https://host/orders/42?x=1` → `/orders/42`; `` `${API}/orders/${id}` `` → `/orders/${id}`; `/orders` →
/// `/orders`; a bare variable or an origin with no path → `None`. The query and fragment are dropped.
pub fn path_of(expression: &str) -> Option<String> {
    let text = expression.trim();
    // A template whose base is an interpolation: everything after the first `}`.
    let rest = if text.starts_with("${") {
        text.split_once('}').map(|(_, rest)| rest)?
    } else if let Some((_, after)) = text.split_once("://") {
        after.find('/').map(|at| &after[at..])?
    } else if text.starts_with('/') {
        text
    } else {
        return None;
    };
    let rest = rest.split(['?', '#']).next().unwrap_or_default();
    if !rest.starts_with('/') || rest.len() < 2 {
        return None;
    }
    Some(rest.to_string())
}

/// `/orders/:id`, `/orders/{id}`, `/orders/${id}`, `/orders/<id>`, `/orders/42` → `/orders/*`. The
/// last because a literal number or uuid in a call is an id, never a route segment of its own.
pub fn normalize(path: &str) -> String {
    let segments: Vec<String> = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(|segment| {
            let parameter = segment.starts_with(':')
                || (segment.starts_with('{') && segment.ends_with('}'))
                || segment.starts_with("${")
                || (segment.starts_with('<') && segment.ends_with('>'))
                || segment.starts_with('[')
                || segment.contains("${")
                || segment.chars().all(|c| c.is_ascii_digit())
                || is_uuid(segment);
            if parameter { "*".to_string() } else { segment.to_ascii_lowercase() }
        })
        .collect();
    format!("/{}", segments.join("/"))
}

fn is_uuid(text: &str) -> bool {
    text.len() == 36 && text.chars().enumerate().all(|(at, c)| if matches!(at, 8 | 13 | 18 | 23) { c == '-' } else { c.is_ascii_hexdigit() })
}

/// The environment variables that name another service's address, by name only.
fn env_in(text: &str) -> Vec<String> {
    let mut out = BTreeSet::new();
    for pattern in [
        re!(r"process\.env\.([A-Z][A-Z0-9_]*)"),
        re!(r"import\.meta\.env\.([A-Z][A-Z0-9_]*)"),
        re!(r#"process\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]"#),
        re!(r#"GetEnvironmentVariable\(\s*"([A-Z][A-Z0-9_]*)""#),
        re!(r#"(?:Configuration|_config|config)\[\s*"([A-Za-z][A-Za-z0-9_:]*)"\s*\]"#),
        re!(r#"os\.environ(?:\.get)?[\[(]\s*['"]([A-Z][A-Z0-9_]*)['"]"#),
    ] {
        for found in pattern.captures_iter(text) {
            out.insert(found[1].to_string());
        }
    }
    out.into_iter().collect()
}

fn names_an_address(variable: &str) -> bool {
    let upper = variable.to_ascii_uppercase();
    ["URL", "URI", "HOST", "ENDPOINT", "BASE", "API", "SERVICE"].iter().any(|word| upper.contains(word))
}

/// The first of the quote-alternative groups from `from` that matched — a string literal in any of the
/// three quotes (the `regex` crate has no back-references, so each quote has its own group).
fn literal(found: &regex::Captures, from: usize) -> String {
    (from..from + 3).find_map(|at| found.get(at)).map_or(String::new(), |m| m.as_str().to_string())
}

/// The HTTP calls a file makes. Only a call whose first argument is a string or template literal; a call
/// through a bare variable is not guessed at.
fn http_calls(rel: &str, text: &str, out: &mut Vec<Consumption>) {
    let language = rel.rsplit('.').next().unwrap_or_default();
    let mut push = |method: &str, expression: &str, offset: usize| {
        let path = path_of(expression);
        let env = env_in(expression).into_iter().find(|name| names_an_address(name));
        // Nothing to link on: a literal with no path and no variable that names an address.
        if path.is_none() && env.is_none() {
            return;
        }
        out.push(Consumption { channel: Channel::Http, method: method.to_ascii_uppercase(), path, env, queue: None, file: rel.to_string(), line: line_of(text, offset) });
    };
    match language {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => {
            for found in re!(r#"\b(?:axios|http|https|got|ky|api|client|this\.http|this\.httpClient|httpClient)\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)"#).captures_iter(text) {
                push(&found[1], &literal(&found, 2), found.get(0).map_or(0, |m| m.start()));
            }
            for found in re!(r#"\bfetch\(\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)([^)]{0,200})"#).captures_iter(text) {
                let method = re!(r#"method\s*:\s*['"`](\w+)['"`]"#).captures(&found[4]).map_or("GET".to_string(), |m| m[1].to_string());
                push(&method, &literal(&found, 1), found.get(0).map_or(0, |m| m.start()));
            }
            // `axios.get(BASE + "/orders")`: the base is a variable whose name says it is an address.
            for found in re!(r#"\b(?:axios|http|fetch|got|ky|api|client)(?:\.(get|post|put|patch|delete))?\(\s*([A-Za-z_][\w.]*)\s*\+\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)"#).captures_iter(text) {
                let method = found.get(1).map_or("GET", |m| m.as_str());
                let base = found[2].to_string();
                if names_an_address(&base) || base.contains("env") {
                    push(method, &format!("${{{}}}{}", base, literal(&found, 3)), found.get(0).map_or(0, |m| m.start()));
                }
            }
        }
        "cs" => {
            for found in re!(r#"\.(Get|Post|Put|Patch|Delete)(?:FromJson|AsJson)?(?:Async)?(?:<[^>]*>)?\(\s*\$?@?"([^"]*)""#).captures_iter(text) {
                push(&found[1], &found[2].replace('{', "${"), found.get(0).map_or(0, |m| m.start()));
            }
        }
        "py" => {
            for found in re!(r#"\b(?:requests|httpx|session|client)\.(get|post|put|patch|delete)\(\s*f?['"]([^'"]*)['"]"#).captures_iter(text) {
                push(&found[1], &found[2].replace('{', "${"), found.get(0).map_or(0, |m| m.start()));
            }
        }
        "java" | "kt" => {
            for found in re!(r#"\b(?:restTemplate|webClient)\.(?:get|post|put|patch|delete)\w*\(\s*"([^"]*)""#).captures_iter(text) {
                let method = re!(r"\.(get|post|put|patch|delete)").captures(found.get(0).map_or("", |m| m.as_str())).map_or("GET".to_string(), |m| m[1].to_string());
                push(&method, &found[1], found.get(0).map_or(0, |m| m.start()));
            }
        }
        "go" => {
            for found in re!(r#"http\.(Get|Post)\(\s*"([^"]*)""#).captures_iter(text) {
                push(&found[1], &found[2], found.get(0).map_or(0, |m| m.start()));
            }
        }
        _ => {}
    }
}

/// Queues, topics and schedules: what a function listens on and what a service sends to.
fn messaging(rel: &str, text: &str, exposes: &mut Vec<Exposure>, consumes: &mut Vec<Consumption>) {
    let mut listens = |name: &str, offset: usize| {
        exposes.push(Exposure { channel: Channel::Queue, method: String::new(), name: name.to_string(), file: rel.to_string(), line: line_of(text, offset) });
    };
    // Azure Functions, JavaScript v4: `app.serviceBusQueue("fn", { queueName: "orders", … })`.
    for found in re!(r#"app\.(?:serviceBusQueue|serviceBusTopic|storageQueue|eventHub)\(\s*['"][^'"]*['"]\s*,\s*\{[^}]*?(?:queueName|topicName|eventHubName)\s*:\s*['"]([^'"]+)['"]"#).captures_iter(text) {
        listens(&found[1], found.get(0).map_or(0, |m| m.start()));
    }
    // C#: `[ServiceBusTrigger("orders", …)]`, `[QueueTrigger("orders")]`, `[EventHubTrigger("hub")]`.
    for found in re!(r#"\[(?:ServiceBusTrigger|QueueTrigger|EventHubTrigger)\(\s*"([^"]+)""#).captures_iter(text) {
        listens(&found[1], found.get(0).map_or(0, |m| m.start()));
    }
    // Any receiver: `createReceiver("orders")`, `CreateProcessor("orders")`.
    for found in re!(r#"\b(?:createReceiver|CreateReceiver|CreateProcessor|createProcessor)\(\s*['"]([^'"]+)['"]"#).captures_iter(text) {
        listens(&found[1], found.get(0).map_or(0, |m| m.start()));
    }
    for found in re!(r#"(?:app\.timer\([^)]*?schedule\s*:\s*|\[TimerTrigger\(\s*)['"]([^'"]+)['"]"#).captures_iter(text) {
        exposes.push(Exposure { channel: Channel::Timer, method: String::new(), name: found[1].to_string(), file: rel.to_string(), line: line_of(text, found.get(0).map_or(0, |m| m.start())) });
    }
    // A sender is a call *to* a queue.
    for found in re!(r#"\b(?:createSender|CreateSender|QueueClient|getQueueClient|GetQueueClient)\(\s*(?:[A-Za-z_][\w.]*\s*,\s*)?['"]([^'"]+)['"]"#).captures_iter(text) {
        consumes.push(Consumption {
            channel: Channel::Queue,
            method: String::new(),
            path: None,
            env: None,
            queue: Some(found[1].to_string()),
            file: rel.to_string(),
            line: line_of(text, found.get(0).map_or(0, |m| m.start())),
        });
    }
}

/// Azure Functions' HTTP triggers, in the four places they are declared.
fn function_triggers(rel: &str, text: &str, exposes: &mut Vec<Exposure>) {
    let mut http = |methods: &str, route: &str, offset: usize| {
        let route = if route.starts_with('/') { route.to_string() } else { format!("/api/{route}") };
        let methods: Vec<String> = methods.split([',', ' ', '"', '\'', '[', ']']).map(str::trim).filter(|m| !m.is_empty()).map(str::to_ascii_uppercase).collect();
        for method in if methods.is_empty() { vec!["ANY".to_string()] } else { methods } {
            exposes.push(Exposure { channel: Channel::Http, method, name: route.clone(), file: rel.to_string(), line: line_of(text, offset) });
        }
    };
    // JavaScript v4: `app.http("name", { methods: ["GET"], route: "orders/{id}", … })`.
    // A window of text rather than "up to the closing brace": a route's own `{id}` closes it too early.
    for found in re!(r#"app\.http\(\s*['"]([^'"]+)['"]\s*,\s*\{([\s\S]{0,400})"#).captures_iter(text) {
        let body = &found[2];
        let route = re!(r#"route\s*:\s*['"]([^'"]*)['"]"#).captures(body).map_or(found[1].to_string(), |m| m[1].to_string());
        let methods = re!(r"methods\s*:\s*\[([^\]]*)\]").captures(body).map_or(String::new(), |m| m[1].to_string());
        http(&methods, &route, found.get(0).map_or(0, |m| m.start()));
    }
    // C# isolated worker: `[HttpTrigger(AuthorizationLevel.Function, "get", "post", Route = "orders/{id}")]`.
    for found in re!(r#"\[HttpTrigger\(([^\]]*)\)\]"#).captures_iter(text) {
        let args = &found[1];
        let route = re!(r#"Route\s*=\s*"([^"]*)""#).captures(args).map_or(String::new(), |m| m[1].to_string());
        let lower = args.to_ascii_lowercase();
        let methods: Vec<&str> = re!(r#""(get|post|put|patch|delete|head|options)""#).find_iter(&lower).map(|m| m.as_str().trim_matches('"')).collect();
        let name = if route.is_empty() { "/api".to_string() } else { route };
        http(&methods.join(","), &name, found.get(0).map_or(0, |m| m.start()));
    }
    // `function.json` (any language): a binding of type httpTrigger.
    if rel.ends_with("function.json") && text.contains("httpTrigger") {
        let route = re!(r#""route"\s*:\s*"([^"]*)""#).captures(text).map_or_else(|| {
            // With no route the function answers on its own folder's name.
            rel.rsplit('/').nth(1).unwrap_or_default().to_string()
        }, |m| m[1].to_string());
        let methods = re!(r#""methods"\s*:\s*\[([^\]]*)\]"#).captures(text).map_or(String::new(), |m| m[1].to_string());
        http(&methods, &route, 0);
    }
}

/// Dependencies → infrastructure, by the names the ecosystems publish them under.
fn infra_in(rel: &str, text: &str, out: &mut BTreeSet<Infra>) {
    let lower = text.to_ascii_lowercase();
    let table: [(&str, &[&str]); 7] = [
        ("redis", &["\"ioredis\"", "\"redis\"", "\"@redis/", "stackexchange.redis", "spring-boot-starter-data-redis", "spring-data-redis", "redis==", "redis-py", "\"@upstash/redis\"", "go-redis"]),
        ("postgres", &["\"pg\"", "\"postgres\"", "npgsql", "psycopg", "org.postgresql", "pgx", "lib/pq", "asyncpg"]),
        ("mongodb", &["\"mongodb\"", "\"mongoose\"", "mongodb.driver", "pymongo", "spring-boot-starter-data-mongodb", "mongo-driver"]),
        ("sqlserver", &["\"mssql\"", "\"tedious\"", "microsoft.data.sqlclient", "system.data.sqlclient", "mssql-jdbc", "pyodbc"]),
        ("servicebus", &["@azure/service-bus", "azure.messaging.servicebus", "azure-servicebus", "azure-messaging-servicebus", "microsoft.azure.functions.worker.extensions.servicebus"]),
        ("storage", &["@azure/storage-blob", "@azure/storage-queue", "azure.storage.blobs", "azure.storage.queues", "azure-storage-blob", "@aws-sdk/client-s3"]),
        ("cosmos", &["@azure/cosmos", "microsoft.azure.cosmos", "azure-cosmos"]),
    ];
    for (kind, needles) in table {
        if needles.iter().any(|needle| lower.contains(needle)) {
            out.insert(Infra { kind: kind.to_string(), file: rel.to_string() });
        }
    }
}

/// UI-framework and server-framework signals in the manifests, for the role.
struct Signals {
    ui: Option<&'static str>,
    server: Option<&'static str>,
    function: Option<&'static str>,
}

fn signals(manifests: &[(String, String)], files: &[String]) -> Signals {
    let has = |needles: &[&str]| manifests.iter().find(|(_, text)| { let lower = text.to_ascii_lowercase(); needles.iter().any(|needle| lower.contains(needle)) });
    let ui = [("\"next\"", "next"), ("\"react-dom\"", "react"), ("\"vue\"", "vue"), ("\"@angular/core\"", "angular"), ("\"svelte\"", "svelte"), ("\"solid-js\"", "solid"), ("\"nuxt\"", "nuxt")]
        .into_iter()
        .find(|(needle, _)| has(&[needle]).is_some())
        .map(|(_, name)| name);
    let server = [
        ("\"express\"", "express"),
        ("\"fastify\"", "fastify"),
        ("\"@nestjs/core\"", "nest"),
        ("\"koa\"", "koa"),
        ("\"hono\"", "hono"),
        ("spring-boot-starter-web", "spring"),
        ("fastapi", "fastapi"),
        ("flask", "flask"),
        ("microsoft.net.sdk.web", "aspnet"),
        ("microsoft.aspnetcore", "aspnet"),
        ("gin-gonic", "gin"),
    ]
    .into_iter()
    .find(|(needle, _)| has(&[needle]).is_some())
    .map(|(_, name)| name);
    let function = if files.iter().any(|file| file.ends_with("host.json")) {
        Some("host.json")
    } else if has(&["@azure/functions", "microsoft.azure.functions.worker", "azure-functions"]).is_some() {
        Some("an Azure Functions package")
    } else {
        None
    };
    Signals { ui, server, function }
}

/// The role, and the signal that decided it.
fn role_of(signals: &Signals, card: &RepoCard) -> (Role, String) {
    let http_routes = card.exposes.iter().filter(|e| e.channel == Channel::Http).count();
    let calls = card.consumes.iter().filter(|c| c.channel == Channel::Http).count();
    let has_db = card.infra.iter().any(|i| matches!(i.kind.as_str(), "postgres" | "mongodb" | "sqlserver" | "cosmos"));
    let listens = card.exposes.iter().any(|e| matches!(e.channel, Channel::Queue | Channel::Timer));
    if let Some(reason) = signals.function {
        return (Role::Function, format!("has {reason}"));
    }
    if let Some(ui) = signals.ui {
        if http_routes < 8 {
            return (Role::Frontend, format!("a {ui} UI that serves {http_routes} route(s) of its own and makes {calls} call(s)"));
        }
    }
    if signals.server.is_some() || http_routes > 0 {
        let framework = signals.server.unwrap_or("route declarations");
        return if !has_db && calls > 0 {
            (Role::Bff, format!("{framework} server that makes {calls} outgoing call(s) and keeps no database"))
        } else {
            (Role::Core, format!("{framework} server{}", if has_db { " with its own database" } else { "" }))
        };
    }
    if listens {
        return (Role::Worker, "listens on a queue or a schedule and serves no HTTP".into());
    }
    if card.consumes.is_empty() && card.exposes.is_empty() {
        return (Role::Library, "declares no routes and makes no calls".into());
    }
    (Role::Other, "no signal decided it".into())
}

/// Reads one repository. Blocking: it walks and reads files.
pub fn scan(root: &Path) -> Result<RepoCard, String> {
    if !root.is_dir() {
        return Err(format!("{} is not a folder", root.display()));
    }
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| root.display().to_string());
    let files = crate::search::list_files(&root.to_string_lossy()).unwrap_or_else(|_| crate::local_agent::tools::plain_walk(root, 20_000));

    let mut exposes = Vec::new();
    let mut consumes = Vec::new();
    let mut infra = BTreeSet::new();
    let mut manifests = Vec::new();
    let mut read = 0;
    for rel in &files {
        let base = rel.rsplit('/').next().unwrap_or(rel).to_ascii_lowercase();
        let is_manifest = matches!(base.as_str(), "package.json" | "pom.xml" | "go.mod" | "pyproject.toml" | "build.gradle" | "build.gradle.kts")
            || base.ends_with(".csproj")
            || (base.starts_with("requirements") && base.ends_with(".txt"));
        let is_function_json = base == "function.json";
        if !is_manifest && !is_function_json && (!is_source(rel) || skipped(rel)) {
            continue;
        }
        if read >= MAX_FILES {
            break;
        }
        let Some(text) = read_small(root, rel) else { continue };
        read += 1;
        if is_manifest {
            infra_in(rel, &text, &mut infra);
            manifests.push((rel.clone(), text));
            continue;
        }
        if is_function_json {
            function_triggers(rel, &text, &mut exposes);
            continue;
        }
        for (method, path) in crate::archify_suggest::exposed_routes(rel, &text) {
            // The detector gives the route, not where it is: the first place the path is written.
            let at = text.find(path.as_str()).map_or(0, |offset| line_of(&text, offset));
            exposes.push(Exposure { channel: Channel::Http, method, name: path, file: rel.clone(), line: at });
        }
        function_triggers(rel, &text, &mut exposes);
        messaging(rel, &text, &mut exposes, &mut consumes);
        http_calls(rel, &text, &mut consumes);
        // The variables a file reads that name an address, even when the call is made elsewhere.
        for variable in env_in(&text).into_iter().filter(|v| names_an_address(v)) {
            let already = consumes.iter().any(|c| c.file == *rel && c.env.as_deref() == Some(variable.as_str()));
            if !already {
                consumes.push(Consumption { channel: Channel::Http, method: String::new(), path: None, env: Some(variable), queue: None, file: rel.clone(), line: 0 });
            }
        }
        // Source files name Redis and the like too (`new Redis(…)`), not only manifests.
        infra_in(rel, &text, &mut infra);
        if exposes.len() + consumes.len() > MAX_FINDINGS {
            break;
        }
    }
    exposes.dedup();
    let mut card = RepoCard {
        name,
        path: root.display().to_string(),
        role: Role::Other,
        role_reason: String::new(),
        exposes,
        consumes,
        infra: infra.into_iter().collect(),
        head: head_of(root),
    };
    let found = signals(&manifests, &files);
    let (role, reason) = role_of(&found, &card);
    card.role = role;
    card.role_reason = reason;
    Ok(card)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_urls_path_is_found_in_every_spelling_it_is_written() {
        assert_eq!(path_of("https://api.example.test/orders/42?x=1").as_deref(), Some("/orders/42"));
        assert_eq!(path_of("${API}/orders/${id}").as_deref(), Some("/orders/${id}"));
        assert_eq!(path_of("/orders").as_deref(), Some("/orders"));
        assert_eq!(path_of("https://api.example.test"), None, "an origin states no path");
        assert_eq!(path_of("ordersUrl"), None, "a variable is not a path");
        assert_eq!(path_of("/"), None);
    }

    #[test]
    fn parameters_in_any_syntax_normalise_to_the_same_route() {
        let routes = ["/orders/:id", "/orders/{id}", "/orders/${id}", "/orders/<id>", "/orders/42", "/Orders/[id]", "/orders/3f2b8c1e-0a4d-4c8e-9d1a-5b6c7d8e9f01"];
        for route in routes {
            assert_eq!(normalize(route), "/orders/*", "{route}");
        }
        assert_eq!(normalize("/orders/items"), "/orders/items", "a word is a segment of the route");
    }

    fn write(root: &Path, rel: &str, text: &str) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn temp(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("cf-card-{tag}-{}-{}", std::process::id(), uuid::Uuid::new_v4()))
    }

    #[test]
    fn a_frontend_that_calls_services_is_a_frontend_with_its_calls() {
        let root = temp("web");
        write(&root, "package.json", r#"{"dependencies":{"react-dom":"18","next":"14"}}"#);
        write(
            &root,
            "src/orders.ts",
            "export const load = (id: string) => fetch(`${process.env.NEXT_PUBLIC_BFF_URL}/orders/${id}`);\nexport const create = () => fetch('/api/orders', { method: 'POST', body: '{}' });\n",
        );
        let card = scan(&root).unwrap();
        assert_eq!(card.role, Role::Frontend, "{}", card.role_reason);
        let paths: Vec<(&str, Option<&str>)> = card.consumes.iter().filter(|c| c.path.is_some()).map(|c| (c.method.as_str(), c.path.as_deref())).collect();
        assert!(paths.contains(&("GET", Some("/orders/${id}"))), "{paths:?}");
        assert!(paths.contains(&("POST", Some("/api/orders"))), "{paths:?}");
        let call = card.consumes.iter().find(|c| c.path.as_deref() == Some("/orders/${id}")).unwrap();
        assert_eq!(call.env.as_deref(), Some("NEXT_PUBLIC_BFF_URL"), "the variable is named, never its value");
        assert_eq!((call.file.as_str(), call.line), ("src/orders.ts", 1));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_server_with_no_database_that_calls_others_is_a_bff_and_one_with_a_database_is_core() {
        let bff = temp("bff");
        write(&bff, "package.json", r#"{"dependencies":{"express":"4","axios":"1"}}"#);
        write(&bff, "src/server.ts", "app.get('/orders/:id', async (req, res) => { const r = await axios.get(`${process.env.CORE_URL}/internal/orders/${req.params.id}`); res.json(r.data); });\n");
        let card = scan(&bff).unwrap();
        assert_eq!(card.role, Role::Bff, "{}", card.role_reason);
        assert!(card.exposes.iter().any(|e| e.channel == Channel::Http && e.name == "/orders/:id"));
        let _ = std::fs::remove_dir_all(&bff);

        let core = temp("core");
        write(&core, "package.json", r#"{"dependencies":{"express":"4","pg":"8","ioredis":"5"}}"#);
        write(&core, "src/server.ts", "app.get('/internal/orders/:id', (req, res) => res.json({}));\n");
        let card = scan(&core).unwrap();
        assert_eq!(card.role, Role::Core, "{}", card.role_reason);
        let kinds: Vec<&str> = card.infra.iter().map(|i| i.kind.as_str()).collect();
        assert!(kinds.contains(&"postgres") && kinds.contains(&"redis"), "{kinds:?}");
        let _ = std::fs::remove_dir_all(&core);
    }

    #[test]
    fn an_azure_function_is_recognised_with_its_http_route_and_its_queue() {
        let root = temp("fn");
        write(&root, "host.json", "{}");
        write(&root, "package.json", r#"{"dependencies":{"@azure/functions":"4","@azure/service-bus":"7"}}"#);
        write(
            &root,
            "src/functions/notify.ts",
            "app.http('notify', { methods: ['POST'], route: 'notifications/{id}', handler });\napp.serviceBusQueue('onOrder', { queueName: 'orders-created', connection: 'SB', handler });\n",
        );
        write(&root, "src/send.ts", "const sender = client.createSender('orders-created');\n");
        let card = scan(&root).unwrap();
        assert_eq!(card.role, Role::Function, "{}", card.role_reason);
        assert!(card.exposes.iter().any(|e| e.channel == Channel::Http && e.method == "POST" && e.name == "/api/notifications/{id}"), "{:?}", card.exposes);
        assert!(card.exposes.iter().any(|e| e.channel == Channel::Queue && e.name == "orders-created"));
        assert!(card.consumes.iter().any(|c| c.channel == Channel::Queue && c.queue.as_deref() == Some("orders-created")));
        assert!(card.infra.iter().any(|i| i.kind == "servicebus"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_csharp_function_names_its_route_and_methods() {
        let root = temp("cs");
        write(&root, "App.csproj", r#"<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Microsoft.Azure.Functions.Worker" Version="1.0" /></ItemGroup></Project>"#);
        write(&root, "Fn.cs", "[Function(\"Get\")]\npublic IActionResult Run([HttpTrigger(AuthorizationLevel.Function, \"get\", \"post\", Route = \"reports/{id}\")] HttpRequest req) => null;\n");
        let card = scan(&root).unwrap();
        assert_eq!(card.role, Role::Function);
        let found: Vec<(&str, &str)> = card.exposes.iter().filter(|e| e.channel == Channel::Http).map(|e| (e.method.as_str(), e.name.as_str())).collect();
        assert!(found.contains(&("GET", "/api/reports/{id}")) && found.contains(&("POST", "/api/reports/{id}")), "{found:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn tests_and_generated_code_are_not_what_a_repository_does() {
        let root = temp("skip");
        write(&root, "package.json", r#"{"dependencies":{"express":"4"}}"#);
        write(&root, "src/real.ts", "app.get('/real', h);\n");
        write(&root, "src/real.test.ts", "app.get('/only-in-a-test', h);\n");
        write(&root, "node_modules/x/index.js", "app.get('/vendored', h);\n");
        let card = scan(&root).unwrap();
        let names: Vec<&str> = card.exposes.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["/real"], "{names:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_repository_that_declares_nothing_is_a_library() {
        let root = temp("lib");
        write(&root, "package.json", r#"{"name":"shared"}"#);
        write(&root, "src/util.ts", "export const sum = (a: number, b: number) => a + b;\n");
        assert_eq!(scan(&root).unwrap().role, Role::Library);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_path_that_is_not_a_folder_is_an_error() {
        assert!(scan(Path::new("/definitely/not/here")).is_err());
    }
}
