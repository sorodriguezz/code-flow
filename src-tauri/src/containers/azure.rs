//! Azure, looked at — never changed. Through `az` and the person's own `az login`: the resources of a
//! subscription or group, their state and Resource Health, the activity log, the logs of the services
//! that have them, Log Analytics queries, and how the resources are connected.
//!
//! **Read-only by construction.** Every command here is a `list`, `show`, `logs` or `query`, or an
//! `az rest` whose method and host are fixed in this file (a GET of Resource Health, the one POST of a
//! Resource Graph query, which only reads). Nothing takes a verb from its caller.
//!
//! **Secrets stay in Rust.** What leaves this module went through `cloud::sanitize` (keys that can hold
//! one are dropped) and `secret_scan::redact`. The connections are found in the *raw* properties and
//! app settings — that is where an app names its database — but an edge carries only the setting's
//! name and the resource it points at, never the value it was read from.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::time::Duration;

use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::AsyncReadExt;

use super::cli;
use crate::architecture::cloud::{self, Provider};

const TIMEOUT: Duration = Duration::from_secs(60);
const QUERY_TIMEOUT: Duration = Duration::from_secs(120);
/// How long a streaming `log tail` is listened to when the logs are read once (for the AI).
const TAIL_LISTEN: Duration = Duration::from_secs(12);
/// Resources a connection map reads in full; a subscription bigger than that is read by group.
const MAX_GRAPH: usize = 800;
/// Web apps whose settings are scanned for the connections they name.
const MAX_SETTINGS: usize = 40;
const ARM: &str = "https://management.azure.com";

pub fn found() -> bool {
    cli::find("az").is_some()
}

fn program() -> Result<String, String> {
    cli::find("az").map(|p| p.to_string_lossy().into_owned()).ok_or_else(|| "the Azure CLI (`az`) is not installed".to_string())
}

/// No colour, no prompt, and no extension installed behind the person's back: a command that needs
/// one fails with the line that says which.
pub fn quiet_env() -> Vec<(String, String)> {
    [("AZURE_CORE_NO_COLOR", "1"), ("AZURE_CORE_ONLY_SHOW_ERRORS", "1"), ("AZURE_EXTENSION_USE_DYNAMIC_INSTALL", "no"), ("AZURE_CORE_COLLECT_TELEMETRY", "no")]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

async fn az_with(args: &[String], timeout: Duration) -> Result<String, String> {
    let output = cli::run_with(&program()?, args, None, timeout, &quiet_env()).await?;
    if output.ok() {
        Ok(output.stdout)
    } else {
        let complaint = output.complaint();
        let first = complaint.lines().map(|l| l.trim().trim_start_matches("ERROR:").trim()).find(|l| !l.is_empty()).unwrap_or("az failed");
        Err(crate::secret_scan::redact(&first.chars().take(400).collect::<String>()).0)
    }
}

async fn az(args: &[String]) -> Result<String, String> {
    az_with(args, TIMEOUT).await
}

async fn az_json(args: &[String]) -> Result<Value, String> {
    let out = az(args).await?;
    serde_json::from_str(out.trim()).map_err(|e| format!("az: {e}"))
}

fn strings(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

fn s(value: &Value, pointer: &str) -> String {
    match value.pointer(pointer) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

// ----------------------------------------------------------------------------------- checking

/// A value that goes on the command line after a flag: never itself a flag, never multi-line.
fn check_word(value: &str, what: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.starts_with('-') || value.chars().any(|c| c.is_control()) {
        Err(format!("\"{value}\" is not a {what}"))
    } else {
        Ok(value.to_string())
    }
}

/// A resource group's name as Azure allows it — also what goes inside a Resource Graph query.
fn check_group(value: &str) -> Result<String, String> {
    let value = value.trim();
    let ok = Regex::new(r"^[-\w.()]{1,90}$").unwrap();
    if ok.is_match(value) && !value.starts_with('-') {
        Ok(value.to_string())
    } else {
        Err(format!("\"{value}\" is not a resource group"))
    }
}

fn check_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    let ok = Regex::new(r"(?i)^/subscriptions/[^/\s]+/resourcegroups/[^/\s]+/providers/[^\s]+$").unwrap();
    if ok.is_match(value) {
        Ok(value.to_string())
    } else {
        Err(format!("\"{value}\" is not an Azure resource id"))
    }
}

/// The parts of a resource id: subscription, group, type (`Microsoft.Web/sites`), name.
pub fn parse_id(id: &str) -> Option<(String, String, String, String)> {
    let parts: Vec<&str> = id.trim_matches('/').split('/').collect();
    if parts.len() < 8 || !parts[0].eq_ignore_ascii_case("subscriptions") || !parts[2].eq_ignore_ascii_case("resourcegroups") || !parts[4].eq_ignore_ascii_case("providers") {
        return None;
    }
    let mut kind = parts[5].to_string();
    let mut name = String::new();
    let mut at = 6;
    while at + 1 < parts.len() {
        kind.push('/');
        kind.push_str(parts[at]);
        name = parts[at + 1].to_string();
        at += 2;
    }
    Some((parts[1].to_string(), parts[3].to_string(), kind, name))
}

// ---------------------------------------------------------------------------------- listing

pub async fn subscriptions() -> cloud::CloudContexts {
    cloud::contexts(Provider::Azure).await
}

pub async fn groups(subscription: &str) -> Result<Vec<cloud::CloudScope>, String> {
    cloud::scopes(Provider::Azure, &check_word(subscription, "subscription")?).await
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AzResource {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    /// The resource's own `kind` (`functionapp,linux`, `StorageV2`).
    pub flavor: String,
    pub location: String,
    pub group: String,
    pub sku: String,
    /// `provisioningState`.
    pub state: String,
    pub tags: BTreeMap<String, String>,
}

pub fn parse_resources(value: &Value) -> Vec<AzResource> {
    let mut out: Vec<AzResource> = value
        .as_array()
        .into_iter()
        .flatten()
        .map(|r| AzResource {
            id: s(r, "/id"),
            name: s(r, "/name"),
            kind: s(r, "/type"),
            flavor: s(r, "/kind"),
            location: s(r, "/location"),
            group: s(r, "/resourceGroup"),
            sku: [s(r, "/sku/name"), s(r, "/sku/tier")].into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" "),
            state: { let p = s(r, "/provisioningState"); if p.is_empty() { s(r, "/properties/provisioningState") } else { p } },
            tags: r.get("tags").and_then(Value::as_object).map(|m| m.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string())).collect()).unwrap_or_default(),
        })
        .filter(|r| !r.id.is_empty())
        .collect();
    out.sort_by(|a, b| (a.kind.to_lowercase(), a.name.to_lowercase()).cmp(&(b.kind.to_lowercase(), b.name.to_lowercase())));
    out
}

