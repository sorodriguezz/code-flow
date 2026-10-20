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
//!   does) and returns rows. The agent sees results, never the connection string.
//! - `cf http` sends the saved request through the API client's own path (`runSavedRequest` in the
//!   window, which resolves its environment), and the answer comes back with every stored API
//!   credential scrubbed and the credential-bearing headers dropped.
//! - `cf secret` is the one where the secret must reach a program — so the *app* runs the program,
//!   with the secret in its environment, and returns its output with the secret (and its base64 and
//!   URL-encoded forms) scrubbed. The user approves the exact command each time: a command is code,
//!   and `echo $TOKEN` is a command too.
//!
//! Reads of a database and a given saved request can be allowed for the rest of the run of one
//! terminal ("allow in this terminal"); writes and Llavero secrets are asked every time.

use std::time::Duration;

use base64::Engine as _;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

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

/// Rows `cf db` returns when not told otherwise, and the most it will.
const DEFAULT_ROWS: u32 = 200;
const MAX_ROWS: u32 = 5_000;
/// The widest a cell is printed; the rest of a long value is cut with an ellipsis.
const CELL_MAX: usize = 80;

/// `cf db <connection> [--max-rows N] <SQL>`: the statement on a saved connection, as text tables.
pub async fn db(request: &Request, app: &AppHandle) -> Reply {
    let usage = || Reply::no("usage: cf db <connection> [--max-rows N] <SQL>");
    let mut args = request.args.clone();
    let mut max_rows = DEFAULT_ROWS;
    if let Some(at) = args.iter().position(|a| a == "--max-rows") {
        let Some(n) = args.get(at + 1).and_then(|n| n.parse::<u32>().ok()) else { return usage() };
        max_rows = n.clamp(1, MAX_ROWS);
        args.drain(at..at + 2);
    }
    let Some((name, sql)) = args.split_first() else { return usage() };
    let sql = sql.join(" ");
    if sql.trim().is_empty() {
        return usage();
    }
    let place = place::of(app, &request.cwd, &request.session);
    let workspace = place.workspace_id.clone().unwrap_or_default();
    let connections = crate::ai_usage::with_conn(|conn| crate::db::datasource_queries::load_tree(conn, &workspace))
        .and_then(Result::ok)
        .map(|tree| tree.connections)
        .unwrap_or_default();
    let row = match pick(connections, name, |c| c.name.as_str()) {
        Ok(row) => row,
        Err(names) if names.is_empty() => return Reply::no(format!("no saved database connection named {name} here")),
        Err(names) => return Reply::no(format!("{name} matches several connections: {}", names.join(", "))),
    };
    let config = match crate::commands::db_cmd::resolve_config(&app.state::<Db>(), &row.id) {
        Ok(config) => config,
        Err(error) => return Reply::no(error),
    };
    let writes = crate::datasource::export_refusal(config.kind, &sql).is_some();
    let production = config.environment.eq_ignore_ascii_case("prod") || config.environment.eq_ignore_ascii_case("production");
    let what = match (writes, production) {
        (true, true) => "changes data on PRODUCTION",
        (true, false) => "changes data",
        (false, true) => "reads PRODUCTION",
        (false, false) => "reads",
    };
    let mut event = AskEvent::new("db", format!("«{}» — {what}", row.name), &request.cwd);
    event.detail = sql.clone();
    // A read can be allowed for the rest of this terminal's run; a write is asked every time.
    event.always = !writes;
    if let Err(refused) = approve(app, request, &row.id, event).await {
        return refused;
    }

    let tag = format!("agentcli-{}", uuid::Uuid::new_v4());
    let session = match crate::datasource::Session::open_tagged(&config, None, &tag).await {
        Ok(session) => session,
        Err(error) => return Reply::no(error),
    };
    let context = crate::datasource::DbExecContext { database: None, schema: None, max_rows };
    match session.execute(&sql, &context).await {
        Ok(result) => {
            let failed = result.results.iter().any(|r| r.error.is_some());
            let text = scrub(&result.results.iter().map(render_statement).collect::<Vec<_>>().join("\n\n"), &[]);
            if failed {
                Reply::no(text)
            } else {
                Reply::ok(text)
            }
        }
        Err(error) => Reply::no(error),
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
