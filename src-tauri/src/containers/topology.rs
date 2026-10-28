//! How a cluster's objects hang together — read, never changed. An ingress routes to services, a
//! service selects pods, a workload owns them, a pod template mounts ConfigMaps, Secrets and claims,
//! an autoscaler scales a workload. The panel draws it as a graph; the AI reads it as text.
//!
//! Every edge comes from the objects themselves (`ownerReferences`, selectors, the pod template), so
//! the graph is what Kubernetes does, not a guess. ReplicaSets and a CronJob's Jobs fold into the
//! workload that owns them — they are how a rollout happens, not part of what the app is.
//!
//! **No Secret or ConfigMap is read.** Their names are listed (`custom-columns`, names only) to tell a
//! reference to one that does not exist; their data never leaves kubectl.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use super::kube::{self, KubeTarget};

const READ_TIMEOUT: Duration = Duration::from_secs(25);

/// The kinds read for the graph, as `kubectl get` names them.
const KINDS: &[&str] = &[
    "ingresses",
    "services",
    "deployments",
    "statefulsets",
    "daemonsets",
    "replicasets",
    "pods",
    "jobs",
    "cronjobs",
    "persistentvolumeclaims",
    "horizontalpodautoscalers",
];

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TopoNode {
    /// `kind/namespace/name`.
    pub id: String,
    pub kind: String,
    pub name: String,
    pub namespace: String,
    pub status: String,
    pub tone: String,
    pub ready: String,
    /// One more line worth showing: a service's type and ports, an ingress's hosts.
    pub detail: String,
    /// Referenced, but not in the cluster.
    pub missing: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct TopoEdge {
    pub from: String,
    pub to: String,
    /// `routes`, `selects`, `owns`, `mounts`, `env`, `pull`, `claims`, `scales`.
    pub kind: String,
    pub label: String,
}

/// Something the graph shows to be wrong. `code`: `noPods` (a service selects nothing),
/// `missing` (a reference to an object that is not there), `failing` (pods that are not running).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TopoIssue {
    pub node: String,
    pub code: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Topology {
    pub nodes: Vec<TopoNode>,
    pub edges: Vec<TopoEdge>,
    pub issues: Vec<TopoIssue>,
    /// Kinds that could not be read (RBAC, an old cluster), with kubectl's reason.
    pub warnings: Vec<String>,
}

fn s(value: &Value, pointer: &str) -> String {
    match value.pointer(pointer) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => String::new(),
    }
}

fn list<'a>(value: &'a Value, pointer: &str) -> impl Iterator<Item = &'a Value> {
    value.pointer(pointer).and_then(Value::as_array).into_iter().flatten()
}

pub fn node_id(kind: &str, namespace: &str, name: &str) -> String {
    format!("{kind}/{namespace}/{name}")
}

/// `ReplicaSet` → `replicasets`: the owner's kind as the panel names kinds.
fn plural(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "ReplicaSet" => "replicasets",
        "Deployment" => "deployments",
        "StatefulSet" => "statefulsets",
        "DaemonSet" => "daemonsets",
        "Job" => "jobs",
        "CronJob" => "cronjobs",
        "Pod" => "pods",
        "Service" => "services",
        _ => return None,
    })
}

fn labels(item: &Value) -> BTreeMap<String, String> {
    item.pointer("/metadata/labels")
        .and_then(Value::as_object)
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string())).collect())
        .unwrap_or_default()
}

/// The pod template of a workload (a bare pod is its own).
fn pod_spec<'a>(kind: &str, item: &'a Value) -> Option<&'a Value> {
    match kind {
        "pods" => item.get("spec"),
        "cronjobs" => item.pointer("/spec/jobTemplate/spec/template/spec"),
        _ => item.pointer("/spec/template/spec"),
    }
}

