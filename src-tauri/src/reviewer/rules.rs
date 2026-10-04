//! The rules and the Quality Gate the local server judges a project by.
//!
//! Three sources, chosen in Settings (see [`RulesPreset`] / [`GatePreset`]):
//!
//! - **SonarQube's own** ("Sonar way"), untouched.
//! - **CodeFlow's**, built on the local server through its Web API: a profile per language that
//!   *inherits* from Sonar way — so the rules SonarSource adds in a later version arrive by themselves
//!   — and activates more on top; and a gate over the whole project rather than over new code, which
//!   is what a review of a project, not of a change, is asking.
//! - **A connected server's**: a company's SonarQube Server or SonarQube Cloud. Its profiles are
//!   copied with the endpoints SonarQube itself offers for that — `backup` there, `restore` here — and
//!   its gate re-created condition by condition. Copied, not linked: a review runs on this machine and
//!   never publishes anything to the company's server. Each copy is renamed `<server> · <profile>`, so
//!   two servers' "Java" profiles can never overwrite one another, and where it came from stays visible
//!   in the local server's own pages.
//!
//! What was applied is recorded in `server/data/codeflow-rules.json`, beside the data it describes, so
//! a start can tell whether anything is left to do — and deleting the data forgets it with the profiles.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::api::{Auth, SonarClient};
use super::config::{GatePreset, RemoteServer, ReviewerConfig, RulesPreset};
use super::install;

/// The local profiles CodeFlow creates, by preset.
pub const STRICT_PROFILE: &str = "CodeFlow strict";
pub const MAX_PROFILE: &str = "CodeFlow max";
pub const STRICT_GATE: &str = "CodeFlow strict";
const SONAR_WAY: &str = "Sonar way";

/// Rules the strict profile leaves out even though their impact qualifies, by rule number (they exist
/// in several languages under the same number). Each one either needs configuring before it means
/// anything or forbids an ordinary construct as a matter of taste:
///
/// - S1451 demands a licence header and, unconfigured, flags every file as a Blocker;
/// - S1539 asks for `"use strict"`, which an ES module already is;
/// - S126 wants an `else` after every `else if` — a coding-standard rule, not a defect;
/// - S7648 enforces one Angular architecture over another;
/// - S1774 and S881 forbid the ternary and `++`/`--` outright.
///
/// Rules tagged `convention` are left out too — they enforce a house style.
pub const STRICT_DENYLIST: &[&str] = &["S1451", "S1539", "S126", "S7648", "S1774", "S881"];

/// "Max" means every rule — but S1451 unconfigured would fail every project's maintainability on a
/// header nobody asked for.
pub const MAX_DENYLIST: &[&str] = &["S1451"];

/// What an application did, for the settings pane.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct RulesReport {
    /// Languages whose default profile is now the chosen one.
    pub languages: u32,
    /// Rules activated beyond the base profile, or restored from a server.
    pub activated: u64,
    /// Rules a server's profile names that this SonarQube doesn't have — a plugin or an edition the
    /// company has and Community Build doesn't.
    pub missing: u64,
    /// The gate now in use.
    pub gate: String,
    pub warnings: Vec<String>,
    /// What was applied, as a fingerprint — compared at every start.
    pub signature: String,
    pub applied_at: i64,
}

fn marker_path() -> std::path::PathBuf {
    install::server_dir().join("data").join("codeflow-rules.json")
}

pub fn last_report() -> Option<RulesReport> {
    let text = std::fs::read_to_string(marker_path()).ok()?;
    serde_json::from_str(&text).ok()
}

/// What `config` asks for, as a string: equal strings mean nothing to re-apply. Includes the server's
/// URL, so pointing a connection at another host re-imports.
pub fn signature(config: &ReviewerConfig, servers: &[RemoteServer]) -> String {
    let url_of = |id: &str| servers.iter().find(|s| s.id == id).map(|s| s.url.clone()).unwrap_or_default();
    let rules_url = match &config.rules {
        RulesPreset::Server { server_id, .. } => url_of(server_id),
        _ => String::new(),
    };
    let gate_url = match &config.gate {
        GatePreset::Server { server_id, .. } => url_of(server_id),
        _ => String::new(),
    };
    serde_json::json!({
        "v": 1,
        "sonarqube": super::catalog::SONARQUBE.version,
        "rules": config.rules,
        "rulesUrl": rules_url,
        "gate": config.gate,
        "gateUrl": gate_url,
        "thresholds": config.thresholds,
    })
    .to_string()
}

