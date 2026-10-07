//! Kubernetes through `kubectl`: the contexts of the user's kubeconfig, the namespaces of one, and
//! the workloads, networking, configuration and nodes in it — read from `kubectl get -o json` into
//! the columns `kubectl get` itself prints, and acted on with the verbs it already has.
//!
//! **The kubeconfig is the user's.** Every command names `--context` explicitly instead of
//! switching the current one, so picking a cluster in the panel never changes what the user's
//! terminal points at. "Use as current context" is a separate, explicit action.

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::cli;

const READ_TIMEOUT: Duration = Duration::from_secs(20);
const ACTION_TIMEOUT: Duration = Duration::from_secs(90);

pub fn program() -> String {
    cli::find("kubectl").map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| "kubectl".into())
}

/// Where a command is aimed: a context, and a namespace (`None`/empty = every namespace).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubeTarget {
    #[serde(default)]
    pub context: Option<String>,
    #[serde(default)]
    pub namespace: Option<String>,
}

impl KubeTarget {
    pub fn context_args(&self) -> Vec<String> {
        match self.context.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
            Some(context) => vec!["--context".into(), context.into()],
            None => vec![],
        }
    }

    pub fn namespace(&self) -> Option<&str> {
        self.namespace.as_deref().map(str::trim).filter(|n| !n.is_empty())
    }

    /// `-n ns`, or `-A` for a list across all of them (never for one object).
    fn scope_args(&self, list: bool) -> Vec<String> {
        match self.namespace() {
            Some(ns) => vec!["-n".into(), ns.into()],
            None if list => vec!["-A".into()],
            None => vec![],
        }
    }

    pub async fn run(&self, args: Vec<String>, stdin: Option<&str>, timeout: Duration) -> Result<String, String> {
        let mut full = self.context_args();
        full.extend(args);
        cli::run_ok(&program(), &full, stdin, timeout).await.map_err(|e| tidy_error(&e))
    }
}

/// kubectl's errors carry a long prefix; the reason is at the end.
fn tidy_error(message: &str) -> String {
    let first = message.lines().next().unwrap_or(message).trim();
    first.strip_prefix("error: ").or_else(|| first.strip_prefix("Error from server ")).unwrap_or(first).to_string()
}

/// The kinds the panel lists, in its order. Cluster-wide ones ignore the namespace.
pub const KINDS: &[&str] = &[
    "pods",
    "deployments",
    "statefulsets",
    "daemonsets",
    "jobs",
    "cronjobs",
    "services",
    "ingresses",
    "configmaps",
    "secrets",
    "persistentvolumeclaims",
    "events",
    "nodes",
    "namespaces",
];

pub fn cluster_scoped(kind: &str) -> bool {
    matches!(kind, "nodes" | "namespaces" | "persistentvolumes" | "storageclasses")
}

fn check_kind(kind: &str) -> Result<(), String> {
    if KINDS.contains(&kind) || matches!(kind, "replicasets" | "persistentvolumes") {
        Ok(())
    } else {
        Err(format!("{kind} is not a kind this panel reads"))
    }
}

/// A Kubernetes object name as kubectl accepts it — refused when it could be read as a flag.
fn check_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.starts_with('-') || name.contains(char::is_whitespace) {
        Err(format!("\"{name}\" is not an object name"))
    } else {
        Ok(())
    }
}

// --------------------------------------------------------------------------------- contexts

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KubeContext {
    pub name: String,
    pub cluster: String,
    pub user: String,
    pub namespace: String,
}

