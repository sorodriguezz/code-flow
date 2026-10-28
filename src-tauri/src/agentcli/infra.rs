//! `cf k8s …`, `cf azure …` and `cf containers …` — the clusters, the Azure resources and the local
//! engines (Docker, Podman, nerdctl) the Contenedores panel shows,
//! for an agent to look at. **Looking only**: every subcommand is a read (`get`, `describe`, `logs`,
//! `show`, a query); there is no verb here that scales, restarts, deletes or starts anything, and
//! none takes a command from its caller. Outputs go through `secret_scan::redact`; a Secret's values
//! are masked as the panel masks them.
//!
//! The defaults are the panel's: the cluster and namespace picked in Contenedores, the Azure
//! subscription and group picked there — so "why is this failing?" is about what the user is looking at.

use std::collections::HashMap;

use serde_json::Value;

use super::Reply;
use crate::containers::{self, azure, engine, kube, topology};

/// The most of one answer a model reads. Every character is tokens on every later turn of the run.
const MAX_OUT: usize = 16_000;
/// Rows of one list; the troubled ones come first, so the cut keeps what the question is usually about.
const MAX_ROWS: usize = 150;

pub const K8S_USAGE: &str = "usage: cf k8s contexts | get <kind> | describe <kind> <name> | yaml <kind> <name> | logs <pod|deployment|part of a name> [-c container] [--tail N] [--previous] | events | top [pods|nodes] [name] | topology   [--context C] [-n namespace | -A]";
pub const CONTAINERS_USAGE: &str = "usage: cf containers engines | ps | images | volumes | networks | compose | inspect <name> [--object image|volume|network] | logs <name> [--tail N] | stats [name]   [--engine docker|podman|nerdctl] [--context C]";
pub const AZURE_USAGE: &str = "usage: cf azure subscriptions | groups | resources | show <name|id> | health | activity [name|id] [--hours H] | logs <name|id> [--tail N] | metrics <name|id> [--metric a,b] [--hours H] | workspaces | query <workspace> <KQL> [--hours H] | topology   [--sub S] [-g group]";

/// Flags with a value, flags without, and the rest in order.
struct Args {
    values: HashMap<&'static str, String>,
    flags: Vec<&'static str>,
    rest: Vec<String>,
}

fn parse(args: &[String]) -> Result<Args, String> {
    const VALUED: &[(&str, &[&str])] = &[
        ("context", &["--context"]),
        ("namespace", &["-n", "--namespace"]),
        ("container", &["-c", "--container"]),
        ("tail", &["--tail"]),
        ("sub", &["--sub", "--subscription"]),
        ("group", &["-g", "--group", "--resource-group"]),
        ("hours", &["--hours"]),
        ("engine", &["--engine", "--runtime"]),
        ("object", &["--object"]),
        ("metric", &["--metric", "--metrics"]),
    ];
    const BARE: &[(&str, &[&str])] = &[("previous", &["--previous", "-p"]), ("all", &["-A", "--all-namespaces"])];
    let mut out = Args { values: HashMap::new(), flags: vec![], rest: vec![] };
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        let (name, inline) = match arg.split_once('=') {
            Some((name, value)) if name.starts_with('-') => (name, Some(value.to_string())),
            _ => (arg.as_str(), None),
        };
        if let Some((key, _)) = VALUED.iter().find(|(_, names)| names.contains(&name)) {
            let value = inline.or_else(|| iter.next().cloned()).ok_or_else(|| format!("{name} takes a value"))?;
            out.values.insert(key, value);
        } else if let Some((key, _)) = BARE.iter().find(|(_, names)| names.contains(&name)) {
            out.flags.push(key);
        } else {
            out.rest.push(arg.clone());
        }
    }
    Ok(out)
}

fn number(args: &Args, key: &str, default: u32) -> Result<u32, String> {
    match args.values.get(key) {
        Some(raw) => raw.parse().map_err(|_| format!("--{key} takes a number")),
        None => Ok(default),
    }
}

fn finish(result: Result<String, String>) -> Reply {
    match result {
        Ok(text) => Reply::ok(squeeze(&crate::secret_scan::redact(&text).0, MAX_OUT)),
        Err(error) => Reply::no(crate::secret_scan::redact(&error).0),
    }
}

/// `text` within `max` bytes: its start (a list's header and its troubled rows) and its end (a log's
/// latest lines), with what was left out said between them.
fn squeeze(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let boundary = |mut at: usize| {
        while !text.is_char_boundary(at) {
            at -= 1;
        }
        at
    };
    let head = boundary(max / 4);
    let tail = boundary(text.len() - max * 3 / 4);
    let head = text[..head].rfind('\n').map(|at| at + 1).unwrap_or(head);
    let tail = text[tail..].find('\n').map(|at| tail + at + 1).unwrap_or(tail);
    let skipped = text[head..tail].lines().count();
    format!("{}[… {skipped} lines cut — narrow it with a name, a namespace or a group]\n{}", &text[..head], &text[tail..])
}

// ------------------------------------------------------------------------------------- reuse

/// Answers reused for a moment, by the whole question and what decides its defaults (the panel's
/// picks, what is hidden): a model asks the same thing again within a turn more often than not, and
/// each `kubectl`/`az` start costs seconds.
static ANSWERS: std::sync::LazyLock<std::sync::Mutex<HashMap<String, (std::time::Instant, String)>>> = std::sync::LazyLock::new(Default::default);
/// The lists a name is looked up in (`resolve_in`, `resource_of`), likewise.
static KUBE_ROWS: std::sync::LazyLock<std::sync::Mutex<HashMap<String, (std::time::Instant, Vec<kube::KubeRow>)>>> = std::sync::LazyLock::new(Default::default);
static AZ_RESOURCES: std::sync::LazyLock<std::sync::Mutex<HashMap<String, (std::time::Instant, Vec<azure::AzResource>)>>> = std::sync::LazyLock::new(Default::default);