/// Applies the configured rules unless they are what was applied last.
pub async fn ensure_applied(local: &SonarClient, config: &ReviewerConfig, servers: &[RemoteServer]) -> Result<(), String> {
    let wanted = signature(config, servers);
    if last_report().is_some_and(|report| report.signature == wanted) {
        return Ok(());
    }
    apply(local, config, servers).await.map(|_| ())
}

/// Puts the configured rules and gate in place on the local server, now.
pub async fn apply(local: &SonarClient, config: &ReviewerConfig, servers: &[RemoteServer]) -> Result<RulesReport, String> {
    let mut report = RulesReport { signature: signature(config, servers), ..Default::default() };
    let profiles = local_profiles(local).await?;

    match &config.rules {
        RulesPreset::SonarWay => {
            for base in base_profiles(&profiles) {
                set_default(local, &base.name, &base.language).await?;
                report.languages += 1;
            }
        }
        RulesPreset::Strict | RulesPreset::Max => {
            let strict = config.rules == RulesPreset::Strict;
            let name = if strict { STRICT_PROFILE } else { MAX_PROFILE };
            for base in base_profiles(&profiles) {
                let key = ensure_child_profile(local, &profiles, name, &base).await?;
                report.activated += activate_extras(local, &key, &base.language, strict).await?;
                drop_denied(local, &key, &base.language, strict).await?;
                set_default(local, name, &base.language).await?;
                report.languages += 1;
            }
        }
        RulesPreset::Server { server_id, profiles: picked } => {
            let server = find_server(servers, server_id)?;
            let remote = remote_client(server)?;
            let org = organization(server);
            let remote_profiles = remote_profiles(&remote, &org).await?;
            let chosen: Vec<&Profile> = if picked.is_empty() {
                remote_profiles.iter().filter(|p| p.is_default).collect()
            } else {
                remote_profiles.iter().filter(|p| picked.contains(&p.key)).collect()
            };
            if chosen.is_empty() {
                return Err(format!("{} has no quality profiles to bring.", server.name));
            }
            for profile in chosen {
                let mut query = vec![("language", profile.language.clone()), ("qualityProfile", profile.name.clone())];
                query.extend(org.clone());
                let xml = remote.get_text("api/qualityprofiles/backup", &query).await.map_err(String::from)?;
                let local_name = imported_name(&server.name, &profile.name);
                let renamed = rename_backup(&xml, &local_name)
                    .ok_or_else(|| format!("The backup of {} isn't a quality profile.", profile.name))?;
                let part = reqwest::multipart::Part::text(renamed)
                    .file_name("profile.xml")
                    .mime_str("application/xml")
                    .map_err(|e| e.to_string())?;
                match local.post_multipart("api/qualityprofiles/restore", reqwest::multipart::Form::new().part("backup", part)).await {
                    Ok(value) => {
                        report.activated += value.get("ruleSuccesses").and_then(Value::as_u64).unwrap_or(0);
                        report.missing += value.get("ruleFailures").and_then(Value::as_u64).unwrap_or(0);
                        set_default(local, &local_name, &profile.language).await?;
                        report.languages += 1;
                    }
                    // A language this SonarQube doesn't analyse (C++ is commercial) can't be restored —
                    // a note, not a failure of the whole import.
                    Err(error) => report.warnings.push(format!("{} ({}): {}", profile.name, profile.language_name, error.message)),
                }
            }
        }
    }

    report.gate = match &config.gate {
        GatePreset::SonarWay => {
            local.post("api/qualitygates/set_as_default", &[("name", SONAR_WAY.into())]).await.map_err(String::from)?;
            SONAR_WAY.to_string()
        }
        GatePreset::Strict => {
            let rating = |mqr: &str, legacy: &str| (mqr.to_string(), legacy.to_string());
            let conditions = vec![
                Condition { metric: "coverage".into(), op: "LT".into(), error: trim_number(config.thresholds.coverage) },
                Condition { metric: "duplicated_lines_density".into(), op: "GT".into(), error: trim_number(config.thresholds.duplication) },
            ];
            let ratings = [
                rating("software_quality_reliability_rating", "reliability_rating"),
                rating("software_quality_security_rating", "security_rating"),
                rating("software_quality_maintainability_rating", "sqale_rating"),
            ];
            let metrics = metric_keys(local).await?;
            let mut all = conditions;
            for (mqr, legacy) in ratings {
                let metric = if metrics.iter().any(|m| m == &mqr) { mqr } else { legacy };
                all.push(Condition { metric, op: "GT".into(), error: "1".into() });
            }
            put_gate(local, STRICT_GATE, &all, &mut report.warnings).await?;
            STRICT_GATE.to_string()
        }
        GatePreset::Server { server_id, gate } => {
            let server = find_server(servers, server_id)?;
            let remote = remote_client(server)?;
            let org = organization(server);
            let list = remote.get("api/qualitygates/list", &org).await.map_err(String::from)?;
            let gates = list.get("qualitygates").and_then(Value::as_array).cloned().unwrap_or_default();
            let name = if gate.trim().is_empty() {
                gates
                    .iter()
                    .find(|g| g.get("isDefault").and_then(Value::as_bool) == Some(true))
                    .and_then(|g| g.get("name").and_then(Value::as_str))
                    .map(str::to_string)
                    .ok_or_else(|| format!("{} has no default Quality Gate.", server.name))?
            } else {
                gate.clone()
            };
            let mut query = vec![("name", name.clone())];
            query.extend(org);
            let shown = remote.get("api/qualitygates/show", &query).await.map_err(String::from)?;
            let conditions: Vec<Condition> = shown
                .get("conditions")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|c| {
                    Some(Condition {
                        metric: c.get("metric")?.as_str()?.to_string(),
                        op: c.get("op")?.as_str()?.to_string(),
                        error: c.get("error")?.as_str()?.to_string(),
                    })
                })
                .collect();
            let local_name = imported_name(&server.name, &name);
            put_gate(local, &local_name, &conditions, &mut report.warnings).await?;
            local_name
        }
    };

    report.applied_at = chrono::Utc::now().timestamp_millis();
    if let Some(parent) = marker_path().parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(marker_path(), serde_json::to_string(&report).unwrap_or_default());
    Ok(report)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub key: String,
    pub name: String,
    pub language: String,
    pub language_name: String,
    pub is_default: bool,
    pub is_built_in: bool,
    pub active_rules: u64,
}

