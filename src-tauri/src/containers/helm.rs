//! Helm, as far as one cluster's releases go: what is installed (`helm list`), one release's state,
//! history, values and manifest, and the verbs a person types most — upgrade with other values, roll
//! back to a revision, uninstall, and install a chart from a repository. Found, not embedded: the
//! user's own `helm`, its own repositories (`helm repo …`, which live in Helm's config, not here) and
//! its own cache.
//!
//! **One context, named every time.** Every command carries `--kube-context`, as every kubectl of the
//! panel carries `--context`: picking a cluster here never changes what the terminal points at. The
//! `KUBECONFIG` it reads is the panel's (`cli::engine_env`), so a cluster added in the panel is a
//! cluster Helm reaches too.
//!
//! **Values go in through stdin** (`-f -`): an edited YAML never touches the disk, and never becomes
//! an argument a process list would show. An empty one on an upgrade is `--reset-values` — the
//! chart's defaults — since Helm would otherwise keep the old ones, the opposite of what clearing the
//! box says.
//!
//! **What upgrades a release is a chart, not the release.** Helm keeps the chart's name and version
//! with a release but not the repository it came from, so an upgrade names it again: the page offers
//! `repo/name` from the repositories that have a chart of that name ([`guess_chart`]) and lets the
//! person correct it.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::cli;

const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// An install or an upgrade downloads its chart and submits the objects (no `--wait`): a slow
/// repository and a slow API server together, never ten minutes.
const CHANGE_TIMEOUT: Duration = Duration::from_secs(600);
/// `helm repo update` fetches every repository's index.
const REPO_TIMEOUT: Duration = Duration::from_secs(180);

pub fn program() -> Result<String, String> {
    cli::find("helm").map(|p| p.to_string_lossy().into_owned()).ok_or_else(|| "Helm (`helm`) is not installed".to_string())
}

// --------------------------------------------------------------------------------- validation

fn dns_label(value: &str, max: usize) -> bool {
    let edge = |c: Option<char>| c.is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    !value.is_empty() && value.len() <= max && edge(value.chars().next()) && edge(value.chars().last()) && value.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// A release name as Helm takes it: a DNS label of at most 53 characters.
pub fn check_release(name: &str) -> Result<(), String> {
    if dns_label(name, 53) {
        Ok(())
    } else {
        Err(format!("\"{name}\" is not a release name: lowercase letters, digits and dashes, up to 53"))
    }
}

pub fn check_namespace(namespace: &str) -> Result<(), String> {
    if dns_label(namespace, 63) {
        Ok(())
    } else {
        Err(format!("\"{namespace}\" is not a namespace"))
    }
}

/// Anything else that becomes a positional argument or a flag's value — a chart, a version, a
/// context, a search term: never empty, never a flag, never more than one word.
fn check_word(value: &str, what: &str) -> Result<(), String> {
    if value.is_empty() || value.starts_with('-') || value.chars().any(|c| c.is_whitespace() || c.is_control()) {
        Err(format!("\"{value}\" is not a {what}"))
    } else {
        Ok(())
    }
}

pub fn check_repo_name(name: &str) -> Result<(), String> {
    let valid = name.len() <= 100 && name.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'));
    if valid {
        Ok(())
    } else {
        Err(format!("\"{name}\" is not a repository name: a letter or digit, then letters, digits, _ . -"))
    }
}

pub fn check_repo_url(url: &str) -> Result<(), String> {
    check_word(url, "repository address")?;
    let lower = url.to_lowercase();
    if lower.starts_with("https://") || lower.starts_with("http://") || lower.starts_with("oci://") {
        Ok(())
    } else {
        Err(format!("\"{url}\" is not a repository address: https://…"))
    }
}

/// `--kube-context X` — none when the panel's context is the current one.
fn context_args(context: Option<&str>) -> Result<Vec<String>, String> {
    match context.map(str::trim).filter(|c| !c.is_empty()) {
        Some(c) => {
            check_word(c, "context")?;
            Ok(vec!["--kube-context".into(), c.into()])
        }
        None => Ok(vec![]),
    }
}

/// One release of one namespace, as the commands that act on it name it.
fn release_args(verb: &[&str], context: Option<&str>, namespace: &str, name: &str) -> Result<Vec<String>, String> {
    check_release(name)?;
    check_namespace(namespace)?;
    let mut args: Vec<String> = verb.iter().map(|v| v.to_string()).collect();
    args.extend([name.to_string(), "-n".into(), namespace.to_string()]);
    args.extend(context_args(context)?);
    Ok(args)
}

// ---------------------------------------------------------------------------------- arguments

pub fn list_args(context: Option<&str>) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = ["list", "--all-namespaces", "--all", "-o", "json"].iter().map(|a| a.to_string()).collect();
    args.extend(context_args(context)?);
    Ok(args)
}

