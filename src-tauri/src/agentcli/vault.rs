//! The verbs that use what the app keeps for the user — a database connection, an API request, a
//! Llavero entry — on an agent's behalf, without ever handing it over.
//!
//! # The rule
//!
//! An agent may **use** a saved credential; it never **receives** one. Every use waits for the
//! user's approval in the window, showing exactly what will run — the SQL, the request, the command —
//! and the credential stays on this side:
//!
//! - `cf db` connects with the saved password (attached from the keychain, as the database console
//!   does) and returns rows. The agent sees results, never the connection string. Only on a
//!   connection the user opened to AI («Acceso de IA», [`AiAccess`]): reads run without asking, on
//!   a read-only session; writes need «Lectura y escritura» and are approved one by one.
//! - `cf http` sends the saved request through the API client's own path (`runSavedRequest` in the
//!   window, which resolves its environment), and the answer comes back with every stored API
//!   credential scrubbed and the credential-bearing headers dropped.
//! - `cf secret` is the one where the secret must reach a program — so the *app* runs the program,
//!   with the secret in its environment, and returns its output with the secret (and its base64 and
//!   URL-encoded forms) scrubbed. The user approves the exact command each time: a command is code,
//!   and `echo $TOKEN` is a command too.
//!
//! A given saved request can be allowed for the rest of the run of one terminal ("allow in this
//! terminal"); database writes and Llavero secrets are asked every time.

use std::time::Duration;

use base64::Engine as _;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use super::{approve, pick, place, AskEvent, Reply, Request};
use crate::db::Db;

/// What a scrubbed secret reads as.
const REDACTED: &str = "[secret]";
/// Shorter values are not scrubbed: replacing every "abc" in a page of output scrubs nothing real
/// and wrecks the output. The API client draws the same line (`api_secrets::MIN_SCRUB_LEN`).
const MIN_SCRUB: usize = 4;
/// The most of a command's output, or a response's body, sent back.
const MAX_OUTPUT: usize = 1 << 20;

// ----------------------------------------------------------------------------------------- secret

/// `cf secret <NAME> [--field <key>] [--env <VAR>] -- '<command>'`.
pub async fn secret(request: &Request, app: &AppHandle) -> Reply {
    let usage = || Reply::no("usage: cf secret <NAME> [--field <key>] [--env <VAR>] -- '<command using $VAR>'");
    let Some(split) = request.args.iter().position(|a| a == "--") else { return usage() };
    let (head, command) = (&request.args[..split], request.args[split + 1..].join(" "));
    let mut name = Vec::new();
    let mut field: Option<String> = None;
    let mut var: Option<String> = None;
    let mut iter = head.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--field" => field = iter.next().cloned(),
            "--env" => var = iter.next().cloned(),
            _ => name.push(arg.clone()),
        }
    }
    let name = name.join(" ");
    if name.trim().is_empty() || command.trim().is_empty() {
        return usage();
    }
    let var = match var {
        Some(var) if is_env_name(&var) => var,
        Some(var) => return Reply::no(format!("{var} is not a valid environment variable name")),
        None => env_name(&name),
    };

    let place = place::of(app, &request.cwd, &request.session);
    let workspace = place.workspace_id.clone().unwrap_or_default();
    let items = crate::ai_usage::with_conn(|conn| crate::db::keyvault_queries::load_tree(conn, &workspace))
        .and_then(Result::ok)
        .map(|tree| tree.items)
        .unwrap_or_default();
    let item = match pick(items, &name, |item| item.title.as_str()) {
        Ok(item) => item,
        Err(names) if names.is_empty() => return Reply::no(format!("no Llavero entry named {name} here (it lists only this workspace's and the global ones)")),
        Err(names) => return Reply::no(format!("{name} matches several Llavero entries: {}", names.join(", "))),
    };
    let session = app.state::<crate::keyvault::session::VaultSession>();
    if !session.is_unlocked() {
        return Reply::no("the Llavero is locked — ask the user to unlock it in the app, then run this again");
    }

    let mut event = AskEvent::new("secret", format!("«{}» → ${var}", item.title), &request.cwd);
    event.detail = command.clone();
    if let Err(refused) = approve(app, request, &item.id, event).await {
        return refused;
    }

    // Read only now, after the approval — and through the one command that reads a single entry (it
    // checks the Llavero is still unlocked and writes the audit row the Llavero shows).
    let plain = match crate::commands::keyvault_cmd::keyvault_get_item(app.state::<Db>(), app.state::<crate::keyvault::session::VaultSession>(), item.id.clone()) {
        Ok(Some(plain)) => plain,
        Ok(None) => return Reply::no("that Llavero entry is gone"),
        Err(error) if error.contains("locked") => return Reply::no("the Llavero locked before the command ran — ask the user to unlock it"),
        Err(error) => return Reply::no(error),
    };
    let value = match secret_field(&plain.secret, field.as_deref()) {
        Ok(value) => value,
        Err(error) => return Reply::no(error),
    };

    let mut cmd = if cfg!(windows) {
        let mut cmd = crate::proc::command("cmd");
        cmd.arg("/C").arg(&command);
        cmd
    } else {
        let mut cmd = crate::proc::command("sh");
        cmd.arg("-c").arg(&command);
        cmd
    };
    cmd.current_dir(&request.cwd).env(&var, &value).stdin(std::process::Stdio::null()).kill_on_drop(true);
    if let Some(path) = crate::shell_env::fresh_path() {
        cmd.env("PATH", path);
    }
    let output = match tokio::time::timeout(Duration::from_secs(600), cmd.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => return Reply::no(format!("the command could not start: {error}")),
        Err(_) => return Reply::no("the command ran for 10 minutes and was stopped"),
    };
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    let errors = String::from_utf8_lossy(&output.stderr);
    if !errors.trim().is_empty() {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&errors);
    }
    let mut text = scrub(&clip(text), &forms_of(&value));
    if output.status.success() {
        Reply::ok(text.trim_end().to_string())
    } else {
        text.push_str(&format!("\n[exit code {}]", output.status.code().map_or_else(|| "signal".to_string(), |c| c.to_string())));
        Reply::no(text.trim().to_string())
    }
}

