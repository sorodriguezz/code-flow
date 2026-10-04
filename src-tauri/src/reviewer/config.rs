//! What the user chose in Settings › Reviewer, as two `app_settings` rows.
//!
//! - [`CONFIG_KEY`]: one JSON object — the local server's port and memory, when it stops on its own,
//!   which rules and which Quality Gate it applies.
//! - [`SERVERS_KEY`]: a JSON array of the remote SonarQube servers connected for their rules. An
//!   array of its own, rather than a field of the object above, because the backup's credential
//!   roster reads exactly that shape (`backup::vault::field_of_each`) to find each server's token.
//!
//! Tokens are never in either row: each remote server's is in the OS keychain under
//! [`crate::secrets::sonar_server_token_key`], and the local server's admin password and token under
//! their own keys — see `server::credentials`.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::db::queries;

pub const CONFIG_KEY: &str = "reviewer_config";
pub const SERVERS_KEY: &str = "reviewer_servers";

/// How much memory the local server's three JVMs get.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum Memory {
    /// SonarQube's own defaults: 512 MB each for the web server, the compute engine and the search
    /// index — about 2 GB with everything else the processes need.
    #[default]
    Standard,
    /// Twice that, for large projects whose analyses the compute engine struggles to process.
    Large,
}

/// Which rules the local server applies to every analysis.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RulesPreset {
    /// SonarQube's built-in profiles, untouched.
    SonarWay,
    /// Sonar way, plus every reliability and security rule and the maintainability rules of high
    /// impact — less the ones that only enforce a house style. See `rules::STRICT_DENYLIST`.
    #[default]
    Strict,
    /// Every rule SonarQube has, but the one that demands a licence header nobody configured.
    Max,
    /// The quality profiles of a connected server: its defaults, or the ones picked.
    #[serde(rename_all = "camelCase")]
    Server { server_id: String, profiles: Vec<String> },
}

/// Which Quality Gate decides whether a review passed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GatePreset {
    /// SonarQube's own, which only looks at code changed since the first analysis.
    SonarWay,
    /// Over the whole project: the thresholds below and an A in reliability, security and
    /// maintainability.
    #[default]
    Strict,
    /// A connected server's gate: its default, or the one named.
    #[serde(rename_all = "camelCase")]
    Server { server_id: String, gate: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Thresholds {
    /// The least coverage, in percent, the strict gate accepts.
    pub coverage: f64,
    /// The most duplicated lines, in percent.
    pub duplication: f64,
}

impl Default for Thresholds {
    fn default() -> Self {
        Self { coverage: 80.0, duplication: 3.0 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ReviewerConfig {
    /// The port the local server is asked for; another free one is used when it is taken.
    pub port: u16,
    pub memory: Memory,
    /// Minutes without a review before the local server is stopped to give its memory back. 0 never.
    pub idle_minutes: u32,
    pub rules: RulesPreset,
    pub gate: GatePreset,
    pub thresholds: Thresholds,
    /// Whether a review goes on to SonarQube when tests fail — what `continueOnError` does in a
    /// pipeline. On, so a red test still yields the full report.
    pub continue_on_test_failure: bool,
}

impl Default for ReviewerConfig {
    fn default() -> Self {
        Self {
            port: 9000,
            memory: Memory::Standard,
            idle_minutes: 15,
            rules: RulesPreset::Strict,
            gate: GatePreset::Strict,
            thresholds: Thresholds::default(),
            continue_on_test_failure: true,
        }
    }
}

/// A SonarQube Server or SonarQube Cloud the user connected, for its rules.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct RemoteServer {
    pub id: String,
    pub name: String,
    pub url: String,
    /// SonarQube Cloud's organization key; empty for a SonarQube Server.
    pub organization: String,
    /// Off accepts any certificate — for a server behind a CA the operating system doesn't know.
    pub verify_tls: bool,
}

impl Default for RemoteServer {
    fn default() -> Self {
        Self { id: String::new(), name: String::new(), url: String::new(), organization: String::new(), verify_tls: true }
    }
}

pub fn load(conn: &Connection) -> ReviewerConfig {
    queries::get_setting(conn, CONFIG_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save(conn: &Connection, config: &ReviewerConfig) -> Result<(), String> {
    let raw = serde_json::to_string(config).map_err(|e| e.to_string())?;
    queries::set_setting(conn, CONFIG_KEY, &raw).map_err(|e| e.to_string())
}

pub fn servers(conn: &Connection) -> Vec<RemoteServer> {
    queries::get_setting(conn, SERVERS_KEY)
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save_servers(conn: &Connection, servers: &[RemoteServer]) -> Result<(), String> {
    let raw = serde_json::to_string(servers).map_err(|e| e.to_string())?;
    queries::set_setting(conn, SERVERS_KEY, &raw).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_or_partial_row_reads_as_the_defaults() {
        let partial: ReviewerConfig = serde_json::from_str(r#"{"port":9100}"#).unwrap();
        assert_eq!(partial.port, 9100);
        assert_eq!(partial.rules, RulesPreset::Strict);
        assert_eq!(partial.gate, GatePreset::Strict);
        assert_eq!(partial.idle_minutes, 15);
        assert!(partial.continue_on_test_failure);
        assert_eq!(partial.thresholds.coverage, 80.0);
    }

    #[test]
    fn presets_round_trip_through_their_tags() {
        let rules = RulesPreset::Server { server_id: "s1".into(), profiles: vec!["k".into()] };
        let text = serde_json::to_string(&rules).unwrap();
        assert_eq!(text, r#"{"kind":"server","serverId":"s1","profiles":["k"]}"#);
        assert_eq!(serde_json::from_str::<RulesPreset>(&text).unwrap(), rules);
        let gate: GatePreset = serde_json::from_str(r#"{"kind":"strict"}"#).unwrap();
        assert_eq!(gate, GatePreset::Strict);
    }
}
