//! Tauri commands for the MCP servers declared in CodeFlow — the settings list, and importing the
//! servers the user already has in a CLI instead of typing them again. See `crate::mcp_registry`.

use std::collections::BTreeMap;

use serde::Serialize;
use tauri::State;

use crate::db::api_secrets::os_store;
use crate::db::Db;
use crate::mcp_registry::{self, McpServer, McpServerInput};

/// The servers a workspace sees: its own and every global one. Folds the pre-1.12 Claude-only list
/// in on the way (see `mcp_registry::absorb_legacy`).
#[tauri::command]
pub fn mcp_list(db: State<'_, Db>, workspace_id: String) -> Result<Vec<McpServer>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let _ = mcp_registry::absorb_legacy(&conn, &os_store());
    mcp_registry::list(&conn, &workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn mcp_save(db: State<'_, Db>, server: McpServerInput) -> Result<McpServer, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    mcp_registry::save(&conn, &os_store(), server)
}

#[tauri::command]
pub fn mcp_delete(db: State<'_, Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    mcp_registry::delete(&conn, &os_store(), &id)
}

/// The user's approval of a server that arrived without it — a restored backup.
#[tauri::command]
pub fn mcp_approve(db: State<'_, Db>, id: String) -> Result<McpServer, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    mcp_registry::approve(&conn, &id)
}

/// One server a CLI already has, offered for import. Secrets are named, never sent: an import
/// re-reads the CLI's config on the backend and seals the values straight into the keychain.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ImportCandidate {
    /// `claude` | `codex`.
    pub source: String,
    pub name: String,
    pub transport: String,
    /// The command and its arguments, or the URL — what the row shows.
    pub summary: String,
    pub secret_names: Vec<String>,
}

/// The servers the user's CLIs have that could be declared here — Claude Code's user-level ones
/// (`~/.claude.json`) and Codex's (`codex mcp list --json`). Names the app cannot use as a server
/// name are cleaned the way a save would require.
#[tauri::command]
pub async fn mcp_import_candidates(db: State<'_, Db>) -> Result<Vec<ImportCandidate>, String> {
    let codex_binary = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        crate::db::queries::get_setting(&conn, "codex_binary_path")
            .ok()
            .flatten()
            .filter(|path| !path.trim().is_empty())
            .unwrap_or_else(|| "codex".to_string())
    };
    let mut out: Vec<ImportCandidate> = claude_specs()
        .into_iter()
        .map(|(name, input)| candidate("claude", name, &input))
        .collect();
    for (name, input) in codex_specs(&codex_binary).await {
        out.push(candidate("codex", name, &input));
    }
    Ok(out)
}

/// Declares the chosen servers of one CLI here, with their values read afresh from that CLI's own
/// config. Trusted, like anything the user chose to declare.
#[tauri::command]
pub async fn mcp_import(
    db: State<'_, Db>,
    workspace_id: String,
    source: String,
    names: Vec<String>,
) -> Result<Vec<McpServer>, String> {
    let specs = match source.as_str() {
        "claude" => claude_specs(),
        "codex" => {
            let binary = {
                let conn = db.0.lock().map_err(|e| e.to_string())?;
                crate::db::queries::get_setting(&conn, "codex_binary_path")
                    .ok()
                    .flatten()
                    .filter(|path| !path.trim().is_empty())
                    .unwrap_or_else(|| "codex".to_string())
            };
            codex_specs(&binary).await
        }
        other => return Err(format!("unknown source: {other}")),
    };
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let store = os_store();
    let mut saved = Vec::new();
    for (name, mut input) in specs.into_iter().filter(|(name, _)| names.contains(name)) {
        input.workspace_id = workspace_id.clone();
        input.name = clean_name(&name);
        saved.push(mcp_registry::save(&conn, &store, input)?);
    }
    Ok(saved)
}

fn clean_name(name: &str) -> String {
    let clean: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '-' })
        .collect();
    clean.chars().take(64).collect()
}