/// What a pod template refers to: `(kind, name, via, optional)`.
pub fn pod_refs(spec: &Value) -> Vec<(&'static str, String, &'static str, bool)> {
    let mut out = Vec::new();
    let optional = |v: &Value| v.get("optional").and_then(Value::as_bool).unwrap_or(false);
    for volume in list(spec, "/volumes") {
        if let Some(cm) = volume.get("configMap") {
            out.push(("configmaps", s(cm, "/name"), "mounts", optional(cm)));
        }
        if let Some(secret) = volume.get("secret") {
            out.push(("secrets", s(secret, "/secretName"), "mounts", optional(secret)));
        }
        if let Some(claim) = volume.get("persistentVolumeClaim") {
            out.push(("persistentvolumeclaims", s(claim, "/claimName"), "mounts", false));
        }
        for source in list(volume, "/projected/sources") {
            if let Some(cm) = source.get("configMap") {
                out.push(("configmaps", s(cm, "/name"), "mounts", optional(cm)));
            }
            if let Some(secret) = source.get("secret") {
                out.push(("secrets", s(secret, "/name"), "mounts", optional(secret)));
            }
        }
    }
    for group in ["/containers", "/initContainers"] {
        for container in list(spec, group) {
            for env in list(container, "/env") {
                if let Some(r) = env.pointer("/valueFrom/configMapKeyRef") {
                    out.push(("configmaps", s(r, "/name"), "env", optional(r)));
                }
                if let Some(r) = env.pointer("/valueFrom/secretKeyRef") {
                    out.push(("secrets", s(r, "/name"), "env", optional(r)));
                }
            }
            for from in list(container, "/envFrom") {
                if let Some(r) = from.get("configMapRef") {
                    out.push(("configmaps", s(r, "/name"), "env", optional(r)));
                }
                if let Some(r) = from.get("secretRef") {
                    out.push(("secrets", s(r, "/name"), "env", optional(r)));
                }
            }
        }
    }
    for pull in list(spec, "/imagePullSecrets") {
        out.push(("secrets", s(pull, "/name"), "pull", false));
    }
    out.retain(|(_, name, _, _)| !name.is_empty());
    out.sort();
    out.dedup();
    out
}

/// What kubectl answered, kind by kind — `None` for a kind it could not read.
pub struct Read {
    pub items: HashMap<&'static str, Vec<Value>>,
    /// `namespace/name` of the ConfigMaps and Secrets there are; `None` when they could not be listed.
    pub configmaps: Option<BTreeSet<String>>,
    pub secrets: Option<BTreeSet<String>>,
    pub warnings: Vec<String>,
}

fn names_args(kind: &str, target: &KubeTarget) -> Vec<String> {
    let mut args = vec!["get".to_string(), kind.to_string(), "-o".into(), "custom-columns=NS:.metadata.namespace,NAME:.metadata.name".into(), "--no-headers".into(), "--request-timeout=15s".into()];
    args.extend(target.scope_args(true));
    args
}

fn parse_names(out: &str) -> BTreeSet<String> {
    out.lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            Some(format!("{}/{}", parts.next()?, parts.next()?))
        })
        .collect()
}

pub async fn read(target: &KubeTarget) -> Read {
    let lists = futures_util::future::join_all(KINDS.iter().map(|kind| async move {
        let mut args = vec!["get".to_string(), kind.to_string(), "-o".into(), "json".into(), "--request-timeout=15s".into()];
        args.extend(target.scope_args(true));
        let answer = target.run(args, None, READ_TIMEOUT).await.and_then(|out| serde_json::from_str::<Value>(&out).map_err(|e| e.to_string()));
        (*kind, answer)
    }));
    let names = futures_util::future::join_all(["configmaps", "secrets"].into_iter().map(|kind| async move { target.run(names_args(kind, target), None, READ_TIMEOUT).await.map(|out| parse_names(&out)) }));
    let (lists, mut names) = tokio::join!(lists, names);
    let mut read = Read { items: HashMap::new(), configmaps: None, secrets: None, warnings: Vec::new() };
    for (kind, answer) in lists {
        match answer {
            Ok(doc) => {
                read.items.insert(kind, doc.get("items").and_then(Value::as_array).cloned().unwrap_or_default());
            }
            Err(error) => read.warnings.push(format!("{kind}: {error}")),
        }
    }
    let secrets = names.pop();
    let configmaps = names.pop();
    match configmaps {
        Some(Ok(set)) => read.configmaps = Some(set),
        Some(Err(error)) => read.warnings.push(format!("configmaps: {error}")),
        None => {}
    }
    match secrets {
        Some(Ok(set)) => read.secrets = Some(set),
        Some(Err(error)) => read.warnings.push(format!("secrets: {error}")),
        None => {}
    }
    read
}

