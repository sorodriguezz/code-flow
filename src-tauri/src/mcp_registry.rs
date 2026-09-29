//! MCP servers declared in CodeFlow — one list that every model's turns can use.
//!
//! # Beside the CLIs' own servers, not instead of them
//!
//! A server the user configured in Claude Code or Codex stays theirs and is handled by
//! `crate::chat_mcp`: the app only decides, per conversation, whether a turn may use it. The servers
//! here are the app's: declared once — for every workspace or for one — and handed to whichever CLI
//! a turn runs on, in that CLI's own terms (see [`claude_config`], [`codex_args`], [`grok_config`]).
//! A server of the same name as one the CLI already has is not handed over twice; the CLI's wins.
//!
//! # Secrets
//!
//! Every environment value and header value is treated as a secret: kept in the OS keychain, with
//! the row holding only a `cf-keychain:` marker — never in the database, never on a command line.
//! At run time each reaches the CLI as an environment variable of its process: Claude Code expands
//! `${VAR}` inside `--mcp-config`, Codex passes `env_vars` and `env_http_headers` through. That is
//! protection **at rest**: while the run lasts the process environment holds them, exactly as it
//! would for a server the user had configured in the CLI itself, and the settings copy says so.
//!
//! # Trust
//!
//! A stdio server is a program this app will start. One the user typed or imported here is trusted
//! by that act; one that arrives any other way — a backup restored onto this machine — is not, until
//! the user approves it. Trust is the SHA-256 of what would run (transport, command, arguments, URL
//! and the *names* of the environment variables and headers), kept in `mcp_trust`, a table that
//! never travels in a backup and is emptied by a restore.

use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::db::api_secrets::{is_marker, SecretStore, MARKER, REDACTED};

/// One declared server, as the settings list shows it — secrets as [`REDACTED`], never their value.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub id: String,
    /// The workspace it was declared in — its home, even when it is global.
    pub workspace_id: String,
    /// `global` (every workspace) | `workspace` (only its own).
    pub scope: String,
    pub name: String,
    /// `stdio` | `http` | `sse`.
    pub transport: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub url: String,
    pub headers: BTreeMap<String, String>,
    /// Off: declared, but offered to no turn.
    pub enabled: bool,
    /// On in every conversation unless switched off there; otherwise off unless switched on.
    pub default_on: bool,
    /// Providers it is never handed to.
    pub excluded: Vec<String>,
    pub trusted: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// A server as the settings form sends it. An env or header value equal to [`REDACTED`] means
/// "keep what is stored"; an empty one removes the entry.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInput {
    #[serde(default)]
    pub id: Option<String>,
    pub workspace_id: String,
    #[serde(default = "global")]
    pub scope: String,
    pub name: String,
    #[serde(default = "stdio")]
    pub transport: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default)]
    pub default_on: bool,
    #[serde(default)]
    pub excluded: Vec<String>,
}

fn global() -> String {
    "global".to_string()
}
fn stdio() -> String {
    "stdio".to_string()
}
fn yes() -> bool {
    true
}

/// A server ready for one run: its secrets resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveServer {
    pub name: String,
    pub transport: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub url: String,
    pub headers: Vec<(String, String)>,
}

impl LiveServer {
    pub fn has_secrets(&self) -> bool {
        !self.env.is_empty() || !self.headers.is_empty()
    }
}

/// The key a server's secret is kept under in the OS keychain.
pub fn secret_key(server_id: &str, slot: &str, name: &str) -> String {
    format!("mcp-secret:{server_id}:{slot}:{name}")
}

/// `[A-Za-z0-9_-]`, 1–64 characters: what every CLI here accepts as a server name, and what Claude
/// Code's `mcp__<server>` tool names can carry unchanged.
pub fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// What trust is keyed by: what would run, and the names — not the values — of what it is given.
pub fn spec_hash(
    transport: &str,
    command: &str,
    args: &[String],
    url: &str,
    env_names: &[String],
    header_names: &[String],
) -> String {
    use sha2::{Digest, Sha256};
    let mut env_names = env_names.to_vec();
    env_names.sort();
    let mut header_names = header_names.to_vec();
    header_names.sort();
    let canonical = serde_json::json!({
        "transport": transport,
        "command": command,
        "args": args,
        "url": url,
        "env": env_names,
        "headers": header_names,
    });
    hex::encode(Sha256::digest(canonical.to_string().as_bytes()))
}

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