/// Which value of an entry a command gets: the field asked for, or the first a credential of its kind
/// keeps its secret in. Never a TOTP seed — a code generator's seed is the second factor itself.
fn secret_field(secret: &Value, field: Option<&str>) -> Result<String, String> {
    const ORDER: &[&str] =
        &["password", "apiKey", "token", "secretAccessKey", "connectionString", "privateKey", "passphrase", "pin", "secret", "value"];
    let text = |key: &str| secret.get(key).and_then(Value::as_str).filter(|v| !v.is_empty()).map(str::to_string);
    let custom = |key: &str| {
        secret.get("custom").and_then(Value::as_array).and_then(|fields| {
            fields
                .iter()
                .find(|f| f.get("name").and_then(Value::as_str).is_some_and(|n| n.eq_ignore_ascii_case(key)))
                .and_then(|f| f.get("value").and_then(Value::as_str))
                .filter(|v| !v.is_empty())
                .map(str::to_string)
        })
    };
    match field {
        Some(key) if key.eq_ignore_ascii_case("totp") => Err("a TOTP seed is never handed to a command".to_string()),
        Some(key) => text(key).or_else(|| custom(key)).ok_or_else(|| format!("that entry has no {key} field")),
        None => ORDER.iter().find_map(|key| text(key)).ok_or_else(|| "that entry has no secret value a command could use (name one with --field)".to_string()),
    }
}

/// `GitHub token` → `GITHUB_TOKEN`.
fn env_name(title: &str) -> String {
    let mut out = String::new();
    for ch in title.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_uppercase());
        } else if !out.ends_with('_') && !out.is_empty() {
            out.push('_');
        }
    }
    let out = out.trim_end_matches('_').to_string();
    match out.chars().next() {
        None => "SECRET".to_string(),
        Some(first) if first.is_ascii_digit() => format!("_{out}"),
        Some(_) => out,
    }
}

fn is_env_name(name: &str) -> bool {
    !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && !name.starts_with(|c: char| c.is_ascii_digit())
}

/// The secret as output could carry it: itself, base64 (standard and URL-safe, padded or not), and
/// percent-encoded — the forms an `Authorization: Basic` header or a query string turns it into.
fn forms_of(value: &str) -> Vec<String> {
    let mut forms = vec![value.to_string()];
    for engine in [&base64::engine::general_purpose::STANDARD, &base64::engine::general_purpose::URL_SAFE] {
        let encoded = engine.encode(value);
        forms.push(encoded.trim_end_matches('=').to_string());
        forms.push(encoded);
    }
    forms.push(percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC).to_string());
    forms
}

/// `text` with every one of `secrets` (at least [`MIN_SCRUB`] long) replaced, longest first so a
/// secret that contains another is scrubbed whole — and then anything that merely *looks* like a
/// credential (`secret_scan`'s rules: a token a login endpoint just issued, a key in a row), because
/// the rule is that an agent never receives one, not only that it never receives ours.
fn scrub(text: &str, secrets: &[String]) -> String {
    let mut secrets: Vec<&String> = secrets.iter().filter(|s| s.chars().count() >= MIN_SCRUB).collect();
    secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
    secrets.dedup();
    let mut out = text.to_string();
    for secret in secrets {
        if out.contains(secret.as_str()) {
            out = out.replace(secret.as_str(), REDACTED);
        }
    }
    crate::secret_scan::redact(&out).0
}

fn clip(mut text: String) -> String {
    if text.len() > MAX_OUTPUT {
        let mut cut = MAX_OUTPUT;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push_str("\n[… output cut at 1 MB]");
    }
    text
}

// --------------------------------------------------------------------------------------------- db

/// Rows `cf db` returns when not told otherwise, and the most it will. Fifty: every row is tokens a
/// model pays for, and a question about data is answered with an aggregate, not a dump.
const DEFAULT_ROWS: u32 = 50;
const MAX_ROWS: u32 = 5_000;
/// The widest a cell is printed; the rest of a long value is cut with an ellipsis.
const CELL_MAX: usize = 80;
/// A whole-schema listing longer than this becomes the table names alone, and the agent asks for
/// the tables it needs one by one.
const SCHEMA_MAX: usize = 16_000;
/// How long a schema read is reused: the catalog rarely changes between two questions, and reading
/// it is the slow part of answering one. A write through `db` drops the connection's entries.
const SCHEMA_FRESH: Duration = Duration::from_secs(600);

