//! R-0004 — dependencies a `package.json` could raise within their line, and own packages behind.
//!
//! For each `dependencies`/`devDependencies` entry with a registry spec (`^1.2.3`, `~1.2.3`,
//! `1.2.3`, `>=1.2.3`, `1.x`): the newest stable version on the same line — same major, or same
//! minor under 0.x, what a caret allows — when it is newer than the spec's floor (`minor_updates`);
//! and, for the own scopes (`@achs/`), a newer MAJOR too (`own_behind`). Tags, `workspace:`,
//! `file:`, git and `npm:` aliases are skipped.
//!
//! The registry is the repository's: the `.npmrc` next to the `package.json`, else at the root
//! (`registry=` and `@scope:registry=`), else the public npm. An Azure Artifacts feed
//! (`pkgs.dev.azure.com`, `*.pkgs.visualstudio.com`) is read with the organisation's Azure DevOps
//! PAT already stored in CodeFlow; a 401/403 there is that registry's `not_evaluated`, never a
//! stopped review. Port of the reference tool's `rules/R-0004.py`.

use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;

use futures_util::future::BoxFuture;
use futures_util::StreamExt;
use regex::Regex;
use serde_json::{json, Value};

use super::source::HttpError;
use super::{capped, Facts, Rule, RuleCx, RuleMeta};

pub const PUBLIC_REGISTRY: &str = "https://registry.npmjs.org/";
const OWN_SCOPES: &[&str] = &["@achs/"];
const MAX_DEPENDENCIES: usize = 150;
const CONCURRENCY: usize = 8;
/// The abbreviated packument: versions and dist-tags, a fraction of the full document.
const ABBREVIATED: &str = "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8";

static META: RuleMeta = RuleMeta {
    id: "R-0004",
    title: "Dependencias que pueden subir dentro de su línea",
    severity: "Info",
    categories: &["outdated-dependency"],
    paths: &["**/package.json"],
    levels: &["completo", "ultra"],
    enabled: true,
    timeout_secs: 120,
    instruction: "Los hechos listan, por cada package.json de este PR, las dependencias cuyo spec puede subir a una versión \
más nueva dentro de su línea (minor_updates: mismo major; mismo minor bajo 0.x) y los paquetes propios (@achs/*) con un \
MAJOR más nuevo (own_behind). UN hallazgo por package.json: tipo Code Smell, severidad Info, confianza 80, anclado en una \
línea cambiada de ese archivo; lista las actualizaciones en el porqué (a lo sumo 15, luego cuántas más) y sugiere subirlas, \
primero los majors propios, avisando que requieren revisar sus breaking changes. not_evaluated: un hallazgo nombrando el \
registry que no se pudo leer y por qué, severidad Info, confianza 60. Nada listado: ningún hallazgo.",
};

pub struct Deps;

impl Rule for Deps {
    fn meta(&self) -> &'static RuleMeta {
        &META
    }

    fn evaluate<'a>(&'a self, cx: &'a RuleCx<'a>) -> BoxFuture<'a, Result<Facts, String>> {
        Box::pin(collect(cx))
    }
}

type Version = (u64, u64, u64);

fn spec_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(\^|~|>=|=)?\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-[\w.]+)?$").unwrap())
}

fn stable_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(\d+)\.(\d+)\.(\d+)$").unwrap())
}

/// The floor of a registry spec, or `None` when it is not one (a tag, a path, a git URL, an alias).
fn spec_floor(spec: &str) -> Option<Version> {
    let text = spec.trim().split("||").next().unwrap_or("").trim();
    let caps = spec_re().captures(text)?;
    let n = |i: usize| caps.get(i).and_then(|m| m.as_str().parse::<u64>().ok()).unwrap_or(0);
    Some((n(2), n(3), n(4)))
}

fn stable(version: &str) -> Option<Version> {
    let caps = stable_re().captures(version)?;
    Some((caps[1].parse().ok()?, caps[2].parse().ok()?, caps[3].parse().ok()?))
}

fn stable_versions(packument: &Value) -> Vec<Version> {
    let mut out: Vec<Version> = packument.get("versions").and_then(Value::as_object).into_iter().flatten().filter_map(|(k, _)| stable(k)).collect();
    out.sort_unstable();
    out
}

fn v(n: Version) -> String {
    format!("{}.{}.{}", n.0, n.1, n.2)
}