pub async fn resources(subscription: &str, group: Option<&str>) -> Result<Vec<AzResource>, String> {
    let mut args = strings(&["resource", "list", "--subscription"]);
    args.push(check_word(subscription, "subscription")?);
    if let Some(group) = group.filter(|g| !g.trim().is_empty()) {
        args.extend(["-g".into(), check_group(group)?]);
    }
    args.extend(strings(&["-o", "json"]));
    let mut value = az_json(&args).await?;
    cloud::sanitize(&mut value);
    Ok(parse_resources(&value))
}

/// One resource in full, its secret-shaped fields dropped.
pub async fn show(id: &str) -> Result<Value, String> {
    let id = check_id(id)?;
    let mut value = az_json(&["resource".into(), "show".into(), "--ids".into(), id, "-o".into(), "json".into()]).await?;
    cloud::sanitize(&mut value);
    Ok(value)
}

// ----------------------------------------------------------------------------------- health

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AzHealth {
    /// The resource's id (the status's own suffix taken off).
    pub id: String,
    /// `Available`, `Degraded`, `Unavailable`, `Unknown`.
    pub state: String,
    pub summary: String,
    pub reason: String,
    pub since: String,
}

pub fn parse_health(value: &Value) -> Vec<AzHealth> {
    value
        .get("value")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|h| {
            let id = s(h, "/id");
            let lower = id.to_lowercase();
            let id = match lower.find("/providers/microsoft.resourcehealth/") {
                Some(at) => id[..at].to_string(),
                None => id,
            };
            AzHealth {
                id,
                state: s(h, "/properties/availabilityState"),
                summary: s(h, "/properties/summary"),
                reason: s(h, "/properties/reasonType"),
                since: { let t = s(h, "/properties/occurredTime"); if t.is_empty() { s(h, "/properties/occuredTime") } else { t } },
            }
        })
        .filter(|h| !h.id.is_empty())
        .collect()
}

/// Resource Health for a subscription or one group — what Azure itself says about each resource.
pub async fn health(subscription: &str, group: Option<&str>) -> Result<Vec<AzHealth>, String> {
    let subscription = check_word(subscription, "subscription")?;
    let scope = match group.filter(|g| !g.trim().is_empty()) {
        Some(group) => format!("/subscriptions/{subscription}/resourceGroups/{}", check_group(group)?),
        None => format!("/subscriptions/{subscription}"),
    };
    let mut url = format!("{ARM}{scope}/providers/Microsoft.ResourceHealth/availabilityStatuses?api-version=2022-10-01");
    let mut out = Vec::new();
    for _ in 0..8 {
        let page = az_json(&["rest".into(), "--method".into(), "get".into(), "--url".into(), url.clone(), "-o".into(), "json".into()]).await?;
        out.extend(parse_health(&page));
        // Only a page of the same API: the host is ARM's, whatever the answer says.
        match page.get("nextLink").and_then(Value::as_str) {
            Some(next) if next.starts_with(&format!("{ARM}/")) => url = next.to_string(),
            _ => break,
        }
    }
    Ok(out)
}

// --------------------------------------------------------------------------------- activity

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AzActivity {
    pub time: String,
    pub operation: String,
    pub status: String,
    pub level: String,
    pub caller: String,
    pub resource: String,
    pub message: String,
}

pub fn parse_activity(value: &Value) -> Vec<AzActivity> {
    let mut out: Vec<AzActivity> = value
        .as_array()
        .into_iter()
        .flatten()
        .map(|e| {
            let op = s(e, "/operationName/localizedValue");
            let status = s(e, "/status/localizedValue");
            let sub = s(e, "/subStatus/localizedValue");
            let message = [s(e, "/properties/statusMessage"), s(e, "/description")].into_iter().find(|m| !m.is_empty()).unwrap_or_default();
            AzActivity {
                time: s(e, "/eventTimestamp"),
                operation: if op.is_empty() { s(e, "/operationName/value") } else { op },
                status: if sub.is_empty() { status } else { format!("{status} · {sub}") },
                level: s(e, "/level"),
                caller: s(e, "/caller"),
                resource: s(e, "/resourceId"),
                message: crate::secret_scan::redact(&message.chars().take(1500).collect::<String>()).0,
            }
        })
        .collect();
    out.sort_by(|a, b| b.time.cmp(&a.time));
    out
}

/// The activity log — who changed or started what, and what failed — for a resource, a group or the
/// whole subscription, over the last `hours` (at most 90 days, as Azure keeps).
pub async fn activity(subscription: &str, group: Option<&str>, resource: Option<&str>, hours: u32) -> Result<Vec<AzActivity>, String> {
    let mut args = strings(&["monitor", "activity-log", "list", "--subscription"]);
    args.push(check_word(subscription, "subscription")?);
    if let Some(id) = resource.filter(|r| !r.trim().is_empty()) {
        args.extend(["--resource-id".into(), check_id(id)?]);
    } else if let Some(group) = group.filter(|g| !g.trim().is_empty()) {
        args.extend(["-g".into(), check_group(group)?]);
    }
    args.extend(["--offset".into(), format!("{}h", hours.clamp(1, 90 * 24)), "--max-events".into(), "300".into(), "-o".into(), "json".into()]);
    let mut value = az_json(&args).await?;
    cloud::sanitize(&mut value);
    Ok(parse_activity(&value))
}

// ------------------------------------------------------------------------------------- logs

/// How a resource's own logs are read, by its type: `stream` can be followed, `once` is read whole.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LogSource {
    /// App Service and Functions: `az webapp log tail` (a stream only).
    WebApp,
    /// Container Apps: `az containerapp logs show`.
    ContainerApp,
    /// Container Instances: `az container logs`.
    ContainerGroup,
    /// AKS: its pods, in the Kubernetes pages.
    Cluster,
}

pub fn log_source(kind: &str) -> Option<LogSource> {
    match kind.to_lowercase().as_str() {
        "microsoft.web/sites" | "microsoft.web/sites/slots" => Some(LogSource::WebApp),
        "microsoft.app/containerapps" => Some(LogSource::ContainerApp),
        "microsoft.containerinstance/containergroups" => Some(LogSource::ContainerGroup),
        "microsoft.containerservice/managedclusters" => Some(LogSource::Cluster),
        _ => None,
    }
}

