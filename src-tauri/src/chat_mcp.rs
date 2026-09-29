//! Which of the user's own MCP servers a chat turn runs with.
//!
//! # Why the chats need this at all
//!
//! The servers are the CLI's: `~/.claude.json`, claude.ai's connectors, `~/.codex/config.toml`. The
//! app does not configure them; it decides, per conversation, whether a turn may use them — and for
//! Claude Code that decision is not optional. In `-p` an MCP tool nobody pre-approved is **denied**,
//! so before this a server that was plainly connected (`trello`, on the machine this was written on)
//! could never be used from a chat, while its tool definitions were still loaded on every turn.
//!
//! # The switches, per engine
//!
//! - **Claude Code**: off unless switched on, or unless the user's own `settings.json` already
//!   allows it (`mcp__<server>` in `permissions.allow`) — which is what their terminal does too. On
//!   is `--allowedTools mcp__<server>`; off is `--disallowedTools mcp__<server>`, which also takes
//!   the tools out of what the model is shown.
//! - **Codex**: on or off exactly as its own config has it, and a switch turned off here is
//!   `-c mcp_servers.<name>.enabled=false` for that run. Its servers need no approval (`exec` runs
//!   with `approval_policy="never"`), so "on" is simply "not turned off".
//! - **Grok**: listed, not switchable — it has no per-run way to leave one server out.
//! - agy, opencode, Cline: nothing is listed.
//!
//! A conversation's switches live on its row (`chat_conversations.mcp_overrides`); a repository's,
//! for the panel's chat, in a setting named after the project. Both are a JSON object from server
//! name to on/off, holding only what the user changed.

use serde::Serialize;
use std::collections::{BTreeMap, HashSet};
use std::path::Path;

/// One of the user's servers, as the switch list shows it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct McpServerView {
    /// What a switch is stored under in `mcp_overrides`: the name for a CLI's own server,
    /// `app:<name>` for one declared in CodeFlow (see `mcp_registry::switch_key`).
    pub key: String,
    pub name: String,
    /// `connected` | `pending` | `needs-auth` | `failed` (Claude's report), `enabled` | `disabled`
    /// (Codex's config), or empty when nothing has said.
    pub status: String,
    /// `connector` (claude.ai) | `user` | `app` (declared in CodeFlow).
    pub source: String,
    /// Whether turns here run with it.
    pub enabled: bool,
    /// Whether the app can switch it for this engine.
    pub togglable: bool,
}

/// What one turn is told about MCP.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TurnMcp {
    /// Permission rules to pre-approve (Claude's `mcp__<server>`), added to the turn's tool list.
    pub allow_rules: Vec<String>,
    /// Servers to keep out of the run, by name — see `AiInvocation::mcp_block`.
    pub block: Vec<String>,
    /// The app's own servers the turn runs with — see `AiInvocation::app_mcp`.
    pub app: Vec<crate::mcp_registry::LiveServer>,
}

/// The setting holding a repository's switches for the panel's chat.
pub fn panel_setting_key(project_id: &str) -> String {
    format!("panel_mcp_overrides:{project_id}")
}

/// A stored switch set. Anything unreadable is "nothing switched" rather than an error: the worst
/// a corrupted value can then do is put every server back to its default.
pub fn parse_overrides(json: &str) -> BTreeMap<String, bool> {
    serde_json::from_str(json).unwrap_or_default()
}

/// The switch set with one server changed — `None` puts it back to its default.
pub fn with_override(json: &str, server: &str, enabled: Option<bool>) -> String {
    let mut overrides = parse_overrides(json);
    match enabled {
        Some(on) => {
            overrides.insert(server.to_string(), on);
        }
        None => {
            overrides.remove(server);
        }
    }
    if overrides.is_empty() {
        String::new()
    } else {
        serde_json::to_string(&overrides).unwrap_or_default()
    }
}