/// How long an answer stands: what moves by the second (logs, CPU) briefly, lists longer.
fn fresh_for(verb: &str) -> std::time::Duration {
    std::time::Duration::from_secs(match verb {
        "logs" | "log" | "top" | "stats" => 10,
        "events" | "health" | "ps" | "list" | "get" => 20,
        _ => 45,
    })
}

fn held<T: Clone>(map: &std::sync::Mutex<HashMap<String, (std::time::Instant, T)>>, key: &str, fresh: std::time::Duration) -> Option<T> {
    map.lock().ok()?.get(key).filter(|(at, _)| at.elapsed() < fresh).map(|(_, value)| value.clone())
}

fn keep<T>(map: &std::sync::Mutex<HashMap<String, (std::time::Instant, T)>>, key: String, value: T) {
    if let Ok(mut held) = map.lock() {
        held.retain(|_, (at, _)| at.elapsed() < std::time::Duration::from_secs(120));
        held.insert(key, (std::time::Instant::now(), value));
    }
}

/// [`k8s_now`], [`azure_now`] or [`containers_now`] — or the same answer given a moment ago.
async fn reused<F: std::future::Future<Output = Reply>>(tool: &str, args: &[String], ask: impl FnOnce() -> F) -> Reply {
    let verb = args.iter().find(|a| !a.starts_with('-')).cloned().unwrap_or_default();
    let settings: Vec<String> = ["containers_prefs", "azure_view_prefs", "ai_infra_hidden"].iter().map(|k| crate::ai_usage::setting(k).unwrap_or_default()).collect();
    let key = format!("{tool}|{}|{}", args.join("\u{1f}"), settings.join("\u{1f}"));
    if let Some(text) = held(&ANSWERS, &key, fresh_for(&verb)) {
        return Reply::ok(text);
    }
    let reply = ask().await;
    if reply.ok {
        keep(&ANSWERS, key, reply.text.clone());
    }
    reply
}

pub async fn k8s(args: &[String]) -> Reply {
    reused("k8s", args, || k8s_now(args)).await
}

pub async fn azure(args: &[String]) -> Reply {
    reused("azure", args, || azure_now(args)).await
}

pub async fn containers(args: &[String]) -> Reply {
    reused("containers", args, || containers_now(args)).await
}

/// `kube::list`, reused for a moment — the list a name is looked up in, then often asked for itself.
async fn kube_rows(target: &kube::KubeTarget, kind: &str) -> Result<Vec<kube::KubeRow>, String> {
    let key = format!("{}|{}|{kind}", target.context.as_deref().unwrap_or(""), target.namespace().unwrap_or(""));
    if let Some(rows) = held(&KUBE_ROWS, &key, std::time::Duration::from_secs(20)) {
        return Ok(rows);
    }
    let rows = kube::list(target, kind).await?;
    keep(&KUBE_ROWS, key, rows.clone());
    Ok(rows)
}

// ---------------------------------------------------------------------------- hidden from AI

/// What the user hid from AI in the Contenedores panel — the setting `ai_infra_hidden`, written by
/// the window (`aiInfraStore`): clusters by context (`kube`), Azure subscriptions by id (`azure`),
/// engines by runtime id (`engines`). Read on every look, so a switch counts from the next call.
fn hidden(kind: &str) -> Vec<String> {
    crate::ai_usage::setting("ai_infra_hidden")
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|doc| doc.get(kind).and_then(Value::as_array).cloned())
        .map(|list| list.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default()
}

fn is_hidden(kind: &str, id: &str) -> bool {
    hidden(kind).iter().any(|h| h.eq_ignore_ascii_case(id))
}

/// The refusal for something hidden — said plainly, so the model tells the user instead of looking
/// for another way in.
fn hidden_reply(what: &str) -> Reply {
    Reply::no(format!("{what} is hidden from AI: the user excluded it in CodeFlow's Contenedores panel. Tell them; they can show it again there."))
}

// ------------------------------------------------------------------------------- kubernetes

/// The panel's cluster and namespace (`containers_prefs`), unless disconnected there.
fn panel_cluster() -> (Option<String>, Option<String>) {
    let Some(prefs) = crate::ai_usage::setting("containers_prefs").and_then(|raw| serde_json::from_str::<Value>(&raw).ok()) else { return (None, None) };
    if prefs.get("kubeDisconnected").and_then(Value::as_bool) == Some(true) {
        return (None, None);
    }
    let context = prefs.pointer("/context/kubernetes").and_then(Value::as_str).filter(|c| !c.is_empty()).map(str::to_string);
    let namespace = prefs.get("namespace").and_then(|map| map.get(context.as_deref().unwrap_or(""))).and_then(Value::as_str).filter(|n| !n.is_empty()).map(str::to_string);
    (context, namespace)
}

fn target_of(args: &Args) -> kube::KubeTarget {
    let (panel_context, panel_namespace) = panel_cluster();
    let explicit_context = args.values.get("context").cloned();
    let context = explicit_context.clone().or(panel_context);
    // The panel's namespace belongs to the panel's cluster: another context starts with all of them.
    let namespace = if args.flags.contains(&"all") {
        None
    } else {
        args.values.get("namespace").cloned().or(if explicit_context.is_none() { panel_namespace } else { None })
    };
    kube::KubeTarget { context, namespace }
}

