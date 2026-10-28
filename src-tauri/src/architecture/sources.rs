//! What an architecture is generated from, read into text: a repository, documents, a brief or pasted
//! text, and a cloud snapshot the app already read with the person's authorization.
//!
//! A repository is read twice over. First **facts** — what a compose file, a Kubernetes manifest, a
//! Terraform block, a Bicep resource, an OpenAPI file, an ADR, a dependency or an `.env.example` key
//! says, each with its `path:line`, extracted here without a model so a replica count is never a
//! guess and every line the model cites can be found again. Then the same orientation the skill
//! generator uses (README, map, manifests, docs), for what the facts cannot say.
//!
//! Everything is bounded and passed through `secret_scan::redact`. `.env` itself is never opened;
//! `.env.example` gives key names, never values, and a manifest gives only the fields named here —
//! never its `env` block.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use regex::Regex;
use serde::{Deserialize, Serialize};
use yaml_rust2::{Yaml, YamlLoader};

use crate::skill_builder::cut_head;

/// One thing to generate an architecture from (or to ground a lens's answer in).
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ArchSource {
    /// A repository or any folder on this machine.
    Repo { path: String },
    /// A PDF, Word, PowerPoint, Excel, OpenDocument, Markdown or text file.
    Document { path: String },
    /// The brief, or text written or pasted in place.
    Text { name: String, text: String },
    /// A cloud snapshot read beforehand, with the person's authorization — passed through as is.
    Cloud { name: String, text: String },
}

/// One fact read out of a repository file.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RepoFact {
    /// `compose`, `k8s`, `helm`, `terraform`, `bicep`, `openapi`, `adr`, `dependency` or `env`.
    pub kind: &'static str,
    pub path: String,
    /// 1-based.
    pub line: usize,
    pub title: String,
    pub detail: String,
}

/// A repository's facts, for the generation dialog to show before anything is sent anywhere.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoScan {
    pub name: String,
    pub facts: Vec<RepoFact>,
    pub counts: BTreeMap<String, usize>,
}

const MAX_FILES_READ: usize = 600;
const MAX_FILE_BYTES: u64 = 400_000;
const MAX_FACTS: usize = 800;
/// The whole repository digest.
pub const REPO_BUDGET: usize = 70_000;
const FACTS_BUDGET: usize = 28_000;
const ADR_BUDGET: usize = 16_000;
const ADR_CHARS: usize = 3_000;
const MAX_ADRS: usize = 10;
/// The system map's own share, taken whole: it is the part nothing else supplies.
const SYSTEM_BUDGET: usize = 30_000;
/// A source never gets less than this when several share one budget.
const MIN_SHARE: usize = 8_000;

// ------------------------------------------------------------------------------------- the scan

/// The repository's facts, read from disk. Blocking: call it from `spawn_blocking`.
pub fn scan_repo(root: &Path) -> Result<RepoScan, String> {
    if !root.is_dir() {
        return Err(format!("{} is not a folder", root.display()));
    }
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| root.display().to_string());
    let facts = facts_in(root, &files_of(root));
    let mut counts = BTreeMap::new();
    for fact in &facts {
        *counts.entry(fact.kind.to_string()).or_insert(0) += 1;
    }
    Ok(RepoScan { name, facts, counts })
}

fn files_of(root: &Path) -> Vec<String> {
    crate::search::list_files(&root.to_string_lossy()).unwrap_or_else(|_| crate::local_agent::tools::plain_walk(root, 20_000))
}

fn base_name(rel: &str) -> &str {
    rel.rsplit('/').next().unwrap_or(rel)
}

fn is_compose(rel: &str) -> bool {
    let name = base_name(rel).to_ascii_lowercase();
    (name.starts_with("docker-compose") || name.starts_with("compose")) && (name.ends_with(".yml") || name.ends_with(".yaml"))
}

/// The example env files — never `.env` itself, nor `.env.local` and the like.
fn is_env_example(rel: &str) -> bool {
    matches!(base_name(rel).to_ascii_lowercase().as_str(), ".env.example" | ".env.sample" | ".env.template" | ".env.dist" | "example.env" | "env.example")
}

fn is_adr(rel: &str) -> bool {
    let lower = rel.to_ascii_lowercase();
    if !lower.ends_with(".md") {
        return false;
    }
    let dir = lower.rsplit_once('/').map(|(d, _)| format!("{d}/")).unwrap_or_default();
    ["docs/adr/", "doc/adr/", "adr/", "adrs/", "docs/adrs/", "docs/decisions/", "decisions/", "docs/architecture/decisions/", "architecture/decisions/"]
        .iter()
        .any(|d| dir == *d || dir.ends_with(&format!("/{d}")))
}

fn is_dependency_manifest(rel: &str) -> bool {
    let name = base_name(rel).to_ascii_lowercase();
    matches!(name.as_str(), "package.json" | "pom.xml" | "go.mod" | "pyproject.toml" | "build.gradle" | "build.gradle.kts")
        || (name.starts_with("requirements") && name.ends_with(".txt"))
}