/// The command that shows a resource's logs — following them (`follow`, the panel's terminal) or
/// once (`tail` lines).
pub fn log_command(id: &str, follow: bool, tail: u32) -> Result<(String, Vec<String>), String> {
    let id = check_id(id)?;
    let (subscription, group, kind, name) = parse_id(&id).ok_or("not a resource id")?;
    let base = |parts: &[&str]| {
        let mut args = strings(parts);
        args.extend(["-n".into(), name.clone(), "-g".into(), group.clone(), "--subscription".into(), subscription.clone()]);
        args
    };
    let tail = tail.clamp(1, 1000).to_string();
    let args = match log_source(&kind) {
        Some(LogSource::WebApp) => base(&["webapp", "log", "tail"]),
        Some(LogSource::ContainerApp) => {
            let mut args = base(&["containerapp", "logs", "show"]);
            args.extend(["--tail".into(), tail, "--format".into(), "text".into()]);
            if follow {
                args.push("--follow".into());
            }
            args
        }
        Some(LogSource::ContainerGroup) => {
            let mut args = base(&["container", "logs"]);
            if follow {
                args.push("--follow".into());
            }
            args
        }
        Some(LogSource::Cluster) => return Err("an AKS cluster's logs are its pods': open it in the Kubernetes pages".into()),
        None => return Err(format!("{kind} has no log stream of its own here — query its Log Analytics workspace instead")),
    };
    Ok((program()?, args))
}

/// The logs, read once: a stream (App Service) is listened to for a few seconds. Redacted.
pub async fn logs(id: &str, tail: u32) -> Result<String, String> {
    let (program, args) = log_command(id, false, tail)?;
    let kind = parse_id(id).map(|p| p.2).unwrap_or_default();
    let text = if log_source(&kind) == Some(LogSource::WebApp) {
        listen(&program, &args, TAIL_LISTEN).await?
    } else {
        az_with(&args, TIMEOUT).await?
    };
    let lines: Vec<&str> = text.lines().collect();
    let keep = tail.clamp(1, 1000) as usize;
    let text = lines[lines.len().saturating_sub(keep)..].join("\n");
    Ok(crate::secret_scan::redact(&text).0)
}

/// What a command that never ends prints in `window`, then it is stopped (its whole tree).
async fn listen(program: &str, args: &[String], window: Duration) -> Result<String, String> {
    let mut cmd = crate::proc::command(program);
    cmd.args(args)
        .env("PATH", cli::search_path())
        .envs(quiet_env())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    crate::proc::own_process_group(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("could not start az: {e}"))?;
    let (mut stdout, mut stderr) = (child.stdout.take(), child.stderr.take());
    let mut out = Vec::new();
    let mut err = Vec::new();
    let _ = tokio::time::timeout(window, async {
        let read_out = async {
            if let Some(pipe) = stdout.as_mut() {
                let _ = pipe.read_to_end(&mut out).await;
            }
        };
        let read_err = async {
            if let Some(pipe) = stderr.as_mut() {
                let _ = pipe.read_to_end(&mut err).await;
            }
        };
        tokio::join!(read_out, read_err);
    })
    .await;
    let finished = child.try_wait().ok().flatten();
    if finished.is_none() {
        crate::ai_runs::kill_tree(&mut child).await;
    }
    let text = String::from_utf8_lossy(&out).into_owned();
    if text.trim().is_empty() {
        let complaint = String::from_utf8_lossy(&err).lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or_default().to_string();
        if finished.is_some_and(|status| !status.success()) || !complaint.is_empty() {
            return Err(crate::secret_scan::redact(complaint.trim_start_matches("ERROR:").trim()).0);
        }
        return Ok(format!("(nothing in {} s)", window.as_secs()));
    }
    Ok(text)
}

// ------------------------------------------------------------------------------ log analytics

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AzWorkspace {
    pub id: String,
    pub name: String,
    pub group: String,
    /// The workspace's GUID, which a query is aimed at.
    pub customer_id: String,
    pub location: String,
}

pub async fn workspaces(subscription: &str) -> Result<Vec<AzWorkspace>, String> {
    let mut args = strings(&["monitor", "log-analytics", "workspace", "list", "--subscription"]);
    args.push(check_word(subscription, "subscription")?);
    args.extend(strings(&["-o", "json"]));
    let value = az_json(&args).await?;
    let mut out: Vec<AzWorkspace> = value
        .as_array()
        .into_iter()
        .flatten()
        .map(|w| AzWorkspace { id: s(w, "/id"), name: s(w, "/name"), group: s(w, "/resourceGroup"), customer_id: s(w, "/customerId"), location: s(w, "/location") })
        .filter(|w| !w.customer_id.is_empty())
        .collect();
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AzQueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    /// More rows came back than are kept.
    pub cut: bool,
}

const MAX_ROWS: usize = 1000;

/// KQL only reads; a line starting with `.` is a management command, which this never sends.
pub fn check_kql(query: &str) -> Result<String, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("the query is empty".into());
    }
    if query.lines().any(|l| l.trim_start().starts_with('.')) {
        return Err("management commands (lines starting with '.') are not run here — only queries".into());
    }
    if query.chars().any(|c| c.is_control() && c != '\n' && c != '\r' && c != '\t') {
        return Err("the query has control characters".into());
    }
    Ok(query.to_string())
}

pub fn parse_query(value: &Value) -> AzQueryResult {
    let rows = value.as_array().cloned().unwrap_or_default();
    let mut columns: Vec<String> = Vec::new();
    for row in &rows {
        if let Some(map) = row.as_object() {
            for key in map.keys() {
                if key != "TableName" && !columns.contains(key) {
                    columns.push(key.clone());
                }
            }
        }
    }
    let cut = rows.len() > MAX_ROWS;
    let rows = rows
        .iter()
        .take(MAX_ROWS)
        .map(|row| {
            columns
                .iter()
                .map(|c| match row.get(c) {
                    Some(Value::String(text)) => Value::String(crate::secret_scan::redact(text).0),
                    Some(other) => other.clone(),
                    None => Value::Null,
                })
                .collect()
        })
        .collect();
    AzQueryResult { columns, rows, cut }
}