pub async fn topology(target: &KubeTarget) -> Topology {
    build(read(target).await)
}

/// The graph of what was read — its own function, so it can be checked without a cluster.
pub fn build(read: Read) -> Topology {
    let empty = Vec::new();
    let items = |kind: &str| read.items.get(kind).unwrap_or(&empty);
    let mut topo = Topology { warnings: read.warnings.clone(), ..Default::default() };
    let mut ids: BTreeSet<String> = BTreeSet::new();
    let key = |kind: &str, item: &Value| node_id(kind, &s(item, "/metadata/namespace"), &s(item, "/metadata/name"));

    // Who owns whom, one step: `kind/ns/name` → the owner's id.
    let mut owner_of: HashMap<String, String> = HashMap::new();
    for kind in KINDS {
        for item in items(kind) {
            if let Some(owner) = item.pointer("/metadata/ownerReferences/0") {
                if let Some(owner_kind) = plural(&s(owner, "/kind")) {
                    owner_of.insert(key(kind, item), node_id(owner_kind, &s(item, "/metadata/namespace"), &s(owner, "/name")));
                }
            }
        }
    }
    let present: BTreeSet<String> = KINDS.iter().flat_map(|kind| items(kind).iter().map(|i| key(kind, i)).collect::<Vec<_>>()).collect();
    // A pod's workload: up the owners while the owner is there (RS → Deployment, Job → CronJob).
    let top = |id: &str| {
        let mut at = id.to_string();
        for _ in 0..4 {
            match owner_of.get(&at) {
                Some(owner) if present.contains(owner) => at = owner.clone(),
                _ => break,
            }
        }
        at
    };

    fn push(topo: &mut Topology, ids: &mut BTreeSet<String>, kind: &str, item: &Value, detail: String) {
        let row = kube::row(kind, item);
        let id = node_id(kind, &row.namespace, &row.name);
        ids.insert(id.clone());
        topo.nodes.push(TopoNode { id, kind: kind.to_string(), name: row.name, namespace: row.namespace, status: row.status, tone: row.tone, ready: row.ready, detail, missing: false });
    }

    for kind in ["deployments", "statefulsets", "daemonsets", "cronjobs"] {
        for item in items(kind) {
            push(&mut topo, &mut ids, kind, item, String::new());
        }
    }
    // A ReplicaSet or Job of its own is a workload; one a Deployment or CronJob owns folds into it.
    for kind in ["replicasets", "jobs"] {
        for item in items(kind) {
            let id = key(kind, item);
            if top(&id) == id {
                push(&mut topo, &mut ids, kind, item, String::new());
            }
        }
    }
    let pods = items("pods");
    let mut pods_of: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    for pod in pods {
        let id = key("pods", pod);
        let workload = top(&id);
        let row = kube::row("pods", pod);
        push(&mut topo, &mut ids, "pods", pod, s(pod, "/spec/nodeName"));
        if workload != id {
            topo.edges.push(TopoEdge { from: workload.clone(), to: id, kind: "owns".into(), label: String::new() });
            let entry = pods_of.entry(workload).or_default();
            entry.0 += 1;
            if row.tone == "bad" {
                entry.1 += 1;
            }
        }
    }
    for (workload, (total, failing)) in &pods_of {
        if *failing > 0 {
            topo.issues.push(TopoIssue { node: workload.clone(), code: "failing".into(), detail: format!("{failing}/{total}") });
        }
    }

    for item in items("services") {
        let ports: Vec<String> = list(item, "/spec/ports")
            .map(|p| {
                let target = p.get("targetPort").map(|t| t.as_str().map(str::to_string).unwrap_or_else(|| t.to_string())).unwrap_or_default();
                if target.is_empty() || target == s(p, "/port") { s(p, "/port") } else { format!("{}→{target}", s(p, "/port")) }
            })
            .collect();
        let kind_ = s(item, "/spec/type");
        let external = s(item, "/spec/externalName");
        let detail = [kind_.clone(), ports.join(", "), external.clone()].into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" · ");
        push(&mut topo, &mut ids, "services", item, detail);
        let id = key("services", item);
        let namespace = s(item, "/metadata/namespace");
        let selector: BTreeMap<String, String> = item
            .pointer("/spec/selector")
            .and_then(Value::as_object)
            .map(|m| m.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string())).collect())
            .unwrap_or_default();
        if selector.is_empty() || kind_ == "ExternalName" {
            continue;
        }
        let mut targets: BTreeSet<String> = BTreeSet::new();
        for pod in pods.iter().filter(|p| s(p, "/metadata/namespace") == namespace) {
            let pod_labels = labels(pod);
            if selector.iter().all(|(k, v)| pod_labels.get(k) == Some(v)) {
                targets.insert(top(&key("pods", pod)));
            }
        }
        if targets.is_empty() {
            let wanted = selector.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(",");
            topo.issues.push(TopoIssue { node: id.clone(), code: "noPods".into(), detail: wanted });
        }
        for to in targets {
            topo.edges.push(TopoEdge { from: id.clone(), to, kind: "selects".into(), label: ports.join(", ") });
        }
    }

    // References to objects that may not be there: made nodes of, flagged when known to be missing.
    type Wanted = BTreeMap<String, (String, String, String, bool)>;
    #[allow(clippy::too_many_arguments)]
    fn want(topo: &mut Topology, wanted: &mut Wanted, from: &str, kind: &str, namespace: &str, name: &str, via: &str, label: String, optional: bool) {
        let to = node_id(kind, namespace, name);
        topo.edges.push(TopoEdge { from: from.to_string(), to: to.clone(), kind: via.to_string(), label });
        let entry = wanted.entry(to).or_insert_with(|| (kind.to_string(), namespace.to_string(), name.to_string(), true));
        entry.3 &= optional;
    }
    let mut wanted: Wanted = BTreeMap::new();

    for item in items("ingresses") {
        let hosts: Vec<String> = list(item, "/spec/rules").map(|r| s(r, "/host")).filter(|h| !h.is_empty()).collect();
        push(&mut topo, &mut ids, "ingresses", item, hosts.join(", "));
        let id = key("ingresses", item);
        let namespace = s(item, "/metadata/namespace");
        let backend = |b: &Value| {
            let name = s(b, "/service/name");
            let port = { let n = s(b, "/service/port/number"); if n.is_empty() { s(b, "/service/port/name") } else { n } };
            (name, port)
        };
        if let Some(default) = item.pointer("/spec/defaultBackend") {
            let (name, port) = backend(default);
            if !name.is_empty() {
                want(&mut topo, &mut wanted, &id, "services", &namespace, &name, "routes", format!("* :{port}"), false);
            }
        }
        for rule in list(item, "/spec/rules") {
            let host = s(rule, "/host");
            for path in list(rule, "/http/paths") {
                let (name, port) = backend(path.get("backend").unwrap_or(&Value::Null));
                if name.is_empty() {
                    continue;
                }
                let label = format!("{}{}{}", if host.is_empty() { "*" } else { &host }, s(path, "/path"), if port.is_empty() { String::new() } else { format!(" :{port}") });
                want(&mut topo, &mut wanted, &id, "services", &namespace, &name, "routes", label, false);
            }
        }
    }

    // What each pod template refers to, from its workload — or the pod, when it has none.
    let claims: Vec<(String, String)> = items("persistentvolumeclaims").iter().map(|c| (s(c, "/metadata/namespace"), s(c, "/metadata/name"))).collect();
    for kind in ["deployments", "statefulsets", "daemonsets", "cronjobs", "replicasets", "jobs", "pods"] {
        for item in items(kind) {
            let id = key(kind, item);
            if !ids.contains(&id) || (kind == "pods" && top(&id) != id) {
                continue;
            }
            let namespace = s(item, "/metadata/namespace");
            if let Some(spec) = pod_spec(kind, item) {
                for (ref_kind, name, via, optional) in pod_refs(spec) {
                    want(&mut topo, &mut wanted, &id, ref_kind, &namespace, &name, via, String::new(), optional);
                }
            }
            if kind == "statefulsets" {
                let name = s(item, "/metadata/name");
                for template in list(item, "/spec/volumeClaimTemplates") {
                    let prefix = format!("{}-{name}-", s(template, "/metadata/name"));
                    for (ns, claim) in claims.iter().filter(|(ns, claim)| *ns == namespace && claim.starts_with(&prefix)) {
                        want(&mut topo, &mut wanted, &id, "persistentvolumeclaims", ns, claim, "claims", String::new(), true);
                    }
                }
            }
        }
    }

    for item in items("persistentvolumeclaims") {
        let detail = [s(item, "/status/capacity/storage"), s(item, "/spec/storageClassName")].into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" · ");
        push(&mut topo, &mut ids, "persistentvolumeclaims", item, detail);
    }

    for item in items("horizontalpodautoscalers") {
        let row_detail = format!("{}–{}", s(item, "/spec/minReplicas"), s(item, "/spec/maxReplicas"));
        let id = key("horizontalpodautoscalers", item);
        ids.insert(id.clone());
        topo.nodes.push(TopoNode {
            id: id.clone(),
            kind: "horizontalpodautoscalers".into(),
            name: s(item, "/metadata/name"),
            namespace: s(item, "/metadata/namespace"),
            status: format!("{}/{}", s(item, "/status/currentReplicas"), s(item, "/status/desiredReplicas")),
            tone: "ok".into(),
            ready: String::new(),
            detail: row_detail.clone(),
            missing: false,
        });
        if let Some(target_kind) = plural(&s(item, "/spec/scaleTargetRef/kind")) {
            let name = s(item, "/spec/scaleTargetRef/name");
            want(&mut topo, &mut wanted, &id, target_kind, &s(item, "/metadata/namespace"), &name, "scales", row_detail, false);
        }
    }

    for (id, (kind, namespace, name, optional)) in wanted {
        if ids.contains(&id) {
            continue;
        }
        let known = match kind.as_str() {
            "configmaps" => read.configmaps.as_ref().map(|set| set.contains(&format!("{namespace}/{name}"))),
            "secrets" => read.secrets.as_ref().map(|set| set.contains(&format!("{namespace}/{name}"))),
            // The kinds read in full: what is not among them is not there — unless the kind could
            // not be read at all.
            other => read.items.contains_key(other).then_some(false),
        };
        let missing = known == Some(false);
        if missing && !optional {
            topo.issues.push(TopoIssue { node: id.clone(), code: "missing".into(), detail: String::new() });
        }
        ids.insert(id.clone());
        topo.nodes.push(TopoNode {
            id,
            kind,
            name,
            namespace,
            status: String::new(),
            tone: if missing && !optional { "bad" } else { "idle" }.into(),
            ready: String::new(),
            detail: String::new(),
            missing,
        });
    }

    topo.edges.sort();
    topo.edges.dedup();
    topo.nodes.sort_by(|a, b| (a.namespace.as_str(), a.kind.as_str(), a.name.as_str()).cmp(&(b.namespace.as_str(), b.kind.as_str(), b.name.as_str())));
    topo
}