/// Schema answers by connection, its spec's last change, database, schema and table.
static SCHEMAS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, String)>>> =
    std::sync::LazyLock::new(Default::default);

fn forget_schemas(connection_id: &str) {
    if let Ok(mut held) = SCHEMAS.lock() {
        held.retain(|key, _| !key.starts_with(&format!("{connection_id}|")));
    }
}

/// The schema as a model reads it cheapest: one line per table, its columns comma-separated with
/// their marks and where each foreign key points (`~` for a relation guessed from a name).
pub(crate) fn compact_schema(diagram: &crate::datasource::DbSchemaDiagram) -> String {
    let qualified = |schema: &Option<String>, name: &str| match schema {
        Some(s) => format!("{s}.{name}"),
        None => name.to_string(),
    };
    let mut out = String::new();
    for table in &diagram.tables {
        let columns: Vec<String> = table
            .columns
            .iter()
            .map(|c| {
                let mut text = format!("{} {}", c.name, c.data_type);
                if c.primary_key {
                    text.push_str(" PK");
                }
                if let Some(edge) = diagram.edges.iter().find(|e| e.from_table == table.name && e.from_schema == table.schema && e.from_column == c.name) {
                    text.push_str(&format!(" {}→{}.{}", if edge.inferred { "~" } else { "" }, edge.to_table, edge.to_column));
                }
                if !c.nullable && !c.primary_key {
                    text.push_str(" NN");
                }
                text
            })
            .collect();
        let rows = table.row_estimate.map(|n| format!(" ~{n} rows")).unwrap_or_default();
        out.push_str(&format!("{}{rows}: {}\n", qualified(&table.schema, &table.name), columns.join(", ")));
    }
    for note in &diagram.notes {
        out.push_str(&format!("note: {note}\n"));
    }
    out
}
/// How long a model's statement may run before CodeFlow stops it on the server: a read (which runs
/// without asking — a heavy one must not hold a production server) and a write the user approved.
const READ_LIMIT: Duration = Duration::from_secs(30);
const WRITE_LIMIT: Duration = Duration::from_secs(120);

/// What the user lets a model do on one connection — «Acceso de IA» in its options, saved in the
/// spec as `ai_access`. Absent (or anything else) is [`AiAccess::None`]: a connection made before the
/// setting existed stays closed to every model until the user opens it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AiAccess {
    None,
    /// Reads, run without asking — on a session opened read-only, so the driver refuses a write
    /// whatever the statement looks like.
    Read,
    /// Reads as above; every write shown to the user verbatim and run only once approved.
    Write,
}

impl AiAccess {
    pub(crate) fn of_spec(spec: &str) -> Self {
        let parsed: Value = serde_json::from_str(spec).unwrap_or(Value::Null);
        match parsed.get("ai_access").and_then(Value::as_str) {
            Some("read") => AiAccess::Read,
            Some("write") => AiAccess::Write,
            _ => AiAccess::None,
        }
    }

    fn label(self) -> &'static str {
        match self {
            AiAccess::None => "closed",
            AiAccess::Read => "read only",
            AiAccess::Write => "read and write (each write approved by the user)",
        }
    }
}

/// The saved connections of the run's workspace and the global ones, with what a model may do on each.
fn connections_here(app: &AppHandle, request: &Request) -> Vec<(crate::db::models::DbConnectionRow, AiAccess)> {
    let place = place::of(app, &request.cwd, &request.session);
    let workspace = place.workspace_id.unwrap_or_default();
    crate::ai_usage::with_conn(|conn| crate::db::datasource_queries::load_tree(conn, &workspace))
        .and_then(Result::ok)
        .map(|tree| tree.connections)
        .unwrap_or_default()
        .into_iter()
        .map(|row| {
            let access = AiAccess::of_spec(&row.spec);
            (row, access)
        })
        .collect()
}

/// The connection named `name`, when the user opened it to AI — or the reply that says why not.
fn usable(app: &AppHandle, request: &Request, name: &str) -> Result<(crate::db::models::DbConnectionRow, AiAccess), Reply> {
    let row = match pick(connections_here(app, request), name, |(row, _)| row.name.as_str()) {
        Ok(found) => found,
        Err(names) if names.is_empty() => return Err(Reply::no(format!("no saved database connection named {name} here — db_connections lists them"))),
        Err(names) => return Err(Reply::no(format!("{name} matches several connections: {}", names.join(", ")))),
    };
    if row.1 == AiAccess::None {
        return Err(Reply::no(format!(
            "«{}» is closed to AI. The user opens it in Base de datos › the connection's settings › Opciones › Acceso de IA.",
            row.0.name
        )));
    }
    Ok(row)
}