fn candidate(source: &str, name: String, input: &McpServerInput) -> ImportCandidate {
    let summary = if input.transport == "stdio" {
        std::iter::once(input.command.clone()).chain(input.args.iter().cloned()).collect::<Vec<_>>().join(" ")
    } else {
        input.url.clone()
    };
    ImportCandidate {
        source: source.to_string(),
        name: clean_name(&name),
        transport: input.transport.clone(),
        summary,
        secret_names: input.env.keys().chain(input.headers.keys()).cloned().collect(),
    }
}

/// Claude Code's user-level servers, from `.claude.json` (the system account's).
fn claude_specs() -> Vec<(String, McpServerInput)> {
    let file = match std::env::var_os("CLAUDE_CONFIG_DIR").filter(|dir| !dir.is_empty()) {
        Some(dir) => std::path::PathBuf::from(dir).join(".claude.json"),
        None => match dirs::home_dir() {
            Some(home) => home.join(".claude.json"),
            None => return Vec::new(),
        },
    };
    let value: serde_json::Value =
        std::fs::read_to_string(file).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default();
    parse_claude_servers(&value)
}

/// The `mcpServers` object of a Claude config, as inputs.
pub fn parse_claude_servers(config: &serde_json::Value) -> Vec<(String, McpServerInput)> {
    let Some(servers) = config.get("mcpServers").and_then(serde_json::Value::as_object) else {
        return Vec::new();
    };
    let strings = |value: Option<&serde_json::Value>| -> Vec<String> {
        value
            .and_then(serde_json::Value::as_array)
            .map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_string)).collect())
            .unwrap_or_default()
    };
    let map = |value: Option<&serde_json::Value>| -> BTreeMap<String, String> {
        value
            .and_then(serde_json::Value::as_object)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string())))
                    .collect()
            })
            .unwrap_or_default()
    };
    servers
        .iter()
        .map(|(name, spec)| {
            let url = spec.get("url").and_then(serde_json::Value::as_str).unwrap_or_default().to_string();
            let transport = match spec.get("type").and_then(serde_json::Value::as_str) {
                Some("http") => "http",
                Some("sse") => "sse",
                Some(_) | None if !url.is_empty() => "http",
                _ => "stdio",
            };
            let input = McpServerInput {
                id: None,
                workspace_id: String::new(),
                scope: "global".into(),
                name: name.clone(),
                transport: transport.into(),
                command: spec.get("command").and_then(serde_json::Value::as_str).unwrap_or_default().into(),
                args: strings(spec.get("args")),
                env: map(spec.get("env")),
                url,
                headers: map(spec.get("headers")),
                enabled: true,
                default_on: false,
                excluded: Vec::new(),
            };
            (name.clone(), input)
        })
        .collect()
}

/// Codex's servers, from its own listing. `env_vars` names variables Codex passes through from its
/// environment; their values are this machine's, so they are read from it now.
async fn codex_specs(binary: &str) -> Vec<(String, McpServerInput)> {
    let (mut cmd, program) = crate::ai::aux_command_resolved(binary);
    cmd.args(["mcp", "list", "--json"]);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let launch = crate::ai::output_patiently(&mut cmd, binary, &program);
    let Ok(Ok(output)) = tokio::time::timeout(std::time::Duration::from_secs(10), launch).await else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap_or_default();
    parse_codex_servers(&value, |name| std::env::var(name).ok())
}