/// `{"": registry, "@scope": registry}` of an `.npmrc`. Auth lines are never read.
fn parse_npmrc(text: Option<&str>) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for line in text.unwrap_or("").lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        let (key, value) = (key.trim(), value.trim());
        if key == "registry" {
            out.insert(String::new(), value.to_string());
        } else if let Some(scope) = key.strip_suffix(":registry").filter(|s| s.starts_with('@')) {
            out.insert(scope.to_string(), value.to_string());
        }
    }
    out
}

fn host_of(url: &str) -> String {
    reqwest::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_lowercase)).unwrap_or_default()
}

fn is_azure_artifacts(url: &str) -> bool {
    let host = host_of(url);
    host == "pkgs.dev.azure.com" || host.ends_with(".pkgs.visualstudio.com")
}

/// The Azure DevOps organisation an Artifacts feed belongs to — whose PAT reads it.
fn azure_org(url: &str) -> Option<String> {
    let parsed = reqwest::Url::parse(url).ok()?;
    let host = parsed.host_str()?.to_lowercase();
    if host == "pkgs.dev.azure.com" {
        return parsed.path_segments()?.next().filter(|s| !s.is_empty()).map(str::to_string);
    }
    host.strip_suffix(".pkgs.visualstudio.com").map(str::to_string)
}

fn registry_for(name: &str, registries: &BTreeMap<String, String>) -> String {
    let scope = if name.starts_with('@') { name.split('/').next().unwrap_or("") } else { "" };
    let url = registries.get(scope).or_else(|| registries.get("")).map(String::as_str).unwrap_or(PUBLIC_REGISTRY);
    if url.ends_with('/') {
        url.to_string()
    } else {
        format!("{url}/")
    }
}

/// The facts of one `package.json`.
async fn check_package_json(path: &str, text: &str, registries: &BTreeMap<String, String>, cx: &RuleCx<'_>) -> Value {
    let Ok(doc) = serde_json::from_str::<Value>(text) else {
        return json!({ "file": path, "not_evaluated": "package.json ilegible" });
    };
    let mut deps: BTreeMap<String, (String, Version)> = BTreeMap::new();
    for section in ["dependencies", "devDependencies"] {
        for (name, spec) in doc.get(section).and_then(Value::as_object).into_iter().flatten() {
            if let Some(spec) = spec.as_str() {
                if let Some(floor) = spec_floor(spec) {
                    deps.insert(name.clone(), (spec.to_string(), floor));
                }
            }
        }
    }
    let names: Vec<String> = deps.keys().take(MAX_DEPENDENCIES).cloned().collect();

    // One PAT lookup per organisation, not per package.
    let mut pats: HashMap<String, Option<String>> = HashMap::new();
    for name in &names {
        let registry = registry_for(name, registries);
        if let Some(org) = azure_org(&registry).filter(|_| is_azure_artifacts(&registry)) {
            pats.entry(org.to_lowercase()).or_insert_with(|| cx.net.ado_pat(&org));
        }
    }

    enum Got {
        Packument(Value),
        Failed(HttpError),
        NoPat(String),
    }
    // Boxed as they are built, so the whole rule stays `Send` (see R-0001's vault reads).
    let jobs: Vec<BoxFuture<'_, (String, String, Got)>> = names.iter().cloned().map(|name| {
        let registry = registry_for(&name, registries);
        let mut headers = vec![("Accept".to_string(), ABBREVIATED.to_string())];
        let mut no_pat = None;
        if is_azure_artifacts(&registry) {
            let org = azure_org(&registry).unwrap_or_default();
            match pats.get(&org.to_lowercase()).cloned().flatten() {
                Some(pat) => headers.push(("Authorization".to_string(), crate::ado::auth_header(&pat))),
                None => no_pat = Some(org),
            }
        }
        // `@scope/name` → `@scope%2Fname`, the way the registry API addresses a scoped package.
        let url = format!("{registry}{}", name.replace('/', "%2F"));
        Box::pin(async move {
            let got = match no_pat {
                Some(org) => Got::NoPat(org),
                None => match cx.net.get_json(&url, headers).await {
                    Ok(p) => Got::Packument(p),
                    Err(e) => Got::Failed(e),
                },
            };
            (name, registry, got)
        }) as BoxFuture<'_, (String, String, Got)>
    }).collect();
    let fetches = futures_util::stream::iter(jobs)
    .buffer_unordered(CONCURRENCY)
    .collect::<Vec<_>>()
    .await;

    let mut minor = Vec::new();
    let mut own = Vec::new();
    let mut denied: BTreeMap<String, String> = BTreeMap::new();
    let mut failed = 0usize;
    for (name, registry, got) in fetches {
        let packument = match got {
            Got::Packument(p) => p,
            Got::NoPat(org) => {
                denied.insert(host_of(&registry), format!("sin PAT de Azure DevOps guardado para la organización {org}"));
                failed += 1;
                continue;
            }
            Got::Failed(e) => {
                if e.denied() {
                    denied.insert(host_of(&registry), e.reason());
                }
                failed += 1;
                continue;
            }
        };
        let (spec, floor) = &deps[&name];
        let versions = stable_versions(&packument);
        if versions.is_empty() {
            continue;
        }
        let same_line = versions.iter().filter(|c| c.0 == floor.0 && (floor.0 > 0 || c.1 == floor.1) && **c > *floor).max();
        if let Some(newest) = same_line {
            minor.push(format!("{name} {spec} → {}", v(*newest)));
        }
        let latest = packument.get("dist-tags").and_then(|t| t.get("latest")).and_then(Value::as_str).unwrap_or("");
        if OWN_SCOPES.iter().any(|s| name.starts_with(s)) {
            if let Some(latest_v) = stable(latest).filter(|l| l.0 > floor.0) {
                own.push(format!("{name} {spec} → {} (mayor)", v(latest_v)));
            }
        }
    }
    let mut out = json!({ "file": path, "checked": names.len() });
    if !minor.is_empty() {
        out["minor_updates"] = json!(capped(minor));
    }
    if !own.is_empty() {
        out["own_behind"] = json!(capped(own));
    }
    if !denied.is_empty() {
        out["not_evaluated"] = json!(denied.iter().map(|(host, why)| format!("{host}: {why}")).collect::<Vec<_>>().join("; "));
    } else if failed > 0 {
        out["unresolved"] = json!(failed);
    }
    out
}