/// `cf dbs`: the connections a model may use here, and the names of the ones it may not.
pub fn dbs(request: &Request, app: &AppHandle) -> Reply {
    let all = connections_here(app, request);
    if all.is_empty() {
        return Reply::ok("No saved database connections in this workspace.");
    }
    let (open, closed): (Vec<_>, Vec<_>) = all.into_iter().partition(|(_, access)| *access != AiAccess::None);
    let mut out = String::new();
    if open.is_empty() {
        out.push_str("No connection is open to AI. The user opens one in Base de datos › the connection's settings › Opciones › Acceso de IA.\n");
    } else {
        out.push_str("Connections open to AI (name · engine · environment · database · access):\n");
        for (row, access) in &open {
            let spec: Value = serde_json::from_str(&row.spec).unwrap_or(Value::Null);
            let field = |key: &str| spec.get(key).and_then(Value::as_str).filter(|v| !v.is_empty()).unwrap_or("—").to_string();
            let read_only = if spec.get("read_only").and_then(Value::as_bool).unwrap_or(false) { " · the connection itself is read-only" } else { "" };
            out.push_str(&format!("- {} · {} · {} · {} · {}{read_only}\n", row.name, row.kind, field("environment"), field("database"), access.label()));
        }
    }
    if !closed.is_empty() {
        let names: Vec<&str> = closed.iter().map(|(row, _)| row.name.as_str()).collect();
        out.push_str(&format!("Closed to AI (the user can open them in their settings): {}\n", names.join(", ")));
    }
    Reply::ok(out.trim_end().to_string())
}

/// `cf dbschema <connection> [--database D] [--schema S] [table]`: the tables, columns, keys and
/// relationships — read by CodeFlow's own driver on a read-only session, no approval needed.
pub async fn dbschema(request: &Request, app: &AppHandle) -> Reply {
    let usage = || Reply::no("usage: cf dbschema <connection> [--database D] [--schema S] [table]");
    let mut args = request.args.clone();
    let mut take = |flag: &str| -> Option<String> {
        let at = args.iter().position(|a| a == flag)?;
        let value = args.get(at + 1).cloned();
        args.drain(at..(at + 2).min(args.len()));
        value.filter(|v| !v.trim().is_empty())
    };
    let database = take("--database");
    let schema = take("--schema");
    let Some((name, rest)) = args.split_first() else { return usage() };
    let table = rest.first().map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
    let (row, _) = match usable(app, request, name) {
        Ok(found) => found,
        Err(refused) => return refused,
    };
    let key = format!("{}|{}|{}|{}|{}", row.id, row.updated_at, database.as_deref().unwrap_or(""), schema.as_deref().unwrap_or(""), table.as_deref().unwrap_or("").to_lowercase());
    if let Some(text) = SCHEMAS.lock().ok().and_then(|held| held.get(&key).filter(|(at, _)| at.elapsed() < SCHEMA_FRESH).map(|(_, text)| text.clone())) {
        return Reply::ok(text);
    }
    let mut config = match crate::commands::db_cmd::resolve_config(&app.state::<Db>(), &row.id) {
        Ok(config) => config,
        Err(error) => return Reply::no(error),
    };
    config.read_only = true;
    let tag = format!("agentcli-{}", uuid::Uuid::new_v4());
    let session = match crate::datasource::Session::open_tagged(&config, database.as_deref(), &tag).await {
        Ok(session) => session,
        Err(error) => return Reply::no(error),
    };
    let node = crate::datasource::DbNodeRef {
        kind: if schema.is_some() { crate::datasource::DbNodeKind::Schema } else { crate::datasource::DbNodeKind::Database },
        database: database.clone(),
        schema: schema.clone(),
        name: schema.clone().or_else(|| database.clone()),
    };
    let mut diagram = match tokio::time::timeout(READ_LIMIT, session.schema_diagram(&node)).await {
        Ok(Ok(diagram)) => diagram,
        Ok(Err(error)) => return Reply::no(error),
        Err(_) => {
            session.cancel_running().await;
            return Reply::no(format!("reading the catalog took over {} s — ask for one schema or one table", READ_LIMIT.as_secs()));
        }
    };
    let scope = match (diagram.database.as_deref(), diagram.schema.as_deref()) {
        (Some(db), Some(s)) => format!("database {db}, schema {s}"),
        (Some(db), None) => format!("database {db}"),
        (None, Some(s)) => format!("schema {s}"),
        (None, None) => "the connection's default database".to_string(),
    };
    if let Some(wanted) = &table {
        let wanted = wanted.to_lowercase();
        let matches = |schema: &Option<String>, name: &str| {
            let name = name.to_lowercase();
            name == wanted || schema.as_ref().is_some_and(|s| format!("{}.{name}", s.to_lowercase()) == wanted)
        };
        let all: Vec<String> = diagram.tables.iter().map(|t| t.name.clone()).collect();
        diagram.tables.retain(|t| matches(&t.schema, &t.name));
        if diagram.tables.is_empty() {
            return Reply::no(format!("no table {wanted} in {scope}. Tables: {}", all.join(", ")));
        }
        diagram.edges.retain(|e| matches(&e.from_schema, &e.from_table) || matches(&e.to_schema, &e.to_table));
    }
    let mut text = compact_schema(&diagram);
    if table.is_none() && text.len() > SCHEMA_MAX {
        let names: Vec<String> = diagram
            .tables
            .iter()
            .map(|t| match &t.schema {
                Some(s) => format!("{s}.{} ({} columns)", t.name, t.columns.len()),
                None => format!("{} ({} columns)", t.name, t.columns.len()),
            })
            .collect();
        text = format!("{} tables — too many to show whole; ask for one by name:\n{}", names.len(), names.join("\n"));
    }
    let text = clip(scrub(&format!("{} · {scope}\n{text}", config.engine_label()), &[]));
    if let Ok(mut held) = SCHEMAS.lock() {
        held.insert(key, (std::time::Instant::now(), text.clone()));
    }
    Reply::ok(text)
}