/// The servers the user's own Claude settings already allow — `mcp__<server>` (or one of its tools)
/// in `permissions.allow` — as the rule for the whole server. Those start switched on, as they are
/// in the user's terminal.
pub fn claude_allowed_servers(config: &Path) -> HashSet<String> {
    let text = std::fs::read_to_string(config.join("settings.json")).unwrap_or_default();
    let value: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
    value
        .pointer("/permissions/allow")
        .and_then(serde_json::Value::as_array)
        .map(|rules| {
            rules
                .iter()
                .filter_map(serde_json::Value::as_str)
                .filter_map(|rule| {
                    let rest = rule.strip_prefix("mcp__")?;
                    let server = rest.split("__").next()?;
                    (!server.is_empty()).then(|| format!("mcp__{server}"))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The user's servers for `provider`, with their state here.
///
/// `servers` is `(name, status)` as the CLI reported it; `overrides` is what this conversation or
/// repository switched.
pub fn views(
    provider: &str,
    servers: &[(String, String)],
    overrides: &BTreeMap<String, bool>,
    claude_allowed: &HashSet<String>,
) -> Vec<McpServerView> {
    servers
        .iter()
        .map(|(name, status)| {
            let default = default_on(provider, name, status, claude_allowed);
            McpServerView {
                key: name.clone(),
                name: name.clone(),
                status: status.clone(),
                source: if name.starts_with("claude.ai ") { "connector" } else { "user" }.to_string(),
                enabled: overrides.get(name).copied().unwrap_or(default),
                togglable: matches!(provider, "claude" | "codex"),
            }
        })
        .collect()
}

fn default_on(provider: &str, name: &str, status: &str, claude_allowed: &HashSet<String>) -> bool {
    match provider {
        "claude" => claude_allowed.contains(&crate::claude::mcp_rule(name)),
        "codex" => status != "disabled",
        "grok" => true,
        _ => false,
    }
}

/// What one turn runs with. Claude: every known server is either pre-approved or kept out, so a
/// switched-off server costs no context; a switch for a server the last report did not list is
/// still honoured when it is on. Codex: only what was switched off, and only if its own config had
/// it on — anything else is already as the user wants it.
pub fn plan(
    provider: &str,
    servers: &[(String, String)],
    overrides: &BTreeMap<String, bool>,
    claude_allowed: &HashSet<String>,
    app: Vec<crate::mcp_registry::LiveServer>,
) -> TurnMcp {
    let mut turn = TurnMcp::default();
    // The app's servers this engine can take, minus any the CLI already has by that name — its own
    // wins, and one server twice would be one tool namespace claimed by two programs. Claude runs
    // them only once pre-approved, like any other server in `-p`.
    turn.app = app
        .into_iter()
        .filter(|server| crate::mcp_registry::supports(provider, server))
        .filter(|server| !servers.iter().any(|(known, _)| known == &server.name))
        .collect();
    if provider == "claude" {
        turn.allow_rules.extend(turn.app.iter().map(|server| crate::claude::mcp_rule(&server.name)));
    }
    match provider {
        "claude" => {
            for view in views(provider, servers, overrides, claude_allowed) {
                if view.enabled {
                    turn.allow_rules.push(crate::claude::mcp_rule(&view.name));
                } else {
                    turn.block.push(view.name);
                }
            }
            for (name, on) in overrides {
                if *on && !servers.iter().any(|(known, _)| known == name) {
                    turn.allow_rules.push(crate::claude::mcp_rule(name));
                }
            }
        }
        "codex" => {
            for (name, status) in servers {
                if overrides.get(name) == Some(&false) && status != "disabled" {
                    turn.block.push(name.clone());
                }
            }
        }
        _ => {}
    }
    turn
}

// ---------------------------------------------------------------------------------------------
// Reading the servers each CLI has
// ---------------------------------------------------------------------------------------------

/// Claude Code's servers for one account: what the last full chat turn reported (with status), or
/// — before any has — the user-level ones in `.claude.json`, status unknown.
pub fn claude_servers(env: &crate::ai_accounts::AccountEnv) -> Vec<(String, String)> {
    if let Some(reported) = crate::claude::install_report(&env.key()).and_then(|report| report.mcp_servers) {
        return reported.into_iter().map(|server| (server.name, server.status)).collect();
    }
    let file = match env.var("CLAUDE_CONFIG_DIR") {
        Some(dir) => std::path::PathBuf::from(dir).join(".claude.json"),
        None => match std::env::var_os("CLAUDE_CONFIG_DIR").filter(|dir| !dir.is_empty()) {
            Some(dir) => std::path::PathBuf::from(dir).join(".claude.json"),
            None => match dirs::home_dir() {
                Some(home) => home.join(".claude.json"),
                None => return Vec::new(),
            },
        },
    };
    let value: serde_json::Value =
        std::fs::read_to_string(file).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default();
    let mut names: Vec<(String, String)> = value
        .get("mcpServers")
        .and_then(serde_json::Value::as_object)
        .map(|servers| servers.keys().map(|name| (name.clone(), String::new())).collect())
        .unwrap_or_default();
    names.sort();
    names
}

/// Codex's servers, from its own `mcp list --json` — asked as the account, and kept for a minute,
/// because the answer is a process launch and every turn and every open menu asks.
pub async fn codex_servers(binary: &str, env: &crate::ai_accounts::AccountEnv) -> Vec<(String, String)> {
    use std::sync::{Mutex, OnceLock};
    type Cache = Mutex<BTreeMap<String, (std::time::Instant, Vec<(String, String)>)>>;
    static CACHE: OnceLock<Cache> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let key = env.key();
    if let Ok(held) = cache.lock() {
        if let Some((at, servers)) = held.get(&key) {
            if at.elapsed() < std::time::Duration::from_secs(60) {
                return servers.clone();
            }
        }
    }
    let (mut cmd, program) = crate::ai::aux_command_resolved(binary);
    cmd.args(["mcp", "list", "--json"]);
    env.apply(&mut cmd);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let launch = crate::ai::output_patiently(&mut cmd, binary, &program);
    let servers = match tokio::time::timeout(std::time::Duration::from_secs(10), launch).await {
        Ok(Ok(output)) if output.status.success() => parse_codex_list(&String::from_utf8_lossy(&output.stdout)),
        _ => Vec::new(),
    };
    if let Ok(mut held) = cache.lock() {
        held.insert(key, (std::time::Instant::now(), servers.clone()));
    }
    servers
}

/// Every server Codex would start, for a turn that promised to write nothing: its `read-only`
/// sandbox confines the model's own tools, not the programs its config launches, so a text-only turn
/// switches each of them off by name. See `AiInvocation::mcp_block`.
pub async fn codex_read_only_block(binary: &str, env: &crate::ai_accounts::AccountEnv) -> Vec<String> {
    codex_servers(binary, env)
        .await
        .into_iter()
        .filter(|(_, status)| status != "disabled")
        .map(|(name, _)| name)
        .collect()
}

/// `codex mcp list --json`: an array of `{name, enabled, …}`.
pub fn parse_codex_list(json: &str) -> Vec<(String, String)> {
    let value: serde_json::Value = serde_json::from_str(json).unwrap_or_default();
    value
        .as_array()
        .map(|servers| {
            servers
                .iter()
                .filter_map(|server| {
                    let name = server.get("name")?.as_str()?.to_string();
                    let enabled = server.get("enabled").and_then(serde_json::Value::as_bool).unwrap_or(true);
                    Some((name, if enabled { "enabled" } else { "disabled" }.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Grok's servers, from `grok inspect --json` — listed so the user can see them, never switched.
pub fn parse_grok_servers(json: &str) -> Vec<(String, String)> {
    let value: serde_json::Value = serde_json::from_str(json).unwrap_or_default();
    value
        .get("mcpServers")
        .and_then(serde_json::Value::as_array)
        .map(|servers| {
            servers
                .iter()
                .filter_map(|server| Some((server.get("name")?.as_str()?.to_string(), String::new())))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn servers() -> Vec<(String, String)> {
        vec![
            ("trello".to_string(), "connected".to_string()),
            ("claude.ai Gmail".to_string(), "needs-auth".to_string()),
        ]
    }

    /// Claude: off unless switched on or already allowed in the user's own settings — and every
    /// known server is either pre-approved or kept out of the model's view.
    #[test]
    fn claude_turns_allow_what_is_on_and_keep_out_the_rest() {
        let none = BTreeMap::new();
        let allowed = HashSet::new();
        let plan0 = plan("claude", &servers(), &none, &allowed, Vec::new());
        assert!(plan0.allow_rules.is_empty());
        assert_eq!(plan0.block, vec!["trello", "claude.ai Gmail"]);

        let on = parse_overrides(r#"{"trello":true}"#);
        let plan1 = plan("claude", &servers(), &on, &allowed, Vec::new());
        assert_eq!(plan1.allow_rules, vec!["mcp__trello"]);
        assert_eq!(plan1.block, vec!["claude.ai Gmail"]);

        // Already allowed by the user's own settings: on, unless switched off here.
        let mut settings_allow = HashSet::new();
        settings_allow.insert("mcp__trello".to_string());
        assert_eq!(plan("claude", &servers(), &none, &settings_allow, Vec::new()).allow_rules, vec!["mcp__trello"]);
        let off = parse_overrides(r#"{"trello":false}"#);
        assert!(plan("claude", &servers(), &off, &settings_allow, Vec::new()).block.contains(&"trello".to_string()));

        // A server switched on that the last report did not list is still pre-approved.
        let unknown = parse_overrides(r#"{"sentry":true}"#);
        assert!(plan("claude", &servers(), &unknown, &allowed, Vec::new()).allow_rules.contains(&"mcp__sentry".to_string()));
    }

    /// Codex runs its servers as configured; only a switch turned off here changes a run.
    #[test]
    fn codex_turns_only_drop_what_was_switched_off() {
        let codex = vec![
            ("node_repl".to_string(), "enabled".to_string()),
            ("codex_app".to_string(), "disabled".to_string()),
        ];
        let allowed = HashSet::new();
        assert_eq!(plan("codex", &codex, &BTreeMap::new(), &allowed, Vec::new()), TurnMcp::default());
        let off = parse_overrides(r#"{"node_repl":false,"codex_app":false}"#);
        assert_eq!(plan("codex", &codex, &off, &allowed, Vec::new()).block, vec!["node_repl"]);
        let views = views("codex", &codex, &BTreeMap::new(), &allowed);
        assert!(views[0].enabled && !views[1].enabled && views[0].togglable);
    }

    /// The app's servers join the turn — pre-approved on Claude — unless the CLI already has one by
    /// that name, or the engine cannot take it.
    #[test]
    fn the_apps_servers_join_unless_the_cli_has_one_by_that_name() {
        let live = |name: &str, transport: &str| crate::mcp_registry::LiveServer {
            name: name.into(),
            transport: transport.into(),
            command: "npx".into(),
            args: vec![],
            env: vec![],
            url: "https://example.com".into(),
            headers: vec![],
        };
        let allowed = HashSet::new();
        let turn = plan("claude", &servers(), &BTreeMap::new(), &allowed, vec![live("github", "stdio"), live("trello", "stdio")]);
        assert_eq!(turn.app.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), vec!["github"]);
        assert!(turn.allow_rules.contains(&"mcp__github".to_string()));
        let codex = plan("codex", &[], &BTreeMap::new(), &allowed, vec![live("docs", "sse"), live("gh", "http")]);
        assert_eq!(codex.app.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), vec!["gh"], "no SSE for Codex");
        assert!(plan("gemini", &[], &BTreeMap::new(), &allowed, vec![live("gh", "stdio")]).app.is_empty());
    }

    #[test]
    fn a_switch_set_round_trips_and_empties_back_to_nothing() {
        let one = with_override("", "trello", Some(true));
        assert_eq!(one, r#"{"trello":true}"#);
        assert_eq!(with_override(&one, "trello", None), "");
        assert!(parse_overrides("not json").is_empty());
    }

    #[test]
    fn the_users_own_allow_rules_name_whole_servers() {
        let dir = std::env::temp_dir().join(format!("cf-mcp-allow-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("settings.json"),
            r#"{"permissions":{"allow":["Bash(npm test:*)","mcp__trello__trello_get_card","mcp__sentry"]}}"#,
        )
        .unwrap();
        let allowed = claude_allowed_servers(&dir);
        assert!(allowed.contains("mcp__trello") && allowed.contains("mcp__sentry"));
        assert_eq!(allowed.len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_clis_listings_are_read() {
        let codex = r#"[{"name":"codex_app","enabled":false,"transport":{}},{"name":"node_repl","enabled":true}]"#;
        assert_eq!(
            parse_codex_list(codex),
            vec![("codex_app".to_string(), "disabled".to_string()), ("node_repl".to_string(), "enabled".to_string())]
        );
        let grok = r#"{"mcpServers":[{"name":"vercel","transport":"http"},{"name":"trello","transport":"stdio"}]}"#;
        assert_eq!(parse_grok_servers(grok).len(), 2);
        assert!(parse_codex_list("oops").is_empty());
    }
}