fn profiles_of(value: &Value) -> Vec<Profile> {
    value
        .get("profiles")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|p| {
            Some(Profile {
                key: p.get("key")?.as_str()?.to_string(),
                name: p.get("name")?.as_str()?.to_string(),
                language: p.get("language")?.as_str()?.to_string(),
                language_name: p.get("languageName").and_then(Value::as_str).unwrap_or_default().to_string(),
                is_default: p.get("isDefault").and_then(Value::as_bool).unwrap_or(false),
                is_built_in: p.get("isBuiltIn").and_then(Value::as_bool).unwrap_or(false),
                active_rules: p.get("activeRuleCount").and_then(Value::as_u64).unwrap_or(0),
            })
        })
        .collect()
}

async fn local_profiles(local: &SonarClient) -> Result<Vec<Profile>, String> {
    Ok(profiles_of(&local.get("api/qualityprofiles/search", &[]).await.map_err(String::from)?))
}

async fn remote_profiles(remote: &SonarClient, org: &[(&'static str, String)]) -> Result<Vec<Profile>, String> {
    Ok(profiles_of(&remote.get("api/qualityprofiles/search", org).await.map_err(String::from)?))
}

/// The built-in "Sonar way" of every language — what CodeFlow's profiles inherit from.
fn base_profiles(profiles: &[Profile]) -> Vec<Profile> {
    let mut languages: Vec<&str> = profiles.iter().map(|p| p.language.as_str()).collect();
    languages.sort_unstable();
    languages.dedup();
    languages
        .into_iter()
        .filter_map(|language| {
            let built_in = profiles.iter().filter(|p| p.language == language && p.is_built_in);
            built_in.clone().find(|p| p.name == SONAR_WAY).or_else(|| built_in.into_iter().next()).cloned()
        })
        .collect()
}

async fn set_default(local: &SonarClient, name: &str, language: &str) -> Result<(), String> {
    local
        .post("api/qualityprofiles/set_default", &[("qualityProfile", name.into()), ("language", language.into())])
        .await
        .map(|_| ())
        .map_err(String::from)
}

/// The profile `name` for `base`'s language, created as a child of `base` when it isn't there.
async fn ensure_child_profile(local: &SonarClient, profiles: &[Profile], name: &str, base: &Profile) -> Result<String, String> {
    if let Some(existing) = profiles.iter().find(|p| p.name == name && p.language == base.language) {
        return Ok(existing.key.clone());
    }
    let created = local
        .post("api/qualityprofiles/create", &[("name", name.into()), ("language", base.language.clone())])
        .await
        .map_err(String::from)?;
    let key = created
        .get("profile")
        .and_then(|p| p.get("key"))
        .and_then(Value::as_str)
        .ok_or("SonarQube created a profile but didn't say its key")?
        .to_string();
    local
        .post(
            "api/qualityprofiles/change_parent",
            &[
                ("qualityProfile", name.into()),
                ("language", base.language.clone()),
                ("parentQualityProfile", base.name.clone()),
            ],
        )
        .await
        .map_err(String::from)?;
    Ok(key)
}

async fn activate(local: &SonarClient, key: &str, language: &str, extra: &[(&str, &str)]) -> Result<u64, String> {
    let mut form: Vec<(&str, String)> = vec![
        ("targetKey", key.into()),
        ("languages", language.into()),
        ("statuses", "READY".into()),
        ("is_template", "false".into()),
    ];
    form.extend(extra.iter().map(|(k, v)| (*k, v.to_string())));
    let value = local.post("api/qualityprofiles/activate_rules", &form).await.map_err(String::from)?;
    Ok(value.get("succeeded").and_then(Value::as_u64).unwrap_or(0))
}

async fn activate_extras(local: &SonarClient, key: &str, language: &str, strict: bool) -> Result<u64, String> {
    if !strict {
        return activate(local, key, language, &[]).await;
    }
    let reliability_security = activate(local, key, language, &[("impactSoftwareQualities", "RELIABILITY,SECURITY")]).await?;
    let maintainability = activate(
        local,
        key,
        language,
        &[("impactSoftwareQualities", "MAINTAINABILITY"), ("impactSeverities", "HIGH,BLOCKER")],
    )
    .await?;
    Ok(reliability_security + maintainability)
}

/// The rule number of a rule key: `typescript:S1451` → `S1451`.
fn rule_number(key: &str) -> &str {
    key.rsplit(':').next().unwrap_or(key)
}

fn denied(rule: &Value, strict: bool) -> bool {
    let key = rule.get("key").and_then(Value::as_str).unwrap_or_default();
    let list = if strict { STRICT_DENYLIST } else { MAX_DENYLIST };
    if list.contains(&rule_number(key)) {
        return true;
    }
    strict
        && rule
            .get("sysTags")
            .and_then(Value::as_array)
            .is_some_and(|tags| tags.iter().any(|t| t.as_str() == Some("convention")))
}

/// Deactivates what the profile added that it shouldn't have — only rules activated on it directly,
/// never the ones it inherits from Sonar way.
async fn drop_denied(local: &SonarClient, key: &str, language: &str, strict: bool) -> Result<(), String> {
    let rules = local
        .get_all(
            "api/rules/search",
            &[
                ("qprofile", key.into()),
                ("activation", "true".into()),
                ("inheritance", "NONE".into()),
                ("languages", language.into()),
                ("f", "sysTags".into()),
            ],
            "rules",
            5_000,
        )
        .await
        .map_err(String::from)?;
    for rule in rules.iter().filter(|r| denied(r, strict)) {
        if let Some(rule_key) = rule.get("key").and_then(Value::as_str) {
            let _ = local
                .post("api/qualityprofiles/deactivate_rule", &[("key", key.into()), ("rule", rule_key.into())])
                .await;
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq)]
struct Condition {
    metric: String,
    op: String,
    error: String,
}

async fn metric_keys(local: &SonarClient) -> Result<Vec<String>, String> {
    let metrics = local.get_all("api/metrics/search", &[], "metrics", 5_000).await.map_err(String::from)?;
    Ok(metrics.iter().filter_map(|m| m.get("key").and_then(Value::as_str).map(str::to_string)).collect())
}

/// Makes the gate `name` hold exactly `conditions`, and the default. A gate created afresh comes with
/// SonarQube's new-code conditions already in it; those are removed with everything else.
async fn put_gate(local: &SonarClient, name: &str, conditions: &[Condition], warnings: &mut Vec<String>) -> Result<(), String> {
    let list = local.get("api/qualitygates/list", &[]).await.map_err(String::from)?;
    let exists = list
        .get("qualitygates")
        .and_then(Value::as_array)
        .is_some_and(|gates| gates.iter().any(|g| g.get("name").and_then(Value::as_str) == Some(name)));
    if !exists {
        local.post("api/qualitygates/create", &[("name", name.into())]).await.map_err(String::from)?;
    }
    let shown = local.get("api/qualitygates/show", &[("name", name.into())]).await.map_err(String::from)?;
    for condition in shown.get("conditions").and_then(Value::as_array).into_iter().flatten() {
        if let Some(id) = condition.get("id").and_then(Value::as_str) {
            let _ = local.post("api/qualitygates/delete_condition", &[("id", id.into())]).await;
        }
    }
    for condition in conditions {
        let created = local
            .post(
                "api/qualitygates/create_condition",
                &[
                    ("gateName", name.into()),
                    ("metric", condition.metric.clone()),
                    ("op", condition.op.clone()),
                    ("error", condition.error.clone()),
                ],
            )
            .await;
        if let Err(error) = created {
            // A metric only a commercial edition has, typically: the rest of the gate still holds.
            warnings.push(format!("{}: {}", condition.metric, error.message));
        }
    }
    local.post("api/qualitygates/set_as_default", &[("name", name.into())]).await.map_err(String::from)?;
    Ok(())
}

/// `80.0` → `"80"`, `2.5` → `"2.5"` — SonarQube takes the threshold as text.
fn trim_number(value: f64) -> String {
    let text = format!("{value:.2}");
    text.trim_end_matches('0').trim_end_matches('.').to_string()
}

pub fn imported_name(server: &str, profile: &str) -> String {
    format!("{} · {}", server.trim(), profile.trim())
}

/// A profile backup with its `<name>` replaced, so the restore lands under that name.
pub fn rename_backup(xml: &str, name: &str) -> Option<String> {
    let start = xml.find("<name>")?;
    let end = start + xml[start..].find("</name>")?;
    let escaped = name.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    Some(format!("{}<name>{escaped}{}", &xml[..start], &xml[end..]))
}

fn find_server<'a>(servers: &'a [RemoteServer], id: &str) -> Result<&'a RemoteServer, String> {
    servers.iter().find(|s| s.id == id).ok_or_else(|| "That SonarQube connection no longer exists.".to_string())
}

fn organization(server: &RemoteServer) -> Vec<(&'static str, String)> {
    let org = server.organization.trim();
    if org.is_empty() { Vec::new() } else { vec![("organization", org.to_string())] }
}

/// A client for a connected server, signed in with the token in the keychain.
pub fn remote_client(server: &RemoteServer) -> Result<SonarClient, String> {
    let token = super::remote_token(&server.id);
    let auth = match token {
        Some(token) if !token.is_empty() => Auth::Bearer(token),
        _ => Auth::None,
    };
    SonarClient::new(&server.url, auth, server.verify_tls)
}

/// What a connected server has to offer, for the import picker.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCatalog {
    pub version: String,
    pub profiles: Vec<Profile>,
    pub gates: Vec<RemoteGate>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteGate {
    pub name: String,
    pub is_default: bool,
}

pub async fn remote_catalog(server: &RemoteServer) -> Result<RemoteCatalog, String> {
    let remote = remote_client(server)?;
    let org = organization(server);
    let version = remote.get_text("api/server/version", &[]).await.map(|v| v.trim().to_string()).unwrap_or_default();
    let validated = remote.get("api/authentication/validate", &[]).await.map_err(String::from)?;
    if validated.get("valid").and_then(Value::as_bool) != Some(true) {
        return Err(format!("{} didn't accept the token.", server.name));
    }
    let profiles = remote_profiles(&remote, &org).await?;
    let list = remote.get("api/qualitygates/list", &org).await.map_err(String::from)?;
    let gates = list
        .get("qualitygates")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|g| {
            Some(RemoteGate {
                name: g.get("name")?.as_str()?.to_string(),
                is_default: g.get("isDefault").and_then(Value::as_bool).unwrap_or(false),
            })
        })
        .collect();
    Ok(RemoteCatalog { version, profiles, gates })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_backup_is_renamed_without_touching_its_rules() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?><profile><name>Acme Java</name><language>java</language><rules><rule><key>S1</key><parameters><parameter><key>name</key><value>x</value></parameter></parameters></rule></rules></profile>"#;
        let renamed = rename_backup(xml, "acme · Acme Java").unwrap();
        assert!(renamed.contains("<profile><name>acme · Acme Java</name><language>java</language>"));
        // Only the profile's own name: a rule parameter that happens to be called `name` is a <key>.
        assert!(renamed.contains("<key>name</key><value>x</value>"));
        assert_eq!(rename_backup("<html>", "x"), None);
        assert!(rename_backup(xml, "R&D <x>").unwrap().contains("<name>R&amp;D &lt;x&gt;</name>"));
    }

    #[test]
    fn thresholds_are_written_the_way_sonarqube_reads_them() {
        assert_eq!(trim_number(80.0), "80");
        assert_eq!(trim_number(2.5), "2.5");
        assert_eq!(trim_number(3.25), "3.25");
    }

    #[test]
    fn the_denylist_matches_by_rule_number_and_strict_drops_conventions() {
        let header = serde_json::json!({ "key": "typescript:S1451", "sysTags": ["convention"] });
        let style = serde_json::json!({ "key": "java:S100", "sysTags": ["convention"] });
        let bug = serde_json::json!({ "key": "java:S2259", "sysTags": ["cwe"] });
        assert!(denied(&header, true));
        assert!(denied(&header, false));
        assert!(denied(&style, true));
        assert!(!denied(&style, false));
        assert!(!denied(&bug, true));
    }

    #[test]
    fn the_base_profile_is_each_languages_built_in_sonar_way() {
        let profile = |name: &str, language: &str, built_in: bool| Profile {
            key: format!("{language}-{name}"),
            name: name.into(),
            language: language.into(),
            language_name: language.into(),
            is_default: false,
            is_built_in: built_in,
            active_rules: 0,
        };
        let profiles = vec![
            profile("Sonar agentic AI", "java", true),
            profile("Sonar way", "java", true),
            profile("CodeFlow strict", "java", false),
            profile("Sonar way", "ts", true),
        ];
        let bases = base_profiles(&profiles);
        assert_eq!(bases.len(), 2);
        assert!(bases.iter().all(|p| p.name == "Sonar way"));
    }

    #[test]
    fn the_signature_moves_with_the_choice_and_the_servers_address() {
        let mut config = ReviewerConfig::default();
        let servers = vec![RemoteServer { id: "s".into(), url: "https://sonar.example.com".into(), ..Default::default() }];
        let strict = signature(&config, &servers);
        config.rules = RulesPreset::Server { server_id: "s".into(), profiles: vec![] };
        let remote = signature(&config, &servers);
        assert_ne!(strict, remote);
        let moved = vec![RemoteServer { id: "s".into(), url: "https://other.example.com".into(), ..Default::default() }];
        assert_ne!(remote, signature(&config, &moved));
    }
}