/// `cf db <connection> [--read|--write] [--max-rows N] <SQL>`: the statement on a saved connection
/// the user opened to AI, as text tables. A read runs at once on a read-only session; a write needs
/// «Lectura y escritura» and the user's approval of the exact statement, every time.
pub async fn db(request: &Request, app: &AppHandle) -> Reply {
    let usage = || Reply::no("usage: cf db <connection> [--read|--write] [--max-rows N] <SQL>");
    let mut args = request.args.clone();
    let mut max_rows = DEFAULT_ROWS;
    if let Some(at) = args.iter().position(|a| a == "--max-rows") {
        let Some(n) = args.get(at + 1).and_then(|n| n.parse::<u32>().ok()) else { return usage() };
        max_rows = n.clamp(1, MAX_ROWS);
        args.drain(at..at + 2);
    }
    let mut flag = |name: &str| match args.iter().position(|a| a == name) {
        Some(at) => {
            args.remove(at);
            true
        }
        None => false,
    };
    let only_read = flag("--read");
    flag("--write");
    let Some((name, sql)) = args.split_first() else { return usage() };
    let sql = sql.join(" ");
    if sql.trim().is_empty() {
        return usage();
    }
    let (row, access) = match usable(app, request, name) {
        Ok(found) => found,
        Err(refused) => return refused,
    };
    let mut config = match crate::commands::db_cmd::resolve_config(&app.state::<Db>(), &row.id) {
        Ok(config) => config,
        Err(error) => return Reply::no(error),
    };
    let writes = crate::datasource::export_refusal(config.kind, &sql).is_some();
    if writes {
        if only_read {
            return Reply::no("This statement changes data, and db_read only reads. Use db_write: the user approves it first.");
        }
        if access != AiAccess::Write {
            return Reply::no(format!("«{}» is open to AI for reading only. Writing needs «Lectura y escritura» in its Acceso de IA.", row.name));
        }
        if config.read_only {
            return Reply::no(format!("«{}» is a read-only connection: it refuses every write.", row.name));
        }
        let production = config.environment.eq_ignore_ascii_case("prod") || config.environment.eq_ignore_ascii_case("production");
        let what = if production { "changes data on PRODUCTION" } else { "changes data" };
        let mut event = AskEvent::new("db", format!("«{}» — {what}", row.name), &request.cwd);
        event.detail = sql.clone();
        // A write is asked every time: one click must not approve the next statement unseen.
        event.always = false;
        if let Err(refused) = approve(app, request, &row.id, event).await {
            return refused;
        }
    } else {
        // What makes a read a read is the driver, not the statement's first word: the session is
        // opened read-only, so whatever slips past the classifier is refused before it is sent.
        config.read_only = true;
    }

    let tag = format!("agentcli-{}", uuid::Uuid::new_v4());
    let session = match crate::datasource::Session::open_tagged(&config, None, &tag).await {
        Ok(session) => session,
        Err(error) => return Reply::no(error),
    };
    let context = crate::datasource::DbExecContext { database: None, schema: None, max_rows };
    let limit = if writes { WRITE_LIMIT } else { READ_LIMIT };
    let started = std::time::Instant::now();
    let outcome = match tokio::time::timeout(limit, session.execute(&sql, &context)).await {
        Ok(outcome) => outcome,
        Err(_) => {
            // Dropping the call stops waiting; this stops the statement on the server too, where the
            // engine can (Postgres, MySQL, IRIS, Oracle, SQLite, JDBC).
            session.cancel_running().await;
            Err(format!(
                "stopped after {} s: the statement ran too long and was cancelled on the server. Narrow it — a WHERE on an indexed column, a LIMIT, a COUNT instead of the rows — and try again.",
                limit.as_secs()
            ))
        }
    };
    let elapsed = started.elapsed().as_millis() as i64;
    let reply = match &outcome {
        Ok(result) => {
            let failed = result.results.iter().any(|r| r.error.is_some());
            let text = scrub(&result.results.iter().map(render_statement).collect::<Vec<_>>().join("\n\n"), &[]);
            if failed {
                Reply::no(text)
            } else {
                Reply::ok(text)
            }
        }
        Err(error) => Reply::no(error.clone()),
    };
    let (rows, error) = match &outcome {
        Ok(result) => (
            result.results.iter().map(|r| r.rows_affected.unwrap_or(r.rows.len() as i64)).sum(),
            result.results.iter().find_map(|r| r.error.clone()).unwrap_or_default(),
        ),
        Err(error) => (0, error.clone()),
    };
    record(app, request, &row, &sql, elapsed, rows, &error);
    if writes {
        // It may have changed the tables: the next schema question reads them again.
        forget_schemas(&row.id);
    }
    reply
}