/// The kubeconfig's contexts and its current one — from `kubectl config view`, which redacts the
/// credentials it holds.
pub fn parse_config_view(doc: &Value) -> (Vec<KubeContext>, Option<String>) {
    let contexts = doc
        .get("contexts")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .map(|entry| KubeContext {
                    name: s(entry, "/name"),
                    cluster: s(entry, "/context/cluster"),
                    user: s(entry, "/context/user"),
                    namespace: s(entry, "/context/namespace"),
                })
                .filter(|c| !c.name.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let current = doc.get("current-context").and_then(Value::as_str).filter(|c| !c.is_empty()).map(str::to_string);
    (contexts, current)
}

pub async fn contexts() -> Result<(Vec<KubeContext>, Option<String>), String> {
    let out = cli::run_ok(&program(), &["config".into(), "view".into(), "-o".into(), "json".into()], None, READ_TIMEOUT).await?;
    let doc: Value = serde_json::from_str(&out).map_err(|e| format!("kubectl config view: {e}"))?;
    Ok(parse_config_view(&doc))
}

/// Whether the context's cluster answers, and its version.
pub async fn reach(target: &KubeTarget) -> Result<String, String> {
    // The request gives up at 5 s; the rest is for an auth plugin — kubelogin asking `az` for a token
    // starts Python on Windows, which alone can take several seconds.
    let out = target.run(vec!["version".into(), "-o".into(), "json".into(), "--request-timeout=5s".into()], None, Duration::from_secs(20)).await?;
    let doc: Value = serde_json::from_str(&out).unwrap_or(Value::Null);
    doc.pointer("/serverVersion/gitVersion").and_then(Value::as_str).map(str::to_string).ok_or_else(|| "the cluster did not answer".to_string())
}

pub async fn namespaces(target: &KubeTarget) -> Result<Vec<String>, String> {
    let out = target
        .run(vec!["get".into(), "namespaces".into(), "-o".into(), "jsonpath={.items[*].metadata.name}".into(), "--request-timeout=10s".into()], None, READ_TIMEOUT)
        .await?;
    let mut names: Vec<String> = out.split_whitespace().map(str::to_string).collect();
    names.sort();
    Ok(names)
}

pub async fn use_context(name: &str) -> Result<String, String> {
    check_name(name)?;
    // kubectl writes the current context into the user's own file, and a terminal's kubectl reads
    // that file without CodeFlow's: a context only CodeFlow's holds would leave it failing on every
    // command.
    if super::kubeconfig::only_in_app(name).await {
        return Err(format!("«{name}» is in CodeFlow's own kubeconfig, which kubectl in a terminal does not read — add it again saving it in ~/.kube/config too"));
    }
    cli::run_ok(&program(), &["config".into(), "use-context".into(), name.into()], None, READ_TIMEOUT).await.map(|o| o.trim().to_string())
}

// ---------------------------------------------------------------------------------- reading

fn s(value: &Value, pointer: &str) -> String {
    match value.pointer(pointer) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

fn n(value: &Value, pointer: &str) -> i64 {
    value.pointer(pointer).and_then(Value::as_i64).unwrap_or(0)
}

/// One object as the panel lists it. `tone` colours its dot: `ok`, `warn`, `bad`, `idle`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KubeRow {
    pub kind: String,
    pub name: String,
    pub namespace: String,
    pub status: String,
    pub tone: String,
    pub ready: String,
    pub restarts: Option<i64>,
    pub created: String,
    /// What else `kubectl get -o wide` would show for this kind.
    pub extra: Map<String, Value>,
    pub labels: BTreeMap<String, String>,
}

fn labels_of(item: &Value) -> BTreeMap<String, String> {
    item.pointer("/metadata/labels")
        .and_then(Value::as_object)
        .map(|map| map.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string())).collect())
        .unwrap_or_default()
}

fn base(kind: &str, item: &Value) -> KubeRow {
    KubeRow {
        kind: kind.to_string(),
        name: s(item, "/metadata/name"),
        namespace: s(item, "/metadata/namespace"),
        status: String::new(),
        tone: "idle".into(),
        ready: String::new(),
        restarts: None,
        created: s(item, "/metadata/creationTimestamp"),
        extra: Map::new(),
        labels: labels_of(item),
    }
}

fn images_of(item: &Value, pointer: &str) -> Vec<String> {
    item.pointer(pointer)
        .and_then(Value::as_array)
        .map(|list| list.iter().map(|c| s(c, "/image")).filter(|i| !i.is_empty()).collect())
        .unwrap_or_default()
}

/// The STATUS column `kubectl get pods` prints: the waiting or terminated reason of a container
/// that has one (`CrashLoopBackOff`, `OOMKilled`, `Completed`), `Init:…` while init containers run,
/// `Terminating` for one being deleted, the phase otherwise.
pub fn pod_status(pod: &Value) -> String {
    if pod.pointer("/metadata/deletionTimestamp").is_some_and(|v| !v.is_null()) {
        return "Terminating".into();
    }
    let mut reason = {
        let r = s(pod, "/status/reason");
        if r.is_empty() { s(pod, "/status/phase") } else { r }
    };
    let inits = pod.pointer("/status/initContainerStatuses").and_then(Value::as_array).cloned().unwrap_or_default();
    let init_total = inits.len();
    for (index, c) in inits.iter().enumerate() {
        let terminated_code = c.pointer("/state/terminated/exitCode").and_then(Value::as_i64);
        if terminated_code == Some(0) {
            continue;
        }
        let waiting = s(c, "/state/waiting/reason");
        let terminated = s(c, "/state/terminated/reason");
        if let Some(code) = terminated_code {
            return format!("Init:{}", if terminated.is_empty() { format!("ExitCode:{code}") } else { terminated });
        }
        if !waiting.is_empty() && waiting != "PodInitializing" {
            return format!("Init:{waiting}");
        }
        return format!("Init:{index}/{init_total}");
    }
    let statuses = pod.pointer("/status/containerStatuses").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut has_running = false;
    for c in statuses.iter().rev() {
        let waiting = s(c, "/state/waiting/reason");
        let terminated = s(c, "/state/terminated/reason");
        if !waiting.is_empty() {
            reason = waiting;
        } else if !terminated.is_empty() {
            reason = terminated;
        } else if let Some(code) = c.pointer("/state/terminated/exitCode").and_then(Value::as_i64) {
            reason = format!("ExitCode:{code}");
        } else if c.pointer("/state/running").is_some() && c.get("ready").and_then(Value::as_bool).unwrap_or(false) {
            has_running = true;
        }
    }
    if reason == "Completed" && has_running {
        reason = "Running".into();
    }
    reason
}