async fn collect(cx: &RuleCx<'_>) -> Result<Facts, String> {
    let targets: Vec<&String> = cx.matched.iter().filter(|p| p.rsplit('/').next() == Some("package.json")).collect();
    if targets.is_empty() {
        return Ok(Facts::NotApplicable("el PR no cambia un package.json".into()));
    }
    // An .npmrc that cannot be read is an .npmrc with no registries: the public one is still worth asking.
    let root_npmrc = cx.source.read(".npmrc").await.ok().flatten();
    let mut results = Vec::new();
    for path in targets {
        let text = match cx.source.read(path).await {
            Ok(Some(text)) => text,
            Ok(None) => continue,
            Err(e) => {
                results.push(json!({ "file": path, "not_evaluated": format!("no se pudo leer: {e}") }));
                continue;
            }
        };
        let mut registries = parse_npmrc(root_npmrc.as_deref());
        if let Some((dir, _)) = path.rsplit_once('/') {
            let local = cx.source.read(&format!("{dir}/.npmrc")).await.ok().flatten();
            registries.extend(parse_npmrc(local.as_deref()));
        }
        results.push(check_package_json(path, &text, &registries, cx).await);
    }
    let worth: Vec<Value> = results
        .into_iter()
        .filter(|r| r.get("minor_updates").is_some() || r.get("own_behind").is_some() || r.get("not_evaluated").is_some())
        .collect();
    if worth.is_empty() {
        return Ok(Facts::NotApplicable("las dependencias están al día dentro de su línea".into()));
    }
    Ok(Facts::Found(json!({ "files": worth })))
}

#[cfg(test)]
mod tests {
    use super::super::source::fake::{FakeNet, Files};
    use super::super::PrFile;
    use super::*;

    #[test]
    fn specs_registries_and_feeds() {
        assert_eq!(spec_floor("^1.2.3"), Some((1, 2, 3)));
        assert_eq!(spec_floor("~0.4"), Some((0, 4, 0)));
        assert_eq!(spec_floor("1.x"), Some((1, 0, 0)));
        assert_eq!(spec_floor(">=2.0.0-beta.1"), Some((2, 0, 0)));
        for skipped in ["latest", "workspace:*", "file:../x", "github:a/b", "npm:other@1"] {
            assert_eq!(spec_floor(skipped), None, "{skipped}");
        }
        let rc = parse_npmrc(Some("registry=https://registry.example.com\n@achs:registry=https://pkgs.dev.azure.com/achs/_packaging/feed/npm/registry/\n//pkgs.dev.azure.com/:_authToken=SECRET\n"));
        assert_eq!(rc.len(), 2);
        assert_eq!(registry_for("@achs/env", &rc), "https://pkgs.dev.azure.com/achs/_packaging/feed/npm/registry/");
        assert_eq!(registry_for("lodash", &rc), "https://registry.example.com/");
        assert_eq!(registry_for("lodash", &BTreeMap::new()), PUBLIC_REGISTRY);
        assert!(is_azure_artifacts("https://contoso.pkgs.visualstudio.com/_packaging/x/npm/registry/"));
        assert_eq!(azure_org("https://contoso.pkgs.visualstudio.com/_packaging/x/npm/registry/").as_deref(), Some("contoso"));
        assert_eq!(azure_org("https://pkgs.dev.azure.com/achs/_packaging/feed/npm/registry/").as_deref(), Some("achs"));
        assert!(!is_azure_artifacts(PUBLIC_REGISTRY));
    }