const COLUMNS: &str = "id, workspace_id, scope, name, transport, command, args, env, url, headers, \
                       enabled, default_on, excluded, created_at, updated_at";

struct Row {
    id: String,
    workspace_id: String,
    scope: String,
    name: String,
    transport: String,
    command: String,
    args: Vec<String>,
    env: BTreeMap<String, String>,
    url: String,
    headers: BTreeMap<String, String>,
    enabled: bool,
    default_on: bool,
    excluded: Vec<String>,
    created_at: String,
    updated_at: String,
}

impl Row {
    fn hash(&self) -> String {
        spec_hash(
            &self.transport,
            &self.command,
            &self.args,
            &self.url,
            &self.env.keys().cloned().collect::<Vec<_>>(),
            &self.headers.keys().cloned().collect::<Vec<_>>(),
        )
    }
}

fn read_row(row: &rusqlite::Row) -> rusqlite::Result<Row> {
    let json_list = |text: String| serde_json::from_str::<Vec<String>>(&text).unwrap_or_default();
    let json_map = |text: String| serde_json::from_str::<BTreeMap<String, String>>(&text).unwrap_or_default();
    Ok(Row {
        id: row.get(0)?,
        workspace_id: row.get(1)?,
        scope: row.get(2)?,
        name: row.get(3)?,
        transport: row.get(4)?,
        command: row.get(5)?,
        args: json_list(row.get(6)?),
        env: json_map(row.get(7)?),
        url: row.get(8)?,
        headers: json_map(row.get(9)?),
        enabled: row.get::<_, i64>(10)? != 0,
        default_on: row.get::<_, i64>(11)? != 0,
        excluded: json_list(row.get(12)?),
        created_at: row.get(13)?,
        updated_at: row.get(14)?,
    })
}

fn trusted(conn: &Connection, hash: &str) -> bool {
    conn.query_row("SELECT 1 FROM mcp_trust WHERE hash = ?1", params![hash], |_| Ok(()))
        .optional()
        .ok()
        .flatten()
        .is_some()
}

fn trust_hash(conn: &Connection, hash: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO mcp_trust (hash, trusted_at) VALUES (?1, ?2)",
        params![hash, crate::db::queries::now()],
    )?;
    Ok(())
}