/// What a model ran, in the connection's query history and marked as the AI's — where the user
/// already looks for what ran against a server — and the window told to show it.
fn record(app: &AppHandle, request: &Request, row: &crate::db::models::DbConnectionRow, sql: &str, duration_ms: i64, row_count: i64, error: &str) {
    let Some(workspace) = place::of(app, &request.cwd, &request.session).workspace_id.filter(|ws| !ws.is_empty()) else { return };
    let spec: Value = serde_json::from_str(&row.spec).unwrap_or(Value::Null);
    let entry = crate::db::models::DbQueryHistoryEntry {
        id: String::new(),
        workspace_id: workspace,
        connection_id: row.id.clone(),
        connection_name: row.name.clone(),
        statement: sql.to_string(),
        database_name: spec.get("database").and_then(Value::as_str).unwrap_or_default().to_string(),
        duration_ms,
        row_count,
        error: error.to_string(),
        ran_at: String::new(),
        source: "ai".to_string(),
    };
    if crate::ai_usage::with_conn(|conn| crate::db::datasource_queries::add_history(conn, &entry).is_ok()) == Some(true) {
        let _ = app.emit("db:history-changed", ());
    }
}

/// One statement's result as text: an aligned table, the documents of a document store, the rows it
/// changed, what the server said.
fn render_statement(result: &crate::datasource::DbStatementResult) -> String {
    if let Some(error) = &result.error {
        return format!("error: {error}");
    }
    let mut out = Vec::new();
    if !result.columns.is_empty() {
        let cell = |value: &Option<String>| match value {
            None => "NULL".to_string(),
            Some(text) => {
                let flat = text.replace(['\n', '\r', '\t'], " ");
                if flat.chars().count() > CELL_MAX { format!("{}…", flat.chars().take(CELL_MAX - 1).collect::<String>()) } else { flat }
            }
        };
        let header: Vec<String> = result.columns.iter().map(|c| c.name.clone()).collect();
        let rows: Vec<Vec<String>> = result.rows.iter().map(|row| row.iter().map(cell).collect()).collect();
        let widths: Vec<usize> = (0..header.len())
            .map(|i| rows.iter().map(|r| r.get(i).map_or(0, |c| c.chars().count())).chain([header[i].chars().count()]).max().unwrap_or(0))
            .collect();
        let line = |cells: &[String]| {
            cells.iter().enumerate().map(|(i, c)| format!("{c:<width$}", width = widths.get(i).copied().unwrap_or(0))).collect::<Vec<_>>().join("  ").trim_end().to_string()
        };
        out.push(line(&header));
        out.push(widths.iter().map(|w| "-".repeat(*w)).collect::<Vec<_>>().join("  "));
        out.extend(rows.iter().map(|r| line(r)));
        let count = result.rows.len();
        out.push(format!("({count} row{}{})", if count == 1 { "" } else { "s" }, if result.truncated { ", more not shown" } else { "" }));
    }
    out.extend(result.documents.iter().cloned());
    if let Some(affected) = result.rows_affected.filter(|_| result.columns.is_empty()) {
        out.push(format!("{affected} row{} affected", if affected == 1 { "" } else { "s" }));
    }
    out.extend(result.messages.iter().cloned());
    if out.is_empty() {
        out.push("done".to_string());
    }
    out.join("\n")
}

// ------------------------------------------------------------------------------------------- http

/// Headers that carry credentials, never shown to the agent whatever the scrub catches.
const SECRET_HEADERS: &[&str] = &["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key", "api-key"];