pub fn history_args(context: Option<&str>, namespace: &str, name: &str) -> Result<Vec<String>, String> {
    let mut args = release_args(&["history"], context, namespace, name)?;
    args.extend(["--max".into(), "50".into(), "-o".into(), "json".into()]);
    Ok(args)
}

pub fn status_args(context: Option<&str>, namespace: &str, name: &str) -> Result<Vec<String>, String> {
    let mut args = release_args(&["status"], context, namespace, name)?;
    args.extend(["-o".into(), "json".into()]);
    Ok(args)
}

pub fn values_args(context: Option<&str>, namespace: &str, name: &str) -> Result<Vec<String>, String> {
    let mut args = release_args(&["get", "values"], context, namespace, name)?;
    args.extend(["-o".into(), "yaml".into()]);
    Ok(args)
}

pub fn manifest_args(context: Option<&str>, namespace: &str, name: &str) -> Result<Vec<String>, String> {
    release_args(&["get", "manifest"], context, namespace, name)
}

/// What an install or an upgrade is asked for.
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HelmChange {
    #[serde(default)]
    pub context: Option<String>,
    pub namespace: String,
    pub name: String,
    /// `repo/chart`, `oci://…`, or a chart folder of this computer.
    pub chart: String,
    #[serde(default)]
    pub version: Option<String>,
    /// YAML; empty for none.
    #[serde(default)]
    pub values: String,
}

fn change_args(verb: &str, change: &HelmChange) -> Result<Vec<String>, String> {
    let chart = change.chart.trim();
    check_word(chart, "chart")?;
    let mut args = release_args(&[verb], change.context.as_deref(), change.namespace.trim(), change.name.trim())?;
    // The chart is the second positional: after the release's name, before its flags.
    args.insert(2, chart.to_string());
    if let Some(version) = change.version.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        check_word(version, "chart version")?;
        args.extend(["--version".into(), version.into()]);
    }
    if !change.values.trim().is_empty() {
        args.extend(["-f".into(), "-".into()]);
    } else if verb == "upgrade" {
        args.push("--reset-values".into());
    }
    if verb == "install" {
        args.push("--create-namespace".into());
    }
    Ok(args)
}

pub fn install_args(change: &HelmChange) -> Result<Vec<String>, String> {
    change_args("install", change)
}

pub fn upgrade_args(change: &HelmChange) -> Result<Vec<String>, String> {
    change_args("upgrade", change)
}

pub fn rollback_args(context: Option<&str>, namespace: &str, name: &str, revision: u32) -> Result<Vec<String>, String> {
    if revision == 0 {
        return Err("0 is not a revision".into());
    }
    let mut args = release_args(&["rollback"], context, namespace, name)?;
    args.insert(2, revision.to_string());
    Ok(args)
}

pub fn uninstall_args(context: Option<&str>, namespace: &str, name: &str) -> Result<Vec<String>, String> {
    release_args(&["uninstall"], context, namespace, name)
}

pub fn search_args(term: &str, versions: bool) -> Result<Vec<String>, String> {
    let mut args: Vec<String> = vec!["search".into(), "repo".into()];
    let term = term.trim();
    // No term lists every chart of every repository.
    if !term.is_empty() {
        check_word(term, "search term")?;
        args.push(term.into());
    }
    if versions {
        args.push("--versions".into());
    }
    args.extend(["-o".into(), "json".into()]);
    Ok(args)
}

pub fn show_values_args(chart: &str, version: Option<&str>) -> Result<Vec<String>, String> {
    check_word(chart, "chart")?;
    let mut args: Vec<String> = vec!["show".into(), "values".into(), chart.into()];
    if let Some(v) = version.map(str::trim).filter(|v| !v.is_empty()) {
        check_word(v, "chart version")?;
        args.extend(["--version".into(), v.into()]);
    }
    Ok(args)
}