fn view(conn: &Connection, row: Row) -> McpServer {
    let is_trusted = row.transport != "stdio" || trusted(conn, &row.hash());
    let redact = |map: BTreeMap<String, String>| map.into_keys().map(|name| (name, REDACTED.to_string())).collect();
    McpServer {
        trusted: is_trusted,
        id: row.id,
        workspace_id: row.workspace_id,
        scope: row.scope,
        name: row.name,
        transport: row.transport,
        command: row.command,
        args: row.args,
        env: redact(row.env),
        url: row.url,
        headers: redact(row.headers),
        enabled: row.enabled,
        default_on: row.default_on,
        excluded: row.excluded,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

fn rows_for(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<Row>> {
    let mut statement = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM mcp_servers WHERE workspace_id = ?1 OR scope = 'global' ORDER BY name COLLATE NOCASE"
    ))?;
    let rows = statement.query_map(params![workspace_id], read_row)?.collect();
    rows
}

fn row_by_id(conn: &Connection, id: &str) -> rusqlite::Result<Option<Row>> {
    conn.query_row(&format!("SELECT {COLUMNS} FROM mcp_servers WHERE id = ?1"), params![id], read_row)
        .optional()
}

/// The servers a workspace sees: its own and every global one.
pub fn list(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<McpServer>> {
    Ok(rows_for(conn, workspace_id)?.into_iter().map(|row| view(conn, row)).collect())
}

/// Seals one map of values: literals into the keychain behind a marker, [`REDACTED`] kept as it was
/// stored, empty dropped.
fn seal(
    store: &dyn SecretStore,
    server_id: &str,
    slot: &str,
    incoming: &BTreeMap<String, String>,
    stored: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, String> {
    let mut out = BTreeMap::new();
    for (name, value) in incoming {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        if value == REDACTED {
            if let Some(marker) = stored.get(name) {
                out.insert(name.to_string(), marker.clone());
            }
            continue;
        }
        if value.is_empty() {
            continue;
        }
        let key = secret_key(server_id, slot, name);
        store.set(&key, value)?;
        out.insert(name.to_string(), format!("{MARKER}{key}"));
    }
    Ok(out)
}

fn marker_keys(map: &BTreeMap<String, String>) -> Vec<String> {
    map.values().filter(|value| is_marker(value)).map(|value| value[MARKER.len()..].to_string()).collect()
}

/// Declares a server, or rewrites one — trusted by the act, since the user wrote it.
pub fn save(conn: &Connection, store: &dyn SecretStore, input: McpServerInput) -> Result<McpServer, String> {
    let name = input.name.trim().to_string();
    if !valid_name(&name) {
        return Err("A server's name may use letters, numbers, - and _, up to 64 characters".to_string());
    }
    if !["stdio", "http", "sse"].contains(&input.transport.as_str()) {
        return Err(format!("unknown transport: {}", input.transport));
    }
    if input.transport == "stdio" && input.command.trim().is_empty() {
        return Err("A stdio server needs a command to start".to_string());
    }
    if input.transport != "stdio" && !(input.url.starts_with("https://") || input.url.starts_with("http://")) {
        return Err("A remote server needs an http(s) URL".to_string());
    }
    let scope = if input.scope == "workspace" { "workspace" } else { "global" };
    let existing = match input.id.as_deref() {
        Some(id) => row_by_id(conn, id).map_err(|e| e.to_string())?,
        None => None,
    };
    // One name per place it is seen: two servers of one name would be one tool namespace.
    let clash = rows_for(conn, &input.workspace_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .any(|row| row.name == name && Some(row.id.as_str()) != input.id.as_deref());
    if clash {
        return Err(format!("There is already a server called \"{name}\""));
    }

    let id = existing.as_ref().map(|row| row.id.clone()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let (stored_env, stored_headers) = existing
        .as_ref()
        .map(|row| (row.env.clone(), row.headers.clone()))
        .unwrap_or_default();
    let env = seal(store, &id, "env", &input.env, &stored_env)?;
    let headers = seal(store, &id, "header", &input.headers, &stored_headers)?;
    let args: Vec<String> = input.args.iter().map(|a| a.to_string()).filter(|a| !a.is_empty()).collect();
    let now = crate::db::queries::now();
    let excluded: Vec<String> = input.excluded.iter().filter(|p| !p.trim().is_empty()).cloned().collect();

    conn.execute(
        "INSERT INTO mcp_servers (id, workspace_id, scope, name, transport, command, args, env, url, headers, \
                                  enabled, default_on, excluded, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14) \
         ON CONFLICT(id) DO UPDATE SET scope = excluded.scope, name = excluded.name, \
             transport = excluded.transport, command = excluded.command, args = excluded.args, \
             env = excluded.env, url = excluded.url, headers = excluded.headers, \
             enabled = excluded.enabled, default_on = excluded.default_on, excluded = excluded.excluded, \
             updated_at = excluded.updated_at",
        params![
            id,
            existing.as_ref().map(|row| row.workspace_id.clone()).unwrap_or_else(|| input.workspace_id.clone()),
            scope,
            name,
            input.transport,
            input.command.trim(),
            serde_json::to_string(&args).unwrap_or_else(|_| "[]".into()),
            serde_json::to_string(&env).unwrap_or_else(|_| "{}".into()),
            input.url.trim(),
            serde_json::to_string(&headers).unwrap_or_else(|_| "{}".into()),
            input.enabled as i64,
            input.default_on as i64,
            serde_json::to_string(&excluded).unwrap_or_else(|_| "[]".into()),
            now,
        ],
    )
    .map_err(|e| e.to_string())?;

    // Secrets that were stored and are no longer named go with the edit.
    let kept: std::collections::BTreeSet<String> = marker_keys(&env).into_iter().chain(marker_keys(&headers)).collect();
    for key in marker_keys(&stored_env).into_iter().chain(marker_keys(&stored_headers)) {
        if !kept.contains(&key) {
            let _ = store.delete(&key);
        }
    }

    let row = row_by_id(conn, &id).map_err(|e| e.to_string())?.ok_or("the server vanished while saving")?;
    trust_hash(conn, &row.hash()).map_err(|e| e.to_string())?;
    Ok(view(conn, row))
}

/// Forgets a server and its secrets.
pub fn delete(conn: &Connection, store: &dyn SecretStore, id: &str) -> Result<(), String> {
    if let Some(row) = row_by_id(conn, id).map_err(|e| e.to_string())? {
        for key in marker_keys(&row.env).into_iter().chain(marker_keys(&row.headers)) {
            let _ = store.delete(&key);
        }
    }
    conn.execute("DELETE FROM mcp_servers WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

/// The user's approval of a server that arrived without it (a restored backup).
pub fn approve(conn: &Connection, id: &str) -> Result<McpServer, String> {
    let row = row_by_id(conn, id).map_err(|e| e.to_string())?.ok_or("server not found")?;
    trust_hash(conn, &row.hash()).map_err(|e| e.to_string())?;
    Ok(view(conn, row))
}

/// What a turn of `provider` in `workspace_id` runs with, secrets resolved: enabled, trusted, not
/// excluded for this provider, and on — by the conversation's switch (`app:<name>`) or, without one,
/// by the server's own default. A secret the keychain no longer has is left out rather than sent
/// empty.
pub fn live_servers(
    conn: &Connection,
    store: &dyn SecretStore,
    workspace_id: &str,
    provider: &str,
    overrides: &BTreeMap<String, bool>,
) -> Vec<LiveServer> {
    let rows = rows_for(conn, workspace_id).unwrap_or_default();
    rows.into_iter()
        .filter(|row| row.enabled && !row.excluded.iter().any(|p| p == provider))
        .filter(|row| overrides.get(&switch_key(&row.name)).copied().unwrap_or(row.default_on))
        .filter(|row| row.transport != "stdio" || trusted(conn, &row.hash()))
        .map(|row| {
            let unseal = |map: &BTreeMap<String, String>| -> Vec<(String, String)> {
                map.iter()
                    .filter_map(|(name, value)| {
                        let secret = if is_marker(value) {
                            store.get(&value[MARKER.len()..]).ok().flatten()?
                        } else {
                            value.clone()
                        };
                        Some((name.clone(), secret))
                    })
                    .collect()
            };
            LiveServer {
                name: row.name.clone(),
                transport: row.transport.clone(),
                command: row.command.clone(),
                args: row.args.clone(),
                env: unseal(&row.env),
                url: row.url.clone(),
                headers: unseal(&row.headers),
            }
        })
        .collect()
}

/// The switch key of an app server in a conversation's `mcp_overrides` — prefixed, so it can never
/// be taken for a CLI's own server of the same name.
pub fn switch_key(name: &str) -> String {
    format!("app:{name}")
}

/// The servers a workspace sees, as the composer's switch list shows them.
pub fn switch_views(
    conn: &Connection,
    workspace_id: &str,
    provider: &str,
    overrides: &BTreeMap<String, bool>,
) -> Vec<crate::chat_mcp::McpServerView> {
    rows_for(conn, workspace_id)
        .unwrap_or_default()
        .into_iter()
        .filter(|row| row.enabled && !row.excluded.iter().any(|p| p == provider))
        .filter(|row| supports(provider, row))
        .map(|row| {
            let is_trusted = row.transport != "stdio" || trusted(conn, &row.hash());
            crate::chat_mcp::McpServerView {
                key: switch_key(&row.name),
                name: row.name.clone(),
                status: if is_trusted { String::new() } else { "untrusted".to_string() },
                source: "app".to_string(),
                enabled: overrides.get(&switch_key(&row.name)).copied().unwrap_or(row.default_on),
                togglable: is_trusted,
            }
        })
        .collect()
}

/// Whether `provider` can be handed this server at all: Claude takes all three transports, Codex
/// stdio and streamable HTTP, Grok only a server with no secrets (its only per-run channel is a
/// config file in the working directory, which the model can read). Nothing else takes one.
pub fn supports(provider: &str, row_transport_secrets: &impl ServerShape) -> bool {
    match provider {
        "claude" => true,
        "codex" => row_transport_secrets.transport() != "sse",
        "grok" => !row_transport_secrets.secret_bearing(),
        _ => false,
    }
}

/// What [`supports`] needs to know about a server, from a stored row or a live one.
pub trait ServerShape {
    fn transport(&self) -> &str;
    fn secret_bearing(&self) -> bool;
}

impl ServerShape for Row {
    fn transport(&self) -> &str {
        &self.transport
    }
    fn secret_bearing(&self) -> bool {
        !self.env.is_empty() || !self.headers.is_empty()
    }
}

impl ServerShape for LiveServer {
    fn transport(&self) -> &str {
        &self.transport
    }
    fn secret_bearing(&self) -> bool {
        self.has_secrets()
    }
}

// ---------------------------------------------------------------------------------------------
// In each CLI's terms
// ---------------------------------------------------------------------------------------------

/// The variable a secret travels in: `CF_MCP_<n>_<NAME>`, upper-case, anything else `_`.
fn env_var(index: usize, name: &str) -> String {
    let clean: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' })
        .collect();
    format!("CF_MCP_{index}_{clean}")
}

/// Claude Code's `--mcp-config` document, with every secret as `${VAR}` — and the variables the
/// process has to be given for them.
pub fn claude_config(servers: &[LiveServer]) -> (String, Vec<(String, String)>) {
    let mut vars = Vec::new();
    let mut entries = serde_json::Map::new();
    for (index, server) in servers.iter().enumerate() {
        let mut entry = serde_json::Map::new();
        entry.insert("type".into(), server.transport.clone().into());
        if server.transport == "stdio" {
            entry.insert("command".into(), server.command.clone().into());
            entry.insert("args".into(), server.args.clone().into());
            let mut env = serde_json::Map::new();
            for (name, value) in &server.env {
                let var = env_var(index, &format!("e_{name}"));
                env.insert(name.clone(), format!("${{{var}}}").into());
                vars.push((var, value.clone()));
            }
            entry.insert("env".into(), env.into());
        } else {
            entry.insert("url".into(), server.url.clone().into());
            let mut headers = serde_json::Map::new();
            for (name, value) in &server.headers {
                let var = env_var(index, &format!("h_{name}"));
                headers.insert(name.clone(), format!("${{{var}}}").into());
                vars.push((var, value.clone()));
            }
            entry.insert("headers".into(), headers.into());
        }
        entries.insert(server.name.clone(), entry.into());
    }
    let document = serde_json::json!({ "mcpServers": entries });
    (document.to_string(), vars)
}

/// Codex's `-c` overrides for these servers, named `cf_<name>` so they never merge into a table of
/// the user's own of the same name — and the variables the process has to be given.
///
/// Every value is written as JSON, which for a string and an array of strings is also valid TOML,
/// and quoted, so nothing in it can break out of the value on any shell. A stdio server's secrets
/// travel under their own names through `env_vars` (the server reads the variable it expects); a
/// remote one's headers through `env_http_headers`. An SSE server is not something Codex speaks.
pub fn codex_args(servers: &[LiveServer]) -> (Vec<String>, Vec<(String, String)>) {
    let mut args = Vec::new();
    let mut vars = Vec::new();
    let quote = |text: &str| serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into());
    for (index, server) in servers.iter().enumerate() {
        let key = format!("mcp_servers.cf_{}", server.name);
        match server.transport.as_str() {
            "stdio" => {
                args.push("-c".into());
                args.push(format!("{key}.command={}", quote(&server.command)));
                args.push("-c".into());
                args.push(format!("{key}.args={}", serde_json::to_string(&server.args).unwrap_or_else(|_| "[]".into())));
                if !server.env.is_empty() {
                    let names: Vec<&String> = server.env.iter().map(|(name, _)| name).collect();
                    args.push("-c".into());
                    args.push(format!("{key}.env_vars={}", serde_json::to_string(&names).unwrap_or_else(|_| "[]".into())));
                    vars.extend(server.env.iter().cloned());
                }
            }
            "http" => {
                args.push("-c".into());
                args.push(format!("{key}.url={}", quote(&server.url)));
                if !server.headers.is_empty() {
                    let pairs: Vec<String> = server
                        .headers
                        .iter()
                        .map(|(name, value)| {
                            let var = env_var(index, &format!("h_{name}"));
                            vars.push((var.clone(), value.clone()));
                            format!("{} = {}", quote(name), quote(&var))
                        })
                        .collect();
                    args.push("-c".into());
                    args.push(format!("{key}.env_http_headers={{ {} }}", pairs.join(", ")));
                }
            }
            _ => {}
        }
    }
    (args, vars)
}

/// Grok's project config for the servers it can be handed — those with no secrets, which is all a
/// file the model can read may carry. `None` when there are none.
pub fn grok_config(servers: &[LiveServer]) -> Option<String> {
    let quote = |text: &str| serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into());
    let mut out = String::from("# Managed by CodeFlow for this conversation — rewritten on every turn.\n");
    let mut any = false;
    for server in servers.iter().filter(|s| !s.has_secrets()) {
        any = true;
        out.push_str(&format!("\n[mcp_servers.{}]\n", server.name));
        if server.transport == "stdio" {
            out.push_str(&format!("command = {}\n", quote(&server.command)));
            out.push_str(&format!("args = {}\n", serde_json::to_string(&server.args).unwrap_or_else(|_| "[]".into())));
        } else {
            out.push_str(&format!("url = {}\n", quote(&server.url)));
        }
        out.push_str("enabled = true\n");
    }
    any.then_some(out)
}

// ---------------------------------------------------------------------------------------------
// The legacy table
// ---------------------------------------------------------------------------------------------

/// Moves the rows of `workspace_mcps` — the Claude-only MCP list removed in 1.12.0, still in the
/// schema and in backups — into this registry, their plaintext `KEY=VALUE` environment into the
/// keychain, and empties it. Trusted: the user configured them in this app. Runs outside the
/// migration transaction (it writes the keychain), whenever the registry is read, and is a no-op
/// once the old table is empty — including after a restore of an old backup refills it.
pub fn absorb_legacy(conn: &Connection, store: &dyn SecretStore) -> Result<usize, String> {
    let legacy: Vec<(String, String, String, String, String, i64)> = {
        let mut statement = match conn.prepare("SELECT workspace_id, name, command, args, env, enabled FROM workspace_mcps") {
            Ok(statement) => statement,
            Err(_) => return Ok(0),
        };
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)))
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    let mut moved = 0;
    for (workspace_id, name, command, args, env, enabled) in legacy {
        let clean: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '-' }).collect();
        let env: BTreeMap<String, String> = env
            .lines()
            .flat_map(|line| line.split(';'))
            .filter_map(|pair| pair.split_once('='))
            .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
            .filter(|(k, _)| !k.is_empty())
            .collect();
        let input = McpServerInput {
            id: None,
            workspace_id,
            scope: "workspace".into(),
            name: clean,
            transport: "stdio".into(),
            command,
            args: args.split_whitespace().map(str::to_string).collect(),
            env,
            enabled: enabled != 0,
            ..Default::default()
        };
        if save(conn, store, input).is_ok() {
            moved += 1;
        }
    }
    let _ = conn.execute("DELETE FROM workspace_mcps", []);
    Ok(moved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::api_secrets::MemoryStore;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn.execute(
            "INSERT INTO workspaces (id, name, created_at) VALUES ('w1', 'Uno', '2026-01-01'), ('w2', 'Dos', '2026-01-01')",
            [],
        )
        .unwrap();
        conn
    }

    fn github(workspace: &str) -> McpServerInput {
        let mut env = BTreeMap::new();
        env.insert("GITHUB_TOKEN".to_string(), "ghp_secret".to_string());
        McpServerInput {
            workspace_id: workspace.into(),
            scope: "global".into(),
            name: "github".into(),
            transport: "stdio".into(),
            command: "npx".into(),
            args: vec!["-y".into(), "@modelcontextprotocol/server-github".into()],
            env,
            enabled: true,
            ..Default::default()
        }
    }

    /// The secret goes to the keychain, the row keeps a marker, and the list never shows the value.
    #[test]
    fn secrets_live_in_the_keychain_and_never_in_the_row_or_the_list() {
        let conn = db();
        let store = MemoryStore::default();
        let saved = save(&conn, &store, github("w1")).unwrap();
        assert_eq!(saved.env.get("GITHUB_TOKEN").map(String::as_str), Some(REDACTED));
        assert!(saved.trusted, "written here, trusted by that");
        let stored: String = conn.query_row("SELECT env FROM mcp_servers", [], |r| r.get(0)).unwrap();
        assert!(!stored.contains("ghp_secret") && stored.contains(MARKER), "{stored}");
        let key = secret_key(&saved.id, "env", "GITHUB_TOKEN");
        assert_eq!(store.get(&key).unwrap().as_deref(), Some("ghp_secret"));

        // Saving again with the redacted value keeps the secret; clearing it removes it.
        let mut again = github("w1");
        again.id = Some(saved.id.clone());
        again.env.insert("GITHUB_TOKEN".into(), REDACTED.into());
        save(&conn, &store, again).unwrap();
        assert_eq!(store.get(&key).unwrap().as_deref(), Some("ghp_secret"));
        let mut cleared = github("w1");
        cleared.id = Some(saved.id.clone());
        cleared.env.clear();
        save(&conn, &store, cleared).unwrap();
        assert_eq!(store.get(&key).unwrap(), None, "a secret no longer named is forgotten");
    }

    /// Global servers are seen everywhere, a workspace's only there, and a turn gets secrets
    /// resolved — only for what is enabled, not excluded, on, and trusted.
    #[test]
    fn a_turn_gets_what_is_on_trusted_and_meant_for_its_provider() {
        let conn = db();
        let store = MemoryStore::default();
        let mut on = github("w1");
        on.default_on = true;
        save(&conn, &store, on).unwrap();
        let mut local = github("w1");
        local.name = "local-only".into();
        // A different program: trust is keyed by what runs, so an identical spec would be approved
        // together with the other.
        local.args = vec!["-y".into(), "another-server".into()];
        local.scope = "workspace".into();
        local.default_on = true;
        local.excluded = vec!["codex".into()];
        save(&conn, &store, local).unwrap();

        let none = BTreeMap::new();
        let w1 = live_servers(&conn, &store, "w1", "claude", &none);
        assert_eq!(w1.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), vec!["github", "local-only"]);
        assert_eq!(w1[0].env, vec![("GITHUB_TOKEN".to_string(), "ghp_secret".to_string())]);
        let w2 = live_servers(&conn, &store, "w2", "claude", &none);
        assert_eq!(w2.len(), 1, "the workspace-scoped one stays home");
        assert!(live_servers(&conn, &store, "w1", "codex", &none).iter().all(|s| s.name != "local-only"));

        // Switched off in the conversation.
        let mut off = BTreeMap::new();
        off.insert(switch_key("github"), false);
        assert!(live_servers(&conn, &store, "w1", "claude", &off).iter().all(|s| s.name != "github"));

        // A restore empties trust: the stdio servers stop until approved again.
        conn.execute("DELETE FROM mcp_trust", []).unwrap();
        assert!(live_servers(&conn, &store, "w1", "claude", &none).is_empty());
        let id: String = conn.query_row("SELECT id FROM mcp_servers WHERE name = 'github'", [], |r| r.get(0)).unwrap();
        assert!(approve(&conn, &id).unwrap().trusted);
        assert_eq!(live_servers(&conn, &store, "w1", "claude", &none).len(), 1);
    }

    #[test]
    fn names_are_what_every_cli_accepts_and_unique_where_seen() {
        let conn = db();
        let store = MemoryStore::default();
        let mut bad = github("w1");
        bad.name = "has space".into();
        assert!(save(&conn, &store, bad).is_err());
        save(&conn, &store, github("w1")).unwrap();
        assert!(save(&conn, &store, github("w2")).is_err(), "a global github is already seen in w2");
        let mut remote = github("w1");
        remote.name = "remote".into();
        remote.transport = "http".into();
        remote.url = "ftp://nope".into();
        assert!(save(&conn, &store, remote).is_err());
    }

    /// Claude gets `${VAR}`s in the document and the values in the process — never in the file.
    #[test]
    fn claudes_config_names_variables_not_secrets() {
        let server = LiveServer {
            name: "github".into(),
            transport: "stdio".into(),
            command: "npx".into(),
            args: vec!["-y".into(), "srv".into()],
            env: vec![("GITHUB_TOKEN".into(), "ghp_secret".into())],
            url: String::new(),
            headers: vec![],
        };
        let web = LiveServer {
            name: "docs".into(),
            transport: "http".into(),
            url: "https://example.com/mcp".into(),
            headers: vec![("Authorization".into(), "Bearer abc".into())],
            ..server.clone()
        };
        let (json, vars) = claude_config(&[server, web]);
        assert!(!json.contains("ghp_secret") && !json.contains("Bearer abc"), "{json}");
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["mcpServers"]["github"]["env"]["GITHUB_TOKEN"], "${CF_MCP_0_E_GITHUB_TOKEN}");
        assert_eq!(value["mcpServers"]["docs"]["headers"]["Authorization"], "${CF_MCP_1_H_AUTHORIZATION}");
        assert!(vars.contains(&("CF_MCP_0_E_GITHUB_TOKEN".to_string(), "ghp_secret".to_string())));
    }

    /// Codex's overrides are prefixed, quoted, and carry no secret on the command line.
    #[test]
    fn codex_overrides_are_prefixed_quoted_and_secret_free() {
        let server = LiveServer {
            name: "github".into(),
            transport: "stdio".into(),
            command: "C:\\tools\\srv \"x\".exe".into(),
            args: vec!["--root".into(), "a b".into()],
            env: vec![("GITHUB_TOKEN".into(), "ghp_secret".into())],
            url: String::new(),
            headers: vec![],
        };
        let (args, vars) = codex_args(&[server]);
        let joined = args.join(" ");
        assert!(joined.contains(r#"mcp_servers.cf_github.command="C:\\tools\\srv \"x\".exe""#), "{joined}");
        assert!(joined.contains(r#"mcp_servers.cf_github.args=["--root","a b"]"#), "{joined}");
        assert!(joined.contains(r#"mcp_servers.cf_github.env_vars=["GITHUB_TOKEN"]"#), "{joined}");
        assert!(!joined.contains("ghp_secret"));
        assert_eq!(vars, vec![("GITHUB_TOKEN".to_string(), "ghp_secret".to_string())]);
    }

    #[test]
    fn grok_only_gets_servers_with_nothing_secret_in_them() {
        let plain = LiveServer {
            name: "docs".into(),
            transport: "http".into(),
            command: String::new(),
            args: vec![],
            env: vec![],
            url: "https://example.com/mcp".into(),
            headers: vec![],
        };
        let secret = LiveServer { name: "github".into(), env: vec![("T".into(), "x".into())], ..plain.clone() };
        let toml = grok_config(&[plain, secret.clone()]).unwrap();
        assert!(toml.contains("[mcp_servers.docs]") && !toml.contains("github"), "{toml}");
        assert!(grok_config(&[secret]).is_none());
    }

    /// The Claude-only list of 1.12.0 moves in, its plaintext env into the keychain.
    #[test]
    fn the_legacy_table_is_absorbed_and_emptied() {
        let conn = db();
        let store = MemoryStore::default();
        conn.execute(
            "INSERT INTO workspace_mcps (id, workspace_id, name, command, args, env, enabled, created_at) \
             VALUES ('m1', 'w1', 'my server', 'node', 'srv.js --port 3', 'API_KEY=abc', 1, '2026-01-01')",
            [],
        )
        .unwrap();
        assert_eq!(absorb_legacy(&conn, &store).unwrap(), 1);
        let servers = list(&conn, "w1").unwrap();
        assert_eq!(servers[0].name, "my-server");
        assert_eq!(servers[0].args, vec!["srv.js", "--port", "3"]);
        assert_eq!(servers[0].scope, "workspace");
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM workspace_mcps", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
        assert_eq!(absorb_legacy(&conn, &store).unwrap(), 0, "a no-op afterwards");
    }
}