/// `cf http <request> [--env <environment>]`: a request saved in the API client, sent the way the API
/// client sends it — its environment, inherited auth and trusted scripts — and its answer.
pub async fn http(request: &Request, app: &AppHandle) -> Reply {
    let usage = || Reply::no("usage: cf http <collection/folder/request or request name> [--env <environment>]");
    let mut args = request.args.clone();
    let mut env: Option<String> = None;
    if let Some(at) = args.iter().position(|a| a == "--env") {
        let Some(name) = args.get(at + 1).cloned() else { return usage() };
        env = Some(name);
        args.drain(at..at + 2);
    }
    let wanted = args.join(" ");
    if wanted.trim().is_empty() {
        return usage();
    }
    let place = place::of(app, &request.cwd, &request.session);
    let Some(workspace) = place.workspace_id.clone() else { return Reply::no("this folder is not in a project of any workspace") };
    let (tree, environments) = match crate::ai_usage::with_conn(|conn| {
        Ok::<_, rusqlite::Error>((crate::db::api_queries::load_tree(conn, &workspace)?, crate::db::api_queries::list_environments(conn, &workspace)?))
    }) {
        Some(Ok(found)) => found,
        _ => return Reply::no("the API client's requests could not be read"),
    };

    let paths: Vec<(String, crate::db::models::ApiRequestRow)> = tree.requests.iter().map(|r| (request_path(&tree, r), r.clone())).collect();
    let normal = |path: &str| path.split('/').map(str::trim).filter(|p| !p.is_empty()).collect::<Vec<_>>().join("/");
    let found = pick(paths.clone(), &normal(&wanted), |(path, _)| path.as_str()).or_else(|by_path| {
        if by_path.is_empty() { pick(paths, wanted.trim(), |(_, r)| r.name.as_str()) } else { Err(by_path) }
    });
    let (path, saved) = match found {
        Ok(found) => found,
        Err(names) if names.is_empty() => return Reply::no(format!("no saved request named {wanted} in this workspace's API client")),
        Err(names) => return Reply::no(format!("{wanted} matches several requests: {}", names.join(", "))),
    };
    if !saved.protocol.is_empty() && !saved.protocol.eq_ignore_ascii_case("http") {
        return Reply::no(format!("{path} is a {} request; cf http sends HTTP ones", saved.protocol));
    }
    let (environment_id, environment_label) = match env.as_deref() {
        None => (String::new(), "the API client's active environment".to_string()),
        Some(name) if name.eq_ignore_ascii_case("none") => ("none".to_string(), "no environment".to_string()),
        Some(name) => match pick(environments.into_iter().filter(|e| !e.is_global).collect(), name, |e| e.name.as_str()) {
            Ok(found) => (found.id, format!("environment {}", found.name)),
            Err(names) if names.is_empty() => return Reply::no(format!("no environment named {name}")),
            Err(names) => return Reply::no(format!("{name} matches several environments: {}", names.join(", "))),
        },
    };

    let mut event = AskEvent::new("http", format!("«{path}»"), &request.cwd);
    // The saved URL as written — `{{variables}}` and all. The resolved one may carry a key in its
    // query string, and this is the line the user approves, not one the agent reads back.
    event.detail = format!("{} {}\n({environment_label})", saved.method.to_uppercase(), saved.url);
    event.always = true;
    if let Err(refused) = approve(app, request, &format!("{}|{environment_id}", saved.id), event).await {
        return refused;
    }

    let payload = json!({ "workspaceId": workspace, "requestId": saved.id, "environmentId": environment_id, "variables": {} });
    let answer = crate::flows::bridge::ask(app, "api.request", payload, Duration::from_secs(300), tokio_util::sync::CancellationToken::new()).await;
    let answer = match answer {
        Ok(answer) => answer,
        Err(error) => return Reply::no(error),
    };
    let secrets = crate::db::api_secrets::stored_secrets(&app.state::<Db>());
    let (ok, text) = render_response(&answer, &saved.url);
    let text = scrub(&text, &secrets);
    if ok {
        Reply::ok(text)
    } else {
        Reply::no(text)
    }
}

/// `Collection/Folder/Sub/Request`, as the API client's sidebar names it.
fn request_path(tree: &crate::db::models::ApiTree, request: &crate::db::models::ApiRequestRow) -> String {
    let mut parts = vec![request.name.clone()];
    let mut folder = request.folder_id.clone();
    let mut guard = 0;
    while let Some(id) = folder {
        guard += 1;
        let Some(found) = tree.folders.iter().find(|f| f.id == id).filter(|_| guard < 64) else { break };
        parts.push(found.name.clone());
        folder = found.parent_id.clone();
    }
    if let Some(collection) = tree.collections.iter().find(|c| c.id == request.collection_id) {
        parts.push(collection.name.clone());
    }
    parts.reverse();
    parts.iter().map(|p| p.trim()).collect::<Vec<_>>().join("/")
}