// ------------------------------------------------------------------------------------ parsing

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HelmRelease {
    pub name: String,
    pub namespace: String,
    pub revision: u32,
    pub updated: String,
    /// `deployed`, `failed`, `pending-install`, `pending-upgrade`, `superseded`, `uninstalling`…
    pub status: String,
    /// `nginx-15.0.0`, as Helm prints it.
    pub chart: String,
    /// The chart's own name and version, split out of `chart`.
    pub chart_name: String,
    pub chart_version: String,
    pub app_version: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HelmRevision {
    pub revision: u32,
    pub updated: String,
    pub status: String,
    pub chart: String,
    pub app_version: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HelmReleaseDetail {
    pub name: String,
    pub namespace: String,
    pub status: String,
    pub description: String,
    pub revision: u32,
    pub first_deployed: String,
    pub last_deployed: String,
    pub chart_name: String,
    pub chart_version: String,
    pub app_version: String,
    pub notes: String,
    pub history: Vec<HelmRevision>,
    /// The values given to it (not the chart's defaults), as YAML; `""` for none.
    pub values: String,
    pub manifest: String,
    /// `repo/chart` an upgrade most likely means, when a repository has a chart of that name.
    pub chart_guess: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HelmRepo {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HelmChart {
    /// `repo/chart`.
    pub name: String,
    pub version: String,
    pub app_version: String,
    pub description: String,
}

fn text(value: &Value, key: &str) -> String {
    match value.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn number(value: &Value, key: &str) -> u32 {
    match value.get(key) {
        Some(Value::Number(n)) => n.as_u64().unwrap_or(0) as u32,
        Some(Value::String(s)) => s.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

/// `ingress-nginx-4.10.0` → (`ingress-nginx`, `4.10.0`): the version starts at the last dash a digit
/// (or `v` and a digit, as cert-manager tags its chart) follows — a chart's name may hold dashes and
/// digits, its version always starts with one.
pub fn split_chart(chart: &str) -> (String, String) {
    let bytes = chart.as_bytes();
    let digit = |i: usize| bytes.get(i).is_some_and(u8::is_ascii_digit);
    let at = (0..bytes.len()).rev().find(|&i| bytes[i] == b'-' && (digit(i + 1) || (bytes.get(i + 1) == Some(&b'v') && digit(i + 2))));
    match at {
        Some(i) => (chart[..i].to_string(), chart[i + 1..].to_string()),
        None => (chart.to_string(), String::new()),
    }
}

/// `helm list -o json`. Revisions come as strings there, numbers in `history`.
pub fn parse_releases(text_out: &str) -> Vec<HelmRelease> {
    cli::json_values(text_out)
        .iter()
        .filter_map(|r| {
            let name = text(r, "name");
            if name.is_empty() {
                return None;
            }
            let chart = text(r, "chart");
            let (chart_name, chart_version) = split_chart(&chart);
            Some(HelmRelease {
                name,
                namespace: text(r, "namespace"),
                revision: number(r, "revision"),
                updated: text(r, "updated"),
                status: text(r, "status"),
                chart,
                chart_name,
                chart_version,
                app_version: text(r, "app_version"),
            })
        })
        .collect()
}

/// `helm history -o json`, newest first.
pub fn parse_history(text_out: &str) -> Vec<HelmRevision> {
    let mut out: Vec<HelmRevision> = cli::json_values(text_out)
        .iter()
        .map(|r| HelmRevision {
            revision: number(r, "revision"),
            updated: text(r, "updated"),
            status: text(r, "status"),
            chart: text(r, "chart"),
            app_version: text(r, "app_version"),
            description: text(r, "description"),
        })
        .filter(|r| r.revision > 0)
        .collect();
    out.sort_by(|a, b| b.revision.cmp(&a.revision));
    out
}

/// `helm get values -o yaml`: `null` (or `{}`) when the release was given none.
pub fn tidy_values(yaml: &str) -> String {
    match yaml.trim() {
        "" | "null" | "{}" => String::new(),
        _ => yaml.trim_end().to_string() + "\n",
    }
}

/// `helm repo list -o json`.
pub fn parse_repos(text_out: &str) -> Vec<HelmRepo> {
    cli::json_values(text_out).iter().map(|r| HelmRepo { name: text(r, "name"), url: text(r, "url") }).filter(|r| !r.name.is_empty()).collect()
}

/// `helm search repo -o json`.
pub fn parse_charts(text_out: &str) -> Vec<HelmChart> {
    cli::json_values(text_out)
        .iter()
        .map(|c| HelmChart { name: text(c, "name"), version: text(c, "version"), app_version: text(c, "app_version"), description: text(c, "description") })
        .filter(|c| !c.name.is_empty())
        .collect()
}

/// The `repo/chart` a release's chart most likely came from: the one search result whose chart part
/// is that name — the one with that version, when several repositories have it.
pub fn guess_chart(charts: &[HelmChart], chart_name: &str, version: &str) -> Option<String> {
    let same: Vec<&HelmChart> = charts.iter().filter(|c| c.name.rsplit('/').next() == Some(chart_name)).collect();
    same.iter().find(|c| c.version == version).or(same.first()).map(|c| c.name.clone())
}

/// Helm's complaint without its `Error: ` in front.
fn tidy_error(message: &str) -> String {
    message.trim().strip_prefix("Error: ").unwrap_or(message.trim()).to_string()
}

// ----------------------------------------------------------------------------------- running

async fn run(args: Vec<String>, stdin: Option<&str>, timeout: Duration) -> Result<String, String> {
    let program = program()?;
    let out = cli::run(&program, &args, stdin, timeout).await?;
    if out.ok() {
        Ok(out.stdout)
    } else {
        Err(tidy_error(&out.complaint()))
    }
}

pub async fn releases(context: Option<&str>) -> Result<Vec<HelmRelease>, String> {
    run(list_args(context)?, None, READ_TIMEOUT).await.map(|out| parse_releases(&out))
}

pub async fn release(context: Option<&str>, namespace: &str, name: &str) -> Result<HelmReleaseDetail, String> {
    let (status, history, values, manifest) = tokio::join!(
        run(status_args(context, namespace, name)?, None, READ_TIMEOUT),
        run(history_args(context, namespace, name)?, None, READ_TIMEOUT),
        run(values_args(context, namespace, name)?, None, READ_TIMEOUT),
        run(manifest_args(context, namespace, name)?, None, READ_TIMEOUT),
    );
    let doc: Value = serde_json::from_str(&status?).map_err(|e| format!("helm status: {e}"))?;
    let meta = doc.pointer("/chart/metadata").cloned().unwrap_or(Value::Null);
    let info = doc.get("info").cloned().unwrap_or(Value::Null);
    let chart_name = text(&meta, "name");
    let chart_version = text(&meta, "version");
    // Only a guess, and only from the repositories' local index: a search that fails guesses nothing.
    let chart_guess = if chart_name.is_empty() {
        None
    } else {
        match search_args(&chart_name, false) {
            Ok(args) => run(args, None, READ_TIMEOUT).await.ok().and_then(|out| guess_chart(&parse_charts(&out), &chart_name, &chart_version)),
            Err(_) => None,
        }
    };
    Ok(HelmReleaseDetail {
        name: name.to_string(),
        namespace: namespace.to_string(),
        status: text(&info, "status"),
        description: text(&info, "description"),
        revision: number(&doc, "version"),
        first_deployed: text(&info, "first_deployed"),
        last_deployed: text(&info, "last_deployed"),
        app_version: text(&meta, "appVersion"),
        notes: text(&info, "notes"),
        history: history.map(|h| parse_history(&h)).unwrap_or_default(),
        values: values.map(|v| tidy_values(&v)).unwrap_or_default(),
        manifest: manifest.unwrap_or_default(),
        chart_name,
        chart_version,
        chart_guess,
    })
}

fn values_in(change: &HelmChange) -> Option<&str> {
    Some(change.values.as_str()).filter(|v| !v.trim().is_empty())
}

pub async fn install(change: &HelmChange) -> Result<String, String> {
    run(install_args(change)?, values_in(change), CHANGE_TIMEOUT).await
}

pub async fn upgrade(change: &HelmChange) -> Result<String, String> {
    run(upgrade_args(change)?, values_in(change), CHANGE_TIMEOUT).await
}

pub async fn rollback(context: Option<&str>, namespace: &str, name: &str, revision: u32) -> Result<String, String> {
    run(rollback_args(context, namespace, name, revision)?, None, CHANGE_TIMEOUT).await
}

pub async fn uninstall(context: Option<&str>, namespace: &str, name: &str) -> Result<String, String> {
    run(uninstall_args(context, namespace, name)?, None, CHANGE_TIMEOUT).await
}

pub async fn repos() -> Result<Vec<HelmRepo>, String> {
    match run(vec!["repo".into(), "list".into(), "-o".into(), "json".into()], None, READ_TIMEOUT).await {
        Ok(out) => Ok(parse_repos(&out)),
        // Helm says so with an error when there are none.
        Err(error) if error.contains("no repositories") => Ok(vec![]),
        Err(error) => Err(error),
    }
}

pub async fn repo_add(name: &str, url: &str) -> Result<String, String> {
    check_repo_name(name)?;
    check_repo_url(url)?;
    run(vec!["repo".into(), "add".into(), name.into(), url.into()], None, REPO_TIMEOUT).await
}

pub async fn repo_remove(name: &str) -> Result<String, String> {
    check_repo_name(name)?;
    run(vec!["repo".into(), "remove".into(), name.into()], None, READ_TIMEOUT).await
}

pub async fn repo_update() -> Result<String, String> {
    run(vec!["repo".into(), "update".into()], None, REPO_TIMEOUT).await
}

pub async fn search(term: &str, versions: bool) -> Result<Vec<HelmChart>, String> {
    match run(search_args(term, versions)?, None, READ_TIMEOUT).await {
        Ok(out) => Ok(parse_charts(&out)),
        Err(error) if error.contains("no repositories") => Ok(vec![]),
        Err(error) => Err(error),
    }
}

pub async fn chart_values(chart: &str, version: Option<&str>) -> Result<String, String> {
    run(show_values_args(chart, version)?, None, CHANGE_TIMEOUT).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(values: &str) -> HelmChange {
        HelmChange { context: Some("kind-dev".into()), namespace: "web".into(), name: "site".into(), chart: "bitnami/nginx".into(), version: Some("15.0.0".into()), values: values.into() }
    }

    #[test]
    fn names_that_could_be_flags_are_refused() {
        assert!(check_release("site").is_ok());
        for bad in ["", "-site", "Site", "site_1", "a b", &"x".repeat(54)] {
            assert!(check_release(bad).is_err(), "{bad}");
        }
        assert!(check_namespace("kube-system").is_ok());
        assert!(check_namespace("--all").is_err());
        assert!(check_repo_name("bitnami").is_ok());
        assert!(check_repo_name("-x").is_err());
        assert!(check_repo_url("https://charts.bitnami.com/bitnami").is_ok());
        assert!(check_repo_url("oci://registry-1.docker.io/bitnamicharts").is_ok());
        assert!(check_repo_url("file:///etc").is_err());
        assert!(check_repo_url("--insecure").is_err());
        assert!(list_args(Some("--kubeconfig=/x")).is_err());
    }

    #[test]
    fn reading_commands_name_the_context() {
        assert_eq!(list_args(Some("kind-dev")).unwrap(), vec!["list", "--all-namespaces", "--all", "-o", "json", "--kube-context", "kind-dev"]);
        assert_eq!(list_args(None).unwrap(), vec!["list", "--all-namespaces", "--all", "-o", "json"]);
        assert_eq!(history_args(Some("c"), "web", "site").unwrap(), vec!["history", "site", "-n", "web", "--kube-context", "c", "--max", "50", "-o", "json"]);
        assert_eq!(values_args(None, "web", "site").unwrap(), vec!["get", "values", "site", "-n", "web", "-o", "yaml"]);
        assert_eq!(manifest_args(None, "web", "site").unwrap(), vec!["get", "manifest", "site", "-n", "web"]);
        assert_eq!(status_args(None, "web", "site").unwrap(), vec!["status", "site", "-n", "web", "-o", "json"]);
    }

    #[test]
    fn changes_take_their_values_from_stdin() {
        assert_eq!(
            install_args(&change("replicaCount: 2\n")).unwrap(),
            vec!["install", "site", "bitnami/nginx", "-n", "web", "--kube-context", "kind-dev", "--version", "15.0.0", "-f", "-", "--create-namespace"]
        );
        assert_eq!(upgrade_args(&change("a: 1")).unwrap(), vec!["upgrade", "site", "bitnami/nginx", "-n", "web", "--kube-context", "kind-dev", "--version", "15.0.0", "-f", "-"]);
        let cleared = upgrade_args(&change("  \n")).unwrap();
        assert_eq!(cleared.last().map(String::as_str), Some("--reset-values"), "an emptied box means the chart's defaults");
        let mut flag = change("");
        flag.chart = "--set=x".into();
        assert!(install_args(&flag).is_err());
        let mut version = change("");
        version.version = Some("1.0 --dry-run".into());
        assert!(upgrade_args(&version).is_err());
    }

    #[test]
    fn rollback_and_uninstall() {
        assert_eq!(rollback_args(Some("c"), "web", "site", 3).unwrap(), vec!["rollback", "site", "3", "-n", "web", "--kube-context", "c"]);
        assert!(rollback_args(None, "web", "site", 0).is_err());
        assert_eq!(uninstall_args(None, "web", "site").unwrap(), vec!["uninstall", "site", "-n", "web"]);
    }

    #[test]
    fn search_and_chart_values() {
        assert_eq!(search_args("", false).unwrap(), vec!["search", "repo", "-o", "json"]);
        assert_eq!(search_args("nginx", true).unwrap(), vec!["search", "repo", "nginx", "--versions", "-o", "json"]);
        assert!(search_args("-x", false).is_err());
        assert_eq!(show_values_args("bitnami/nginx", Some("15.0.0")).unwrap(), vec!["show", "values", "bitnami/nginx", "--version", "15.0.0"]);
    }

    #[test]
    fn chart_names_split_at_their_version() {
        assert_eq!(split_chart("ingress-nginx-4.10.0"), ("ingress-nginx".into(), "4.10.0".into()));
        assert_eq!(split_chart("cert-manager-v1.14.4"), ("cert-manager".into(), "v1.14.4".into()), "cert-manager tags its chart v1.14.4");
        assert_eq!(split_chart("k8s-2-app-0.1.0"), ("k8s-2-app".into(), "0.1.0".into()));
        assert_eq!(split_chart("nginx"), ("nginx".into(), String::new()));
    }

    #[test]
    fn outputs_read() {
        let list = r#"[{"name":"site","namespace":"web","revision":"3","updated":"2026-11-20 10:00:00.1 +0000 UTC","status":"deployed","chart":"nginx-15.0.0","app_version":"1.25.3"}]"#;
        let releases = parse_releases(list);
        assert_eq!(releases.len(), 1);
        assert_eq!((releases[0].revision, releases[0].chart_name.as_str(), releases[0].chart_version.as_str()), (3, "nginx", "15.0.0"));
        assert!(parse_releases("[]").is_empty());
        let history = r#"[{"revision":1,"updated":"x","status":"superseded","chart":"nginx-14.0.0","app_version":"1.25","description":"Install complete"},{"revision":2,"updated":"y","status":"deployed","chart":"nginx-15.0.0","app_version":"1.25.3","description":"Upgrade complete"}]"#;
        let revisions = parse_history(history);
        assert_eq!(revisions.iter().map(|r| r.revision).collect::<Vec<_>>(), vec![2, 1], "newest first");
        assert_eq!(tidy_values("null\n"), "");
        assert_eq!(tidy_values("{}\n"), "");
        assert_eq!(tidy_values("replicaCount: 2"), "replicaCount: 2\n");
        assert_eq!(parse_repos(r#"[{"name":"bitnami","url":"https://charts.bitnami.com/bitnami"}]"#), vec![HelmRepo { name: "bitnami".into(), url: "https://charts.bitnami.com/bitnami".into() }]);
        let charts = parse_charts(r#"[{"name":"bitnami/nginx","version":"15.0.0","app_version":"1.25.3","description":"NGINX"},{"name":"other/nginx","version":"14.0.0","app_version":"","description":""},{"name":"bitnami/nginx-ingress","version":"1.0.0"}]"#);
        assert_eq!(charts.len(), 3);
        assert_eq!(guess_chart(&charts, "nginx", "14.0.0").as_deref(), Some("other/nginx"));
        assert_eq!(guess_chart(&charts, "nginx", "9.9.9").as_deref(), Some("bitnami/nginx"));
        assert_eq!(guess_chart(&charts, "redis", "1"), None);
        assert_eq!(tidy_error("Error: release: not found"), "release: not found");
    }
}