/// `codex mcp list --json`, as inputs. `lookup` reads a pass-through variable's value.
pub fn parse_codex_servers(
    listing: &serde_json::Value,
    lookup: impl Fn(&str) -> Option<String>,
) -> Vec<(String, McpServerInput)> {
    let Some(servers) = listing.as_array() else { return Vec::new() };
    servers
        .iter()
        .filter_map(|server| {
            let name = server.get("name")?.as_str()?.to_string();
            let transport = server.get("transport")?;
            let kind = transport.get("type").and_then(serde_json::Value::as_str).unwrap_or("stdio");
            let mut input = McpServerInput {
                id: None,
                workspace_id: String::new(),
                scope: "global".into(),
                name: name.clone(),
                transport: if kind == "stdio" { "stdio" } else { "http" }.into(),
                enabled: true,
                ..Default::default()
            };
            if kind == "stdio" {
                input.command = transport.get("command").and_then(serde_json::Value::as_str).unwrap_or_default().into();
                input.args = transport
                    .get("args")
                    .and_then(serde_json::Value::as_array)
                    .map(|items| items.iter().filter_map(|i| i.as_str().map(str::to_string)).collect())
                    .unwrap_or_default();
                if let Some(env) = transport.get("env").and_then(serde_json::Value::as_object) {
                    for (k, v) in env {
                        if let Some(v) = v.as_str() {
                            input.env.insert(k.clone(), v.to_string());
                        }
                    }
                }
                if let Some(vars) = transport.get("env_vars").and_then(serde_json::Value::as_array) {
                    for var in vars.iter().filter_map(serde_json::Value::as_str) {
                        // Codex's own plumbing, not the server's configuration.
                        if matches!(var, "HOME" | "PATH" | "USERPROFILE" | "LOCALAPPDATA" | "XDG_CACHE_HOME") {
                            continue;
                        }
                        if let Some(value) = lookup(var) {
                            input.env.insert(var.to_string(), value);
                        }
                    }
                }
            } else {
                input.url = transport.get("url").and_then(serde_json::Value::as_str).unwrap_or_default().into();
                if let Some(var) = transport.get("bearer_token_env_var").and_then(serde_json::Value::as_str) {
                    if let Some(token) = lookup(var) {
                        input.headers.insert("Authorization".into(), format!("Bearer {token}"));
                    }
                }
            }
            Some((name, input))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claudes_config_reads_as_inputs() {
        let config = serde_json::json!({
            "mcpServers": {
                "trello": {"type": "stdio", "command": "npx", "args": ["-y", "trello-mcp"], "env": {"TRELLO_KEY": "k"}},
                "docs": {"type": "http", "url": "https://example.com/mcp", "headers": {"Authorization": "Bearer t"}},
                "old style": {"url": "https://example.com/sse-less"}
            }
        });
        let specs = parse_claude_servers(&config);
        let by = |name: &str| specs.iter().find(|(n, _)| n == name).map(|(_, input)| input.clone()).unwrap();
        assert_eq!(by("trello").args, vec!["-y", "trello-mcp"]);
        assert_eq!(by("trello").env.get("TRELLO_KEY").map(String::as_str), Some("k"));
        assert_eq!(by("docs").transport, "http");
        assert_eq!(by("old style").transport, "http", "a URL with no type is a remote server");
        assert_eq!(clean_name("old style"), "old-style");
    }

    #[test]
    fn codexs_listing_reads_as_inputs_with_its_pass_through_values() {
        let listing = serde_json::json!([
            {"name": "gh", "enabled": true, "transport": {"type": "stdio", "command": "npx", "args": ["gh-mcp"], "env": {}, "env_vars": ["GITHUB_TOKEN", "PATH"]}},
            {"name": "web", "enabled": true, "transport": {"type": "streamable_http", "url": "https://example.com/mcp", "bearer_token_env_var": "WEB_TOKEN"}}
        ]);
        let specs = parse_codex_servers(&listing, |name| match name {
            "GITHUB_TOKEN" => Some("ghp".into()),
            "WEB_TOKEN" => Some("abc".into()),
            _ => Some("noise".into()),
        });
        assert_eq!(specs[0].1.env.get("GITHUB_TOKEN").map(String::as_str), Some("ghp"));
        assert!(!specs[0].1.env.contains_key("PATH"), "Codex's plumbing is not the server's config");
        assert_eq!(specs[1].1.transport, "http");
        assert_eq!(specs[1].1.headers.get("Authorization").map(String::as_str), Some("Bearer abc"));
    }
}