fn tone_of_pod(status: &str) -> &'static str {
    match status {
        "Running" => "ok",
        "Succeeded" | "Completed" => "idle",
        "Pending" | "ContainerCreating" | "PodInitializing" | "Terminating" => "warn",
        s if s.starts_with("Init:") && !s.contains("Error") && !s.contains("CrashLoop") => "warn",
        _ => "bad",
    }
}

fn container_state(c: &Value) -> String {
    if c.pointer("/state/running").is_some() {
        return "running".into();
    }
    let waiting = s(c, "/state/waiting/reason");
    if !waiting.is_empty() {
        return format!("waiting: {waiting}");
    }
    if c.pointer("/state/terminated").is_some() {
        let reason = s(c, "/state/terminated/reason");
        return format!("terminated: {}", if reason.is_empty() { s(c, "/state/terminated/exitCode") } else { reason });
    }
    String::new()
}

pub fn parse_rows(kind: &str, doc: &Value) -> Vec<KubeRow> {
    let items = doc.get("items").and_then(Value::as_array).cloned().unwrap_or_else(|| if doc.get("metadata").is_some() { vec![doc.clone()] } else { vec![] });
    items.iter().map(|item| row(kind, item)).collect()
}

pub fn row(kind: &str, item: &Value) -> KubeRow {
    let mut r = base(kind, item);
    match kind {
        "pods" => {
            let statuses = item.pointer("/status/containerStatuses").and_then(Value::as_array).cloned().unwrap_or_default();
            let total = item.pointer("/spec/containers").and_then(Value::as_array).map(Vec::len).unwrap_or(statuses.len());
            let ready = statuses.iter().filter(|c| c.get("ready").and_then(Value::as_bool).unwrap_or(false)).count();
            r.status = pod_status(item);
            r.tone = tone_of_pod(&r.status).into();
            r.ready = format!("{ready}/{total}");
            r.restarts = Some(statuses.iter().map(|c| n(c, "/restartCount")).sum());
            r.extra.insert("node".into(), json!(s(item, "/spec/nodeName")));
            r.extra.insert("ip".into(), json!(s(item, "/status/podIP")));
            r.extra.insert("phase".into(), json!(s(item, "/status/phase")));
            let containers: Vec<Value> = item
                .pointer("/spec/containers")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .map(|spec| {
                            let name = s(spec, "/name");
                            let status = statuses.iter().find(|c| s(c, "/name") == name).cloned().unwrap_or(Value::Null);
                            json!({
                                "name": name,
                                "image": s(spec, "/image"),
                                "ready": status.get("ready").and_then(Value::as_bool).unwrap_or(false),
                                "restarts": n(&status, "/restartCount"),
                                "state": container_state(&status),
                                "lastState": s(&status, "/lastState/terminated/reason"),
                                "ports": spec.get("ports").cloned().unwrap_or(json!([])),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            r.extra.insert("containers".into(), json!(containers));
            if let Some(owner) = item.pointer("/metadata/ownerReferences/0") {
                r.extra.insert("owner".into(), json!(format!("{}/{}", s(owner, "/kind"), s(owner, "/name"))));
            }
        }
        "deployments" | "statefulsets" | "replicasets" => {
            let want = item.pointer("/spec/replicas").and_then(Value::as_i64).unwrap_or(1);
            let ready = n(item, "/status/readyReplicas");
            r.ready = format!("{ready}/{want}");
            r.status = if want == 0 { "Scaled to 0".into() } else if ready >= want { "Ready".into() } else { "Progressing".into() };
            r.tone = if want == 0 { "idle" } else if ready >= want { "ok" } else if ready == 0 { "bad" } else { "warn" }.into();
            r.extra.insert("replicas".into(), json!(want));
            r.extra.insert("updated".into(), json!(n(item, "/status/updatedReplicas")));
            r.extra.insert("available".into(), json!(n(item, "/status/availableReplicas")));
            r.extra.insert("images".into(), json!(images_of(item, "/spec/template/spec/containers")));
            r.extra.insert("selector".into(), item.pointer("/spec/selector/matchLabels").cloned().unwrap_or(json!({})));
            let conditions: Vec<Value> = item
                .pointer("/status/conditions")
                .and_then(Value::as_array)
                .map(|list| list.iter().map(|c| json!({"type": s(c, "/type"), "status": s(c, "/status"), "reason": s(c, "/reason"), "message": s(c, "/message")})).collect())
                .unwrap_or_default();
            r.extra.insert("conditions".into(), json!(conditions));
        }
        "daemonsets" => {
            let desired = n(item, "/status/desiredNumberScheduled");
            let ready = n(item, "/status/numberReady");
            r.ready = format!("{ready}/{desired}");
            r.status = if ready >= desired { "Ready".into() } else { "Progressing".into() };
            r.tone = if desired == 0 { "idle" } else if ready >= desired { "ok" } else { "warn" }.into();
            r.extra.insert("images".into(), json!(images_of(item, "/spec/template/spec/containers")));
            r.extra.insert("selector".into(), item.pointer("/spec/selector/matchLabels").cloned().unwrap_or(json!({})));
        }
        "jobs" => {
            let completions = item.pointer("/spec/completions").and_then(Value::as_i64).unwrap_or(1);
            let succeeded = n(item, "/status/succeeded");
            let failed = n(item, "/status/failed");
            let active = n(item, "/status/active");
            r.ready = format!("{succeeded}/{completions}");
            let complete = item
                .pointer("/status/conditions")
                .and_then(Value::as_array)
                .map(|list| list.iter().find(|c| s(c, "/status") == "True").map(|c| s(c, "/type")).unwrap_or_default())
                .unwrap_or_default();
            r.status = if !complete.is_empty() { complete.clone() } else if active > 0 { "Running".into() } else { "Pending".into() };
            r.tone = match complete.as_str() {
                "Complete" => "idle",
                "Failed" => "bad",
                _ => "warn",
            }
            .into();
            r.extra.insert("failed".into(), json!(failed));
            r.extra.insert("active".into(), json!(active));
            r.extra.insert("images".into(), json!(images_of(item, "/spec/template/spec/containers")));
        }
        "cronjobs" => {
            let suspended = item.pointer("/spec/suspend").and_then(Value::as_bool).unwrap_or(false);
            r.status = if suspended { "Suspended".into() } else { "Scheduled".into() };
            r.tone = if suspended { "idle" } else { "ok" }.into();
            r.extra.insert("schedule".into(), json!(s(item, "/spec/schedule")));
            r.extra.insert("suspend".into(), json!(suspended));
            r.extra.insert("lastSchedule".into(), json!(s(item, "/status/lastScheduleTime")));
            r.extra.insert("active".into(), json!(item.pointer("/status/active").and_then(Value::as_array).map(Vec::len).unwrap_or(0)));
        }
        "services" => {
            let kind_ = s(item, "/spec/type");
            r.status = kind_.clone();
            r.tone = "ok".into();
            let ports: Vec<Value> = item
                .pointer("/spec/ports")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .map(|p| {
                            json!({
                                "name": s(p, "/name"),
                                "port": n(p, "/port"),
                                "targetPort": p.get("targetPort").cloned().unwrap_or(Value::Null),
                                "nodePort": p.get("nodePort").cloned().unwrap_or(Value::Null),
                                "protocol": s(p, "/protocol"),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            let external: Vec<String> = item
                .pointer("/status/loadBalancer/ingress")
                .and_then(Value::as_array)
                .map(|list| list.iter().map(|i| { let ip = s(i, "/ip"); if ip.is_empty() { s(i, "/hostname") } else { ip } }).filter(|v| !v.is_empty()).collect())
                .unwrap_or_default();
            r.extra.insert("type".into(), json!(kind_));
            r.extra.insert("clusterIP".into(), json!(s(item, "/spec/clusterIP")));
            r.extra.insert("externalIP".into(), json!(external));
            r.extra.insert("ports".into(), json!(ports));
            r.extra.insert("selector".into(), item.pointer("/spec/selector").cloned().unwrap_or(json!({})));
        }
        "ingresses" => {
            let hosts: Vec<String> = item
                .pointer("/spec/rules")
                .and_then(Value::as_array)
                .map(|list| list.iter().map(|rule| s(rule, "/host")).filter(|h| !h.is_empty()).collect())
                .unwrap_or_default();
            let address: Vec<String> = item
                .pointer("/status/loadBalancer/ingress")
                .and_then(Value::as_array)
                .map(|list| list.iter().map(|i| { let ip = s(i, "/ip"); if ip.is_empty() { s(i, "/hostname") } else { ip } }).filter(|v| !v.is_empty()).collect())
                .unwrap_or_default();
            r.status = if address.is_empty() { "Pending".into() } else { "Ready".into() };
            r.tone = if address.is_empty() { "warn" } else { "ok" }.into();
            r.extra.insert("class".into(), json!(s(item, "/spec/ingressClassName")));
            r.extra.insert("hosts".into(), json!(hosts));
            r.extra.insert("address".into(), json!(address));
            r.extra.insert("tls".into(), json!(item.pointer("/spec/tls").and_then(Value::as_array).is_some_and(|l| !l.is_empty())));
        }
        "configmaps" => {
            let keys: Vec<String> = item.get("data").and_then(Value::as_object).map(|m| m.keys().cloned().collect()).unwrap_or_default();
            r.status = format!("{}", keys.len());
            r.extra.insert("keys".into(), json!(keys));
        }
        "secrets" => {
            // Names of the keys only: their values are never read into a row.
            let keys: Vec<String> = item.get("data").and_then(Value::as_object).map(|m| m.keys().cloned().collect()).unwrap_or_default();
            r.status = s(item, "/type");
            r.extra.insert("keys".into(), json!(keys));
            r.extra.insert("type".into(), json!(s(item, "/type")));
        }
        "persistentvolumeclaims" => {
            r.status = s(item, "/status/phase");
            r.tone = if r.status == "Bound" { "ok" } else { "warn" }.into();
            r.extra.insert("volume".into(), json!(s(item, "/spec/volumeName")));
            r.extra.insert("capacity".into(), json!(s(item, "/status/capacity/storage")));
            r.extra.insert("storageClass".into(), json!(s(item, "/spec/storageClassName")));
            r.extra.insert("accessModes".into(), item.pointer("/spec/accessModes").cloned().unwrap_or(json!([])));
        }
        "nodes" => {
            let ready = item
                .pointer("/status/conditions")
                .and_then(Value::as_array)
                .and_then(|list| list.iter().find(|c| s(c, "/type") == "Ready").map(|c| s(c, "/status") == "True"))
                .unwrap_or(false);
            let unschedulable = item.pointer("/spec/unschedulable").and_then(Value::as_bool).unwrap_or(false);
            r.status = format!("{}{}", if ready { "Ready" } else { "NotReady" }, if unschedulable { ",SchedulingDisabled" } else { "" });
            r.tone = if !ready { "bad" } else if unschedulable { "warn" } else { "ok" }.into();
            let roles: Vec<String> = r.labels.keys().filter_map(|k| k.strip_prefix("node-role.kubernetes.io/").map(str::to_string)).collect();
            r.extra.insert("roles".into(), json!(roles));
            r.extra.insert("version".into(), json!(s(item, "/status/nodeInfo/kubeletVersion")));
            r.extra.insert("os".into(), json!(format!("{}/{}", s(item, "/status/nodeInfo/operatingSystem"), s(item, "/status/nodeInfo/architecture"))));
            r.extra.insert("cpu".into(), json!(s(item, "/status/capacity/cpu")));
            r.extra.insert("memory".into(), json!(s(item, "/status/capacity/memory")));
            r.extra.insert("unschedulable".into(), json!(unschedulable));
            let internal = item
                .pointer("/status/addresses")
                .and_then(Value::as_array)
                .and_then(|list| list.iter().find(|a| s(a, "/type") == "InternalIP").map(|a| s(a, "/address")))
                .unwrap_or_default();
            r.extra.insert("internalIP".into(), json!(internal));
        }
        "namespaces" => {
            r.status = s(item, "/status/phase");
            r.tone = if r.status == "Active" { "ok" } else { "warn" }.into();
        }
        "events" => {
            let kind_ = s(item, "/type");
            r.status = s(item, "/reason");
            r.tone = if kind_ == "Warning" { "bad" } else { "idle" }.into();
            r.restarts = item.get("count").and_then(Value::as_i64).or_else(|| item.pointer("/series/count").and_then(Value::as_i64));
            let last = [s(item, "/lastTimestamp"), s(item, "/series/lastObservedTime"), s(item, "/eventTime"), s(item, "/metadata/creationTimestamp")]
                .into_iter()
                .find(|t| !t.is_empty())
                .unwrap_or_default();
            r.created = last;
            r.extra.insert("type".into(), json!(kind_));
            r.extra.insert("message".into(), json!(s(item, "/message")));
            r.extra.insert("object".into(), json!(format!("{}/{}", s(item, "/involvedObject/kind").to_lowercase(), s(item, "/involvedObject/name"))));
        }
        _ => {}
    }
    r
}

pub async fn list(target: &KubeTarget, kind: &str) -> Result<Vec<KubeRow>, String> {
    check_kind(kind)?;
    let mut args = vec!["get".to_string(), kind.to_string(), "-o".into(), "json".into(), "--request-timeout=15s".into()];
    if !cluster_scoped(kind) {
        args.extend(target.scope_args(true));
    }
    let out = target.run(args, None, READ_TIMEOUT).await?;
    let doc: Value = serde_json::from_str(&out).map_err(|e| format!("kubectl get {kind}: {e}"))?;
    let mut rows = parse_rows(kind, &doc);
    if kind == "events" {
        rows.sort_by(|a, b| b.created.cmp(&a.created));
        rows.truncate(300);
    } else {
        rows.sort_by(|a, b| a.namespace.cmp(&b.namespace).then(a.name.cmp(&b.name)));
    }
    Ok(rows)
}

/// `describe`, or the object as YAML — a Secret's values masked unless `reveal`.
pub async fn text(target: &KubeTarget, kind: &str, name: &str, what: &str, reveal: bool) -> Result<String, String> {
    check_kind(kind)?;
    check_name(name)?;
    let mut args = match what {
        "describe" => vec!["describe".to_string(), kind.to_string(), name.to_string()],
        "yaml" if kind == "secrets" && !reveal => vec!["get".to_string(), kind.to_string(), name.to_string(), "-o".into(), "json".into()],
        "yaml" => vec!["get".to_string(), kind.to_string(), name.to_string(), "-o".into(), "yaml".into()],
        other => return Err(format!("unknown view {other}")),
    };
    if !cluster_scoped(kind) {
        args.extend(target.scope_args(false));
    }
    let out = target.run(args, None, READ_TIMEOUT).await?;
    if what == "yaml" && kind == "secrets" && !reveal {
        let mut doc: Value = serde_json::from_str(&out).map_err(|e| e.to_string())?;
        for field in ["data", "stringData"] {
            if let Some(map) = doc.get_mut(field).and_then(Value::as_object_mut) {
                for value in map.values_mut() {
                    *value = json!("••••••");
                }
            }
        }
        if let Some(meta) = doc.get_mut("metadata").and_then(Value::as_object_mut) {
            meta.remove("managedFields");
            if let Some(annotations) = meta.get_mut("annotations").and_then(Value::as_object_mut) {
                annotations.remove("kubectl.kubernetes.io/last-applied-configuration");
            }
        }
        return Ok(to_yaml(&doc));
    }
    Ok(out)
}

/// JSON as block YAML — for the one view we rewrite before showing (a masked Secret).
pub fn to_yaml(value: &Value) -> String {
    fn scalar(v: &Value) -> String {
        match v {
            Value::Null => "null".into(),
            Value::Bool(b) => b.to_string(),
            Value::Number(n) => n.to_string(),
            Value::String(s) => {
                let plain = !s.is_empty()
                    && !s.contains([':', '#', '\n', '"', '\'', '{', '}', '[', ']', ',', '&', '*', '!', '|', '>', '%', '@', '`'])
                    && !s.starts_with([' ', '-', '?'])
                    && !s.ends_with(' ')
                    && !matches!(s.as_str(), "true" | "false" | "null" | "yes" | "no" | "~")
                    && s.parse::<f64>().is_err();
                if plain { s.clone() } else { serde_json::to_string(s).unwrap_or_default() }
            }
            _ => String::new(),
        }
    }
    fn walk(v: &Value, indent: usize, out: &mut String) {
        let pad = " ".repeat(indent);
        match v {
            Value::Object(map) => {
                for (key, child) in map {
                    match child {
                        Value::Object(m) if !m.is_empty() => {
                            out.push_str(&format!("{pad}{key}:\n"));
                            walk(child, indent + 2, out);
                        }
                        Value::Array(a) if !a.is_empty() => {
                            out.push_str(&format!("{pad}{key}:\n"));
                            walk(child, indent, out);
                        }
                        Value::Object(_) => out.push_str(&format!("{pad}{key}: {{}}\n")),
                        Value::Array(_) => out.push_str(&format!("{pad}{key}: []\n")),
                        _ => out.push_str(&format!("{pad}{key}: {}\n", scalar(child))),
                    }
                }
            }
            Value::Array(list) => {
                for child in list {
                    match child {
                        Value::Object(m) if !m.is_empty() => {
                            let mut inner = String::new();
                            walk(child, indent + 2, &mut inner);
                            let trimmed = inner.trim_start_matches(' ');
                            out.push_str(&format!("{pad}- {trimmed}"));
                        }
                        Value::Array(_) => {
                            out.push_str(&format!("{pad}-\n"));
                            walk(child, indent + 2, out);
                        }
                        _ => out.push_str(&format!("{pad}- {}\n", scalar(child))),
                    }
                }
            }
            other => out.push_str(&format!("{pad}{}\n", scalar(other))),
        }
    }
    let mut out = String::new();
    walk(value, 0, &mut out);
    out
}

// ---------------------------------------------------------------------------------- acting

/// The command line of one action — its own function so it can be checked without a cluster.
pub fn action_args(target: &KubeTarget, kind: &str, names: &[String], action: &str, options: &Value) -> Result<Vec<String>, String> {
    check_kind(kind)?;
    for name in names {
        check_name(name)?;
    }
    let one = || names.first().cloned().ok_or_else(|| "nothing was chosen".to_string());
    let singular = kind.trim_end_matches('s');
    let mut args: Vec<String> = match action {
        "delete" => {
            if names.is_empty() {
                return Err("nothing was chosen".into());
            }
            let mut a = vec!["delete".to_string(), kind.to_string()];
            a.extend(names.iter().cloned());
            a.push("--wait=false".into());
            a
        }
        "scale" => {
            if !matches!(kind, "deployments" | "statefulsets" | "replicasets") {
                return Err(format!("a {singular} cannot be scaled"));
            }
            let replicas = options.get("replicas").and_then(Value::as_i64).filter(|r| *r >= 0).ok_or("say how many replicas")?;
            vec!["scale".into(), format!("{singular}/{}", one()?), format!("--replicas={replicas}")]
        }
        "restart" => {
            if !matches!(kind, "deployments" | "statefulsets" | "daemonsets") {
                return Err(format!("a {singular} cannot be restarted"));
            }
            vec!["rollout".into(), "restart".into(), format!("{singular}/{}", one()?)]
        }
        "undo" => {
            if !matches!(kind, "deployments" | "statefulsets" | "daemonsets") {
                return Err(format!("a {singular} has no rollout to undo"));
            }
            vec!["rollout".into(), "undo".into(), format!("{singular}/{}", one()?)]
        }
        "suspend" | "resume" => {
            if kind != "cronjobs" {
                return Err("only a CronJob can be suspended".into());
            }
            vec!["patch".into(), "cronjob".into(), one()?, "-p".into(), format!("{{\"spec\":{{\"suspend\":{}}}}}", action == "suspend")]
        }
        "trigger" => {
            if kind != "cronjobs" {
                return Err("only a CronJob can be run now".into());
            }
            let name = one()?;
            let stamp = chrono::Utc::now().format("%m%d%H%M%S");
            let job: String = format!("{}-manual-{stamp}", name.chars().take(40).collect::<String>());
            vec!["create".into(), "job".into(), job, format!("--from=cronjob/{name}")]
        }
        "cordon" | "uncordon" => {
            if kind != "nodes" {
                return Err("only a node can be cordoned".into());
            }
            vec![action.to_string(), one()?]
        }
        other => return Err(format!("unknown action {other}")),
    };
    if !cluster_scoped(kind) {
        if let Some(ns) = target.namespace() {
            args.extend(["-n".into(), ns.into()]);
        } else if let Some(ns) = options.get("namespace").and_then(Value::as_str).filter(|n| !n.is_empty()) {
            args.extend(["-n".into(), ns.into()]);
        }
    }
    Ok(args)
}

pub async fn act(target: &KubeTarget, kind: &str, names: &[String], action: &str, options: &Value) -> Result<String, String> {
    let args = action_args(target, kind, names, action, options)?;
    target.run(args, None, ACTION_TIMEOUT).await.map(|o| o.trim().to_string())
}

/// `kubectl apply -f -` with the given manifest.
pub async fn apply(target: &KubeTarget, manifest: &str) -> Result<String, String> {
    if manifest.trim().is_empty() {
        return Err("the manifest is empty".into());
    }
    let mut args = vec!["apply".to_string(), "-f".into(), "-".into()];
    if let Some(ns) = target.namespace() {
        args.extend(["-n".into(), ns.into()]);
    }
    target.run(args, Some(manifest), ACTION_TIMEOUT).await.map(|o| o.trim().to_string())
}

/// A pod's logs, read once — for flow nodes (the panel streams them in a terminal instead).
pub async fn logs(target: &KubeTarget, pod: &str, container: Option<&str>, tail: u32, previous: bool) -> Result<String, String> {
    check_name(pod)?;
    let mut args = vec!["logs".to_string(), pod.to_string(), format!("--tail={tail}")];
    if let Some(c) = container.filter(|c| !c.trim().is_empty()) {
        args.extend(["-c".into(), c.trim().to_string()]);
    }
    if previous {
        args.push("--previous".into());
    }
    args.extend(target.scope_args(false));
    target.run(args, None, READ_TIMEOUT).await
}

/// One command inside a pod, waited for. `mark` (`NAME=value`) goes into its environment — every
/// process it starts inherits it, which is how they are found again if the wait is cut short.
pub async fn exec(target: &KubeTarget, pod: &str, container: Option<&str>, command: &str, mark: Option<&str>, timeout: Duration) -> Result<cli::Output, String> {
    check_name(pod)?;
    let mut args = target.context_args();
    args.extend(["exec".to_string(), pod.to_string()]);
    if let Some(c) = container.filter(|c| !c.trim().is_empty()) {
        args.extend(["-c".into(), c.trim().to_string()]);
    }
    args.extend(target.scope_args(false));
    args.push("--".into());
    if let Some(mark) = mark {
        // `kubectl exec` has no `--env`: `env` sets it, and runs the command as it was written.
        args.extend(["env".into(), mark.to_string()]);
    }
    args.extend(["sh".into(), "-c".into(), command.to_string()]);
    cli::run(&program(), &args, None, timeout).await
}

/// Waits for a rollout to finish (or `timeout` to pass).
pub async fn rollout_status(target: &KubeTarget, kind: &str, name: &str, timeout_sec: u64) -> Result<String, String> {
    check_name(name)?;
    let singular = kind.trim_end_matches('s');
    let mut args = vec!["rollout".to_string(), "status".into(), format!("{singular}/{name}"), format!("--timeout={timeout_sec}s")];
    args.extend(target.scope_args(false));
    target.run(args, None, Duration::from_secs(timeout_sec + 15)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pod(json_text: &str) -> Value {
        serde_json::from_str(json_text).unwrap()
    }

    #[test]
    fn pod_status_reads_like_kubectl() {
        let crash = pod(r#"{"metadata":{"name":"api-1","namespace":"shop"},"spec":{"containers":[{"name":"api","image":"api:1"}]},"status":{"phase":"Running","containerStatuses":[{"name":"api","ready":false,"restartCount":7,"state":{"waiting":{"reason":"CrashLoopBackOff"}}}]}}"#);
        assert_eq!(pod_status(&crash), "CrashLoopBackOff");
        let r = row("pods", &crash);
        assert_eq!(r.ready, "0/1");
        assert_eq!(r.restarts, Some(7));
        assert_eq!(r.tone, "bad");

        let fine = pod(r#"{"metadata":{"name":"web"},"spec":{"containers":[{"name":"a"},{"name":"b"}]},"status":{"phase":"Running","containerStatuses":[{"name":"a","ready":true,"restartCount":0,"state":{"running":{}}},{"name":"b","ready":true,"restartCount":1,"state":{"running":{}}}]}}"#);
        assert_eq!(pod_status(&fine), "Running");
        assert_eq!(row("pods", &fine).ready, "2/2");

        let init = pod(r#"{"metadata":{"name":"x"},"spec":{"containers":[{"name":"a"}]},"status":{"phase":"Pending","initContainerStatuses":[{"name":"migrate","state":{"running":{}}}]}}"#);
        assert_eq!(pod_status(&init), "Init:0/1");

        let gone = pod(r#"{"metadata":{"name":"x","deletionTimestamp":"2026-10-07T00:00:00Z"},"status":{"phase":"Running"}}"#);
        assert_eq!(pod_status(&gone), "Terminating");

        let oom = pod(r#"{"metadata":{"name":"x"},"spec":{"containers":[{"name":"a"}]},"status":{"phase":"Running","containerStatuses":[{"name":"a","ready":false,"state":{"terminated":{"reason":"OOMKilled","exitCode":137}}}]}}"#);
        assert_eq!(pod_status(&oom), "OOMKilled");
    }

    #[test]
    fn deployments_services_and_nodes() {
        let deploy = pod(r#"{"metadata":{"name":"api","namespace":"shop"},"spec":{"replicas":3,"template":{"spec":{"containers":[{"name":"api","image":"ghcr.io/me/api:2"}]}}},"status":{"readyReplicas":1,"updatedReplicas":3,"availableReplicas":1}}"#);
        let r = row("deployments", &deploy);
        assert_eq!(r.ready, "1/3");
        assert_eq!(r.tone, "warn");
        assert_eq!(r.extra["images"], json!(["ghcr.io/me/api:2"]));

        let svc = pod(r#"{"metadata":{"name":"api"},"spec":{"type":"ClusterIP","clusterIP":"10.0.0.5","ports":[{"port":80,"targetPort":8080,"protocol":"TCP"}],"selector":{"app":"api"}}}"#);
        let r = row("services", &svc);
        assert_eq!(r.status, "ClusterIP");
        assert_eq!(r.extra["ports"][0]["port"], 80);

        let node = pod(r#"{"metadata":{"name":"n1","labels":{"node-role.kubernetes.io/control-plane":""}},"spec":{"unschedulable":true},"status":{"conditions":[{"type":"Ready","status":"True"}],"nodeInfo":{"kubeletVersion":"v1.33.1","operatingSystem":"linux","architecture":"arm64"}}}"#);
        let r = row("nodes", &node);
        assert_eq!(r.status, "Ready,SchedulingDisabled");
        assert_eq!(r.extra["roles"], json!(["control-plane"]));
    }

    #[test]
    fn secrets_never_carry_values_into_rows() {
        let secret = pod(r#"{"metadata":{"name":"db"},"type":"Opaque","data":{"password":"c2VjcmV0"}}"#);
        let r = row("secrets", &secret);
        assert_eq!(r.extra["keys"], json!(["password"]));
        assert!(!serde_json::to_string(&r).unwrap().contains("c2VjcmV0"));
    }

    #[test]
    fn config_view_contexts() {
        let doc = pod(r#"{"contexts":[{"name":"orbstack","context":{"cluster":"orbstack","user":"orbstack"}},{"name":"prod","context":{"cluster":"eks","user":"me","namespace":"shop"}}],"current-context":"orbstack"}"#);
        let (contexts, current) = parse_config_view(&doc);
        assert_eq!(contexts.len(), 2);
        assert_eq!(contexts[1].namespace, "shop");
        assert_eq!(current.as_deref(), Some("orbstack"));
    }

    #[test]
    fn action_lines() {
        let target = KubeTarget { context: Some("orbstack".into()), namespace: Some("shop".into()) };
        assert_eq!(action_args(&target, "deployments", &["api".into()], "scale", &json!({"replicas": 2})).unwrap(), vec!["scale", "deployment/api", "--replicas=2", "-n", "shop"]);
        assert_eq!(action_args(&target, "deployments", &["api".into()], "restart", &json!({})).unwrap(), vec!["rollout", "restart", "deployment/api", "-n", "shop"]);
        assert_eq!(action_args(&target, "pods", &["a".into(), "b".into()], "delete", &json!({})).unwrap(), vec!["delete", "pods", "a", "b", "--wait=false", "-n", "shop"]);
        assert_eq!(action_args(&target, "nodes", &["n1".into()], "cordon", &json!({})).unwrap(), vec!["cordon", "n1"]);
        assert!(action_args(&target, "pods", &["a".into()], "scale", &json!({"replicas": 1})).is_err());
        assert!(action_args(&target, "pods", &["--all".into()], "delete", &json!({})).is_err(), "a name never becomes a flag");
        let all = KubeTarget { context: None, namespace: None };
        assert_eq!(action_args(&all, "pods", &["a".into()], "delete", &json!({"namespace": "kube-system"})).unwrap(), vec!["delete", "pods", "a", "--wait=false", "-n", "kube-system"]);
        let suspend = action_args(&target, "cronjobs", &["nightly".into()], "suspend", &json!({})).unwrap();
        assert_eq!(suspend[3], "-p");
        assert_eq!(suspend[4], "{\"spec\":{\"suspend\":true}}");
    }

    #[test]
    fn yaml_of_a_masked_secret() {
        let yaml = to_yaml(&json!({"apiVersion": "v1", "kind": "Secret", "data": {"password": "••••••"}, "metadata": {"name": "db", "labels": {"app": "shop"}}, "list": [{"a": 1, "b": "x: y"}, "plain"]}));
        assert!(yaml.contains("kind: Secret\n"));
        assert!(yaml.contains("data:\n  password: ••••••\n"));
        assert!(yaml.contains("- a: 1\n  b: \"x: y\"\n"), "{yaml}");
        assert!(yaml.contains("- plain\n"));
    }
}