fn row_line(row: &kube::KubeRow) -> String {
    let mut extra = Value::Object(row.extra.clone());
    if let Some(map) = extra.as_object_mut() {
        map.remove("containers");
        map.remove("conditions");
    }
    let mut extra = extra.to_string();
    if extra.len() > 200 {
        extra = format!("{}…", extra.chars().take(200).collect::<String>());
    }
    let mut parts = vec![if row.namespace.is_empty() { row.name.clone() } else { format!("{}/{}", row.namespace, row.name) }];
    parts.extend([row.status.clone(), row.ready.clone()].into_iter().filter(|p| !p.is_empty()));
    if let Some(restarts) = row.restarts.filter(|r| *r > 0) {
        parts.push(format!("restarts {restarts}"));
    }
    if !row.created.is_empty() {
        parts.push(row.created.clone());
    }
    if extra != "{}" {
        parts.push(extra);
    }
    format!("- {}", parts.join(" | "))
}

fn rows_text(kind: &str, target: &kube::KubeTarget, rows: &[kube::KubeRow]) -> String {
    let rank = |tone: &str| match tone {
        "bad" => 0,
        "warn" => 1,
        _ => 2,
    };
    let mut ordered: Vec<&kube::KubeRow> = rows.iter().collect();
    // Events keep their own order (newest first); everything else puts what is in trouble on top.
    if kind != "events" {
        ordered.sort_by_key(|r| rank(&r.tone));
    }
    let troubled = rows.iter().filter(|r| rank(&r.tone) < 2).count();
    let mut out = format!(
        "{} {kind} in {} · {}{}\n",
        rows.len(),
        target.context.as_deref().unwrap_or("the current context"),
        target.namespace().unwrap_or("all namespaces"),
        if troubled > 0 && kind != "events" { format!(" · {troubled} not healthy, listed first") } else { String::new() }
    );
    for row in ordered.iter().take(MAX_ROWS) {
        out.push_str(&row_line(row));
        out.push('\n');
    }
    if rows.len() > MAX_ROWS {
        out.push_str(&format!("[… {} more — filter by name or namespace]\n", rows.len() - MAX_ROWS));
    }
    out
}

/// `pod` → `pods`: what a person types, as the panel names kinds.
fn kind_of(word: &str) -> String {
    let lower = word.to_lowercase();
    let known = [
        ("po", "pods"),
        ("pod", "pods"),
        ("deploy", "deployments"),
        ("deployment", "deployments"),
        ("sts", "statefulsets"),
        ("statefulset", "statefulsets"),
        ("ds", "daemonsets"),
        ("daemonset", "daemonsets"),
        ("rs", "replicasets"),
        ("replicaset", "replicasets"),
        ("job", "jobs"),
        ("cj", "cronjobs"),
        ("cronjob", "cronjobs"),
        ("svc", "services"),
        ("service", "services"),
        ("ing", "ingresses"),
        ("ingress", "ingresses"),
        ("cm", "configmaps"),
        ("configmap", "configmaps"),
        ("secret", "secrets"),
        ("pvc", "persistentvolumeclaims"),
        ("ev", "events"),
        ("event", "events"),
        ("no", "nodes"),
        ("node", "nodes"),
        ("ns", "namespaces"),
        ("namespace", "namespaces"),
    ];
    known.iter().find(|(short, _)| *short == lower).map(|(_, kind)| kind.to_string()).unwrap_or(lower)
}

/// The object a name the caller gave turned out to be — and, when it was not that exact name, a line
/// saying so, put before the answer so the reader knows which object it is looking at.
#[derive(Debug, PartialEq)]
pub(crate) struct Resolved {
    pub name: String,
    pub namespace: String,
    pub note: Option<String>,
}

/// The workload a pod belongs to, as a person names it: a ReplicaSet's Deployment (its name without
/// the pod-template hash), else its owner's own name (StatefulSet, DaemonSet, Job), else the pod.
fn workload_of(row: &kube::KubeRow) -> String {
    let owner = row.extra.get("owner").and_then(Value::as_str).unwrap_or_default();
    match owner.split_once('/') {
        Some(("ReplicaSet", rs)) => rs.rsplit_once('-').map(|(deployment, _)| deployment.to_string()).unwrap_or_else(|| rs.to_string()),
        Some((_, name)) if !name.is_empty() => name.to_string(),
        _ => row.name.clone(),
    }
}

/// Which of `rows` the caller meant by `wanted`, so a person need not know a pod's generated name.
/// Tried in order, case-insensitively, stopping at the first that matches: the exact name; for pods,
/// the exact workload (`payments-api` → its pods); a name or workload starting with it; one
/// containing it. Within that level, one workload is an answer — for pods its most telling one: a
/// failing pod first, then the one restarted most, then the newest. Several are the candidates, as
/// `namespace/name`, for the caller to choose from.
pub(crate) fn resolve(rows: &[kube::KubeRow], wanted: &str, pods: bool) -> Result<Resolved, Vec<String>> {
    // `deploy/payments` or `pod/x`: kubectl's own spelling — the name is what follows.
    let wanted = wanted.rsplit('/').next().unwrap_or(wanted).trim().to_lowercase();
    if wanted.is_empty() {
        return Err(vec![]);
    }
    let group = |row: &kube::KubeRow| if pods { workload_of(row) } else { row.name.clone() };
    let levels: [&dyn Fn(&kube::KubeRow) -> bool; 4] = [
        &|r| r.name.to_lowercase() == wanted,
        &|r| pods && group(r).to_lowercase() == wanted,
        &|r| r.name.to_lowercase().starts_with(&wanted) || group(r).to_lowercase().starts_with(&wanted),
        &|r| r.name.to_lowercase().contains(&wanted) || group(r).to_lowercase().contains(&wanted),
    ];
    for (level, test) in levels.iter().enumerate() {
        let found: Vec<&kube::KubeRow> = rows.iter().filter(|r| test(r)).collect();
        if found.is_empty() {
            continue;
        }
        let mut groups: Vec<(String, String)> = found.iter().map(|r| (r.namespace.clone(), group(r))).collect();
        groups.sort();
        groups.dedup();
        // The exact name of one object is never a choice to make, whatever its workload's siblings.
        if level == 0 && found.len() == 1 {
            return Ok(Resolved { name: found[0].name.clone(), namespace: found[0].namespace.clone(), note: None });
        }
        if groups.len() > 1 || (level == 0 && !pods) {
            return Err(groups
                .iter()
                .map(|(ns, name)| {
                    let count = found.iter().filter(|r| &r.namespace == ns && &group(r) == name).count();
                    let label = if ns.is_empty() { name.clone() } else { format!("{ns}/{name}") };
                    if pods && count > 1 { format!("{label} ({count} pods)") } else { label }
                })
                .collect());
        }
        let mut chosen = found.clone();
        chosen.sort_by(|a, b| {
            (b.tone == "bad").cmp(&(a.tone == "bad")).then(b.restarts.unwrap_or(0).cmp(&a.restarts.unwrap_or(0))).then(b.created.cmp(&a.created))
        });
        let best = chosen[0];
        let why = if !pods || found.len() == 1 {
            String::new()
        } else if best.tone == "bad" {
            format!(", 1 of {} — chosen because it is failing ({})", found.len(), best.status)
        } else {
            format!(", 1 of {} — none failing; the one restarted most, else the newest", found.len())
        };
        let kind = if pods { "pod" } else { "object" };
        let of = if pods && group(best) != best.name { format!(" of {}", group(best)) } else { String::new() };
        let note = Some(format!("«{wanted}» → {kind} {}{of}{}{why}", best.name, if best.namespace.is_empty() { String::new() } else { format!(" in {}", best.namespace) }));
        return Ok(Resolved { name: best.name.clone(), namespace: best.namespace.clone(), note });
    }
    Err(vec![])
}