fn read_small(root: &Path, rel: &str) -> Option<String> {
    let path = root.join(rel);
    let meta = std::fs::metadata(&path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

fn facts_in(root: &Path, files: &[String]) -> Vec<RepoFact> {
    let mut out = Vec::new();
    let mut read = 0usize;
    let mut charts: Vec<String> = files.iter().filter(|f| base_name(f) == "Chart.yaml").map(|f| f.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default()).collect();
    charts.sort();
    for rel in files {
        if out.len() >= MAX_FACTS || read >= MAX_FILES_READ {
            break;
        }
        let lower = rel.to_ascii_lowercase();
        let name = base_name(rel).to_ascii_lowercase();
        // `.env` and its private siblings are never opened, whatever else matches.
        if name == ".env" || (name.starts_with(".env.") && !is_env_example(rel)) {
            continue;
        }
        let yaml = lower.ends_with(".yml") || lower.ends_with(".yaml");
        let wanted = is_compose(rel)
            || is_env_example(rel)
            || is_adr(rel)
            || is_dependency_manifest(rel)
            || lower.ends_with(".tf")
            || lower.ends_with(".bicep")
            || yaml
            || (lower.ends_with(".json") && (name.contains("openapi") || name.contains("swagger")));
        if !wanted {
            continue;
        }
        let Some(text) = read_small(root, rel) else { continue };
        read += 1;
        if is_compose(rel) {
            out.extend(compose_facts(rel, &text));
        } else if is_env_example(rel) {
            out.extend(env_facts(rel, &text));
        } else if is_adr(rel) {
            out.extend(adr_fact(rel, &text));
        } else if is_dependency_manifest(rel) {
            out.extend(dependency_facts(rel, &text));
        } else if lower.ends_with(".tf") {
            out.extend(terraform_facts(rel, &text));
        } else if lower.ends_with(".bicep") {
            out.extend(bicep_facts(rel, &text));
        } else if let Some(fact) = openapi_fact(rel, &text) {
            out.push(fact);
        } else if yaml {
            let dir = rel.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
            if name.starts_with("values") && charts.iter().any(|c| c == dir) {
                out.extend(helm_facts(rel, &text));
            } else {
                out.extend(k8s_facts(rel, &text));
            }
        }
    }
    out.truncate(MAX_FACTS);
    out
}

fn fact(kind: &'static str, path: &str, line: usize, title: impl Into<String>, detail: impl Into<String>) -> RepoFact {
    let clip = |s: String| if s.chars().count() > 240 { s.chars().take(240).collect::<String>() + "…" } else { s };
    RepoFact { kind, path: path.to_string(), line: line.max(1), title: clip(title.into()), detail: clip(detail.into()) }
}

fn yaml_str(y: &Yaml) -> Option<String> {
    match y {
        Yaml::String(s) => Some(s.clone()),
        Yaml::Integer(i) => Some(i.to_string()),
        Yaml::Real(r) => Some(r.clone()),
        Yaml::Boolean(b) => Some(b.to_string()),
        _ => None,
    }
}

fn yaml_list(y: &Yaml) -> Vec<String> {
    match y {
        Yaml::Array(items) => items.iter().filter_map(|i| yaml_str(i).or_else(|| i["target"].as_i64().map(|t| t.to_string()))).collect(),
        Yaml::Hash(map) => map.keys().filter_map(yaml_str).collect(),
        other => yaml_str(other).into_iter().collect(),
    }
}

/// The first line at or after `from` (0-based) that matches, as a 1-based line number.
fn line_of(text: &str, from: usize, re: &Regex) -> Option<usize> {
    text.lines().enumerate().skip(from).find(|(_, l)| re.is_match(l)).map(|(i, _)| i + 1)
}

fn compose_facts(rel: &str, text: &str) -> Vec<RepoFact> {
    let Ok(docs) = YamlLoader::load_from_str(text) else { return vec![] };
    let Some(doc) = docs.first() else { return vec![] };
    let Yaml::Hash(services) = &doc["services"] else { return vec![] };
    let services_line = text.lines().position(|l| l.trim_end() == "services:").unwrap_or(0);
    let mut out = Vec::new();
    for (key, service) in services {
        let Some(name) = yaml_str(key) else { continue };
        let re = Regex::new(&format!(r"^\s+{}:\s*$", regex::escape(&name))).unwrap();
        let line = line_of(text, services_line, &re).unwrap_or(services_line + 1);
        let mut parts = Vec::new();
        if let Some(image) = yaml_str(&service["image"]) {
            parts.push(format!("image {image}"));
        } else if !service["build"].is_badvalue() {
            parts.push("built from this repository".to_string());
        }
        let ports = yaml_list(&service["ports"]);
        if !ports.is_empty() {
            parts.push(format!("ports {}", ports.join(", ")));
        }
        let deps = yaml_list(&service["depends_on"]);
        if !deps.is_empty() {
            parts.push(format!("depends on {}", deps.join(", ")));
        }
        if let Some(replicas) = service["deploy"]["replicas"].as_i64() {
            parts.push(format!("replicas {replicas}"));
        }
        out.push(fact("compose", rel, line, format!("service {name}"), parts.join(" · ")));
    }
    out
}

const K8S_KINDS: &[&str] = &["Deployment", "StatefulSet", "DaemonSet", "Service", "Ingress", "HorizontalPodAutoscaler", "CronJob", "Job"];

fn k8s_facts(rel: &str, text: &str) -> Vec<RepoFact> {
    let kind_re = Regex::new(r"^kind:\s*([A-Za-z]+)\s*$").unwrap();
    let name_re = Regex::new(r#"^\s{2}name:\s*['"]?([^'"\s#]+)"#).unwrap();
    let num = |key: &str| Regex::new(&format!(r"^\s+{key}:\s*([0-9]+|\{{\{{.*\}}\}})")).unwrap();
    let replicas_re = num("replicas");
    let min_re = num("minReplicas");
    let max_re = num("maxReplicas");
    let image_re = Regex::new(r#"^\s+(?:-\s+)?image:\s*['"]?([^'"\s#]+)"#).unwrap();
    let host_re = Regex::new(r#"^\s+(?:-\s+)?host:\s*['"]?([^'"\s#]+)"#).unwrap();
    let type_re = Regex::new(r"^\s{2}type:\s*(LoadBalancer|NodePort|ClusterIP|ExternalName)").unwrap();
    let schedule_re = Regex::new(r##"^\s{2}schedule:\s*['"]?([^'"#]+)"##).unwrap();
    let target_re = Regex::new(r"^\s+scaleTargetRef:").unwrap();
    let lines: Vec<&str> = text.lines().collect();
    let mut out = Vec::new();
    let mut start = 0;
    while start < lines.len() {
        let end = (start..lines.len()).find(|&i| i > start && lines[i].trim() == "---").unwrap_or(lines.len());
        let doc = &lines[start..end];
        let kind = doc.iter().enumerate().find_map(|(i, l)| kind_re.captures(l).map(|c| (i, c[1].to_string())));
        if let Some((kind_at, kind)) = kind {
            if K8S_KINDS.contains(&kind.as_str()) {
                let meta_at = doc.iter().position(|l| l.trim_end() == "metadata:").unwrap_or(0);
                let name = doc.iter().skip(meta_at).find_map(|l| name_re.captures(l).map(|c| c[1].to_string())).unwrap_or_else(|| "?".into());
                let mut parts = Vec::new();
                let first = |re: &Regex| doc.iter().find_map(|l| re.captures(l).map(|c| c[1].trim().to_string()));
                match kind.as_str() {
                    "HorizontalPodAutoscaler" => {
                        let target = doc.iter().position(|l| target_re.is_match(l)).and_then(|at| doc.iter().skip(at + 1).find_map(|l| l.trim().strip_prefix("name:").map(|v| v.trim().trim_matches(['"', '\'']).to_string())));
                        if let Some(target) = target {
                            parts.push(format!("scales {target}"));
                        }
                        if let Some(v) = first(&min_re) {
                            parts.push(format!("min {v}"));
                        }
                        if let Some(v) = first(&max_re) {
                            parts.push(format!("max {v}"));
                        }
                    }
                    "Ingress" => {
                        let hosts: Vec<String> = doc.iter().filter_map(|l| host_re.captures(l).map(|c| c[1].to_string())).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
                        if !hosts.is_empty() {
                            parts.push(format!("hosts {}", hosts.join(", ")));
                        }
                        parts.push(if doc.iter().any(|l| l.trim_start().starts_with("tls:")) { "tls".into() } else { "no tls".into() });
                    }
                    "Service" => {
                        parts.push(format!("type {}", first(&type_re).unwrap_or_else(|| "ClusterIP".into())));
                    }
                    "CronJob" => {
                        if let Some(v) = first(&schedule_re) {
                            parts.push(format!("schedule {v}"));
                        }
                    }
                    _ => {
                        if let Some(v) = first(&replicas_re) {
                            parts.push(format!("replicas {v}"));
                        }
                    }
                }
                if matches!(kind.as_str(), "Deployment" | "StatefulSet" | "DaemonSet" | "CronJob" | "Job") {
                    if let Some(image) = first(&image_re) {
                        parts.push(format!("image {image}"));
                    }
                }
                out.push(fact("k8s", rel, start + kind_at + 1, format!("{kind} {name}"), parts.join(" · ")));
            }
        }
        start = end + usize::from(end < lines.len());
    }
    out
}

fn helm_facts(rel: &str, text: &str) -> Vec<RepoFact> {
    let re = Regex::new(r"^\s*(replicaCount|minReplicas|maxReplicas|enabled):\s*([0-9]+|true|false)\s*$").unwrap();
    let mut first_line = 0;
    let mut parts = Vec::new();
    let mut in_autoscaling = false;
    for (i, line) in text.lines().enumerate() {
        if !line.starts_with(' ') && !line.trim().is_empty() {
            in_autoscaling = line.trim_end() == "autoscaling:";
        }
        if let Some(c) = re.captures(line) {
            let key = &c[1];
            if key == "enabled" && !in_autoscaling {
                continue;
            }
            if first_line == 0 {
                first_line = i + 1;
            }
            let label = if key == "enabled" { "autoscaling".to_string() } else { key.to_string() };
            parts.push(format!("{label} {}", &c[2]));
        }
    }
    if parts.is_empty() {
        return vec![];
    }
    let chart = rel.rsplit_once('/').map(|(d, _)| base_name(d).to_string()).unwrap_or_default();
    vec![fact("helm", rel, first_line, format!("chart {chart}"), parts.join(" · "))]
}

fn provider_of(resource_type: &str) -> &'static str {
    match resource_type.split('_').next().unwrap_or("") {
        "azurerm" | "azapi" | "azuread" => "azure",
        "aws" => "aws",
        "google" => "gcp",
        _ => "other",
    }
}

fn terraform_facts(rel: &str, text: &str) -> Vec<RepoFact> {
    let start_re = Regex::new(r#"^\s*resource\s+"([\w-]+)"\s+"([\w-]+)""#).unwrap();
    let module_re = Regex::new(r#"^\s*module\s+"([\w-]+)""#).unwrap();
    let attr_re = Regex::new(r"^\s*(sku_name|sku_tier|sku|tier|size|instance_type|instance_class|node_count|min_count|max_count|desired_count|min_capacity|max_capacity|capacity|replicas|zone_redundant|runtime|memory_size|engine|engine_version|source)\s*=\s*(.+?)\s*$").unwrap();
    let mut out = Vec::new();
    let mut current: Option<(usize, String, Vec<String>)> = None;
    let mut depth: i64 = 0;
    for (i, line) in text.lines().enumerate() {
        if current.is_none() {
            if let Some(c) = start_re.captures(line) {
                current = Some((i + 1, format!("{} {} ({})", &c[1], &c[2], provider_of(&c[1])), vec![]));
                depth = 0;
            } else if let Some(c) = module_re.captures(line) {
                current = Some((i + 1, format!("module {}", &c[1]), vec![]));
                depth = 0;
            }
        }
        if let Some((_, _, attrs)) = current.as_mut() {
            if depth >= 1 {
                if let Some(c) = attr_re.captures(line) {
                    let value: String = c[2].trim().chars().take(60).collect();
                    attrs.push(format!("{} {}", &c[1], value));
                }
            }
            depth += line.matches('{').count() as i64 - line.matches('}').count() as i64;
            if depth <= 0 && line.contains('}') {
                let (at, title, attrs) = current.take().unwrap();
                out.push(fact("terraform", rel, at, title, attrs.join(" · ")));
            }
        }
    }
    if let Some((at, title, attrs)) = current {
        out.push(fact("terraform", rel, at, title, attrs.join(" · ")));
    }
    out
}

fn bicep_facts(rel: &str, text: &str) -> Vec<RepoFact> {
    let start_re = Regex::new(r"^\s*resource\s+(\w+)\s+'([^'@]+)@[^']*'").unwrap();
    let attr_re = Regex::new(r"^\s+(name|capacity|tier):\s*(.+?)\s*$").unwrap();
    let lines: Vec<&str> = text.lines().collect();
    let mut out = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let Some(c) = start_re.captures(line) else { continue };
        let mut attrs = Vec::new();
        for next in lines.iter().skip(i + 1).take(40) {
            if start_re.is_match(next) || next.starts_with('}') {
                break;
            }
            if let Some(a) = attr_re.captures(next) {
                attrs.push(format!("{} {}", &a[1], a[2].chars().take(60).collect::<String>()));
            }
        }
        out.push(fact("bicep", rel, i + 1, format!("{} {}", &c[2], &c[1]), attrs.join(" · ")));
    }
    out
}

fn openapi_fact(rel: &str, text: &str) -> Option<RepoFact> {
    let head: String = text.chars().take(2_000).collect();
    let looks = head.contains("openapi") || head.contains("swagger");
    if !looks {
        return None;
    }
    let (title, version, servers, paths) = if rel.to_ascii_lowercase().ends_with(".json") {
        let v: serde_json::Value = serde_json::from_str(text).ok()?;
        v.get("openapi").or_else(|| v.get("swagger"))?;
        let servers = v["servers"].as_array().map(|a| a.iter().filter_map(|s| s["url"].as_str().map(String::from)).collect::<Vec<_>>()).unwrap_or_default();
        (v["info"]["title"].as_str().unwrap_or("").to_string(), v["info"]["version"].as_str().unwrap_or("").to_string(), servers, v["paths"].as_object().map(|o| o.len()).unwrap_or(0))
    } else {
        let docs = YamlLoader::load_from_str(text).ok()?;
        let d = docs.first()?;
        if d["openapi"].is_badvalue() && d["swagger"].is_badvalue() {
            return None;
        }
        let servers = match &d["servers"] {
            Yaml::Array(items) => items.iter().filter_map(|s| yaml_str(&s["url"])).collect(),
            _ => vec![],
        };
        let paths = match &d["paths"] {
            Yaml::Hash(map) => map.len(),
            _ => 0,
        };
        (yaml_str(&d["info"]["title"]).unwrap_or_default(), yaml_str(&d["info"]["version"]).unwrap_or_default(), servers, paths)
    };
    let mut parts = vec![format!("{paths} paths")];
    if !version.is_empty() {
        parts.push(format!("version {version}"));
    }
    if !servers.is_empty() {
        parts.push(format!("servers {}", servers.join(", ")));
    }
    Some(fact("openapi", rel, 1, if title.is_empty() { "API".to_string() } else { title }, parts.join(" · ")))
}

fn adr_fact(rel: &str, text: &str) -> Option<RepoFact> {
    let title_re = Regex::new(r"^#\s+(.+?)\s*$").unwrap();
    let status_re = Regex::new(r"(?i)^\s*[-*]?\s*(?:\*\*)?status(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.+?)\s*$").unwrap();
    let date_re = Regex::new(r"(?i)^\s*[-*]?\s*(?:\*\*)?date(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.+?)\s*$").unwrap();
    let any_date = Regex::new(r"\b(\d{4}-\d{2}-\d{2})\b").unwrap();
    let lines: Vec<&str> = text.lines().collect();
    let (line, title) = lines.iter().enumerate().find_map(|(i, l)| title_re.captures(l).map(|c| (i + 1, c[1].to_string())))?;
    let mut status = lines.iter().find_map(|l| status_re.captures(l).map(|c| c[1].to_string()));
    if status.is_none() {
        // MADR / Nygard: a `## Status` heading and the word under it.
        if let Some(at) = lines.iter().position(|l| l.trim().eq_ignore_ascii_case("## status")) {
            status = lines.iter().skip(at + 1).map(|l| l.trim()).find(|l| !l.is_empty()).map(String::from);
        }
    }
    let date = lines.iter().find_map(|l| date_re.captures(l).map(|c| c[1].to_string())).or_else(|| any_date.captures(text).map(|c| c[1].to_string()));
    let mut parts = Vec::new();
    if let Some(s) = status {
        parts.push(format!("status {s}"));
    }
    if let Some(d) = date {
        parts.push(format!("date {d}"));
    }
    Some(fact("adr", rel, line, title, parts.join(" · ")))
}

/// What a dependency says about the system around the code: an external service, a store, a
/// broker, an identity provider, telemetry, or the stack itself.
fn dependency_hint(name: &str) -> Option<String> {
    let n = name.to_ascii_lowercase();
    let n = n.as_str();
    const EXACT: &[(&str, &str)] = &[
        ("stripe", "Stripe — payments (external)"),
        ("twilio", "Twilio — SMS / WhatsApp (external)"),
        ("@sendgrid/mail", "SendGrid — email (external)"),
        ("sendgrid", "SendGrid — email (external)"),
        ("nodemailer", "SMTP email (external)"),
        ("@azure/service-bus", "Azure Service Bus — messaging"),
        ("@azure/storage-blob", "Azure Blob Storage — data"),
        ("@azure/cosmos", "Azure Cosmos DB — data"),
        ("@azure/identity", "Microsoft Entra ID — identity"),
        ("@azure/msal-node", "Microsoft Entra ID — identity"),
        ("@azure/msal-browser", "Microsoft Entra ID — identity"),
        ("kafkajs", "Kafka — messaging"),
        ("kafka-clients", "Kafka — messaging"),
        ("spring-kafka", "Kafka — messaging"),
        ("confluent-kafka", "Kafka — messaging"),
        ("amqplib", "RabbitMQ / AMQP — messaging"),
        ("spring-boot-starter-amqp", "RabbitMQ / AMQP — messaging"),
        ("pika", "RabbitMQ / AMQP — messaging"),
        ("bullmq", "BullMQ on Redis — messaging"),
        ("bull", "Bull on Redis — messaging"),
        ("ioredis", "Redis — data (cache)"),
        ("redis", "Redis — data (cache)"),
        ("spring-boot-starter-data-redis", "Redis — data (cache)"),
        ("pg", "PostgreSQL — data"),
        ("postgres", "PostgreSQL — data"),
        ("postgresql", "PostgreSQL — data"),
        ("psycopg2", "PostgreSQL — data"),
        ("psycopg", "PostgreSQL — data"),
        ("mysql", "MySQL — data"),
        ("mysql2", "MySQL — data"),
        ("mongodb", "MongoDB — data"),
        ("mongoose", "MongoDB — data"),
        ("pymongo", "MongoDB — data"),
        ("mssql", "SQL Server — data"),
        ("tedious", "SQL Server — data"),
        ("mssql-jdbc", "SQL Server — data"),
        ("@elastic/elasticsearch", "Elasticsearch — data"),
        ("elasticsearch", "Elasticsearch — data"),
        ("aws-sdk", "AWS SDK"),
        ("boto3", "AWS SDK (boto3)"),
        ("firebase-admin", "Firebase (external)"),
        ("openai", "OpenAI API (external)"),
        ("@anthropic-ai/sdk", "Anthropic API (external)"),
        ("auth0", "Auth0 — identity"),
        ("keycloak-connect", "Keycloak — identity"),
        ("applicationinsights", "Application Insights — observability"),
        ("dd-trace", "Datadog — observability"),
        ("newrelic", "New Relic — observability"),
        ("@grpc/grpc-js", "gRPC between services"),
        ("grpcio", "gRPC between services"),
        ("socket.io", "WebSockets"),
        ("@nestjs/core", "stack NestJS"),
        ("express", "stack Express"),
        ("fastify", "stack Fastify"),
        ("next", "stack Next.js"),
        ("react", "stack React"),
        ("vue", "stack Vue"),
        ("@angular/core", "stack Angular"),
        ("spring-boot-starter-web", "stack Spring Boot"),
        ("spring-boot-starter-webflux", "stack Spring Boot (reactive)"),
        ("fastapi", "stack FastAPI"),
        ("django", "stack Django"),
        ("flask", "stack Flask"),
        ("github.com/gin-gonic/gin", "stack Gin"),
    ];
    if let Some((_, hint)) = EXACT.iter().find(|(k, _)| *k == n) {
        return Some(hint.to_string());
    }
    if let Some(rest) = n.strip_prefix("@aws-sdk/client-") {
        return Some(format!("AWS {rest}"));
    }
    if let Some(rest) = n.strip_prefix("@google-cloud/") {
        return Some(format!("Google Cloud {rest}"));
    }
    if let Some(rest) = n.strip_prefix("google-cloud-") {
        return Some(format!("Google Cloud {rest}"));
    }
    if let Some(rest) = n.strip_prefix("@azure/") {
        return Some(format!("Azure {rest}"));
    }
    if let Some(rest) = n.strip_prefix("azure-") {
        return Some(format!("Azure {rest}"));
    }
    if n.starts_with("@sentry/") || n == "sentry-sdk" {
        return Some("Sentry — observability".into());
    }
    if n.starts_with("@opentelemetry/") || n.starts_with("opentelemetry") {
        return Some("OpenTelemetry — observability".into());
    }
    if n.starts_with("@okta/") {
        return Some("Okta — identity".into());
    }
    None
}

fn dependency_facts(rel: &str, text: &str) -> Vec<RepoFact> {
    let name = base_name(rel).to_ascii_lowercase();
    let mut names: Vec<String> = Vec::new();
    if name == "package.json" {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(text) {
            for key in ["dependencies", "devDependencies", "peerDependencies"] {
                if let Some(map) = v[key].as_object() {
                    names.extend(map.keys().cloned());
                }
            }
        }
    } else if name == "pom.xml" || name.starts_with("build.gradle") {
        let re = Regex::new(r#"<artifactId>([^<]+)</artifactId>|['"][\w.-]+:([\w.-]+)(?::[^'"]*)?['"]"#).unwrap();
        for c in re.captures_iter(text) {
            if let Some(m) = c.get(1).or_else(|| c.get(2)) {
                names.push(m.as_str().to_string());
            }
        }
    } else if name == "go.mod" {
        let re = Regex::new(r"^\s*(?:require\s+)?([\w.-]+/[\w./-]+)\s+v").unwrap();
        names.extend(text.lines().filter_map(|l| re.captures(l).map(|c| c[1].to_string())));
    } else {
        // requirements*.txt and pyproject.toml: a distribution name at the start of an entry.
        let re = Regex::new(r#"^\s*['"]?([A-Za-z0-9][A-Za-z0-9._-]*)"#).unwrap();
        names.extend(text.lines().filter(|l| !l.trim_start().starts_with('#') && !l.trim_start().starts_with('[')).filter_map(|l| re.captures(l).map(|c| c[1].to_string())));
    }
    let mut seen = std::collections::BTreeSet::new();
    let mut out = Vec::new();
    for dep in names {
        let Some(hint) = dependency_hint(&dep) else { continue };
        if !seen.insert(hint.clone()) {
            continue;
        }
        let needle = Regex::new(&regex::escape(&dep)).unwrap();
        let line = line_of(text, 0, &needle).unwrap_or(1);
        out.push(fact("dependency", rel, line, dep, hint));
    }
    out
}

/// Key names only: the value after `=` is never kept, never logged, never shown.
fn env_facts(rel: &str, text: &str) -> Vec<RepoFact> {
    let re = Regex::new(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=").unwrap();
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let Some(c) = re.captures(line) else { continue };
        let key = c[1].to_string();
        out.push(fact("env", rel, i + 1, key.clone(), env_hint(&key)));
    }
    out
}

fn env_hint(key: &str) -> String {
    let k = key.to_ascii_uppercase();
    const PREFIXES: &[(&str, &str)] = &[
        ("STRIPE", "payments (external)"),
        ("TWILIO", "SMS / WhatsApp (external)"),
        ("SENDGRID", "email (external)"),
        ("SMTP", "email (external)"),
        ("MAIL", "email"),
        ("SERVICEBUS", "messaging"),
        ("SERVICE_BUS", "messaging"),
        ("KAFKA", "messaging"),
        ("RABBIT", "messaging"),
        ("AMQP", "messaging"),
        ("REDIS", "cache"),
        ("DATABASE", "data"),
        ("DB_", "data"),
        ("POSTGRES", "data"),
        ("MYSQL", "data"),
        ("MONGO", "data"),
        ("COSMOS", "data"),
        ("AZURE", "Azure"),
        ("AWS", "AWS"),
        ("GOOGLE", "Google Cloud"),
        ("GCP", "Google Cloud"),
        ("SENTRY", "observability"),
        ("APPLICATIONINSIGHTS", "observability"),
        ("OTEL", "observability"),
        ("OPENAI", "OpenAI API (external)"),
        ("AUTH0", "identity"),
        ("OIDC", "identity"),
        ("OAUTH", "identity"),
        ("ENTRA", "identity"),
        ("RECAPTCHA", "CAPTCHA (external)"),
    ];
    PREFIXES.iter().find(|(p, _)| k.starts_with(p) || k.contains(&format!("_{p}"))).map(|(_, h)| h.to_string()).unwrap_or_else(|| "configuration".into())
}

// ----------------------------------------------------------------------------------- the digest

/// A repository as the model reads it: the facts first (each citable as `repo:<path>:<line>`), the
/// ADRs' own text, then the orientation the skill generator uses. Blocking.
pub fn repo_digest(root: &Path, budget: usize) -> Result<(String, String), String> {
    if !root.is_dir() {
        return Err(format!("{} is not a folder", root.display()));
    }
    let files = files_of(root);
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| root.display().to_string());
    let scan = RepoScan { name, facts: facts_in(root, &files), counts: BTreeMap::new() };
    let mut out = String::new();
    out.push_str("### Facts read from the repository by CodeFlow (cite each as `repo:<path>:<line>`)\n\n");
    if scan.facts.is_empty() {
        out.push_str("(none: no compose, Kubernetes, Helm, Terraform, Bicep, OpenAPI, ADR or dependency facts found)\n");
    }
    let mut facts = String::new();
    for f in &scan.facts {
        facts.push_str(&format!("- [{}] {}:{} — {}{}\n", f.kind, f.path, f.line, f.title, if f.detail.is_empty() { String::new() } else { format!(" · {}", f.detail) }));
    }
    out.push_str(&cut_head(&facts, FACTS_BUDGET.min(budget / 2)));
    out.push('\n');
    let mut adrs = String::new();
    for f in scan.facts.iter().filter(|f| f.kind == "adr").take(MAX_ADRS) {
        if let Some(text) = read_small(root, &f.path) {
            adrs.push_str(&format!("### ADR file {}\n\n{}\n\n", f.path, cut_head(text.trim(), ADR_CHARS)));
        }
    }
    if !adrs.is_empty() {
        out.push_str(&cut_head(&adrs, ADR_BUDGET));
        out.push('\n');
    }
    let rest = budget.saturating_sub(out.chars().count()).max(MIN_SHARE);
    out.push_str(&cut_head(&orientation(root, &files), rest));
    Ok((scan.name, crate::secret_scan::redact(&out).0))
}

const ORIENTATION_DOCS: &[(&str, usize)] = &[
    ("ARCHITECTURE.md", 12_000),
    ("docs/architecture.md", 12_000),
    ("docs/ARCHITECTURE.md", 12_000),
    ("CLAUDE.md", 6_000),
    ("AGENTS.md", 6_000),
    ("CONTRIBUTING.md", 4_000),
];
/// The manifests worth reading whole. Compose files and `.env.example` are deliberately absent: the
/// facts already say what they hold that matters, and their `environment` blocks and values are
/// exactly what must not travel.
const ORIENTATION_MANIFESTS: &[&str] = &["package.json", "Cargo.toml", "pyproject.toml", "requirements.txt", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts", "Dockerfile", "Makefile"];

/// README, the architecture docs, the project map and the manifests — what the facts cannot say.
fn orientation(root: &Path, files: &[String]) -> String {
    let mut out = String::new();
    let mut section = |title: &str, body: &str| {
        let body = body.trim();
        if !body.is_empty() {
            out.push_str(&format!("### {title}\n\n{body}\n\n"));
        }
    };
    let read = |rel: &str, limit: usize| read_small(root, rel).map(|text| cut_head(&crate::secret_scan::redact(&text).0, limit));
    if let Some(readme) = files.iter().find(|f| !f.contains('/') && f.to_ascii_lowercase().starts_with("readme")) {
        if let Some(text) = read(readme, 15_000) {
            section(readme, &text);
        }
    }
    for (rel, limit) in ORIENTATION_DOCS {
        if files.iter().any(|f| f == rel) {
            if let Some(text) = read(rel, *limit) {
                section(rel, &text);
            }
        }
    }
    match crate::codemap::orientation(&root.to_string_lossy(), 12_000) {
        Some(map) => section("Project map", &map),
        None => section("Files", &files.iter().take(300).cloned().collect::<Vec<_>>().join("\n")),
    }
    for rel in ORIENTATION_MANIFESTS {
        if files.iter().any(|f| f == rel) {
            if let Some(text) = read(rel, 3_000) {
                section(rel, &text);
            }
        }
    }
    let docs = files
        .iter()
        .filter(|f| (f.starts_with("docs/") || f.starts_with("doc/")) && f.to_ascii_lowercase().ends_with(".md") && !is_adr(f))
        .take(8);
    for rel in docs {
        if let Some(text) = read(rel, 4_000) {
            section(rel, &text);
        }
    }
    out
}

/// A source read into text.
#[derive(Debug, Clone, PartialEq)]
pub struct ReadSource {
    /// `repository`, `document`, `text` or `cloud`.
    pub kind: &'static str,
    pub name: String,
    /// How the model cites what it takes from this source.
    pub cite: &'static str,
    pub text: String,
}

/// One source, read. A cloud snapshot is `None` when `include_cloud` is false: re-reading the cloud
/// needs a fresh authorization, which only the generation dialog asks for.
pub async fn read_one(source: &ArchSource, include_cloud: bool) -> Result<Option<ReadSource>, String> {
    let read = match source {
        ArchSource::Repo { path } => {
            let root = PathBuf::from(path);
            let (name, text) = tokio::task::spawn_blocking(move || repo_digest(&root, REPO_BUDGET)).await.map_err(|e| e.to_string())??;
            ReadSource { kind: "repository", name, cite: "repo:<path>:<line> — what", text }
        }
        ArchSource::Document { path } => {
            let doc = crate::commands::stories_cmd::story_source_document(path.clone()).await.map_err(|e| format!("{path}: {e}"))?;
            ReadSource { kind: "document", cite: "doc:<name> — what", text: crate::secret_scan::redact(&doc.markdown).0, name: doc.name }
        }
        ArchSource::Text { name, text } => ReadSource { kind: "text", name: name.clone(), cite: "brief — what", text: crate::secret_scan::redact(text).0 },
        ArchSource::Cloud { name, text } => {
            if !include_cloud {
                return Ok(None);
            }
            ReadSource { kind: "cloud", name: name.clone(), cite: "azure:<resource id> | aws:<arn> | gcp:<resource name>", text: crate::secret_scan::redact(text).0 }
        }
    };
    if read.text.trim().is_empty() {
        return Err(format!("{} has nothing to read", if read.name.is_empty() { read.kind } else { read.name.as_str() }));
    }
    Ok(Some(read))
}

/// Every source, read; the first that cannot be read fails the lot, named — an architecture
/// generated from half of what was picked would look complete and not be.
pub async fn read_all(sources: &[ArchSource], include_cloud: bool) -> Result<Vec<ReadSource>, String> {
    let mut out = Vec::new();
    for source in sources {
        if let Some(read) = read_one(source, include_cloud).await? {
            out.push(read);
        }
    }
    // Two or more repositories are a system: how they connect is read from their code, first, so the
    // model describes connections that were found and never has to invent one. A failure here leaves
    // the per-repository digests, which is what generation always had.
    let repos: Vec<String> = sources
        .iter()
        .filter_map(|source| match source {
            ArchSource::Repo { path } => Some(path.clone()),
            _ => None,
        })
        .collect();
    if repos.len() >= 2 {
        if let Ok(Ok(map)) = tokio::task::spawn_blocking(move || super::system::scan_system(&repos)).await {
            let text = crate::secret_scan::redact(&super::system::digest(&map, SYSTEM_BUDGET)).0;
            out.insert(0, ReadSource { kind: "system", name: "system map".to_string(), cite: "system:<repo> → <repo> — verified | inferred | unresolved", text });
        }
    }
    Ok(out)
}

/// The same, never failing: what could not be read is named in a note instead. For a lens's answer,
/// where the document alone still makes an answer.
pub async fn read_lenient(sources: &[ArchSource]) -> (Vec<ReadSource>, Vec<String>) {
    let mut out = Vec::new();
    let mut notes = Vec::new();
    for source in sources {
        match read_one(source, false).await {
            Ok(Some(read)) => out.push(read),
            Ok(None) => {}
            Err(e) => notes.push(e),
        }
    }
    (out, notes)
}

/// The sources in tagged blocks, each cut to its share of `budget`.
pub fn assemble(sources: &[ReadSource], budget: usize) -> String {
    let share = (budget / sources.len().max(1)).max(MIN_SHARE);
    let mut out = String::new();
    for (index, source) in sources.iter().enumerate() {
        let name = source.name.replace('"', "'");
        out.push_str(&format!("<source n=\"{}\" kind=\"{}\" name=\"{name}\" cite=\"{}\">\n", index + 1, source.kind, source.cite));
        out.push_str(cut_head(&source.text, share).trim());
        out.push_str("\n</source>\n\n");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cf-arch-src-{}-{}", std::process::id(), uuid::Uuid::new_v4()));
        let write = |rel: &str, text: &str| {
            let path = dir.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        };
        write("README.md", "# Shop\n\nA small shop.\n");
        write(
            "docker-compose.yml",
            "services:\n  api:\n    build: .\n    ports:\n      - \"3000:3000\"\n    depends_on:\n      - db\n      - cache\n    environment:\n      DB_PASSWORD: hunter2-compose\n  db:\n    image: postgres:16\n  cache:\n    image: redis:7\n",
        );
        write(
            "k8s/api.yaml",
            "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\nspec:\n  replicas: 3\n  template:\n    spec:\n      containers:\n        - name: api\n          image: ghcr.io/example/api:1.2\n          env:\n            - name: TOKEN\n              value: s3cr3t-k8s\n---\napiVersion: autoscaling/v2\nkind: HorizontalPodAutoscaler\nmetadata:\n  name: api\nspec:\n  scaleTargetRef:\n    kind: Deployment\n    name: api\n  minReplicas: 2\n  maxReplicas: 8\n---\napiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: web\nspec:\n  tls:\n    - hosts: [shop.example.com]\n  rules:\n    - host: shop.example.com\n",
        );
        write("charts/api/Chart.yaml", "name: api\n");
        write("charts/api/values.yaml", "replicaCount: 2\nautoscaling:\n  enabled: true\n  minReplicas: 2\n  maxReplicas: 6\n");
        write("infra/main.tf", "resource \"azurerm_kubernetes_cluster\" \"main\" {\n  name = \"aks-shop\"\n  default_node_pool {\n    node_count = 3\n  }\n  sku_tier = \"Standard\"\n}\n\nresource \"aws_sqs_queue\" \"orders\" {\n  name = \"orders\"\n}\n");
        write("infra/app.bicep", "resource site 'Microsoft.Web/sites@2023-01-01' = {\n  name: 'app-shop'\n}\n");
        write("api/openapi.yaml", "openapi: 3.0.0\ninfo:\n  title: Shop API\n  version: 1.0.0\nservers:\n  - url: https://api.example.com\npaths:\n  /orders: {}\n  /items: {}\n");
        write("docs/adr/0001-use-queues.md", "# 1. Use queues for orders\n\nDate: 2026-01-05\n\n## Status\n\nAccepted\n\n## Context\n\nOrders spike.\n");
        write("package.json", "{\n  \"dependencies\": {\n    \"@nestjs/core\": \"10\",\n    \"stripe\": \"14\",\n    \"ioredis\": \"5\"\n  }\n}\n");
        write(".env.example", "STRIPE_SECRET_KEY=sk_live_example_value_xyz\nDATABASE_URL=postgres://user:pa55@db/shop\n");
        write(".env", "REAL_SECRET=never-read-this\n");
        dir
    }

    #[test]
    fn a_repository_yields_its_facts_with_lines_and_never_its_values() {
        let dir = repo();
        let scan = scan_repo(&dir).unwrap();
        let has = |kind: &str, needle: &str| scan.facts.iter().any(|f| f.kind == kind && format!("{} · {}", f.title, f.detail).contains(needle));
        assert!(has("compose", "service api"), "{:?}", scan.facts);
        assert!(has("compose", "depends on db, cache"));
        assert!(has("compose", "image postgres:16"));
        assert!(has("k8s", "Deployment api · replicas 3 · image ghcr.io/example/api:1.2"));
        assert!(has("k8s", "HorizontalPodAutoscaler api · scales api · min 2 · max 8"));
        assert!(has("k8s", "hosts shop.example.com · tls"));
        assert!(has("helm", "replicaCount 2"));
        assert!(has("terraform", "azurerm_kubernetes_cluster main (azure)"));
        assert!(has("terraform", "aws_sqs_queue orders (aws)"));
        assert!(has("bicep", "Microsoft.Web/sites site"));
        assert!(has("openapi", "Shop API"));
        assert!(has("openapi", "2 paths"));
        assert!(has("adr", "status Accepted"));
        assert!(has("adr", "date 2026-01-05"));
        assert!(has("dependency", "Stripe"));
        assert!(has("dependency", "stack NestJS"));
        assert!(has("env", "STRIPE_SECRET_KEY"));
        let deployment = scan.facts.iter().find(|f| f.title == "Deployment api").unwrap();
        assert_eq!((deployment.path.as_str(), deployment.line), ("k8s/api.yaml", 2));
        let hpa = scan.facts.iter().find(|f| f.title.starts_with("HorizontalPodAutoscaler")).unwrap();
        assert_eq!(hpa.line, 17);
        assert_eq!(scan.counts.get("k8s"), Some(&3));

        let (_, digest) = repo_digest(&dir, REPO_BUDGET).unwrap();
        for secret in ["sk_live_example_value_xyz", "pa55", "never-read-this", "REAL_SECRET", "hunter2-compose", "s3cr3t-k8s"] {
            assert!(!digest.contains(secret), "{secret} leaked into the digest");
            assert!(!format!("{:?}", scan.facts).contains(secret), "{secret} leaked into the facts");
        }
        assert!(digest.contains("k8s/api.yaml:2"));
        assert!(digest.contains("### ADR file docs/adr/0001-use-queues.md"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn sources_are_tagged_with_how_to_cite_them() {
        let text = assemble(&[ReadSource { kind: "text", name: "Brief".into(), cite: "brief — what", text: "scale: 50 rps".into() }], 10_000);
        assert!(text.starts_with("<source n=\"1\" kind=\"text\" name=\"Brief\" cite=\"brief — what\">"));
        assert!(text.contains("scale: 50 rps"));
    }

    #[test]
    fn a_cloud_snapshot_is_only_passed_on_when_asked() {
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let cloud = ArchSource::Cloud { name: "Azure".into(), text: "Microsoft.Web/sites | app".into() };
        assert_eq!(rt.block_on(read_one(&cloud, false)).unwrap(), None);
        assert!(rt.block_on(read_one(&cloud, true)).unwrap().is_some());
        let source: ArchSource = serde_json::from_str(r#"{"kind":"text","name":"Brief","text":"x"}"#).unwrap();
        assert_eq!(source, ArchSource::Text { name: "Brief".into(), text: "x".into() });
    }
}