    fn packument(versions: &[&str], latest: &str) -> Value {
        let versions: serde_json::Map<String, Value> = versions.iter().map(|v| (v.to_string(), json!({}))).collect();
        json!({ "versions": versions, "dist-tags": { "latest": latest } })
    }

    #[tokio::test]
    async fn raises_within_the_line_and_flags_own_majors() {
        let pkg = r#"{ "dependencies": { "lodash": "^4.17.20", "zod": "~0.4.1", "@achs/env": "^2.1.0", "local": "file:../x" },
                       "devDependencies": { "typescript": "5.4.0" } }"#;
        let feed = "https://pkgs.dev.azure.com/achs/_packaging/feed/npm/registry/";
        let source = Files::with(&[("app/package.json", pkg), (".npmrc", &format!("@achs:registry={feed}"))]);
        let mut net = FakeNet::default()
            .answer("https://registry.npmjs.org/lodash", Ok(packument(&["4.17.20", "4.17.21", "5.0.0-beta.1"], "4.17.21")))
            .answer("https://registry.npmjs.org/zod", Ok(packument(&["0.4.1", "0.4.9", "0.5.0", "3.0.0"], "3.0.0")))
            .answer("https://registry.npmjs.org/typescript", Ok(packument(&["5.4.0"], "5.4.0")))
            .answer(&format!("{feed}@achs%2Fenv"), Ok(packument(&["2.1.0", "2.3.0", "3.0.0"], "3.0.0")));
        net.pats.insert("achs".into(), "pat".into());
        let files = [PrFile { path: "app/package.json".into(), ..Default::default() }];
        let matched = vec!["app/package.json".to_string()];
        let cx = RuleCx { matched: &matched, files: &files, source: &source, net: &net, today: chrono::NaiveDate::MIN, now: 0 };
        let Ok(Facts::Found(facts)) = collect(&cx).await else { panic!("expected facts") };
        let file = &facts["files"][0];
        assert_eq!(file["checked"], 4);
        assert_eq!(file["minor_updates"], json!(["@achs/env ^2.1.0 → 2.3.0", "lodash ^4.17.20 → 4.17.21", "zod ~0.4.1 → 0.4.9"]));
        assert_eq!(file["own_behind"], json!(["@achs/env ^2.1.0 → 3.0.0 (mayor)"]));
        // The feed got the PAT; the public registry got nothing.
        let asked = net.asked.lock().unwrap().clone();
        assert!(asked.iter().all(|(url, authed)| *authed == url.starts_with(feed)));
    }

    #[tokio::test]
    async fn a_feed_without_access_is_not_evaluated() {
        let feed = "https://pkgs.dev.azure.com/achs/_packaging/feed/npm/registry/";
        let source = Files::with(&[("package.json", r#"{ "dependencies": { "@achs/a": "^1.0.0" } }"#), (".npmrc", &format!("@achs:registry={feed}"))]);
        let files = [PrFile { path: "package.json".into(), ..Default::default() }];
        let matched = vec!["package.json".to_string()];

        let no_pat = FakeNet::default();
        let cx = RuleCx { matched: &matched, files: &files, source: &source, net: &no_pat, today: chrono::NaiveDate::MIN, now: 0 };
        let Ok(Facts::Found(facts)) = collect(&cx).await else { panic!("expected facts") };
        assert_eq!(facts["files"][0]["not_evaluated"], "pkgs.dev.azure.com: sin PAT de Azure DevOps guardado para la organización achs");

        let mut rejected = FakeNet::default().answer(&format!("{feed}@achs%2Fa"), Err(HttpError::Status(401)));
        rejected.pats.insert("achs".into(), "expired".into());
        let cx = RuleCx { net: &rejected, ..cx };
        let Ok(Facts::Found(facts)) = collect(&cx).await else { panic!("expected facts") };
        assert_eq!(facts["files"][0]["not_evaluated"], "pkgs.dev.azure.com: sin autorización");
    }
}