/// The answer `runSavedRequest` gave, as text: status, headers (no credentials), body. `ok` is a 2xx
/// or 3xx with every test passing.
fn render_response(answer: &Value, saved_url: &str) -> (bool, String) {
    let status = answer.get("status").and_then(Value::as_u64).unwrap_or(0);
    let status_text = answer.get("statusText").and_then(Value::as_str).unwrap_or_default();
    let method = answer.get("method").and_then(Value::as_str).unwrap_or_default();
    let ms = answer.get("durationMs").and_then(Value::as_u64).unwrap_or(0);
    let mut out = vec![format!("{method} {saved_url}"), format!("HTTP {status} {status_text} · {ms} ms")];
    if let Some(interrupted) = answer.get("interrupted").and_then(Value::as_str).filter(|s| !s.is_empty()) {
        out.push(format!("interrupted: {interrupted}"));
    }
    if let Some(headers) = answer.get("headers").and_then(Value::as_object) {
        for (name, value) in headers {
            if SECRET_HEADERS.contains(&name.to_ascii_lowercase().as_str()) {
                continue;
            }
            out.push(format!("{name}: {}", value.as_str().unwrap_or_default()));
        }
    }
    out.push(String::new());
    let body = match answer.get("body") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => match answer.get("bodyBase64").and_then(Value::as_str) {
            Some(raw) => format!("[binary body, {} bytes]", answer.get("sizeBytes").and_then(Value::as_u64).unwrap_or(raw.len() as u64 * 3 / 4)),
            None => String::new(),
        },
        Some(json) => serde_json::to_string_pretty(json).unwrap_or_default(),
    };
    out.push(clip(body));
    let failed_tests = answer.get("testsFailed").and_then(Value::as_u64).unwrap_or(0);
    if let Some(tests) = answer.get("tests").and_then(Value::as_array).filter(|t| !t.is_empty()) {
        out.push(String::new());
        for test in tests {
            let passed = test.get("passed").and_then(Value::as_bool).unwrap_or(false);
            let name = test.get("name").and_then(Value::as_str).unwrap_or_default();
            out.push(format!("{} {name}", if passed { "✓" } else { "✗" }));
        }
    }
    let ok = (200..400).contains(&status) && failed_tests == 0;
    (ok, out.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_schema_reads_as_one_line_per_table() {
        use crate::datasource::{DbDiagramColumn, DbDiagramEdge, DbDiagramTable, DbNodeKind, DbSchemaDiagram};
        let column = |name: &str, data_type: &str, nullable: bool, primary_key: bool| DbDiagramColumn { name: name.into(), data_type: data_type.into(), nullable, primary_key, foreign_key: false };
        let diagram = DbSchemaDiagram {
            database: Some("shop".into()),
            schema: Some("public".into()),
            tables: vec![
                DbDiagramTable { schema: Some("public".into()), name: "orders".into(), kind: DbNodeKind::Table, columns: vec![column("id", "int", false, true), column("customer_id", "int", false, false), column("note", "text", true, false)], row_estimate: Some(1200) },
                DbDiagramTable { schema: Some("public".into()), name: "customers".into(), kind: DbNodeKind::Table, columns: vec![column("id", "int", false, true)], row_estimate: None },
            ],
            edges: vec![DbDiagramEdge {
                constraint: "fk".into(),
                from_schema: Some("public".into()),
                from_table: "orders".into(),
                from_column: "customer_id".into(),
                to_schema: Some("public".into()),
                to_table: "customers".into(),
                to_column: "id".into(),
                inferred: false,
            }],
            notes: vec![],
        };
        assert_eq!(compact_schema(&diagram), "public.orders ~1200 rows: id int PK, customer_id int →customers.id NN, note text\npublic.customers: id int PK\n");
    }

    #[test]
    fn a_connection_is_closed_to_ai_unless_the_user_opened_it() {
        assert_eq!(AiAccess::of_spec(r#"{"host":"localhost"}"#), AiAccess::None, "made before the setting");
        assert_eq!(AiAccess::of_spec(r#"{"ai_access":""}"#), AiAccess::None);
        assert_eq!(AiAccess::of_spec(r#"{"ai_access":"read"}"#), AiAccess::Read);
        assert_eq!(AiAccess::of_spec(r#"{"ai_access":"write"}"#), AiAccess::Write);
        assert_eq!(AiAccess::of_spec(r#"{"ai_access":"admin"}"#), AiAccess::None, "anything unknown stays closed");
        assert_eq!(AiAccess::of_spec("not json"), AiAccess::None);
    }

    #[test]
    fn an_entry_title_becomes_an_environment_name() {
        assert_eq!(env_name("GitHub token"), "GITHUB_TOKEN");
        assert_eq!(env_name("  stripe / live key "), "STRIPE_LIVE_KEY");
        assert_eq!(env_name("1password"), "_1PASSWORD");
        assert_eq!(env_name("—"), "SECRET");
    }

    #[test]
    fn the_secret_field_is_the_kind_s_own_and_never_a_totp_seed() {
        let entry = json!({ "username": "me", "password": "hunter22", "totp": "SEED", "custom": [{ "name": "pat", "value": "ghp-x" }] });
        assert_eq!(secret_field(&entry, None).unwrap(), "hunter22");
        assert_eq!(secret_field(&entry, Some("pat")).unwrap(), "ghp-x");
        assert!(secret_field(&entry, Some("totp")).is_err());
        assert!(secret_field(&json!({ "notes": "x" }), None).is_err());
    }

    #[test]
    fn a_secret_is_scrubbed_in_every_form_output_carries_it() {
        let value = "s3cret/value";
        let basic = base64::engine::general_purpose::STANDARD.encode(value);
        let output = format!("token={value} basic={basic} url=s3cret%2Fvalue short=abc");
        let clean = scrub(&output, &forms_of(value));
        assert!(!clean.contains(value) && !clean.contains(&basic) && !clean.contains("s3cret%2Fvalue"), "{clean}");
        assert!(clean.contains("short=abc"));
    }

    #[test]
    fn a_response_never_shows_credential_headers() {
        let answer = json!({
            "method": "GET", "status": 200, "statusText": "OK", "durationMs": 12,
            "headers": { "content-type": "application/json", "set-cookie": "sid=abc", "Authorization": "Bearer x" },
            "body": { "ok": true }, "tests": [], "testsFailed": 0
        });
        let (ok, text) = render_response(&answer, "{{base}}/me");
        assert!(ok);
        assert!(text.contains("HTTP 200 OK") && text.contains("content-type: application/json") && text.contains("\"ok\": true"));
        assert!(!text.contains("sid=abc") && !text.contains("Bearer"));
    }

    #[test]
    fn a_result_set_prints_as_an_aligned_table() {
        let result: crate::datasource::DbStatementResult = serde_json::from_value(json!({
            "statement": "select",
            "columns": [{ "name": "id", "type_name": "int" }, { "name": "name", "type_name": "text" }],
            "rows": [["1", "Ana"], ["22", null]],
            "documents": [], "rows_affected": null, "duration_ms": 1, "truncated": false, "messages": [], "error": null
        }))
        .expect("a statement result");
        assert_eq!(render_statement(&result), "id  name\n--  ----\n1   Ana\n22  NULL\n(2 rows)");
    }
}
