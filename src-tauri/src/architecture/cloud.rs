//! Reading a cloud account for Arquitectura — read-only, through the provider's own CLI and the
//! person's own login, and only ever because they authorized that exact read in the app.
//!
//! Nothing here decides to read: each command is a separate click in the generation dialog, which
//! first shows the command lines [`plan`] returns. Every command is a list/describe call with JSON
//! output, run non-interactively with a timeout; a failing one is recorded and the rest go on.
//!
//! What comes back is **sanitized before it leaves Rust**: object keys that can hold a secret —
//! environment blocks, passwords, tokens, connection strings, keys, certificates — are dropped from
//! the parsed JSON, and the text is passed through `secret_scan::redact`. Only identity, kind,
//! location, group and size of each resource reach the model.

use std::time::Duration;

use regex::Regex;
use serde::Serialize;
use serde_json::Value;

use crate::containers::cli;

const TIMEOUT: Duration = Duration::from_secs(60);
/// Resources in the text the model reads.
const MAX_LISTED: usize = 600;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Azure,
    Aws,
    Gcp,
}

impl Provider {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "azure" => Ok(Self::Azure),
            "aws" => Ok(Self::Aws),
            "gcp" => Ok(Self::Gcp),
            other => Err(format!("Unknown cloud provider: {other}")),
        }
    }

    fn binary(self) -> &'static str {
        match self {
            Self::Azure => "az",
            Self::Aws => "aws",
            Self::Gcp => "gcloud",
        }
    }

    fn key(self) -> &'static str {
        match self {
            Self::Azure => "azure",
            Self::Aws => "aws",
            Self::Gcp => "gcp",
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudContext {
    pub id: String,
    pub name: String,
    pub detail: String,
    pub default: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudContexts {
    /// Whether the provider's CLI is installed.
    pub found: bool,
    pub contexts: Vec<CloudContext>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudScope {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub command: String,
    pub ok: bool,
    pub error: Option<String>,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudResource {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub location: String,
    pub group: String,
    pub sku: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSnapshot {
    pub provider: String,
    pub context: String,
    pub scope: Option<String>,
    pub commands: Vec<CommandResult>,
    pub resources: Vec<CloudResource>,
    /// One line per resource, for the model.
    pub text: String,
}

/// One planned call: the arguments, and how its JSON becomes resources.
struct Call {
    args: Vec<String>,
    extract: fn(&Value) -> Vec<CloudResource>,
}

fn strings(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

/// A command line as the authorization card shows it.
fn display(program: &str, args: &[String]) -> String {
    let quote = |a: &String| if a.chars().any(|c| c.is_whitespace() || c == '"') { format!("'{}'", a.replace('\'', "'\\''")) } else { a.clone() };
    std::iter::once(program.to_string()).chain(args.iter().map(quote)).collect::<Vec<_>>().join(" ")
}

/// Non-interactive, no pager, no colour, no prompt — a read that cannot stall on a question.
fn quiet_env() -> Vec<(String, String)> {
    [("AWS_PAGER", ""), ("CLOUDSDK_CORE_DISABLE_PROMPTS", "1"), ("AZURE_CORE_NO_COLOR", "1"), ("AZURE_CORE_ONLY_SHOW_ERRORS", "1")]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

async fn run(provider: Provider, args: &[String]) -> Result<String, String> {
    let binary = cli::find(provider.binary()).ok_or_else(|| format!("{} is not installed", provider.binary()))?;
    let program = binary.to_string_lossy().into_owned();
    let output = cli::run_with(&program, args, None, TIMEOUT, &quiet_env()).await?;
    if output.ok() {
        Ok(output.stdout)
    } else {
        // The first line says it — "Please run 'az login'", "The config profile (x) could not be found".
        let complaint = output.complaint();
        Err(complaint.lines().next().unwrap_or("").chars().take(300).collect())
    }
}

// ------------------------------------------------------------------------------------- contexts

pub async fn contexts(provider: Provider) -> CloudContexts {
    if cli::find(provider.binary()).is_none() {
        return CloudContexts { found: false, contexts: vec![], error: None };
    }
    let result = match provider {
        Provider::Azure => run(provider, &strings(&["account", "list", "-o", "json"])).await.map(|out| {
            json_items(&out)
                .iter()
                .map(|a| CloudContext {
                    id: s(&a["id"]),
                    name: s(&a["name"]),
                    detail: s(&a["state"]),
                    default: a["isDefault"].as_bool().unwrap_or(false),
                })
                .collect()
        }),
        Provider::Aws => match run(provider, &strings(&["configure", "list-profiles"])).await {
            Ok(out) => {
                let wanted = std::env::var("AWS_PROFILE").unwrap_or_else(|_| "default".into());
                let regions = aws_config_regions();
                Ok(out
                    .lines()
                    .map(str::trim)
                    .filter(|l| !l.is_empty())
                    .take(50)
                    .map(|p| CloudContext { id: p.to_string(), name: p.to_string(), detail: regions.iter().find(|(name, _)| name == p).map(|(_, r)| r.clone()).unwrap_or_default(), default: p == wanted })
                    .collect())
            }
            Err(e) => Err(e),
        },
        Provider::Gcp => run(provider, &strings(&["projects", "list", "--format=json"])).await.map(|out| {
            let current = std::env::var("CLOUDSDK_CORE_PROJECT").unwrap_or_default();
            json_items(&out)
                .iter()
                .map(|p| {
                    let id = s(&p["projectId"]);
                    CloudContext { default: !current.is_empty() && id == current, name: s(&p["name"]), detail: s(&p["lifecycleState"]), id }
                })
                .collect()
        }),
    };
    match result {
        Ok(contexts) => CloudContexts { found: true, contexts, error: None },
        Err(error) => CloudContexts { found: true, contexts: vec![], error: Some(error) },
    }
}

/// The region each AWS profile names, from `~/.aws/config` — the config file only, never the
/// credentials file, and only its `region` lines.
fn aws_config_regions() -> Vec<(String, String)> {
    let path = std::env::var("AWS_CONFIG_FILE").map(std::path::PathBuf::from).ok().or_else(|| dirs::home_dir().map(|h| h.join(".aws").join("config")));
    let Some(text) = path.and_then(|p| std::fs::read_to_string(p).ok()) else { return vec![] };
    parse_aws_regions(&text)
}

fn parse_aws_regions(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut profile: Option<String> = None;
    for line in text.lines().map(str::trim) {
        if let Some(header) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            let name = header.trim().strip_prefix("profile ").unwrap_or(header.trim()).trim().to_string();
            profile = Some(name);
        } else if let (Some(p), Some(value)) = (&profile, line.strip_prefix("region").map(str::trim_start).and_then(|l| l.strip_prefix('='))) {
            out.push((p.clone(), value.trim().to_string()));
        }
    }
    out
}

// --------------------------------------------------------------------------------------- scopes

const AWS_REGIONS: &[&str] = &[
    "us-east-1", "us-east-2", "us-west-1", "us-west-2", "ca-central-1", "sa-east-1", "eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1", "eu-north-1", "eu-south-1", "ap-south-1",
    "ap-northeast-1", "ap-northeast-2", "ap-southeast-1", "ap-southeast-2", "me-south-1", "af-south-1",
];

pub async fn scopes(provider: Provider, context: &str) -> Result<Vec<CloudScope>, String> {
    match provider {
        Provider::Azure => {
            let out = run(provider, &strings(&["group", "list", "--subscription", context, "-o", "json"])).await?;
            let mut groups: Vec<CloudScope> = json_items(&out).iter().map(|g| CloudScope { id: s(&g["name"]), name: format!("{} ({})", s(&g["name"]), s(&g["location"])) }).collect();
            groups.sort_by(|a, b| a.id.to_lowercase().cmp(&b.id.to_lowercase()));
            Ok(groups)
        }
        Provider::Aws => Ok(aws_regions(aws_config_regions().into_iter().find(|(p, _)| p == context).map(|(_, r)| r))),
        Provider::Gcp => Ok(vec![]),
    }
}

fn aws_regions(default: Option<String>) -> Vec<CloudScope> {
    let mut out: Vec<CloudScope> = Vec::new();
    if let Some(region) = default.filter(|r| !r.is_empty()) {
        out.push(CloudScope { id: region.clone(), name: region });
    }
    for region in AWS_REGIONS {
        if !out.iter().any(|s| s.id == *region) {
            out.push(CloudScope { id: region.to_string(), name: region.to_string() });
        }
    }
    out
}

// ----------------------------------------------------------------------------------------- plan

fn calls(provider: Provider, context: &str, scope: Option<&str>) -> Vec<Call> {
    match provider {
        Provider::Azure => {
            let mut args = strings(&["resource", "list", "--subscription", context]);
            if let Some(group) = scope.filter(|g| !g.is_empty()) {
                args.extend(strings(&["-g", group]));
            }
            args.extend(strings(&["-o", "json"]));
            vec![Call { args, extract: azure_resources }]
        }
        Provider::Aws => {
            let region = scope.filter(|r| !r.is_empty()).unwrap_or("us-east-1");
            let base = |parts: &[&str]| {
                let mut a = strings(parts);
                a.extend(strings(&["--profile", context, "--region", region, "--output", "json", "--no-cli-pager"]));
                a
            };
            vec![
                Call { args: base(&["resourcegroupstaggingapi", "get-resources"]), extract: aws_tagged },
                Call { args: base(&["lambda", "list-functions"]), extract: aws_lambda },
                Call { args: base(&["ecs", "list-clusters"]), extract: aws_ecs },
                Call { args: base(&["eks", "list-clusters"]), extract: aws_eks },
                Call { args: base(&["rds", "describe-db-instances"]), extract: aws_rds },
                Call { args: base(&["dynamodb", "list-tables"]), extract: aws_dynamodb },
                Call { args: base(&["sqs", "list-queues"]), extract: aws_sqs },
                Call { args: base(&["sns", "list-topics"]), extract: aws_sns },
                Call { args: base(&["apigateway", "get-rest-apis"]), extract: aws_rest_apis },
                Call { args: base(&["apigatewayv2", "get-apis"]), extract: aws_http_apis },
                Call { args: base(&["elbv2", "describe-load-balancers"]), extract: aws_elb },
                Call { args: base(&["elasticache", "describe-cache-clusters"]), extract: aws_elasticache },
                Call { args: base(&["cloudfront", "list-distributions"]), extract: aws_cloudfront },
                Call { args: base(&["s3api", "list-buckets"]), extract: aws_s3 },
            ]
        }
        Provider::Gcp => gcp_asset_call(context).into_iter().chain(gcp_fallback_calls(context)).collect(),
    }
}

fn gcp_asset_call(project: &str) -> Option<Call> {
    Some(Call { args: vec!["asset".into(), "search-all-resources".into(), format!("--scope=projects/{project}"), "--format=json".into(), "--quiet".into()], extract: gcp_assets })
}

fn gcp_fallback_calls(project: &str) -> Vec<Call> {
    let base = |parts: &[&str]| {
        let mut a = strings(parts);
        a.extend([format!("--project={project}"), "--format=json".into(), "--quiet".into()]);
        a
    };
    vec![
        Call { args: base(&["run", "services", "list"]), extract: gcp_run },
        Call { args: base(&["functions", "list"]), extract: |v| gcp_named(v, "cloudfunctions.googleapis.com/Function") },
        Call { args: base(&["sql", "instances", "list"]), extract: gcp_sql },
        Call { args: base(&["container", "clusters", "list"]), extract: |v| gcp_named(v, "container.googleapis.com/Cluster") },
        Call { args: base(&["pubsub", "topics", "list"]), extract: |v| gcp_named(v, "pubsub.googleapis.com/Topic") },
        Call { args: base(&["redis", "instances", "list", "--region=-"]), extract: |v| gcp_named(v, "redis.googleapis.com/Instance") },
        Call { args: base(&["compute", "instances", "list"]), extract: |v| gcp_named(v, "compute.googleapis.com/Instance") },
        Call { args: base(&["storage", "buckets", "list"]), extract: |v| gcp_named(v, "storage.googleapis.com/Bucket") },
    ]
}

/// The command lines [`read`] runs, for the person to see and authorize. For Google Cloud the
/// per-service lists run only when the asset search fails; they are listed so nothing runs unseen.
pub fn plan(provider: Provider, context: &str, scope: Option<&str>) -> Vec<String> {
    calls(provider, context, scope).iter().map(|c| display(provider.binary(), &c.args)).collect()
}

// ----------------------------------------------------------------------------------------- read

pub async fn read(provider: Provider, context: &str, scope: Option<&str>) -> Result<CloudSnapshot, String> {
    if cli::find(provider.binary()).is_none() {
        return Err(format!("{} is not installed", provider.binary()));
    }
    let mut commands = Vec::new();
    let mut resources: Vec<CloudResource> = Vec::new();
    let all = calls(provider, context, scope);
    let (first, rest): (Vec<Call>, Vec<Call>) = if provider == Provider::Gcp {
        let mut iter = all.into_iter();
        (iter.next().into_iter().collect(), iter.collect())
    } else {
        (all, vec![])
    };
    let mut gcp_asset_failed = false;
    for call in &first {
        let ok = run_call(provider, call, &mut commands, &mut resources).await;
        gcp_asset_failed |= !ok;
    }
    if provider == Provider::Gcp && gcp_asset_failed {
        for call in &rest {
            run_call(provider, call, &mut commands, &mut resources).await;
        }
    }
    resources.sort_by(|a, b| (a.kind.as_str(), a.name.as_str()).cmp(&(b.kind.as_str(), b.name.as_str())));
    let text = listing(provider, context, scope, &commands, &resources);
    Ok(CloudSnapshot { provider: provider.key().into(), context: context.into(), scope: scope.map(String::from), commands, resources, text })
}

async fn run_call(provider: Provider, call: &Call, commands: &mut Vec<CommandResult>, resources: &mut Vec<CloudResource>) -> bool {
    let command = display(provider.binary(), &call.args);
    match run(provider, &call.args).await {
        Ok(out) => {
            let mut value: Value = serde_json::from_str(out.trim()).unwrap_or(Value::Null);
            sanitize(&mut value);
            let found = (call.extract)(&value);
            let count = found.len();
            for r in found {
                if let Some(existing) = resources.iter_mut().find(|e| !r.id.is_empty() && e.id == r.id) {
                    // A specific list knows more than the tag index: its fields win where it has them.
                    for (have, new) in [(&mut existing.kind, r.kind), (&mut existing.name, r.name), (&mut existing.location, r.location), (&mut existing.group, r.group), (&mut existing.sku, r.sku)] {
                        if !new.is_empty() {
                            *have = new;
                        }
                    }
                } else {
                    resources.push(r);
                }
            }
            commands.push(CommandResult { command, ok: true, error: None, count });
            true
        }
        Err(error) => {
            commands.push(CommandResult { command, ok: false, error: Some(crate::secret_scan::redact(&error).0), count: 0 });
            false
        }
    }
}

fn listing(provider: Provider, context: &str, scope: Option<&str>, commands: &[CommandResult], resources: &[CloudResource]) -> String {
    let mut out = format!("Provider: {} · context: {context}{}\n", provider.key(), scope.map(|s| format!(" · scope: {s}")).unwrap_or_default());
    let failed: Vec<&CommandResult> = commands.iter().filter(|c| !c.ok).collect();
    if !failed.is_empty() {
        out.push_str("Commands that failed (their resources are missing below):\n");
        for c in failed {
            out.push_str(&format!("- {} → {}\n", c.command, c.error.clone().unwrap_or_default()));
        }
    }
    out.push_str(&format!("{} resources (id · kind | name | location | group | sku):\n", resources.len()));
    for r in resources.iter().take(MAX_LISTED) {
        out.push_str(&format!("- {} · {} | {} | {} | {} | {}\n", r.id, r.kind, r.name, r.location, r.group, r.sku));
    }
    if resources.len() > MAX_LISTED {
        out.push_str(&format!("[… {} more not listed]\n", resources.len() - MAX_LISTED));
    }
    crate::secret_scan::redact(&out).0
}

// ------------------------------------------------------------------------------------- sanitize

/// Drops, recursively, every object key that can carry a secret. Applied to every parsed output
/// before a single field is read from it.
pub fn sanitize(value: &mut Value) {
    let sensitive = Regex::new(r"(?i)environment|variables|secret|password|passwd|token|connectionstring|connection_string|credential|certificate|privatekey|private_key|accesskey|access_key|appsettings|\bsas\b|sastoken|^env$|^key$|keys$").unwrap();
    fn walk(value: &mut Value, sensitive: &Regex) {
        match value {
            Value::Object(map) => {
                map.retain(|k, _| !sensitive.is_match(k));
                for v in map.values_mut() {
                    walk(v, sensitive);
                }
            }
            Value::Array(items) => items.iter_mut().for_each(|v| walk(v, sensitive)),
            _ => {}
        }
    }
    walk(value, &sensitive);
}

// ----------------------------------------------------------------------------------- extractors

fn s(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}

fn json_items(text: &str) -> Vec<Value> {
    cli::json_values(text)
}

fn arr<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v[key].as_array().map(|a| a.as_slice()).unwrap_or(&[])
}

fn resource(id: String, name: String, kind: &str, location: String, group: String, sku: String) -> CloudResource {
    CloudResource { id, name, kind: kind.to_string(), location, group, sku }
}

fn azure_resources(v: &Value) -> Vec<CloudResource> {
    v.as_array()
        .map(|items| {
            items
                .iter()
                .map(|r| {
                    let mut sku = [s(&r["sku"]["name"]), s(&r["sku"]["tier"]), s(&r["sku"]["capacity"])].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(" ");
                    let kind = s(&r["kind"]);
                    if !kind.is_empty() {
                        sku = if sku.is_empty() { format!("kind {kind}") } else { format!("{sku} · kind {kind}") };
                    }
                    CloudResource { id: s(&r["id"]), name: s(&r["name"]), kind: s(&r["type"]), location: s(&r["location"]), group: s(&r["resourceGroup"]), sku }
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `arn:aws:<service>:<region>:<account>:<resource>` → (service[:type], name, region).
fn arn_parts(arn: &str) -> (String, String, String) {
    let parts: Vec<&str> = arn.splitn(6, ':').collect();
    if parts.len() < 6 {
        return (String::new(), arn.to_string(), String::new());
    }
    let service = parts[2];
    let rest = parts[5];
    let (kind, name) = match rest.split_once(['/', ':']) {
        Some((t, n)) => (format!("{service}:{t}"), n.rsplit('/').next().unwrap_or(n).to_string()),
        None => (service.to_string(), rest.to_string()),
    };
    (kind, name, parts[3].to_string())
}

fn aws_tagged(v: &Value) -> Vec<CloudResource> {
    arr(v, "ResourceTagMappingList")
        .iter()
        .map(|r| {
            let arn = s(&r["ResourceARN"]);
            let (kind, name, region) = arn_parts(&arn);
            resource(arn, name, &kind, region, String::new(), String::new())
        })
        .collect()
}

fn aws_lambda(v: &Value) -> Vec<CloudResource> {
    arr(v, "Functions").iter().map(|f| resource(s(&f["FunctionArn"]), s(&f["FunctionName"]), "lambda:function", String::new(), String::new(), format!("{} · {} MB", s(&f["Runtime"]), s(&f["MemorySize"])))).collect()
}

fn aws_arn_list(v: &Value, key: &str) -> Vec<CloudResource> {
    arr(v, key)
        .iter()
        .map(|a| {
            let arn = s(a);
            let (kind, name, region) = arn_parts(&arn);
            resource(arn, name, &kind, region, String::new(), String::new())
        })
        .collect()
}

fn aws_ecs(v: &Value) -> Vec<CloudResource> {
    aws_arn_list(v, "clusterArns")
}

fn aws_eks(v: &Value) -> Vec<CloudResource> {
    arr(v, "clusters").iter().map(|c| resource(format!("eks:{}", s(c)), s(c), "eks:cluster", String::new(), String::new(), String::new())).collect()
}

fn aws_rds(v: &Value) -> Vec<CloudResource> {
    arr(v, "DBInstances")
        .iter()
        .map(|d| {
            let multi = if d["MultiAZ"].as_bool().unwrap_or(false) { " · multi-AZ" } else { "" };
            resource(s(&d["DBInstanceArn"]), s(&d["DBInstanceIdentifier"]), "rds:db", s(&d["AvailabilityZone"]), String::new(), format!("{} {}{multi}", s(&d["Engine"]), s(&d["DBInstanceClass"])))
        })
        .collect()
}

fn aws_dynamodb(v: &Value) -> Vec<CloudResource> {
    arr(v, "TableNames").iter().map(|t| resource(format!("dynamodb:{}", s(t)), s(t), "dynamodb:table", String::new(), String::new(), String::new())).collect()
}

fn aws_sqs(v: &Value) -> Vec<CloudResource> {
    arr(v, "QueueUrls").iter().map(|u| {
        let url = s(u);
        let name = url.rsplit('/').next().unwrap_or(&url).to_string();
        resource(url, name, "sqs:queue", String::new(), String::new(), String::new())
    }).collect()
}

fn aws_sns(v: &Value) -> Vec<CloudResource> {
    arr(v, "Topics").iter().map(|t| {
        let arn = s(&t["TopicArn"]);
        let (_, name, region) = arn_parts(&arn);
        resource(arn, name, "sns:topic", region, String::new(), String::new())
    }).collect()
}

fn aws_rest_apis(v: &Value) -> Vec<CloudResource> {
    arr(v, "items").iter().map(|a| resource(format!("apigateway:{}", s(&a["id"])), s(&a["name"]), "apigateway:restapi", String::new(), String::new(), String::new())).collect()
}

fn aws_http_apis(v: &Value) -> Vec<CloudResource> {
    arr(v, "Items").iter().map(|a| resource(format!("apigatewayv2:{}", s(&a["ApiId"])), s(&a["Name"]), "apigateway:api", String::new(), String::new(), s(&a["ProtocolType"]))).collect()
}

fn aws_elb(v: &Value) -> Vec<CloudResource> {
    arr(v, "LoadBalancers").iter().map(|l| resource(s(&l["LoadBalancerArn"]), s(&l["LoadBalancerName"]), "elasticloadbalancing:loadbalancer", String::new(), String::new(), format!("{} {}", s(&l["Type"]), s(&l["Scheme"])))).collect()
}

fn aws_elasticache(v: &Value) -> Vec<CloudResource> {
    arr(v, "CacheClusters").iter().map(|c| resource(s(&c["ARN"]), s(&c["CacheClusterId"]), "elasticache:cluster", s(&c["PreferredAvailabilityZone"]), String::new(), format!("{} {} × {}", s(&c["Engine"]), s(&c["CacheNodeType"]), s(&c["NumCacheNodes"])))).collect()
}

fn aws_cloudfront(v: &Value) -> Vec<CloudResource> {
    arr(&v["DistributionList"], "Items").iter().map(|d| resource(s(&d["ARN"]), s(&d["DomainName"]), "cloudfront:distribution", "global".into(), String::new(), String::new())).collect()
}

fn aws_s3(v: &Value) -> Vec<CloudResource> {
    arr(v, "Buckets").iter().map(|b| resource(format!("arn:aws:s3:::{}", s(&b["Name"])), s(&b["Name"]), "s3:bucket", String::new(), String::new(), String::new())).collect()
}

fn gcp_assets(v: &Value) -> Vec<CloudResource> {
    v.as_array()
        .map(|items| {
            items
                .iter()
                .map(|a| {
                    let name = s(&a["displayName"]);
                    let full = s(&a["name"]);
                    resource(full.clone(), if name.is_empty() { full.rsplit('/').next().unwrap_or("").to_string() } else { name }, &s(&a["assetType"]), s(&a["location"]), s(&a["project"]), String::new())
                })
                .collect()
        })
        .unwrap_or_default()
}

fn gcp_run(v: &Value) -> Vec<CloudResource> {
    v.as_array()
        .map(|items| {
            items
                .iter()
                .map(|r| {
                    let name = s(&r["metadata"]["name"]);
                    let location = s(&r["metadata"]["labels"]["cloud.googleapis.com/location"]);
                    resource(format!("run:{location}/{name}"), name, "run.googleapis.com/Service", location, String::new(), String::new())
                })
                .collect()
        })
        .unwrap_or_default()
}

fn gcp_sql(v: &Value) -> Vec<CloudResource> {
    v.as_array()
        .map(|items| items.iter().map(|d| resource(s(&d["selfLink"]), s(&d["name"]), "sqladmin.googleapis.com/Instance", s(&d["region"]), String::new(), format!("{} {}", s(&d["databaseVersion"]), s(&d["settings"]["tier"])))).collect())
        .unwrap_or_default()
}

fn gcp_named(v: &Value, kind: &str) -> Vec<CloudResource> {
    v.as_array()
        .map(|items| {
            items
                .iter()
                .map(|r| {
                    let full = s(&r["name"]);
                    let short = full.rsplit('/').next().unwrap_or(&full).to_string();
                    let location = [s(&r["location"]), s(&r["zone"]), s(&r["region"])].into_iter().find(|x| !x.is_empty()).unwrap_or_default();
                    let location = location.rsplit('/').next().unwrap_or("").to_string();
                    let sku = [s(&r["machineType"]).rsplit('/').next().unwrap_or("").to_string(), s(&r["runtime"]), s(&r["storageClass"]), s(&r["tier"]), s(&r["currentNodeCount"])].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(" ");
                    resource(if full.is_empty() { short.clone() } else { full }, short, kind, location, String::new(), sku)
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_sanitizer_drops_every_key_that_can_hold_a_secret() {
        let mut v = json!([{
            "FunctionName": "orders",
            "Runtime": "nodejs20.x",
            "Environment": { "Variables": { "DB_URL": "postgres://u:p@h/db" } },
            "properties": { "connectionString": "Server=x;Password=y", "siteConfig": { "appSettings": [{ "name": "A", "value": "b" }] }, "accessKeys": ["k"], "sasToken": "t" },
            "spec": { "template": { "spec": { "containers": [{ "image": "x", "env": [{ "name": "TOKEN", "value": "v" }] }] } } },
            "masterUserPassword": "hunter2",
            "keys": ["a"],
            "KeyName": "my-keypair"
        }]);
        sanitize(&mut v);
        let text = v.to_string();
        for leaked in ["postgres://", "Password=y", "accessKeys", "sasToken", "hunter2", "TOKEN", "\"keys\"", "appSettings"] {
            assert!(!text.contains(leaked), "{leaked} survived: {text}");
        }
        assert!(text.contains("orders") && text.contains("nodejs20.x") && text.contains("my-keypair"));
    }

    #[test]
    fn each_provider_plans_read_only_listing_commands() {
        let azure = plan(Provider::Azure, "sub-1", Some("rg-shop"));
        assert_eq!(azure, vec!["az resource list --subscription sub-1 -g rg-shop -o json"]);
        assert_eq!(plan(Provider::Azure, "sub-1", None), vec!["az resource list --subscription sub-1 -o json"]);
        let aws = plan(Provider::Aws, "dev", Some("eu-west-1"));
        assert_eq!(aws.len(), 14);
        assert_eq!(aws[0], "aws resourcegroupstaggingapi get-resources --profile dev --region eu-west-1 --output json --no-cli-pager");
        assert!(aws.iter().all(|c| c.contains(" list-") || c.contains(" describe-") || c.contains(" get-")));
        let gcp = plan(Provider::Gcp, "shop-prod", None);
        assert_eq!(gcp[0], "gcloud asset search-all-resources --scope=projects/shop-prod --format=json --quiet");
        assert!(gcp.iter().skip(1).all(|c| c.contains(" list") && c.contains("--project=shop-prod")));
        for line in azure.iter().chain(&aws).chain(&gcp) {
            for verb in [" create", " delete", " update", " set ", " login"] {
                assert!(!line.contains(verb), "{line} is not a read");
            }
        }
    }

    #[test]
    fn outputs_become_resources() {
        let azure = azure_resources(&json!([{ "id": "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Web/sites/app", "name": "app", "type": "Microsoft.Web/sites", "kind": "app,linux", "location": "eastus", "resourceGroup": "rg", "sku": { "name": "P1v3", "capacity": 2 } }]));
        assert_eq!(azure[0].kind, "Microsoft.Web/sites");
        assert_eq!(azure[0].sku, "P1v3 2 · kind app,linux");
        let (kind, name, region) = arn_parts("arn:aws:lambda:eu-west-1:123:function:orders");
        assert_eq!((kind.as_str(), name.as_str(), region.as_str()), ("lambda:function", "orders", "eu-west-1"));
        let queues = aws_sqs(&json!({ "QueueUrls": ["https://sqs.eu-west-1.amazonaws.com/123/orders"] }));
        assert_eq!(queues[0].name, "orders");
        assert_eq!(parse_aws_regions("[default]\nregion = us-east-2\n[profile dev]\noutput=json\nregion=eu-west-1\n"), vec![("default".into(), "us-east-2".into()), ("dev".into(), "eu-west-1".into())]);
        assert_eq!(aws_regions(Some("eu-west-1".into()))[0].id, "eu-west-1");
    }
}