/// A Log Analytics query against a workspace (its GUID), over the last `hours`.
pub async fn query(workspace: &str, kql: &str, hours: u32) -> Result<AzQueryResult, String> {
    let workspace = workspace.trim();
    if !Regex::new(r"^[0-9a-fA-F-]{36}$").unwrap().is_match(workspace) {
        return Err(format!("\"{workspace}\" is not a workspace id (its GUID)"));
    }
    let kql = check_kql(kql)?;
    let args = vec![
        "monitor".into(),
        "log-analytics".into(),
        "query".into(),
        "-w".into(),
        workspace.to_string(),
        "--analytics-query".into(),
        kql,
        "--timespan".into(),
        format!("PT{}H", hours.clamp(1, 24 * 30)),
        "-o".into(),
        "json".into(),
    ];
    let out = az_with(&args, QUERY_TIMEOUT).await?;
    let value: Value = serde_json::from_str(out.trim()).map_err(|e| format!("az: {e}"))?;
    Ok(parse_query(&value))
}

pub fn query_text(result: &AzQueryResult) -> String {
    let mut out = result.columns.join(" | ");
    out.push('\n');
    for row in result.rows.iter().take(300) {
        let cells: Vec<String> = row.iter().map(|v| match v { Value::String(t) => t.replace('\n', " "), Value::Null => String::new(), other => other.to_string() }).collect();
        out.push_str(&cells.join(" | "));
        out.push('\n');
    }
    if result.rows.len() > 300 || result.cut {
        out.push_str("[… more rows not shown]\n");
    }
    out
}