/// [`resolve`] against what the cluster lists for `kind`, with the reason in words when nothing fits.
/// A list the cluster refuses (no right to list, say) leaves the name as it was given: kubectl answers.
async fn resolve_in(target: &kube::KubeTarget, kind: &str, wanted: &str) -> Result<Resolved, String> {
    let rows = match kube_rows(target, kind).await {
        Ok(rows) => rows,
        Err(_) => return Ok(Resolved { name: wanted.to_string(), namespace: target.namespace().unwrap_or_default().to_string(), note: None }),
    };
    let place = format!("{} · {}", target.context.as_deref().unwrap_or("the current context"), target.namespace().unwrap_or("all namespaces"));
    resolve(&rows, wanted, kind == "pods").map_err(|candidates| {
        if candidates.is_empty() {
            let names: Vec<String> = rows.iter().take(40).map(|r| if target.namespace().is_some() { r.name.clone() } else { format!("{}/{}", r.namespace, r.name) }).collect();
            format!("no {kind} named like «{wanted}» in {place}. There are: {}", if names.is_empty() { "none".to_string() } else { names.join(", ") })
        } else {
            format!("«{wanted}» matches several {kind} in {place}: {}. Say which.", candidates.join(", "))
        }
    })
}

/// The target narrowed to the namespace the object was found in — needed when listing ran across all.
fn in_namespace(target: &kube::KubeTarget, namespace: &str) -> kube::KubeTarget {
    kube::KubeTarget { context: target.context.clone(), namespace: if namespace.is_empty() { target.namespace.clone() } else { Some(namespace.to_string()) } }
}