/// The graph as lines for a model: per namespace, each object with its state and what it points at.
/// Pods are summarised under their workload unless they are failing.
pub fn topology_text(topo: &Topology) -> String {
    let mut out = String::new();
    if !topo.warnings.is_empty() {
        out.push_str("Not readable (left out): ");
        out.push_str(&topo.warnings.join("; "));
        out.push('\n');
    }
    let by_id: HashMap<&str, &TopoNode> = topo.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
    let short = |id: &str| by_id.get(id).map(|n| format!("{}/{}", n.kind, n.name)).unwrap_or_else(|| id.to_string());
    let mut namespaces: Vec<&str> = topo.nodes.iter().map(|n| n.namespace.as_str()).collect();
    namespaces.sort();
    namespaces.dedup();
    for namespace in namespaces {
        out.push_str(&format!("\nnamespace {}\n", if namespace.is_empty() { "-" } else { namespace }));
        for node in topo.nodes.iter().filter(|n| n.namespace == namespace) {
            if node.kind == "pods" && node.tone != "bad" && topo.edges.iter().any(|e| e.kind == "owns" && e.to == node.id) {
                continue;
            }
            let state = [node.status.as_str(), node.ready.as_str(), node.detail.as_str()].into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" · ");
            out.push_str(&format!("- {}/{}{}{}\n", node.kind, node.name, if state.is_empty() { String::new() } else { format!(" [{state}]") }, if node.missing { " (MISSING)" } else { "" }));
            let pods = topo.edges.iter().filter(|e| e.from == node.id && e.kind == "owns").count();
            if pods > 0 {
                out.push_str(&format!("    owns {pods} pod(s)\n"));
            }
            for edge in topo.edges.iter().filter(|e| e.from == node.id && e.kind != "owns") {
                out.push_str(&format!("    {} → {}{}\n", edge.kind, short(&edge.to), if edge.label.is_empty() { String::new() } else { format!(" ({})", edge.label) }));
            }
        }
    }
    if !topo.issues.is_empty() {
        out.push_str("\nProblems:\n");
        for issue in &topo.issues {
            let what = match issue.code.as_str() {
                "noPods" => format!("selects no pod (selector {})", issue.detail),
                "missing" => "is referenced but does not exist".to_string(),
                "failing" => format!("{} pods failing", issue.detail),
                other => other.to_string(),
            };
            out.push_str(&format!("- {} {what}\n", short(&issue.node)));
        }
    }
    crate::secret_scan::redact(&out).0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> Read {
        let mut items: HashMap<&'static str, Vec<Value>> = HashMap::new();
        items.insert(
            "ingresses",
            vec![json!({"metadata": {"name": "web", "namespace": "shop"}, "spec": {"rules": [{"host": "shop.example.test", "http": {"paths": [
                {"path": "/api", "backend": {"service": {"name": "api", "port": {"number": 80}}}},
                {"path": "/old", "backend": {"service": {"name": "gone", "port": {"number": 80}}}}
            ]}}]}})],
        );
        items.insert(
            "services",
            vec![
                json!({"metadata": {"name": "api", "namespace": "shop"}, "spec": {"type": "ClusterIP", "selector": {"app": "api"}, "ports": [{"port": 80, "targetPort": 8080}]}}),
                json!({"metadata": {"name": "orphan", "namespace": "shop"}, "spec": {"type": "ClusterIP", "selector": {"app": "nothing"}, "ports": [{"port": 80}]}}),
            ],
        );
        items.insert(
            "deployments",
            vec![json!({"metadata": {"name": "api", "namespace": "shop"}, "spec": {"replicas": 2, "template": {"spec": {
                "containers": [{"name": "api", "image": "api:1", "envFrom": [{"configMapRef": {"name": "api-config"}}], "env": [{"name": "DB_PASSWORD", "valueFrom": {"secretKeyRef": {"name": "db"}}}]}],
                "volumes": [{"name": "data", "persistentVolumeClaim": {"claimName": "uploads"}}]
            }}}, "status": {"readyReplicas": 1}})],
        );
        items.insert("replicasets", vec![json!({"metadata": {"name": "api-7d", "namespace": "shop", "ownerReferences": [{"kind": "Deployment", "name": "api"}]}, "spec": {"replicas": 2}})]);
        items.insert(
            "pods",
            vec![
                json!({"metadata": {"name": "api-7d-a", "namespace": "shop", "labels": {"app": "api"}, "ownerReferences": [{"kind": "ReplicaSet", "name": "api-7d"}]}, "spec": {"containers": [{"name": "api"}]}, "status": {"phase": "Running", "containerStatuses": [{"name": "api", "ready": true, "state": {"running": {}}}]}}),
                json!({"metadata": {"name": "api-7d-b", "namespace": "shop", "labels": {"app": "api"}, "ownerReferences": [{"kind": "ReplicaSet", "name": "api-7d"}]}, "spec": {"containers": [{"name": "api"}]}, "status": {"phase": "Running", "containerStatuses": [{"name": "api", "ready": false, "state": {"waiting": {"reason": "CrashLoopBackOff"}}}]}}),
            ],
        );
        items.insert("jobs", vec![]);
        items.insert("cronjobs", vec![]);
        items.insert("statefulsets", vec![]);
        items.insert("daemonsets", vec![]);
        items.insert("persistentvolumeclaims", vec![]);
        items.insert(
            "horizontalpodautoscalers",
            vec![json!({"metadata": {"name": "api", "namespace": "shop"}, "spec": {"minReplicas": 2, "maxReplicas": 5, "scaleTargetRef": {"kind": "Deployment", "name": "api"}}, "status": {"currentReplicas": 2, "desiredReplicas": 2}})],
        );
        Read {
            items,
            configmaps: Some(["shop/api-config".to_string()].into_iter().collect()),
            secrets: Some(BTreeSet::new()),
            warnings: vec![],
        }
    }

    fn has(topo: &Topology, from: &str, to: &str, kind: &str) -> bool {
        topo.edges.iter().any(|e| e.from == from && e.to == to && e.kind == kind)
    }

    #[test]
    fn edges_follow_routes_selectors_owners_and_the_pod_template() {
        let topo = build(fixture());
        assert!(has(&topo, "ingresses/shop/web", "services/shop/api", "routes"));
        assert!(has(&topo, "services/shop/api", "deployments/shop/api", "selects"), "a service selects the workload, not its ReplicaSet: {:?}", topo.edges);
        assert!(has(&topo, "deployments/shop/api", "pods/shop/api-7d-a", "owns"));
        assert!(has(&topo, "deployments/shop/api", "configmaps/shop/api-config", "env"));
        assert!(has(&topo, "deployments/shop/api", "secrets/shop/db", "env"));
        assert!(has(&topo, "deployments/shop/api", "persistentvolumeclaims/shop/uploads", "mounts"));
        assert!(has(&topo, "horizontalpodautoscalers/shop/api", "deployments/shop/api", "scales"));
        assert!(!topo.nodes.iter().any(|n| n.kind == "replicasets"), "an owned ReplicaSet folds into its Deployment");
        let route = topo.edges.iter().find(|e| e.kind == "routes" && e.to == "services/shop/api").unwrap();
        assert_eq!(route.label, "shop.example.test/api :80");
    }

    #[test]
    fn problems_are_named() {
        let topo = build(fixture());
        let codes = |node: &str| topo.issues.iter().filter(|i| i.node == node).map(|i| i.code.as_str()).collect::<Vec<_>>();
        assert_eq!(codes("services/shop/orphan"), vec!["noPods"]);
        assert_eq!(codes("services/shop/gone"), vec!["missing"]);
        assert_eq!(codes("secrets/shop/db"), vec!["missing"]);
        assert!(codes("configmaps/shop/api-config").is_empty());
        assert_eq!(codes("deployments/shop/api"), vec!["failing"]);
        assert!(topo.nodes.iter().find(|n| n.id == "services/shop/gone").unwrap().missing);
    }

    #[test]
    fn an_unreadable_kind_is_never_called_missing() {
        let mut read = fixture();
        read.secrets = None;
        read.items.remove("persistentvolumeclaims");
        let topo = build(read);
        assert!(!topo.issues.iter().any(|i| i.node == "secrets/shop/db" || i.node == "persistentvolumeclaims/shop/uploads"));
    }

    #[test]
    fn the_text_names_each_link_and_never_a_value() {
        let text = topology_text(&build(fixture()));
        assert!(text.contains("namespace shop"));
        assert!(text.contains("- deployments/api [Progressing · 1/2]"), "{text}");
        assert!(text.contains("owns 2 pod(s)"));
        assert!(text.contains("routes → services/api (shop.example.test/api :80)"));
        assert!(text.contains("pods/api-7d-b"), "a failing pod is listed on its own");
        assert!(!text.contains("pods/api-7d-a"), "a healthy owned pod is only counted");
        assert!(text.contains("services/orphan selects no pod (selector app=nothing)"));
    }

    #[test]
    fn pod_refs_reads_every_place_a_reference_can_be() {
        let spec = json!({
            "volumes": [{"projected": {"sources": [{"configMap": {"name": "a"}}, {"secret": {"name": "b"}}]}}, {"secret": {"secretName": "c", "optional": true}}],
            "initContainers": [{"env": [{"valueFrom": {"configMapKeyRef": {"name": "d"}}}]}],
            "imagePullSecrets": [{"name": "registry"}]
        });
        let refs = pod_refs(&spec);
        let names: Vec<&str> = refs.iter().map(|r| r.1.as_str()).collect();
        assert_eq!(names, vec!["a", "d", "b", "c", "registry"]);
        assert!(refs.iter().any(|r| r.1 == "c" && r.3), "optional is kept");
    }
}