// -------------------------------------------------------------------------------- connections

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AzNode {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub flavor: String,
    pub group: String,
    pub location: String,
    pub state: String,
    /// Outside what was read (another group, another subscription): known only by its id.
    pub external: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct AzEdge {
    pub from: String,
    pub to: String,
    /// `ref` (an id in the properties), `host` (a hostname of another resource), `setting` (an app
    /// setting or environment variable names it), `vault` (a Key Vault reference).
    pub kind: String,
    /// The property or setting's name — never its value.
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AzTopology {
    pub nodes: Vec<AzNode>,
    pub edges: Vec<AzEdge>,
    pub warnings: Vec<String>,
}

/// A resource as read in full: its card fields, and its raw properties (never sent anywhere).
pub struct Raw {
    pub resource: AzResource,
    pub properties: Value,
    /// App settings and connection strings, `name → value` — values used to match, then dropped.
    pub settings: Vec<(String, String)>,
}

/// Host names a resource answers on, from its raw properties.
fn hosts_of(properties: &Value) -> Vec<String> {
    const KEYS: &[&str] = &[
        "defaultHostName",
        "hostNames",
        "enabledHostNames",
        "fqdn",
        "fullyQualifiedDomainName",
        "vaultUri",
        "loginServer",
        "hostName",
        "documentEndpoint",
        "serviceBusEndpoint",
        "primaryEndpoints",
        "endpoint",
        "dnsSettings",
        "latestRevisionFqdn",
    ];
    let host = Regex::new(r"(?i)(?:https?://)?([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+)").unwrap();
    let mut out = Vec::new();
    fn strings_in(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::String(text) => out.push(text.clone()),
            Value::Array(list) => list.iter().for_each(|v| strings_in(v, out)),
            Value::Object(map) => map.values().for_each(|v| strings_in(v, out)),
            _ => {}
        }
    }
    fn walk(value: &Value, keys: &[&str], found: &mut Vec<String>) {
        match value {
            Value::Object(map) => {
                for (k, v) in map {
                    if keys.iter().any(|want| want.eq_ignore_ascii_case(k)) {
                        strings_in(v, found);
                    } else {
                        walk(v, keys, found);
                    }
                }
            }
            Value::Array(list) => list.iter().for_each(|v| walk(v, keys, found)),
            _ => {}
        }
    }
    let mut found = Vec::new();
    walk(properties, KEYS, &mut found);
    for text in found {
        if let Some(m) = host.captures(&text).and_then(|c| c.get(1)) {
            let h = m.as_str().to_lowercase();
            // Shared names (`azurewebsites.net` alone, a bare IP) say nothing about one resource.
            if h.split('.').count() >= 3 && !h.chars().all(|c| c.is_ascii_digit() || c == '.') {
                out.push(h);
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

/// Every string in `value` with the name it goes by: the key it sits under (`serverFarmId`, a
/// parent's for an `id`), or for a `{name, value}` pair — an environment variable — its name.
fn labelled_strings(value: &Value) -> Vec<(String, String)> {
    fn walk(value: &Value, label: &str, out: &mut Vec<(String, String)>) {
        match value {
            Value::String(text) => out.push((label.to_string(), text.clone())),
            Value::Array(list) => list.iter().for_each(|v| walk(v, label, out)),
            Value::Object(map) => {
                let pair_name = map.get("name").and_then(Value::as_str).filter(|_| map.contains_key("value") || map.contains_key("secretRef"));
                for (k, v) in map {
                    let next = if let (Some(name), "value" | "secretRef") = (pair_name, k.as_str()) {
                        name.to_string()
                    } else if matches!(k.as_str(), "id" | "value" | "resourceId") && !label.is_empty() {
                        label.to_string()
                    } else {
                        k.clone()
                    };
                    walk(v, &next, out);
                }
            }
            _ => {}
        }
    }
    let mut out = Vec::new();
    walk(value, "", &mut out);
    out
}

/// The connections between resources — found, never guessed: ids in properties, host names of one
/// resource in another's settings, Key Vault references.
pub fn connect(raws: &[Raw]) -> AzTopology {
    let arm_id = Regex::new(r"(?i)/subscriptions/[0-9a-z-]+/resourcegroups/[^/\x22\s]+/providers/[^\x22\s?,;)]+").unwrap();
    let host = Regex::new(r"(?i)[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+){2,}").unwrap();
    let vault_ref = Regex::new(r"(?i)@Microsoft\.KeyVault\(\s*(?:VaultName=([^;)\s]+)|SecretUri=https://([^./]+)\.vault\.azure\.net)").unwrap();
    let mut topo = AzTopology::default();
    let known: Vec<(String, &AzResource)> = raws.iter().map(|r| (r.resource.id.to_lowercase(), &r.resource)).collect();
    let mut by_host: HashMap<String, String> = HashMap::new();
    for raw in raws {
        for h in hosts_of(&raw.properties) {
            by_host.entry(h).or_insert_with(|| raw.resource.id.clone());
        }
    }
    let vaults: HashMap<String, String> = raws.iter().filter(|r| r.resource.kind.eq_ignore_ascii_case("microsoft.keyvault/vaults")).map(|r| (r.resource.name.to_lowercase(), r.resource.id.clone())).collect();
    let mut external: BTreeMap<String, AzNode> = BTreeMap::new();
    // The resource an id is part of: the longest known id it starts with, at a segment boundary.
    let owner = |found: &str| -> Option<String> {
        let lower = found.to_lowercase().trim_end_matches('/').to_string();
        known
            .iter()
            .filter(|(id, _)| lower == *id || lower.starts_with(&format!("{id}/")))
            .max_by_key(|(id, _)| id.len())
            .map(|(_, r)| r.id.clone())
    };
    let mut edges: BTreeSet<AzEdge> = BTreeSet::new();
    for raw in raws {
        let from = &raw.resource.id;
        let mut add = |to: String, kind: &str, label: &str| {
            if !to.eq_ignore_ascii_case(from) {
                edges.insert(AzEdge { from: from.clone(), to, kind: kind.into(), label: label.to_string() });
            }
        };
        let mut strings = labelled_strings(&raw.properties);
        strings.extend(raw.settings.iter().map(|(name, value)| (format!("setting:{name}"), value.clone())));
        for (label, text) in &strings {
            let (kind, label) = match label.strip_prefix("setting:") {
                Some(name) => ("setting", name),
                None => ("ref", label.as_str()),
            };
            for m in arm_id.find_iter(text) {
                match owner(m.as_str()) {
                    Some(to) => add(to, kind, label),
                    None => {
                        // Outside what was read: a node of its own, named by its id — the top resource
                        // of it, not a subnet or a child.
                        if let Some((_, group, type_, _)) = parse_id(m.as_str()) {
                            let parts: Vec<&str> = m.as_str().trim_matches('/').split('/').collect();
                            if parts.len() >= 8 {
                                let top = format!("/{}", parts[..8].join("/"));
                                let top_type = format!("{}/{}", parts[5], parts[6]);
                                let _ = type_;
                                external.entry(top.to_lowercase()).or_insert_with(|| AzNode {
                                    id: top.clone(),
                                    name: parts[7].to_string(),
                                    kind: top_type,
                                    flavor: String::new(),
                                    group,
                                    location: String::new(),
                                    state: String::new(),
                                    external: true,
                                });
                                let id = external[&top.to_lowercase()].id.clone();
                                add(id, kind, label);
                            }
                        }
                    }
                }
            }
            for m in host.find_iter(text) {
                if let Some(to) = by_host.get(&m.as_str().to_lowercase()) {
                    add(to.clone(), if kind == "setting" { "setting" } else { "host" }, label);
                }
            }
            for c in vault_ref.captures_iter(text) {
                let name = c.get(1).or_else(|| c.get(2)).map(|m| m.as_str().to_lowercase()).unwrap_or_default();
                if let Some(to) = vaults.get(&name) {
                    add(to.clone(), "vault", label);
                }
            }
        }
    }
    // One edge per pair and kind, labels joined: a web app naming its database in three settings is
    // one line on the map.
    let mut merged: BTreeMap<(String, String, String), BTreeSet<String>> = BTreeMap::new();
    for edge in edges {
        merged.entry((edge.from, edge.to, edge.kind)).or_default().insert(edge.label);
    }
    topo.edges = merged
        .into_iter()
        .map(|((from, to, kind), labels)| AzEdge { from, to, kind, label: labels.into_iter().filter(|l| !l.is_empty()).take(4).collect::<Vec<_>>().join(", ") })
        .collect();
    topo.nodes = raws
        .iter()
        .map(|r| AzNode {
            id: r.resource.id.clone(),
            name: r.resource.name.clone(),
            kind: r.resource.kind.clone(),
            flavor: r.resource.flavor.clone(),
            group: r.resource.group.clone(),
            location: r.resource.location.clone(),
            state: r.resource.state.clone(),
            external: false,
        })
        .chain(external.into_values())
        .collect();
    topo
}

/// Reads every resource of the scope in full — Resource Graph, one call; `az resource show` in
/// chunks when Resource Graph does not answer — plus the app settings of the web apps among them.
pub async fn read_raw(subscription: &str, group: Option<&str>) -> Result<(Vec<Raw>, Vec<String>), String> {
    let subscription = check_word(subscription, "subscription")?;
    let group = match group.filter(|g| !g.trim().is_empty()) {
        Some(g) => Some(check_group(g)?),
        None => None,
    };
    let mut warnings = Vec::new();
    let mut raws: Vec<Raw> = match graph(&subscription, group.as_deref()).await {
        Ok(raws) => raws,
        Err(error) => {
            warnings.push(format!("Resource Graph: {error}"));
            shown(&subscription, group.as_deref(), &mut warnings).await?
        }
    };
    if raws.len() > MAX_GRAPH {
        warnings.push(format!("{} resources; the first {MAX_GRAPH} are mapped — pick a group", raws.len()));
        raws.truncate(MAX_GRAPH);
    }
    let sites: Vec<usize> = raws.iter().enumerate().filter(|(_, r)| r.resource.kind.eq_ignore_ascii_case("microsoft.web/sites")).map(|(i, _)| i).take(MAX_SETTINGS).collect();
    let settings = futures_util::future::join_all(sites.iter().map(|&i| {
        let id = raws[i].resource.id.clone();
        async move { (i, site_settings(&id).await) }
    }))
    .await;
    for (i, found) in settings {
        match found {
            Ok(list) => raws[i].settings = list,
            Err(error) => warnings.push(format!("{}: {error}", raws[i].resource.name)),
        }
    }
    Ok((raws, warnings))
}

async fn graph(subscription: &str, group: Option<&str>) -> Result<Vec<Raw>, String> {
    let mut kql = String::from("Resources");
    if let Some(group) = group {
        kql.push_str(&format!(" | where resourceGroup =~ '{group}'"));
    }
    kql.push_str(" | project id, name, type, kind, location, resourceGroup, sku, tags, properties");
    let body = json!({"subscriptions": [subscription], "query": kql, "options": {"$top": 1000, "resultFormat": "objectArray"}});
    // The body goes in a file: on Windows `az` is a batch file, which mangles JSON in an argument.
    let file = std::env::temp_dir().join(format!("codeflow-arg-{}.json", uuid::Uuid::new_v4().simple()));
    std::fs::write(&file, body.to_string()).map_err(|e| e.to_string())?;
    let answer = az_json(&[
        "rest".into(),
        "--method".into(),
        "post".into(),
        "--url".into(),
        format!("{ARM}/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01"),
        "--body".into(),
        format!("@{}", file.to_string_lossy()),
        "-o".into(),
        "json".into(),
    ])
    .await;
    let _ = std::fs::remove_file(&file);
    let answer = answer?;
    let items = answer.get("data").cloned().unwrap_or(Value::Null);
    Ok(raws_of(&items))
}

fn raws_of(items: &Value) -> Vec<Raw> {
    items
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let mut card = item.clone();
            cloud::sanitize(&mut card);
            let resource = parse_resources(&Value::Array(vec![card])).pop()?;
            Some(Raw { resource, properties: item.get("properties").cloned().unwrap_or(Value::Null), settings: vec![] })
        })
        .collect()
}

async fn shown(subscription: &str, group: Option<&str>, warnings: &mut Vec<String>) -> Result<Vec<Raw>, String> {
    let list = resources(subscription, group).await?;
    let mut raws = Vec::new();
    for chunk in list.iter().take(MAX_GRAPH).collect::<Vec<_>>().chunks(20) {
        let mut args = strings(&["resource", "show", "-o", "json", "--ids"]);
        args.extend(chunk.iter().map(|r| r.id.clone()));
        match az_json(&args).await {
            Ok(Value::Array(items)) => raws.extend(raws_of(&Value::Array(items))),
            Ok(one @ Value::Object(_)) => raws.extend(raws_of(&Value::Array(vec![one]))),
            Ok(_) => {}
            Err(error) => {
                warnings.push(error);
                raws.extend(chunk.iter().map(|r| Raw { resource: (*r).clone(), properties: Value::Null, settings: vec![] }));
            }
        }
    }
    Ok(raws)
}

/// A web app's settings and connection strings — read only to find what they point at.
async fn site_settings(id: &str) -> Result<Vec<(String, String)>, String> {
    let mut out = Vec::new();
    let settings = az_json(&["webapp".into(), "config".into(), "appsettings".into(), "list".into(), "--ids".into(), id.to_string(), "-o".into(), "json".into()]).await?;
    for entry in settings.as_array().into_iter().flatten() {
        out.push((s(entry, "/name"), s(entry, "/value")));
    }
    if let Ok(strings) = az_json(&["webapp".into(), "config".into(), "connection-string".into(), "list".into(), "--ids".into(), id.to_string(), "-o".into(), "json".into()]).await {
        for entry in strings.as_array().into_iter().flatten() {
            out.push((s(entry, "/name"), s(entry, "/value/value")));
        }
    }
    Ok(out)
}

pub async fn topology(subscription: &str, group: Option<&str>) -> Result<AzTopology, String> {
    let (raws, warnings) = read_raw(subscription, group).await?;
    let mut topo = connect(&raws);
    topo.warnings = warnings;
    Ok(topo)
}

/// The map as lines for a model, with each resource's health when it is known.
pub fn topology_text(topo: &AzTopology, health: &[AzHealth]) -> String {
    let state_of: HashMap<String, &AzHealth> = health.iter().map(|h| (h.id.to_lowercase(), h)).collect();
    let name_of: HashMap<&str, String> = topo.nodes.iter().map(|n| (n.id.as_str(), format!("{} ({})", n.name, n.kind))).collect();
    let mut out = String::new();
    for warning in &topo.warnings {
        out.push_str(&format!("Note: {warning}\n"));
    }
    out.push_str(&format!("{} resources, {} connections\n", topo.nodes.len(), topo.edges.len()));
    for node in &topo.nodes {
        let mut state = node.state.clone();
        if let Some(h) = state_of.get(&node.id.to_lowercase()) {
            state = [state, format!("health {}", h.state), h.summary.clone()].into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" · ");
        }
        out.push_str(&format!("- {} ({}) group {}{}{}\n", node.name, node.kind, node.group, if state.is_empty() { String::new() } else { format!(" [{state}]") }, if node.external { " (outside this scope)" } else { "" }));
        for edge in topo.edges.iter().filter(|e| e.from == node.id) {
            out.push_str(&format!("    {} → {}{}\n", edge.kind, name_of.get(edge.to.as_str()).cloned().unwrap_or_else(|| edge.to.clone()), if edge.label.is_empty() { String::new() } else { format!(" via {}", edge.label) }));
        }
    }
    crate::secret_scan::redact(&out).0
}

pub fn resources_text(list: &[AzResource], health: &[AzHealth]) -> String {
    let state_of: HashMap<String, &AzHealth> = health.iter().map(|h| (h.id.to_lowercase(), h)).collect();
    let mut out = format!("{} resources (name | type | group | location | provisioning | health):\n", list.len());
    for r in list.iter().take(600) {
        let h = state_of.get(&r.id.to_lowercase()).map(|h| if h.summary.is_empty() { h.state.clone() } else { format!("{} — {}", h.state, h.summary) }).unwrap_or_default();
        out.push_str(&format!("- {} | {}{} | {} | {} | {} | {}\n", r.name, r.kind, if r.flavor.is_empty() { String::new() } else { format!(" ({})", r.flavor) }, r.group, r.location, r.state, h));
    }
    if list.len() > 600 {
        out.push_str(&format!("[… {} more]\n", list.len() - 600));
    }
    crate::secret_scan::redact(&out).0
}

pub fn activity_text(list: &[AzActivity]) -> String {
    let mut out = String::new();
    for e in list.iter().take(150) {
        let resource = parse_id(&e.resource).map(|p| p.3).unwrap_or_else(|| e.resource.clone());
        out.push_str(&format!("- {} {} [{}] {} by {}{}\n", e.time, e.operation, e.status, resource, e.caller, if e.message.is_empty() { String::new() } else { format!(" — {}", e.message.replace('\n', " ")) }));
    }
    if out.is_empty() {
        out.push_str("No activity in that window.\n");
    }
    out
}

// ------------------------------------------------------------------------------------ metrics

/// The metrics most worth a first look, by the names Azure gives them across services — App
/// Service and Functions, Container Apps, AKS, SQL, Storage, Service Bus, Redis, Cosmos DB, VMs,
/// Application Insights. Whichever a resource publishes are read, in this order; a resource that
/// publishes none of them gets its first few.
const PREFERRED_METRICS: &[&str] = &[
    "CpuPercentage", "CpuTime", "MemoryPercentage", "MemoryWorkingSet", "Requests", "Http5xx", "Http4xx", "HttpResponseTime", "AverageResponseTime",
    "UsageNanoCores", "WorkingSetBytes", "RestartCount", "Replicas",
    "node_cpu_usage_percentage", "node_memory_working_set_percentage", "kube_pod_status_ready",
    "cpu_percent", "dtu_consumption_percent", "storage_percent", "connection_failed", "deadlock", "workers_percent",
    "Transactions", "Availability", "SuccessE2ELatency", "UsedCapacity",
    "ActiveMessages", "DeadletteredMessages", "IncomingMessages", "ServerErrors", "UserErrors", "ThrottledRequests",
    "percentProcessorTime", "usedmemorypercentage", "errors", "connectedclients",
    "TotalRequests", "NormalizedRUConsumption", "ServerSideLatency",
    "Percentage CPU", "Available Memory Bytes", "Network In Total", "Network Out Total",
    "requests/failed", "requests/duration", "exceptions/count", "dependencies/failed",
];
const MAX_METRICS: usize = 8;

/// Which metrics to read from `az monitor metrics list-definitions`: the preferred ones it has, else
/// its first few.
pub fn pick_metrics(definitions: &Value) -> Vec<String> {
    let names: Vec<String> = definitions.as_array().map(|list| list.iter().map(|d| s(d, "/name/value")).filter(|n| !n.is_empty()).collect()).unwrap_or_default();
    let mut picked: Vec<String> = PREFERRED_METRICS
        .iter()
        .filter_map(|wanted| names.iter().find(|n| n.eq_ignore_ascii_case(wanted)).cloned())
        .take(MAX_METRICS)
        .collect();
    if picked.is_empty() {
        picked = names.into_iter().take(6).collect();
    }
    picked
}

/// `az monitor metrics list` as one line per metric: its last value, average, peak — or sum, for a
/// count — over the window, and whether it went up or down in it.
pub fn metrics_text(value: &Value, hours: u32) -> String {
    let fmt = |n: f64| if n.abs() >= 100.0 || n.fract() == 0.0 { format!("{n:.0}") } else { format!("{n:.2}") };
    let mut out = format!("Metrics over the last {hours} h:\n");
    for metric in value.get("value").and_then(Value::as_array).cloned().unwrap_or_default() {
        let name = { let localized = s(&metric, "/name/localizedValue"); if localized.is_empty() { s(&metric, "/name/value") } else { localized } };
        let unit = s(&metric, "/unit");
        let data: Vec<Value> = metric.pointer("/timeseries/0/data").and_then(Value::as_array).cloned().unwrap_or_default();
        let series = |key: &str| -> Vec<f64> { data.iter().filter_map(|p| p.get(key).and_then(Value::as_f64)).collect() };
        let (averages, maxima, totals) = (series("average"), series("maximum"), series("total"));
        let line = if !averages.is_empty() && unit != "Count" {
            let avg = averages.iter().sum::<f64>() / averages.len() as f64;
            let peak = maxima.iter().chain(averages.iter()).cloned().fold(f64::MIN, f64::max);
            let half = averages.len() / 2;
            let trend = if half == 0 {
                String::new()
            } else {
                let early = averages[..half].iter().sum::<f64>() / half as f64;
                let late = averages[half..].iter().sum::<f64>() / (averages.len() - half) as f64;
                let base = early.abs().max(1e-9);
                if (late - early) / base > 0.2 { " · rising".into() } else if (early - late) / base > 0.2 { " · falling".into() } else { " · steady".into() }
            };
            format!("last {} · avg {} · peak {}{trend}", fmt(*averages.last().unwrap()), fmt(avg), fmt(peak))
        } else if !totals.is_empty() {
            format!("total {} · peak per interval {}", fmt(totals.iter().sum()), fmt(totals.iter().cloned().fold(f64::MIN, f64::max)))
        } else {
            "no data in this window".to_string()
        };
        out.push_str(&format!("- {name}{}: {line}\n", if unit.is_empty() { String::new() } else { format!(" ({unit})") }));
    }
    out
}

/// A resource's metrics over the last `hours` — the ones named, else [`pick_metrics`]'s choice.
pub async fn metrics(id: &str, wanted: &[String], hours: u32) -> Result<String, String> {
    let id = check_id(id)?;
    let names: Vec<String> = if wanted.is_empty() {
        let mut args = strings(&["monitor", "metrics", "list-definitions", "--resource"]);
        args.extend([id.clone(), "-o".into(), "json".into()]);
        pick_metrics(&az_json(&args).await?)
    } else {
        wanted.iter().map(|w| check_word(w, "metric name")).collect::<Result<_, _>>()?
    };
    if names.is_empty() {
        return Ok("This resource publishes no metrics.".to_string());
    }
    let hours = hours.clamp(1, 24 * 30);
    let interval = if hours <= 6 { "PT5M" } else if hours <= 72 { "PT1H" } else { "P1D" };
    let mut args = strings(&["monitor", "metrics", "list", "--resource"]);
    args.push(id);
    args.push("--metrics".into());
    args.extend(names);
    args.extend(["--interval".into(), interval.into(), "--offset".into(), format!("{}d{}h", hours / 24, hours % 24)]);
    args.extend(strings(&["--aggregation", "Average", "Maximum", "Total", "-o", "json"]));
    Ok(metrics_text(&az_json(&args).await?, hours))
}

#[cfg(test)]
mod tests {
    #[test]
    fn metrics_pick_the_telling_ones_and_read_as_a_line_each() {
        let definitions = serde_json::json!([{"name": {"value": "BytesSent"}}, {"name": {"value": "Requests"}}, {"name": {"value": "CpuPercentage"}}]);
        assert_eq!(super::pick_metrics(&definitions), vec!["CpuPercentage", "Requests"]);
        let unknown = serde_json::json!([{"name": {"value": "A"}}, {"name": {"value": "B"}}]);
        assert_eq!(super::pick_metrics(&unknown), vec!["A", "B"], "none preferred: its first few");
        let value = serde_json::json!({"value": [
            {"name": {"value": "CpuPercentage", "localizedValue": "CPU Percentage"}, "unit": "Percent", "timeseries": [{"data": [
                {"average": 10.0, "maximum": 12.0}, {"average": 10.0, "maximum": 11.0}, {"average": 40.0, "maximum": 90.0}, {"average": 50.0, "maximum": 60.0}
            ]}]},
            {"name": {"value": "Requests"}, "unit": "Count", "timeseries": [{"data": [{"total": 100.0}, {"total": 250.0}]}]},
            {"name": {"value": "Http5xx"}, "unit": "Count", "timeseries": []}
        ]});
        let text = super::metrics_text(&value, 1);
        assert!(text.contains("- CPU Percentage (Percent): last 50 · avg 27.50 · peak 90 · rising"), "{text}");
        assert!(text.contains("- Requests (Count): total 350 · peak per interval 250"), "{text}");
        assert!(text.contains("- Http5xx (Count): no data in this window"), "{text}");
    }

    use super::*;

    const SUB: &str = "00000000-0000-0000-0000-000000000001";

    fn id(group: &str, kind: &str, name: &str) -> String {
        format!("/subscriptions/{SUB}/resourceGroups/{group}/providers/{kind}/{name}")
    }

    fn raw(group: &str, kind: &str, name: &str, properties: Value) -> Raw {
        Raw {
            resource: AzResource { id: id(group, kind, name), name: name.into(), kind: kind.into(), flavor: String::new(), location: "westeurope".into(), group: group.into(), sku: String::new(), state: "Succeeded".into(), tags: BTreeMap::new() },
            properties,
            settings: vec![],
        }
    }

    #[test]
    fn ids_are_taken_apart() {
        let (sub, group, kind, name) = parse_id(&id("rg-app", "Microsoft.Network/virtualNetworks", "vnet/subnets/apps")).unwrap();
        assert_eq!((sub.as_str(), group.as_str(), kind.as_str(), name.as_str()), (SUB, "rg-app", "Microsoft.Network/virtualNetworks/subnets", "apps"));
        assert!(parse_id("/subscriptions/x").is_none());
    }

    #[test]
    fn connections_come_from_ids_hosts_settings_and_vault_references() {
        let mut web = raw(
            "rg-app",
            "Microsoft.Web/sites",
            "web",
            json!({
                "serverFarmId": id("rg-app", "Microsoft.Web/serverfarms", "plan"),
                "virtualNetworkSubnetId": id("rg-net", "Microsoft.Network/virtualNetworks", "vnet/subnets/apps"),
                "defaultHostName": "web.azurewebsites.net"
            }),
        );
        web.settings = vec![
            ("DB_HOST".into(), "sql-orders.database.windows.net".into()),
            ("API_KEY".into(), "@Microsoft.KeyVault(VaultName=kv-app;SecretName=api)".into()),
            ("SECRET_VALUE".into(), "s3cr3t-never-shown".into()),
        ];
        let sql = raw("rg-app", "Microsoft.Sql/servers", "sql-orders", json!({"fullyQualifiedDomainName": "sql-orders.database.windows.net"}));
        let vault = raw("rg-app", "Microsoft.KeyVault/vaults", "kv-app", json!({"vaultUri": "https://kv-app.vault.azure.net/"}));
        let plan = raw("rg-app", "Microsoft.Web/serverfarms", "plan", json!({}));
        let app = raw(
            "rg-app",
            "Microsoft.App/containerApps",
            "worker",
            json!({"template": {"containers": [{"env": [{"name": "API_URL", "value": "https://web.azurewebsites.net/v1"}]}]}}),
        );
        let topo = connect(&[web, sql, vault, plan, app]);
        let edge = |from: &str, to: &str| topo.edges.iter().find(|e| e.from.ends_with(&format!("/{from}")) && e.to.ends_with(&format!("/{to}"))).cloned();
        assert_eq!(edge("web", "plan").unwrap().label, "serverFarmId");
        assert_eq!(edge("web", "sql-orders").unwrap(), AzEdge { from: id("rg-app", "Microsoft.Web/sites", "web"), to: id("rg-app", "Microsoft.Sql/servers", "sql-orders"), kind: "setting".into(), label: "DB_HOST".into() });
        assert_eq!(edge("web", "kv-app").unwrap().kind, "vault");
        assert_eq!(edge("worker", "web").unwrap().label, "API_URL", "an environment variable is named by its name");
        let vnet = edge("web", "vnet").expect("a subnet outside the group points at its network");
        assert_eq!(vnet.label, "virtualNetworkSubnetId");
        assert!(topo.nodes.iter().any(|n| n.external && n.name == "vnet" && n.kind == "Microsoft.Network/virtualNetworks"));
        let all = serde_json::to_string(&topo).unwrap();
        assert!(!all.contains("s3cr3t") && !all.contains("SecretName"), "values never leave: {all}");
    }

    #[test]
    fn health_ids_are_the_resources_own() {
        let page = json!({"value": [{"id": format!("{}/providers/Microsoft.ResourceHealth/availabilityStatuses/current", id("rg", "Microsoft.Web/sites", "web")), "properties": {"availabilityState": "Degraded", "summary": "Restarting", "occurredTime": "2026-10-28T10:00:00Z"}}]});
        let found = parse_health(&page);
        assert_eq!(found[0].id, id("rg", "Microsoft.Web/sites", "web"));
        assert_eq!(found[0].state, "Degraded");
    }

    #[test]
    fn kql_only_reads() {
        assert!(check_kql("AppExceptions | take 10").is_ok());
        assert!(check_kql(".drop table AppExceptions").is_err());
        assert!(check_kql("AppTraces\n.set-or-append x <| y").is_err());
        assert!(check_kql("  ").is_err());
    }

    #[test]
    fn query_rows_follow_the_columns() {
        let result = parse_query(&json!([{"TableName": "PrimaryResult", "TimeGenerated": "t1", "Message": "boom"}, {"TableName": "PrimaryResult", "TimeGenerated": "t2", "Count": 3}]));
        assert_eq!(result.columns, vec!["TimeGenerated", "Message", "Count"]);
        assert_eq!(result.rows[1], vec![json!("t2"), Value::Null, json!(3)]);
    }

    #[test]
    fn log_commands_by_type() {
        let (_, args) = log_command(&id("rg", "Microsoft.App/containerApps", "worker"), true, 50).unwrap_or_else(|_| ("az".into(), vec![]));
        if found() {
            assert_eq!(args[..3], ["containerapp", "logs", "show"]);
            assert!(args.contains(&"--follow".to_string()));
        }
        assert!(log_command(&id("rg", "Microsoft.Storage/storageAccounts", "st"), false, 50).is_err());
        assert!(log_command("--all", false, 50).is_err());
        assert_eq!(log_source("Microsoft.Web/sites"), Some(LogSource::WebApp));
    }

    #[test]
    fn names_that_could_be_flags_are_refused() {
        assert!(check_group("-g").is_err());
        assert!(check_group("rg' | project x").is_err(), "a group never breaks out of the graph query");
        assert!(check_group("rg-app.prod_(1)").is_ok());
        assert!(check_word("--subscription", "subscription").is_err());
    }
}