fn with_note(note: Option<String>, text: String) -> String {
    match note {
        Some(note) => format!("{note}

{text}"),
        None => text,
    }
}

async fn k8s_now(args: &[String]) -> Reply {
    if crate::containers::cli::find("kubectl").is_none() {
        return Reply::no("kubectl is not installed on this computer");
    }
    let args = match parse(args) {
        Ok(args) => args,
        Err(error) => return Reply::no(format!("{error}\n{K8S_USAGE}")),
    };
    let target = target_of(&args);
    let word = |i: usize| args.rest.get(i).cloned().unwrap_or_default();
    let hidden_contexts = hidden("kube");
    if !hidden_contexts.is_empty() && !matches!(word(0).as_str(), "" | "help" | "contexts") {
        // No context named and none picked in the panel is kubeconfig's current one: that is the one
        // to check.
        let context = match &target.context {
            Some(context) => Some(context.clone()),
            None => kube::contexts().await.ok().and_then(|(_, current)| current),
        };
        if let Some(context) = context.filter(|c| hidden_contexts.iter().any(|h| h.eq_ignore_ascii_case(c))) {
            return hidden_reply(&format!("The cluster «{context}»"));
        }
    }
    let result = match word(0).as_str() {
        "" | "help" => Err(K8S_USAGE.to_string()),
        "contexts" => kube::contexts().await.map(|(contexts, current)| {
            let panel = panel_cluster().0;
            contexts
                .iter()
                .map(|c| {
                    if hidden_contexts.iter().any(|h| h.eq_ignore_ascii_case(&c.name)) {
                        return format!("- {} [hidden from AI by the user — not readable]", c.name);
                    }
                    format!("- {}{}{} (cluster {}, namespace {})", c.name, if Some(&c.name) == current.as_ref() { " [kubeconfig current]" } else { "" }, if Some(&c.name) == panel.as_ref() { " [picked in CodeFlow]" } else { "" }, c.cluster, if c.namespace.is_empty() { "default" } else { &c.namespace })
                })
                .collect::<Vec<_>>()
                .join("\n")
        }),
        "get" | "list" => {
            let kind = kind_of(&word(1));
            if kind.is_empty() {
                Err(K8S_USAGE.to_string())
            } else {
                kube_rows(&target, &kind).await.map(|rows| {
                    let name = word(2);
                    let rows: Vec<kube::KubeRow> = if name.is_empty() { rows } else { rows.into_iter().filter(|r| r.name.contains(&name)).collect() };
                    rows_text(&kind, &target, &rows)
                })
            }
        }
        "events" => kube::list(&target, "events").await.map(|rows| rows_text("events", &target, &rows)),
        verb @ ("describe" | "yaml") => {
            let (kind, name) = (kind_of(&word(1)), word(2));
            if name.is_empty() {
                Err(K8S_USAGE.to_string())
            } else {
                match resolve_in(&target, &kind, &name).await {
                    // A Secret's values are never shown, whatever was asked.
                    Ok(found) => kube::text(&in_namespace(&target, &found.namespace), &kind, &found.name, verb, false).await.map(|text| with_note(found.note, text)),
                    Err(error) => Err(error),
                }
            }
        }
        "logs" | "log" => {
            let pod = word(1);
            if pod.is_empty() {
                Err(K8S_USAGE.to_string())
            } else {
                match (number(&args, "tail", 200), resolve_in(&target, "pods", &pod).await) {
                    (Ok(tail), Ok(found)) => kube::logs(&in_namespace(&target, &found.namespace), &found.name, args.values.get("container").map(String::as_str), tail.min(5000), args.flags.contains(&"previous"))
                        .await
                        .map(|text| with_note(found.note, text)),
                    (Err(e), _) | (_, Err(e)) => Err(e),
                }
            }
        }
        "top" => {
            let filter = word(2);
            kube::top(&target, &word(1)).await.map(|text| {
                if filter.is_empty() {
                    text
                } else {
                    // The header line, and the rows naming what was asked about.
                    text.lines().enumerate().filter(|(i, line)| *i == 0 || line.contains(&filter)).map(|(_, line)| line).collect::<Vec<_>>().join("\n")
                }
            })
        }
        "topology" | "map" => {
            let topo = topology::topology(&target).await;
            Ok(format!("{} · {}\n{}", target.context.as_deref().unwrap_or("current context"), target.namespace().unwrap_or("all namespaces"), topology::topology_text(&topo)))
        }
        other => Err(format!("cf k8s {other}: not a read this verb has\n{K8S_USAGE}")),
    };
    finish(result)
}

// ------------------------------------------------------------------------------------ azure

/// The panel's subscription and group (`azure_view_prefs`).
fn panel_azure() -> (Option<String>, Option<String>) {
    let Some(prefs) = crate::ai_usage::setting("azure_view_prefs").and_then(|raw| serde_json::from_str::<Value>(&raw).ok()) else { return (None, None) };
    let pick = |key: &str| prefs.get(key).and_then(Value::as_str).filter(|v| !v.is_empty()).map(str::to_string);
    (pick("subscription"), pick("group"))
}

async fn scope_of(args: &Args) -> Result<(String, Option<String>), String> {
    let (panel_sub, panel_group) = panel_azure();
    let explicit = args.values.get("sub").cloned();
    let group = args.values.get("group").cloned().or(if explicit.is_none() { panel_group } else { None });
    if let Some(sub) = explicit.or(panel_sub) {
        return Ok((sub, group));
    }
    let found = azure::subscriptions().await;
    if let Some(error) = found.error {
        return Err(error);
    }
    found.contexts.iter().find(|c| c.default).or(found.contexts.first()).map(|c| (c.id.clone(), group)).ok_or_else(|| "no Azure subscription — `az login` first".to_string())
}

/// A resource by its id, or by its name within the scope.
async fn resource_of(wanted: &str, sub: &str, group: Option<&str>) -> Result<azure::AzResource, String> {
    let key = format!("{sub}|{}", group.unwrap_or(""));
    let list = match held(&AZ_RESOURCES, &key, std::time::Duration::from_secs(60)) {
        Some(list) => list,
        None => {
            let list = azure::resources(sub, group).await?;
            keep(&AZ_RESOURCES, key, list.clone());
            list
        }
    };
    if wanted.starts_with("/subscriptions/") {
        if let Some(found) = list.iter().find(|r| r.id.eq_ignore_ascii_case(wanted)) {
            return Ok(found.clone());
        }
        let (_, group, kind, name) = azure::parse_id(wanted).ok_or("not a resource id")?;
        return Ok(azure::AzResource { id: wanted.to_string(), name, kind, flavor: String::new(), location: String::new(), group, sku: String::new(), state: String::new(), tags: Default::default() });
    }
    super::pick(list, wanted, |r| r.name.as_str()).map_err(|names| if names.is_empty() { format!("no resource called {wanted} here") } else { format!("{wanted} is ambiguous: {}", names.join(", ")) })
}

async fn azure_now(args: &[String]) -> Reply {
    if !azure::found() {
        return Reply::no("the Azure CLI (az) is not installed on this computer");
    }
    let args = match parse(args) {
        Ok(args) => args,
        Err(error) => return Reply::no(format!("{error}\n{AZURE_USAGE}")),
    };
    let word = |i: usize| args.rest.get(i).cloned().unwrap_or_default();
    let verb = word(0);
    if verb.is_empty() || verb == "help" {
        return Reply::no(AZURE_USAGE);
    }
    if verb == "subscriptions" || verb == "subs" {
        let found = azure::subscriptions().await;
        let panel = panel_azure().0;
        return finish(match found.error {
            Some(error) => Err(error),
            None => Ok(found
                .contexts
                .iter()
                .map(|c| {
                    if is_hidden("azure", &c.id) {
                        return format!("- {} ({}) [hidden from AI by the user — not readable]", c.name, c.id);
                    }
                    format!("- {} ({}){}{}", c.name, c.id, if c.default { " [az default]" } else { "" }, if panel.as_deref() == Some(c.id.as_str()) { " [picked in CodeFlow]" } else { "" })
                })
                .collect::<Vec<_>>()
                .join("\n")),
        });
    }
    let (sub, group) = match scope_of(&args).await {
        Ok(scope) => scope,
        Err(error) => return Reply::no(error),
    };
    if is_hidden("azure", &sub) {
        return hidden_reply(&format!("The Azure subscription {sub}"));
    }
    let group = group.as_deref();
    let result = match verb.as_str() {
        "groups" => azure::groups(&sub).await.map(|list| list.iter().map(|g| format!("- {}", g.name)).collect::<Vec<_>>().join("\n")),
        "resources" | "list" => match tokio::join!(azure::resources(&sub, group), azure::health(&sub, group)) {
            (Ok(list), health) => Ok(azure::resources_text(&list, &health.unwrap_or_default())),
            (Err(e), _) => Err(e),
        },
        "show" => match resource_of(&word(1), &sub, group).await {
            Ok(resource) => azure::show(&resource.id).await.map(|value| serde_json::to_string_pretty(&value).unwrap_or_default()),
            Err(e) => Err(e),
        },
        "health" => azure::health(&sub, group).await.map(|list| {
            let mut list = list;
            list.sort_by_key(|h| h.state == "Available");
            list.iter().map(|h| format!("- {} | {} | {} | {}", azure::parse_id(&h.id).map(|p| p.3).unwrap_or_else(|| h.id.clone()), h.state, h.summary, h.since)).collect::<Vec<_>>().join("\n")
        }),
        "activity" => match number(&args, "hours", 24) {
            Ok(hours) => {
                let resource = if word(1).is_empty() { Ok(None) } else { resource_of(&word(1), &sub, group).await.map(|r| Some(r.id)) };
                match resource {
                    Ok(resource) => azure::activity(&sub, group, resource.as_deref(), hours).await.map(|list| azure::activity_text(&list)),
                    Err(e) => Err(e),
                }
            }
            Err(e) => Err(e),
        },
        "metrics" => match (resource_of(&word(1), &sub, group).await, number(&args, "hours", 1)) {
            (Ok(resource), Ok(hours)) => {
                let wanted: Vec<String> = args.values.get("metric").map(|m| m.split(',').map(|n| n.trim().to_string()).filter(|n| !n.is_empty()).collect()).unwrap_or_default();
                azure::metrics(&resource.id, &wanted, hours).await.map(|text| format!("{} ({})\n{text}", resource.name, resource.kind))
            }
            (Err(e), _) | (_, Err(e)) => Err(e),
        },
        "logs" | "log" => match (resource_of(&word(1), &sub, group).await, number(&args, "tail", 200)) {
            (Ok(resource), Ok(tail)) => azure::logs(&resource.id, tail).await,
            (Err(e), _) | (_, Err(e)) => Err(e),
        },
        "workspaces" => azure::workspaces(&sub).await.map(|list| list.iter().map(|w| format!("- {} (group {}, id {})", w.name, w.group, w.customer_id)).collect::<Vec<_>>().join("\n")),
        "query" => {
            let workspace = word(1);
            let kql = args.rest.iter().skip(2).cloned().collect::<Vec<_>>().join(" ");
            match (azure::workspaces(&sub).await, number(&args, "hours", 24)) {
                (Ok(list), Ok(hours)) => {
                    let id = list.iter().find(|w| w.customer_id.eq_ignore_ascii_case(&workspace) || w.name.eq_ignore_ascii_case(&workspace)).map(|w| w.customer_id.clone()).unwrap_or(workspace);
                    azure::query(&id, &kql, hours).await.map(|r| azure::query_text(&r))
                }
                (Err(e), _) | (_, Err(e)) => Err(e),
            }
        }
        "topology" | "map" => match tokio::join!(azure::topology(&sub, group), azure::health(&sub, group)) {
            (Ok(topo), health) => Ok(azure::topology_text(&topo, &health.unwrap_or_default())),
            (Err(e), _) => Err(e),
        },
        other => Err(format!("cf azure {other}: not a read this verb has\n{AZURE_USAGE}")),
    };
    finish(result)
}

// ------------------------------------------------------------------------------- containers

/// An inspect document with every environment value masked — names stay, values never leave.
pub fn masked_inspect(text: &str) -> String {
    let Ok(mut doc) = serde_json::from_str::<Value>(text) else { return crate::secret_scan::redact(text).0 };
    if let Some(env) = doc.pointer_mut("/Config/Env").and_then(Value::as_array_mut) {
        for entry in env.iter_mut() {
            if let Some(line) = entry.as_str() {
                let name = line.split_once('=').map(|(n, _)| n).unwrap_or(line);
                *entry = Value::String(format!("{name}=••••••"));
            }
        }
    }
    crate::secret_scan::redact(&serde_json::to_string_pretty(&doc).unwrap_or_default()).0
}

/// The engine to read: the one asked for, else the one on screen in the panel, else the first that
/// answers — and its context (the panel's for it).
async fn engine_of(args: &Args) -> Result<(engine::Target, Vec<containers::RuntimeInfo>), String> {
    let runtimes: Vec<containers::RuntimeInfo> = containers::detect().await.into_iter().filter(|r| r.id != "kubernetes").collect();
    let prefs = crate::ai_usage::setting("containers_prefs").and_then(|raw| serde_json::from_str::<Value>(&raw).ok()).unwrap_or(Value::Null);
    let on_screen = prefs.pointer("/nav/runtime").and_then(Value::as_str).map(str::to_string);
    let wanted = args.values.get("engine").cloned();
    let chosen = match &wanted {
        Some(id) => runtimes.iter().find(|r| r.id == *id).ok_or_else(|| format!("no {id} on this computer — cf containers engines lists them"))?,
        None => runtimes
            .iter()
            .find(|r| r.running && Some(&r.id) == on_screen.as_ref())
            .or_else(|| runtimes.iter().find(|r| r.running))
            .ok_or("no container engine is running on this computer")?,
    };
    let context = args.values.get("context").cloned().or_else(|| prefs.pointer(&format!("/context/{}", chosen.id)).and_then(Value::as_str).filter(|c| !c.is_empty()).map(str::to_string));
    Ok((engine::Target { runtime: chosen.id.clone(), context }, runtimes))
}

fn container_line(row: &engine::ContainerRow) -> String {
    let ports: Vec<String> = row.ports.iter().map(|p| match p.host_port { Some(host) => format!("{host}→{}", p.container_port), None => p.container_port.to_string() }).collect();
    let mut parts = vec![row.name.clone(), row.image.clone(), format!("{} ({})", row.state, row.status)];
    if !row.health.is_empty() {
        parts.push(format!("health {}", row.health));
    }
    if !ports.is_empty() {
        parts.push(format!("ports {}", ports.join(",")));
    }
    if !row.project.is_empty() {
        parts.push(format!("compose {}/{}", row.project, row.service));
    }
    format!("- {}", parts.join(" | "))
}

async fn containers_now(args: &[String]) -> Reply {
    let args = match parse(args) {
        Ok(args) => args,
        Err(error) => return Reply::no(format!("{error}\n{CONTAINERS_USAGE}")),
    };
    let word = |i: usize| args.rest.get(i).cloned().unwrap_or_default();
    let verb = word(0);
    if verb.is_empty() || verb == "help" {
        return Reply::no(CONTAINERS_USAGE);
    }
    let (target, runtimes) = match engine_of(&args).await {
        Ok(found) => found,
        Err(error) if verb == "engines" => return finish(Ok(format!("No engine: {error}"))),
        Err(error) => return Reply::no(error),
    };
    if verb != "engines" && is_hidden("engines", &target.runtime) {
        return hidden_reply(&format!("The {} engine", target.runtime));
    }
    let label = format!("{}{}", target.runtime, target.context.as_deref().map(|c| format!(" ({c})")).unwrap_or_default());
    let result = match verb.as_str() {
        "engines" => Ok(runtimes
            .iter()
            .map(|r| format!("- {}{}{} {} — {}{}", r.id, if is_hidden("engines", &r.id) { " [hidden from AI by the user — not readable]" } else { "" }, r.provider.as_deref().map(|p| format!(" ({p})")).unwrap_or_default(), r.version.clone().unwrap_or_default(), if r.running { "running" } else { "not running" }, if r.contexts.len() > 1 { format!(" · contexts: {}", r.contexts.iter().map(|c| c.name.clone()).collect::<Vec<_>>().join(", ")) } else { String::new() }))
            .collect::<Vec<_>>()
            .join("\n")),
        "ps" | "list" | "containers" => engine::list_containers(&target).await.map(|rows| {
            let name = word(1);
            let rows: Vec<&engine::ContainerRow> = rows.iter().filter(|r| name.is_empty() || r.name.contains(&name)).collect();
            format!("{} containers in {label}:\n{}", rows.len(), rows.iter().map(|r| container_line(r)).collect::<Vec<_>>().join("\n"))
        }),
        what @ ("images" | "volumes" | "networks") => engine::list(&target, what).await.map(|value| {
            let rows = value.as_array().cloned().unwrap_or_default();
            format!("{} {what} in {label}:\n{}", rows.len(), rows.iter().take(400).map(|r| format!("- {r}")).collect::<Vec<_>>().join("\n"))
        }),
        "compose" => engine::list_containers(&target).await.map(|rows| {
            let mut projects: std::collections::BTreeMap<String, Vec<&engine::ContainerRow>> = Default::default();
            for row in rows.iter().filter(|r| !r.project.is_empty()) {
                projects.entry(row.project.clone()).or_default().push(row);
            }
            if projects.is_empty() {
                return format!("No Compose projects in {label}.");
            }
            projects
                .iter()
                .map(|(name, rows)| format!("{name} ({}/{} running){}\n{}", rows.iter().filter(|r| r.state == "running").count(), rows.len(), rows.first().map(|r| format!(" · {}", r.project_dir)).unwrap_or_default(), rows.iter().map(|r| format!("  {}", container_line(r))).collect::<Vec<_>>().join("\n")))
                .collect::<Vec<_>>()
                .join("\n")
        }),
        "inspect" | "show" => {
            let name = word(1);
            let object = args.values.get("object").cloned().unwrap_or_else(|| "container".into());
            if name.is_empty() {
                Err(CONTAINERS_USAGE.to_string())
            } else {
                engine::inspect(&target, &object, &name).await.map(|text| masked_inspect(&text))
            }
        }
        "logs" | "log" => {
            let name = word(1);
            match (name.is_empty(), number(&args, "tail", 200)) {
                (true, _) => Err(CONTAINERS_USAGE.to_string()),
                (_, Err(e)) => Err(e),
                (false, Ok(tail)) => {
                    if name.starts_with('-') {
                        Err(format!("\"{name}\" is not a container"))
                    } else {
                        match target.run_owned(vec!["logs".into(), "--tail".into(), tail.clamp(1, 5000).to_string(), name], std::time::Duration::from_secs(30)).await {
                            Ok(output) if output.ok() => Ok(format!("{}{}", output.stdout, output.stderr)),
                            Ok(output) => Err(output.complaint()),
                            Err(e) => Err(e),
                        }
                    }
                }
            }
        }
        "stats" => {
            let name = word(1);
            match engine::list_containers(&target).await {
                Ok(rows) => {
                    let mut lines = Vec::new();
                    for row in rows.iter().filter(|r| r.state == "running" && (name.is_empty() || r.name.contains(&name))).take(30) {
                        if let Ok(stats) = engine::stats(&target, &row.id).await {
                            lines.push(format!("- {}: {stats}", row.name));
                        }
                    }
                    Ok(if lines.is_empty() { "No running container matches.".to_string() } else { lines.join("\n") })
                }
                Err(e) => Err(e),
            }
        }
        other => Err(format!("cf containers {other}: not a read this verb has\n{CONTAINERS_USAGE}")),
    };
    finish(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn pod(name: &str, owner: (&str, &str), waiting: Option<&str>, restarts: i64, created: &str) -> kube::KubeRow {
        let state = match waiting {
            Some(reason) => serde_json::json!({"waiting": {"reason": reason}}),
            None => serde_json::json!({"running": {}}),
        };
        kube::row(
            "pods",
            &serde_json::json!({
                "metadata": {"name": name, "namespace": "shop", "creationTimestamp": created, "ownerReferences": [{"kind": owner.0, "name": owner.1}]},
                "spec": {"containers": [{"name": "app"}]},
                "status": {"phase": "Running", "containerStatuses": [{"name": "app", "ready": waiting.is_none(), "restartCount": restarts, "state": state}]}
            }),
        )
    }

    fn pods() -> Vec<kube::KubeRow> {
        vec![
            pod("orders-api-7f9c8d-aaaa", ("ReplicaSet", "orders-api-7f9c8d"), None, 0, "2026-10-28T10:00:00Z"),
            pod("orders-api-7f9c8d-bbbb", ("ReplicaSet", "orders-api-7f9c8d"), Some("CrashLoopBackOff"), 9, "2026-10-28T09:00:00Z"),
            pod("orders-worker-5d4c-cccc", ("ReplicaSet", "orders-worker-5d4c"), None, 0, "2026-10-28T08:00:00Z"),
            pod("db-0", ("StatefulSet", "db"), None, 1, "2026-10-27T08:00:00Z"),
        ]
    }

    #[test]
    fn a_pod_is_found_by_its_workload_and_the_failing_one_is_picked() {
        let found = resolve(&pods(), "orders-api", true).unwrap();
        assert_eq!(found.name, "orders-api-7f9c8d-bbbb");
        assert_eq!(found.namespace, "shop");
        let note = found.note.unwrap();
        assert!(note.contains("failing") && note.contains("1 of 2"), "{note}");
        assert_eq!(resolve(&pods(), "deploy/orders-api", true).unwrap().name, "orders-api-7f9c8d-bbbb", "kubectl's own spelling");
        assert_eq!(resolve(&pods(), "db", true).unwrap().name, "db-0", "a StatefulSet's name");
        assert_eq!(resolve(&pods(), "WORKER", true).unwrap().name, "orders-worker-5d4c-cccc", "part of a name, any case");
    }

    #[test]
    fn an_exact_pod_name_is_taken_as_given_and_an_ambiguous_one_lists_the_choices() {
        let exact = resolve(&pods(), "orders-api-7f9c8d-aaaa", true).unwrap();
        assert_eq!(exact.name, "orders-api-7f9c8d-aaaa");
        assert_eq!(exact.note, None, "nothing to explain");
        let choices = resolve(&pods(), "orders", true).unwrap_err();
        assert_eq!(choices, vec!["shop/orders-api (2 pods)".to_string(), "shop/orders-worker".to_string()]);
        assert!(resolve(&pods(), "billing", true).unwrap_err().is_empty());
    }

    #[test]
    fn other_kinds_are_found_by_part_of_their_name() {
        let service = |name: &str| kube::row("services", &serde_json::json!({"metadata": {"name": name, "namespace": "shop"}, "spec": {"type": "ClusterIP"}}));
        let rows = vec![service("orders-api"), service("orders-db")];
        assert_eq!(resolve(&rows, "orders-db", false).unwrap().name, "orders-db");
        assert_eq!(resolve(&rows, "db", false).unwrap().name, "orders-db");
        assert_eq!(resolve(&rows, "orders", false).unwrap_err().len(), 2);
    }

    #[test]
    fn a_long_answer_keeps_its_start_and_its_end() {
        let text: String = (0..2000).map(|i| format!("line {i}\n")).collect();
        let short = squeeze(&text, 4000);
        assert!(short.len() < 4200, "{}", short.len());
        assert!(short.starts_with("line 0\n"));
        assert!(short.ends_with("line 1999\n"), "a log's latest lines survive");
        assert!(short.contains("lines cut"));
        assert_eq!(squeeze("small", 4000), "small");
    }

    #[test]
    fn flags_are_read_in_any_place_and_spelling() {
        let parsed = parse(&args(&["logs", "api-1", "-c", "api", "--tail=50", "--previous", "-n", "shop"])).ok().unwrap();
        assert_eq!(parsed.rest, args(&["logs", "api-1"]));
        assert_eq!(parsed.values["container"], "api");
        assert_eq!(parsed.values["tail"], "50");
        assert_eq!(parsed.values["namespace"], "shop");
        assert!(parsed.flags.contains(&"previous"));
        assert!(parse(&args(&["get", "pods", "--context"])).is_err());
    }

    #[test]
    fn an_inspect_keeps_env_names_and_drops_their_values() {
        let text = masked_inspect(r#"[{"Config": {"Env": ["DATABASE_URL=postgres://u:pw@db/app", "MODE=dev"]}}]"#.trim_start_matches('[').trim_end_matches(']'));
        assert!(text.contains("DATABASE_URL=••••••") && text.contains("MODE=••••••"), "{text}");
        assert!(!text.contains("pw@db"));
    }

    #[test]
    fn kinds_read_like_kubectl() {
        assert_eq!(kind_of("po"), "pods");
        assert_eq!(kind_of("Deploy"), "deployments");
        assert_eq!(kind_of("services"), "services");
    }

    #[test]
    fn only_reads_are_verbs() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        for verb in ["delete", "scale", "apply", "start", "restart", "exec"] {
            if crate::containers::cli::find("kubectl").is_some() {
                let reply = rt.block_on(k8s(&args(&[verb, "pods", "x"])));
                assert!(!reply.ok && reply.text.contains("not a read"), "{verb}: {}", reply.text);
            }
        }
    }
}
