//! A developer's chores as nodes: the project's version («Versión del proyecto»), its code searched
//! («Buscar en el código»), its dependencies against OSV.dev («Vulnerabilidades de dependencias») and
//! this computer's processes and ports («Procesos y puertos»).

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use futures_util::StreamExt;
use regex::Regex;
use serde_json::{json, Value};

use super::{flag, number, strings, text, NodeCtx, NodeError};
use crate::flows::run::{Item, Ports};

pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    match ctx.node.type_id.as_str() {
        "files.version" => version(ctx).await,
        "app.search" => search(ctx).await,
        "app.audit" => audit(ctx).await,
        "app.process" => process(ctx).await,
        other => Err(NodeError::failed(format!("No executor for {other}"))),
    }
}

fn one(ctx: &NodeCtx, json: Value) -> Ports {
    vec![vec![if ctx.items().is_empty() { Item::new(json) } else { Item::paired(json, 0) }]]
}

async fn folder_of(ctx: &NodeCtx, params: &Value) -> Result<PathBuf, NodeError> {
    let project = text(params, "project");
    if !project.trim().is_empty() {
        return ctx.run.host.project_path(&project).map(PathBuf::from).map_err(NodeError::Failed);
    }
    let path = text(params, "repoPath");
    if path.trim().is_empty() {
        return Err(NodeError::failed("Choose the repository or its folder"));
    }
    let path = super::expand_path(&path);
    if !path.is_dir() {
        return Err(NodeError::failed(format!("{} is not a folder", path.display())));
    }
    Ok(path)
}

fn http() -> Result<reqwest::Client, NodeError> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("CodeFlow (https://github.com/sorodriguezz/code-flow)")
        .build()
        .map_err(|e| NodeError::failed(e.to_string()))
}

// ------------------------------------------------------------------------------------- version

/// A version in a manifest: the file, the version as written, and where it sits in the text.
#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub file: String,
    pub version: String,
    pub start: usize,
    pub end: usize,
}

/// The manifests this node reads, relative to the repository's root.
const MANIFESTS: &[&str] = &[
    "package.json",
    "Cargo.toml",
    "src-tauri/Cargo.toml",
    "tauri.conf.json",
    "src-tauri/tauri.conf.json",
    "pyproject.toml",
    "composer.json",
    "Chart.yaml",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "VERSION",
];

fn capture_span(re: &Regex, text: &str) -> Option<(usize, usize)> {
    re.captures(text).and_then(|c| c.get(1)).map(|m| (m.start(), m.end()))
}

/// The span of `version = "…"` inside a TOML section (`[package]`, `[project]`…), before the next one.
fn toml_version_in(text: &str, sections: &[&str]) -> Option<(usize, usize)> {
    let header = Regex::new(r"(?m)^\s*\[([^\]]+)\]\s*$").ok()?;
    let version = Regex::new(r#"(?m)^\s*version\s*=\s*"([^"]+)""#).ok()?;
    let headers: Vec<(usize, usize, String)> = header.captures_iter(text).map(|c| (c.get(0).map(|m| m.start()).unwrap_or(0), c.get(0).map(|m| m.end()).unwrap_or(0), c[1].trim().to_string())).collect();
    for (index, (_, end, name)) in headers.iter().enumerate() {
        if !sections.contains(&name.as_str()) {
            continue;
        }
        let stop = headers.get(index + 1).map(|h| h.0).unwrap_or(text.len());
        let body = &text[*end..stop];
        if let Some(c) = version.captures(body).and_then(|c| c.get(1)) {
            return Some((end + c.start(), end + c.end()));
        }
    }
    None
}

/// Where a manifest keeps its version — `None` when it does not have one.
pub fn locate(file: &str, text: &str) -> Option<(usize, usize)> {
    let name = Path::new(file).file_name()?.to_string_lossy().into_owned();
    match name.as_str() {
        "package.json" | "tauri.conf.json" | "composer.json" => {
            // The first `"version"` of a manifest is its own: dependencies are maps of names to ranges.
            let (start, end) = capture_span(&Regex::new(r#""version"\s*:\s*"([^"]+)""#).ok()?, text)?;
            // Tauri's `"version": "../package.json"` says where the version is, and is not one: written
            // over, the link would be cut and the app frozen at whatever one run put there.
            (name != "tauri.conf.json" || !text[start..end].trim().ends_with(".json")).then_some((start, end))
        }
        "Cargo.toml" => toml_version_in(text, &["package", "workspace.package"]),
        "pyproject.toml" => toml_version_in(text, &["project", "tool.poetry"]),
        "Chart.yaml" => capture_span(&Regex::new(r#"(?m)^version:\s*["']?([^"'\s]+)"#).ok()?, text),
        "build.gradle" | "build.gradle.kts" => capture_span(&Regex::new(r#"(?m)^\s*version\s*=\s*["']([^"']+)["']"#).ok()?, text),
        "pom.xml" => {
            // The project's own `<version>`: not its parent's, and not a dependency's.
            let stripped_parent = Regex::new(r"(?s)<parent>.*?</parent>").ok()?;
            let mut masked = text.to_string();
            for m in stripped_parent.find_iter(text) {
                masked.replace_range(m.start()..m.end(), &" ".repeat(m.end() - m.start()));
            }
            let deps = Regex::new(r"(?s)<(dependencies|dependencyManagement|build|plugins|profiles)>.*?</(dependencies|dependencyManagement|build|plugins|profiles)>").ok()?;
            let copy = masked.clone();
            for m in deps.find_iter(&copy) {
                masked.replace_range(m.start()..m.end(), &" ".repeat(m.end() - m.start()));
            }
            capture_span(&Regex::new(r"<version>\s*([^<\s]+)\s*</version>").ok()?, &masked)
        }
        "VERSION" => {
            let trimmed = text.trim();
            (!trimmed.is_empty() && !trimmed.contains('\n')).then(|| {
                let start = text.find(trimmed).unwrap_or(0);
                (start, start + trimmed.len())
            })
        }
        _ => None,
    }
}

fn lenient(version: &str) -> Result<semver::Version, String> {
    let v = version.trim().trim_start_matches(['v', 'V']);
    semver::Version::parse(v).or_else(|_| {
        // `1.2` and `1` are versions too, to a person.
        let parts: Vec<&str> = v.split('.').collect();
        let padded = match parts.len() {
            1 => format!("{v}.0.0"),
            2 => format!("{v}.0"),
            _ => v.to_string(),
        };
        semver::Version::parse(&padded).map_err(|e| format!("\"{version}\" is not a version: {e}"))
    })
}

/// The next version: major/minor/patch, their pre-release forms, or the next pre-release.
pub fn bump(current: &str, part: &str, preid: &str) -> Result<String, String> {
    let mut v = lenient(current)?;
    let preid = if preid.trim().is_empty() { "beta" } else { preid.trim() };
    let pre0 = semver::Prerelease::new(&format!("{preid}.0")).map_err(|e| e.to_string())?;
    match part {
        "major" => {
            // 2.0.0-beta.3 → 2.0.0: a pre-release of a major is promoted, not skipped past.
            if !(v.pre.is_empty() || (v.minor == 0 && v.patch == 0)) || v.pre.is_empty() {
                v.major += 1;
            }
            v.minor = 0;
            v.patch = 0;
            v.pre = semver::Prerelease::EMPTY;
        }
        "minor" => {
            if v.pre.is_empty() || v.patch != 0 {
                v.minor += 1;
            }
            v.patch = 0;
            v.pre = semver::Prerelease::EMPTY;
        }
        "patch" => {
            if v.pre.is_empty() {
                v.patch += 1;
            }
            v.pre = semver::Prerelease::EMPTY;
        }
        "premajor" => {
            v.major += 1;
            v.minor = 0;
            v.patch = 0;
            v.pre = pre0;
        }
        "preminor" => {
            v.minor += 1;
            v.patch = 0;
            v.pre = pre0;
        }
        "prepatch" => {
            v.patch += 1;
            v.pre = pre0;
        }
        "prerelease" => {
            if v.pre.is_empty() {
                v.patch += 1;
                v.pre = pre0;
            } else {
                // beta.3 → beta.4; a pre-release with no number gets one.
                let text_pre = v.pre.as_str().to_string();
                let mut parts: Vec<String> = text_pre.split('.').map(str::to_string).collect();
                match parts.last().and_then(|p| p.parse::<u64>().ok()) {
                    Some(n) => *parts.last_mut().expect("non-empty") = (n + 1).to_string(),
                    None => parts.push("0".into()),
                }
                v.pre = semver::Prerelease::new(&parts.join(".")).map_err(|e| e.to_string())?;
            }
        }
        other => return Err(format!("unknown part {other}")),
    }
    v.build = semver::BuildMetadata::EMPTY;
    Ok(v.to_string())
}

/// Every manifest in `root` (or the ones named) that holds a version.
fn find_versions(root: &Path, named: &[String]) -> Vec<Found> {
    let candidates: Vec<String> = if named.is_empty() { MANIFESTS.iter().map(|s| s.to_string()).collect() } else { named.to_vec() };
    candidates
        .iter()
        .filter_map(|rel| {
            let path = root.join(rel);
            let content = std::fs::read_to_string(&path).ok()?;
            let (start, end) = locate(rel, &content)?;
            Some(Found { file: rel.clone(), version: content[start..end].to_string(), start, end })
        })
        .collect()
}

/// Cargo.lock's entry for the crate a Cargo.toml names, moved to the new version with it.
fn bump_cargo_lock(root: &Path, cargo_toml: &str, from: &str, to: &str) -> Option<String> {
    let manifest = std::fs::read_to_string(root.join(cargo_toml)).ok()?;
    let name = Regex::new(r#"(?m)^\s*name\s*=\s*"([^"]+)""#).ok()?.captures(&manifest)?.get(1)?.as_str().to_string();
    let dir = Path::new(cargo_toml).parent().map(|p| root.join(p)).unwrap_or_else(|| root.to_path_buf());
    let lock_path = [dir.join("Cargo.lock"), root.join("Cargo.lock")].into_iter().find(|p| p.exists())?;
    let lock = std::fs::read_to_string(&lock_path).ok()?;
    let entry = format!("name = \"{name}\"\nversion = \"{from}\"");
    if !lock.contains(&entry) {
        return None;
    }
    std::fs::write(&lock_path, lock.replacen(&entry, &format!("name = \"{name}\"\nversion = \"{to}\""), 1)).ok()?;
    Some(lock_path.strip_prefix(root).unwrap_or(&lock_path).to_string_lossy().into_owned())
}

async fn version(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let params = ctx.resolve_once().await?;
    let op = text(&params, "versionOp");
    match op.as_str() {
        "versionCompare" => {
            let a = lenient(&text(&params, "versionA")).map_err(NodeError::Failed)?;
            let b_text = text(&params, "versionB");
            let mut out = json!({"a": a.to_string()});
            if !b_text.trim().is_empty() {
                let b = lenient(&b_text).map_err(NodeError::Failed)?;
                let order = a.cmp(&b);
                out["b"] = json!(b.to_string());
                out["comparison"] = json!(order as i8);
                out["newer"] = json!(order == std::cmp::Ordering::Greater);
                out["equal"] = json!(order == std::cmp::Ordering::Equal);
            }
            let range = text(&params, "versionRange");
            if !range.trim().is_empty() {
                let req = semver::VersionReq::parse(range.trim()).map_err(|e| NodeError::failed(format!("\"{range}\" is not a range: {e}")))?;
                out["satisfies"] = json!(req.matches(&a));
            }
            Ok(one(ctx, out))
        }
        "versionLatest" => {
            let name = text(&params, "packageName");
            let latest = registry_latest(&text(&params, "registry"), &name, flag(&params, "includePrereleases")).await.map_err(NodeError::Failed)?;
            Ok(one(ctx, latest))
        }
        _ => {
            let root = folder_of(ctx, &params).await?;
            let found = find_versions(&root, &strings(&params, "versionFiles"));
            if found.is_empty() {
                return Err(NodeError::failed(format!("No manifest with a version in {}", root.display())));
            }
            let current = found[0].version.clone();
            if op == "versionRead" {
                return Ok(one(ctx, json!({
                    "version": current,
                    "files": found.iter().map(|f| json!({"file": f.file, "version": f.version})).collect::<Vec<_>>(),
                    "consistent": found.iter().all(|f| f.version == current),
                })));
            }
            let next = if op == "versionSet" {
                let wanted = text(&params, "newVersion");
                lenient(&wanted).map_err(NodeError::Failed)?.to_string()
            } else {
                bump(&current, &text(&params, "bumpPart"), &text(&params, "preid")).map_err(NodeError::Failed)?
            };
            let mut changed = Vec::new();
            for f in &found {
                let path = root.join(&f.file);
                let content = std::fs::read_to_string(&path).map_err(|e| NodeError::failed(e.to_string()))?;
                // Re-located, not trusted from the first read: the file is written once per run.
                let Some((start, end)) = locate(&f.file, &content) else { continue };
                let mut updated = content.clone();
                updated.replace_range(start..end, &next);
                std::fs::write(&path, updated).map_err(|e| NodeError::failed(format!("{}: {e}", f.file)))?;
                changed.push(json!({"file": f.file, "from": f.version, "to": next}));
                if f.file.ends_with("Cargo.toml") {
                    if let Some(lock) = bump_cargo_lock(&root, &f.file, &f.version, &next) {
                        changed.push(json!({"file": lock, "from": f.version, "to": next}));
                    }
                }
            }
            Ok(one(ctx, json!({"version": current, "newVersion": next, "files": changed})))
        }
    }
}

/// The latest version a registry publishes — npm, crates.io, PyPI, Docker Hub, the Go proxy, NuGet
/// or Maven Central. Shared with «Nueva versión de un paquete».
pub async fn registry_latest(registry: &str, name: &str, prereleases: bool) -> Result<Value, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Write the package's name".into());
    }
    let http = http().map_err(|e| e.to_string())?;
    let get = |url: String| {
        let http = http.clone();
        async move {
            let response = http.get(&url).send().await.map_err(|e| e.to_string())?;
            if response.status() == reqwest::StatusCode::NOT_FOUND {
                return Err("The registry does not know that package".to_string());
            }
            if !response.status().is_success() {
                return Err(format!("The registry answered {}", response.status()));
            }
            response.json::<Value>().await.map_err(|e| e.to_string())
        }
    };
    let pick_max = |versions: Vec<String>| -> Option<String> {
        versions
            .into_iter()
            .filter_map(|v| lenient(&v).ok().map(|parsed| (parsed, v)))
            .filter(|(parsed, _)| prereleases || parsed.pre.is_empty())
            .max_by(|a, b| a.0.cmp(&b.0))
            .map(|(_, v)| v)
    };
    let (version, published, url) = match registry {
        "cratesIo" => {
            let doc = get(format!("https://crates.io/api/v1/crates/{name}")).await?;
            let key = if prereleases { "max_version" } else { "max_stable_version" };
            let v = doc.pointer(&format!("/crate/{key}")).and_then(Value::as_str).unwrap_or_default().to_string();
            (v, doc.pointer("/crate/updated_at").and_then(Value::as_str).unwrap_or_default().to_string(), format!("https://crates.io/crates/{name}"))
        }
        "pypi" => {
            let doc = get(format!("https://pypi.org/pypi/{name}/json")).await?;
            let mut v = doc.pointer("/info/version").and_then(Value::as_str).unwrap_or_default().to_string();
            if prereleases {
                if let Some(releases) = doc.get("releases").and_then(Value::as_object) {
                    if let Some(newest) = releases
                        .iter()
                        .filter_map(|(ver, files)| files.as_array()?.first()?.get("upload_time_iso_8601")?.as_str().map(|t| (t.to_string(), ver.clone())))
                        .max()
                    {
                        v = newest.1;
                    }
                }
            }
            let published = doc.pointer(&format!("/releases/{v}/0/upload_time_iso_8601")).and_then(Value::as_str).unwrap_or_default().to_string();
            (v, published, format!("https://pypi.org/project/{name}/"))
        }
        "dockerHub" => {
            let repo = if name.contains('/') { name.to_string() } else { format!("library/{name}") };
            let doc = get(format!("https://hub.docker.com/v2/repositories/{repo}/tags?page_size=100&ordering=last_updated")).await?;
            let tags: Vec<(String, String)> = doc
                .get("results")
                .and_then(Value::as_array)
                .map(|list| list.iter().filter_map(|t| Some((t.get("name")?.as_str()?.to_string(), t.get("last_updated").and_then(Value::as_str).unwrap_or_default().to_string()))).collect())
                .unwrap_or_default();
            let best = pick_max(tags.iter().map(|t| t.0.clone()).filter(|t| t.chars().next().is_some_and(|c| c.is_ascii_digit() || c == 'v')).collect());
            let v = best.unwrap_or_else(|| tags.first().map(|t| t.0.clone()).unwrap_or_default());
            let published = tags.iter().find(|t| t.0 == v).map(|t| t.1.clone()).unwrap_or_default();
            (v, published, format!("https://hub.docker.com/r/{repo}"))
        }
        "goProxy" => {
            // Upper-case letters in a module path are written `!` + lower-case by the proxy protocol.
            let escaped: String = name.chars().map(|c| if c.is_ascii_uppercase() { format!("!{}", c.to_ascii_lowercase()) } else { c.to_string() }).collect();
            let doc = get(format!("https://proxy.golang.org/{escaped}/@latest")).await?;
            (
                doc.get("Version").and_then(Value::as_str).unwrap_or_default().to_string(),
                doc.get("Time").and_then(Value::as_str).unwrap_or_default().to_string(),
                format!("https://pkg.go.dev/{name}"),
            )
        }
        "nuget" => {
            let doc = get(format!("https://api.nuget.org/v3-flatcontainer/{}/index.json", name.to_lowercase())).await?;
            let versions: Vec<String> = doc.get("versions").and_then(Value::as_array).map(|l| l.iter().filter_map(|v| v.as_str().map(str::to_string)).collect()).unwrap_or_default();
            (pick_max(versions).unwrap_or_default(), String::new(), format!("https://www.nuget.org/packages/{name}"))
        }
        "maven" => {
            let (group, artifact) = name.split_once(':').ok_or("Write it as group:artifact")?;
            let doc = get(format!("https://search.maven.org/solrsearch/select?q=g:%22{group}%22+AND+a:%22{artifact}%22&rows=1&wt=json")).await?;
            let v = doc.pointer("/response/docs/0/latestVersion").and_then(Value::as_str).unwrap_or_default().to_string();
            let ts = doc.pointer("/response/docs/0/timestamp").and_then(Value::as_i64).and_then(chrono::DateTime::from_timestamp_millis).map(|d| d.to_rfc3339()).unwrap_or_default();
            (v, ts, format!("https://central.sonatype.com/artifact/{group}/{artifact}"))
        }
        _ => {
            let encoded = name.replacen('/', "%2f", 1);
            let doc = get(format!("https://registry.npmjs.org/{encoded}")).await?;
            let mut v = doc.pointer("/dist-tags/latest").and_then(Value::as_str).unwrap_or_default().to_string();
            if prereleases {
                if let Some(all) = doc.get("versions").and_then(Value::as_object) {
                    if let Some(best) = pick_max(all.keys().cloned().collect()) {
                        v = best;
                    }
                }
            }
            let published = doc.pointer(&format!("/time/{v}")).and_then(Value::as_str).unwrap_or_default().to_string();
            (v, published, format!("https://www.npmjs.com/package/{name}"))
        }
    };
    if version.is_empty() {
        return Err("The registry listed no version".into());
    }
    Ok(json!({"registry": registry, "package": name, "version": version, "published": published, "url": url}))
}

// -------------------------------------------------------------------------------------- search

async fn search(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let params = ctx.resolve_once().await?;
    let project = text(&params, "project");
    if project.trim().is_empty() {
        return Err(NodeError::failed("Choose the repository to search"));
    }
    let root = ctx.run.host.project_path(&project).map_err(NodeError::Failed)?;
    let query = text(&params, "searchText");
    if query.trim().is_empty() {
        return Err(NodeError::failed("Write what to search for"));
    }
    let options = crate::search::SearchOptions {
        case_sensitive: flag(&params, "caseSensitive"),
        whole_word: flag(&params, "wholeWord"),
        regex: flag(&params, "regex"),
        include: text(&params, "includeGlobs"),
        exclude: text(&params, "excludeGlobs"),
    };
    let max = number(&params, "maxResults").unwrap_or(500.0).clamp(1.0, 20_000.0) as usize;
    let root_for = root.clone();
    let outcome = tokio::task::spawn_blocking(move || crate::search::search(&root_for, &query, &options, max))
        .await
        .map_err(|e| NodeError::failed(e.to_string()))?
        .map_err(NodeError::Failed)?;
    if outcome.truncated {
        ctx.log(crate::flows::engine::LogStream::Info, &format!("Stopped at {max} matches"));
    }
    let base = Path::new(&root);
    if text(&params, "searchOutput") == "perFile" {
        let mut files: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        for hit in &outcome.hits {
            files.entry(hit.path.clone()).or_default().push(json!({"line": hit.line_no, "text": hit.line}));
        }
        return Ok(vec![files
            .into_iter()
            .map(|(path, lines)| Item::new(json!({"path": path, "absolutePath": base.join(&path).to_string_lossy(), "matches": lines.len(), "lines": lines})))
            .collect()]);
    }
    Ok(vec![outcome
        .hits
        .iter()
        .map(|hit| Item::new(json!({"path": hit.path, "absolutePath": base.join(&hit.path).to_string_lossy(), "line": hit.line_no, "text": hit.line.trim()})))
        .collect()])
}

// --------------------------------------------------------------------------------------- audit

/// One dependency, as a lockfile pins it.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Pinned {
    pub ecosystem: &'static str,
    pub name: String,
    pub version: String,
    pub lockfile: String,
}

const LOCKFILES: &[&str] = &["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.lock", "src-tauri/Cargo.lock", "poetry.lock", "requirements.txt", "go.sum", "composer.lock", "Gemfile.lock"];

/// `/@scope/name@1.2.3(peer@2)` (pnpm) → `@scope/name`, `1.2.3`.
fn split_pnpm_key(key: &str) -> Option<(String, String)> {
    let key = key.trim().trim_start_matches('/');
    let key = key.split('(').next().unwrap_or(key);
    let at = key[1..].rfind('@').map(|i| i + 1)?;
    let (name, version) = key.split_at(at);
    let version = version.trim_start_matches('@');
    (!name.is_empty() && !version.is_empty()).then(|| (name.to_string(), version.to_string()))
}

pub fn parse_lockfile(file: &str, content: &str) -> Vec<Pinned> {
    let name = Path::new(file).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let pin = |ecosystem: &'static str, n: &str, v: &str| Pinned { ecosystem, name: n.to_string(), version: v.to_string(), lockfile: file.to_string() };
    let mut out = Vec::new();
    match name.as_str() {
        "package-lock.json" => {
            let doc: Value = serde_json::from_str(content).unwrap_or(Value::Null);
            if let Some(packages) = doc.get("packages").and_then(Value::as_object) {
                for (path, info) in packages {
                    let Some(n) = path.rsplit("node_modules/").next().filter(|n| !n.is_empty() && path.contains("node_modules/")) else { continue };
                    if let Some(v) = info.get("version").and_then(Value::as_str) {
                        out.push(pin("npm", n, v));
                    }
                }
            } else if let Some(deps) = doc.get("dependencies").and_then(Value::as_object) {
                fn walk(deps: &serde_json::Map<String, Value>, file: &str, out: &mut Vec<Pinned>) {
                    for (n, info) in deps {
                        if let Some(v) = info.get("version").and_then(Value::as_str) {
                            out.push(Pinned { ecosystem: "npm", name: n.clone(), version: v.to_string(), lockfile: file.to_string() });
                        }
                        if let Some(inner) = info.get("dependencies").and_then(Value::as_object) {
                            walk(inner, file, out);
                        }
                    }
                }
                walk(deps, file, &mut out);
            }
        }
        "pnpm-lock.yaml" => {
            if let Ok(docs) = yaml_rust2::YamlLoader::load_from_str(content) {
                if let Some(doc) = docs.first() {
                    for section in ["packages", "snapshots"] {
                        if let Some(map) = doc[section].as_hash() {
                            for key in map.keys() {
                                if let Some((n, v)) = key.as_str().and_then(split_pnpm_key) {
                                    out.push(pin("npm", &n, &v));
                                }
                            }
                        }
                    }
                }
            }
        }
        "yarn.lock" if content.lines().any(|line| line.trim_end() == "__metadata:") => {
            // Yarn 2+ writes YAML, each entry saying what it resolved to: `resolution: "name@npm:1.2.3"`
            // (an alias resolves to the real name). Read as Yarn 1's format it held no dependency at
            // all, and the audit said "no vulnerabilities". Only `npm:` resolutions come from the
            // registry: a workspace or a link is not a package to look up, and a patch repeats the
            // entry of the package it patches.
            for line in content.lines() {
                let Some(resolution) = line.trim().strip_prefix("resolution:") else { continue };
                let resolution = resolution.trim().trim_matches('"');
                if let Some((n, v)) = resolution.split_once("@npm:") {
                    // A registry other than npm's adds `::__archiveUrl=…` after the version.
                    let v = v.split("::").next().unwrap_or(v);
                    if !n.is_empty() && !v.is_empty() {
                        out.push(pin("npm", n, v));
                    }
                }
            }
        }
        "yarn.lock" => {
            let mut current: Option<String> = None;
            for line in content.lines() {
                if !line.starts_with(' ') && line.trim_end().ends_with(':') && !line.starts_with('#') {
                    let spec = line.trim_end_matches(':').split(',').next().unwrap_or("").trim().trim_matches('"').to_string();
                    let at = spec[1.min(spec.len())..].find('@').map(|i| i + 1);
                    current = at.map(|i| spec[..i].to_string());
                } else if let (Some(n), Some(rest)) = (&current, line.trim().strip_prefix("version ")) {
                    out.push(pin("npm", n, rest.trim().trim_matches('"')));
                    current = None;
                }
            }
        }
        "Cargo.lock" | "poetry.lock" => {
            let ecosystem = if name == "Cargo.lock" { "crates.io" } else { "PyPI" };
            for block in content.split("[[package]]").skip(1) {
                let field = |key: &str| block.lines().find_map(|l| l.trim().strip_prefix(&format!("{key} = ")).map(|v| v.trim_matches('"').to_string()));
                // A Cargo package with no `source` is a workspace member, not a dependency.
                if ecosystem == "crates.io" && field("source").is_none() {
                    continue;
                }
                if let (Some(n), Some(v)) = (field("name"), field("version")) {
                    out.push(pin(ecosystem, &n, &v));
                }
            }
        }
        "requirements.txt" => {
            for line in content.lines() {
                let line = line.split('#').next().unwrap_or("").trim();
                if let Some((n, v)) = line.split_once("==") {
                    let n = n.split('[').next().unwrap_or(n).trim();
                    out.push(pin("PyPI", n, v.split(';').next().unwrap_or(v).trim()));
                }
            }
        }
        "go.sum" => {
            let mut seen = HashSet::new();
            for line in content.lines() {
                let mut parts = line.split_whitespace();
                let (Some(module), Some(version)) = (parts.next(), parts.next()) else { continue };
                let version = version.trim_end_matches("/go.mod");
                if seen.insert((module.to_string(), version.to_string())) {
                    out.push(pin("Go", module, version));
                }
            }
        }
        "composer.lock" => {
            let doc: Value = serde_json::from_str(content).unwrap_or(Value::Null);
            for section in ["packages", "packages-dev"] {
                for p in doc.get(section).and_then(Value::as_array).into_iter().flatten() {
                    if let (Some(n), Some(v)) = (p.get("name").and_then(Value::as_str), p.get("version").and_then(Value::as_str)) {
                        out.push(pin("Packagist", n, v.trim_start_matches('v')));
                    }
                }
            }
        }
        "Gemfile.lock" => {
            let spec = Regex::new(r"^    ([A-Za-z0-9_.-]+) \(([^)]+)\)$").expect("a valid pattern");
            for line in content.lines() {
                if let Some(c) = spec.captures(line) {
                    out.push(pin("RubyGems", &c[1], &c[2]));
                }
            }
        }
        _ => {}
    }
    out.sort();
    out.dedup();
    out
}

fn severity_rank(severity: &str) -> u8 {
    match severity.to_uppercase().as_str() {
        "CRITICAL" => 4,
        "HIGH" => 3,
        "MODERATE" | "MEDIUM" => 2,
        "LOW" => 1,
        _ => 0,
    }
}

async fn audit(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let params = ctx.resolve_once().await?;
    let root = folder_of(ctx, &params).await?;
    let named = strings(&params, "lockfiles");
    let files: Vec<String> = if named.is_empty() { LOCKFILES.iter().map(|s| s.to_string()).collect() } else { named };
    let mut pinned: Vec<Pinned> = Vec::new();
    let mut read_files = Vec::new();
    for rel in &files {
        if let Ok(content) = std::fs::read_to_string(root.join(rel)) {
            read_files.push(rel.clone());
            pinned.extend(parse_lockfile(rel, &content));
        }
    }
    if read_files.is_empty() {
        return Err(NodeError::failed(format!("No lockfile in {} — name it in Lockfiles", root.display())));
    }
    pinned.sort();
    pinned.dedup();
    ctx.log(crate::flows::engine::LogStream::Info, &format!("{} dependencies in {}", pinned.len(), read_files.join(", ")));
    let client = http()?;
    // OSV takes 1,000 queries a batch and answers with ids; the details come one by one.
    let mut hits: Vec<(Pinned, String)> = Vec::new();
    for chunk in pinned.chunks(1000) {
        let queries: Vec<Value> = chunk.iter().map(|p| json!({"package": {"name": p.name, "ecosystem": p.ecosystem}, "version": p.version})).collect();
        let request = client.post("https://api.osv.dev/v1/querybatch").json(&json!({"queries": queries})).send();
        let response = tokio::select! {
            r = request => r.map_err(|e| NodeError::failed(format!("OSV: {e}")))?,
            _ = ctx.cancel.cancelled() => return Err(NodeError::Cancelled),
        };
        if !response.status().is_success() {
            return Err(NodeError::failed(format!("OSV answered {}", response.status())));
        }
        let doc: Value = response.json().await.map_err(|e| NodeError::failed(e.to_string()))?;
        for (index, result) in doc.get("results").and_then(Value::as_array).into_iter().flatten().enumerate() {
            for vuln in result.get("vulns").and_then(Value::as_array).into_iter().flatten() {
                if let (Some(p), Some(id)) = (chunk.get(index), vuln.get("id").and_then(Value::as_str)) {
                    hits.push((p.clone(), id.to_string()));
                }
            }
        }
    }
    let ids: Vec<String> = { let mut v: Vec<String> = hits.iter().map(|h| h.1.clone()).collect(); v.sort(); v.dedup(); v };
    let details: BTreeMap<String, Value> = futures_util::stream::iter(ids.into_iter().map(|id| {
        let client = client.clone();
        async move {
            let doc = client.get(format!("https://api.osv.dev/v1/vulns/{id}")).send().await.ok()?.json::<Value>().await.ok()?;
            Some((id, doc))
        }
    }))
    .buffer_unordered(8)
    .filter_map(|x| async move { x })
    .collect()
    .await;
    let threshold = match text(&params, "auditSeverity").as_str() {
        "sevCritical" => 4,
        "sevHigh" => 3,
        "sevModerate" => 2,
        _ => 0,
    };
    let mut items = Vec::new();
    for (p, id) in &hits {
        let doc = details.get(id).cloned().unwrap_or(Value::Null);
        let severity = doc
            .pointer("/database_specific/severity")
            .and_then(Value::as_str)
            .or_else(|| doc.pointer("/affected/0/ecosystem_specific/severity").and_then(Value::as_str))
            .unwrap_or("UNKNOWN")
            .to_uppercase();
        if severity_rank(&severity) < threshold {
            continue;
        }
        let fixed: Vec<String> = doc
            .get("affected")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|a| a.pointer("/package/name").and_then(Value::as_str).is_some_and(|n| n.eq_ignore_ascii_case(&p.name)))
            .flat_map(|a| a.get("ranges").and_then(Value::as_array).cloned().unwrap_or_default())
            .flat_map(|r| r.get("events").and_then(Value::as_array).cloned().unwrap_or_default())
            .filter_map(|e| e.get("fixed").and_then(Value::as_str).map(str::to_string))
            .collect();
        items.push(json!({
            "package": p.name,
            "version": p.version,
            "ecosystem": p.ecosystem,
            "lockfile": p.lockfile,
            "id": id,
            "aliases": doc.get("aliases").cloned().unwrap_or(json!([])),
            "summary": doc.get("summary").and_then(Value::as_str).unwrap_or_else(|| doc.get("details").and_then(Value::as_str).unwrap_or("")).chars().take(400).collect::<String>(),
            "severity": severity,
            "fixedIn": fixed,
            "url": format!("https://osv.dev/vulnerability/{id}"),
        }));
    }
    items.sort_by(|a, b| severity_rank(b["severity"].as_str().unwrap_or("")).cmp(&severity_rank(a["severity"].as_str().unwrap_or(""))));
    if text(&params, "auditOutput") == "summaryOnly" {
        let mut by_severity: BTreeMap<String, usize> = BTreeMap::new();
        for item in &items {
            *by_severity.entry(item["severity"].as_str().unwrap_or("UNKNOWN").to_string()).or_default() += 1;
        }
        let packages: HashSet<String> = items.iter().map(|i| format!("{}@{}", i["package"].as_str().unwrap_or(""), i["version"].as_str().unwrap_or(""))).collect();
        return Ok(one(ctx, json!({
            "dependencies": pinned.len(),
            "vulnerabilities": items.len(),
            "packagesAffected": packages.len(),
            "bySeverity": by_severity,
            "lockfiles": read_files,
            "ids": items.iter().map(|i| i["id"].clone()).collect::<Vec<_>>(),
        })));
    }
    Ok(vec![items.into_iter().map(Item::new).collect()])
}

// ------------------------------------------------------------------------------------- process

/// One process as the node reads it.
struct ProcessRow {
    pid: u32,
    name: String,
    cpu: f32,
    memory: u64,
    command: String,
    /// The program as it was started (`argv[0]`): `/usr/local/bin/node`, `C:\…\chrome.exe`.
    program: String,
    started: u64,
}

/// Whether a process is the one a kill by name means: its name, or its program's file name, is the
/// name written — whole, in any case, with or without `.exe`. The listing matches any part of the
/// command line, which is right for finding one; for killing, that took down every editor with a
/// file of that name open and every process handed the name as an argument.
pub fn is_named(name: &str, program: &str, wanted: &str) -> bool {
    let bare = |text: &str| {
        let lower = text.trim().to_lowercase();
        lower.strip_suffix(".exe").map(str::to_string).unwrap_or(lower)
    };
    let wanted = bare(wanted);
    let file = program.rsplit(['/', '\\']).next().unwrap_or(program);
    !wanted.is_empty() && (bare(name) == wanted || bare(file) == wanted)
}

async fn process(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let params = ctx.resolve_once().await?;
    let op = text(&params, "processOp");
    let max = number(&params, "maxResults").unwrap_or(20.0).clamp(1.0, 5000.0) as usize;
    let me = std::process::id();
    match op.as_str() {
        "listPorts" | "whoUsesPort" | "freePort" => {
            let mut listeners = tokio::task::spawn_blocking(crate::services::ports::all_listeners).await.map_err(|e| NodeError::failed(e.to_string()))?;
            listeners.sort_by_key(|l| (l.port, l.pid));
            listeners.dedup_by_key(|l| (l.port, l.pid));
            let port = number(&params, "port").unwrap_or(0.0) as u16;
            if op != "listPorts" {
                if port == 0 {
                    return Err(NodeError::failed("Write the port"));
                }
                listeners.retain(|l| l.port == port);
            }
            if op == "freePort" {
                let mut killed = Vec::new();
                for l in &listeners {
                    if l.pid == me || l.pid <= 1 {
                        return Err(NodeError::failed(format!("Port {port} is CodeFlow's own; it is not freed from a flow")));
                    }
                    let pid = l.pid;
                    tokio::task::spawn_blocking(move || crate::services::ports::terminate(pid)).await.map_err(|e| NodeError::failed(e.to_string()))?.map_err(NodeError::Failed)?;
                    killed.push(json!({"pid": l.pid, "process": l.process}));
                }
                return Ok(one(ctx, json!({"port": port, "freed": !killed.is_empty(), "killed": killed})));
            }
            if op == "whoUsesPort" && listeners.is_empty() {
                return Ok(one(ctx, json!({"port": port, "free": true})));
            }
            Ok(vec![listeners.into_iter().take(max).map(|l| Item::new(json!({"port": l.port, "address": l.address, "pid": l.pid, "process": l.process, "free": false}))).collect()])
        }
        "listProcesses" | "killProcess" => {
            let wanted = text(&params, "processName").trim().to_lowercase();
            let pid_wanted = number(&params, "pid").unwrap_or(0.0) as u32;
            let sort = text(&params, "sortProcesses");
            let rows: Vec<ProcessRow> = tokio::task::spawn_blocking(move || {
                use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
                let mut system = System::new();
                let kind = ProcessRefreshKind::nothing().with_cpu().with_memory().with_cmd(UpdateKind::OnlyIfNotSet);
                system.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
                std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
                system.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
                system
                    .processes()
                    .iter()
                    .map(|(pid, p)| {
                        let args: Vec<String> = p.cmd().iter().map(|a| a.to_string_lossy().into_owned()).collect();
                        ProcessRow {
                            pid: pid.as_u32(),
                            name: p.name().to_string_lossy().into_owned(),
                            cpu: p.cpu_usage(),
                            memory: p.memory(),
                            program: args.first().cloned().unwrap_or_default(),
                            command: args.join(" "),
                            started: p.start_time(),
                        }
                    })
                    .collect()
            })
            .await
            .map_err(|e| NodeError::failed(e.to_string()))?;
            let mut matched: Vec<ProcessRow> = rows
                .into_iter()
                .filter(|row| match op.as_str() {
                    "killProcess" if pid_wanted > 0 => row.pid == pid_wanted,
                    "killProcess" => is_named(&row.name, &row.program, &wanted),
                    _ => wanted.is_empty() || row.name.to_lowercase().contains(&wanted) || row.command.to_lowercase().contains(&wanted),
                })
                .collect();
            if op == "killProcess" {
                if pid_wanted == 0 && wanted.is_empty() {
                    return Err(NodeError::failed("Write the process's name or its PID"));
                }
                let mut killed = Vec::new();
                for row in &matched {
                    if row.pid == me || row.pid <= 1 {
                        continue;
                    }
                    let pid = row.pid;
                    if tokio::task::spawn_blocking(move || crate::services::ports::terminate(pid)).await.ok().and_then(|r| r.ok()).is_some() {
                        killed.push(json!({"pid": row.pid, "name": row.name}));
                    }
                }
                return Ok(one(ctx, json!({"killed": killed, "count": killed.len()})));
            }
            match sort.as_str() {
                "byMemory" => matched.sort_by(|a, b| b.memory.cmp(&a.memory)),
                "byName" => matched.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase())),
                _ => matched.sort_by(|a, b| b.cpu.total_cmp(&a.cpu)),
            }
            Ok(vec![matched
                .into_iter()
                .take(max)
                .map(|row| {
                    Item::new(json!({
                        "pid": row.pid,
                        "name": row.name,
                        "cpu": (row.cpu * 10.0).round() / 10.0,
                        "memoryBytes": row.memory,
                        "memory": crate::containers::engine::human_bytes(row.memory),
                        "command": row.command,
                        "startedAt": chrono::DateTime::from_timestamp(row.started as i64, 0).map(|d| d.to_rfc3339()),
                    }))
                })
                .collect()])
        }
        _ => {
            let info = tokio::task::spawn_blocking(|| {
                use sysinfo::{Disks, System};
                let mut system = System::new();
                system.refresh_cpu_usage();
                system.refresh_memory();
                std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
                system.refresh_cpu_usage();
                let disks: Vec<Value> = Disks::new_with_refreshed_list()
                    .iter()
                    .map(|d| {
                        json!({
                            "mount": d.mount_point().to_string_lossy(),
                            "totalBytes": d.total_space(),
                            "availableBytes": d.available_space(),
                            "available": crate::containers::engine::human_bytes(d.available_space()),
                            "usedPercent": if d.total_space() > 0 { ((d.total_space() - d.available_space()) as f64 / d.total_space() as f64 * 1000.0).round() / 10.0 } else { 0.0 },
                        })
                    })
                    .collect();
                let load = System::load_average();
                json!({
                    "hostname": System::host_name(),
                    "os": System::long_os_version(),
                    "cpus": system.cpus().len(),
                    "cpuPercent": (system.global_cpu_usage() * 10.0).round() / 10.0,
                    "memoryTotal": system.total_memory(),
                    "memoryUsed": system.used_memory(),
                    "memoryPercent": if system.total_memory() > 0 { (system.used_memory() as f64 / system.total_memory() as f64 * 1000.0).round() / 10.0 } else { 0.0 },
                    "uptimeSeconds": System::uptime(),
                    "load": [load.one, load.five, load.fifteen],
                    "disks": disks,
                })
            })
            .await
            .map_err(|e| NodeError::failed(e.to_string()))?;
            Ok(one(ctx, info))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_found_in_each_manifest() {
        let pkg = "{\n  \"name\": \"app\",\n  \"version\": \"1.4.2\",\n  \"dependencies\": { \"x\": \"^2.0.0\" }\n}\n";
        let (s, e) = locate("package.json", pkg).unwrap();
        assert_eq!(&pkg[s..e], "1.4.2");
        let cargo = "[workspace]\nmembers = []\n\n[package]\nname = \"codeflow\"\nversion = \"0.9.0\"\n\n[dependencies]\nserde = { version = \"1\" }\n";
        let (s, e) = locate("src-tauri/Cargo.toml", cargo).unwrap();
        assert_eq!(&cargo[s..e], "0.9.0");
        let pyproject = "[tool.black]\nline-length = 100\n[project]\nname = \"x\"\nversion = \"3.1.0\"\n";
        let (s, e) = locate("pyproject.toml", pyproject).unwrap();
        assert_eq!(&pyproject[s..e], "3.1.0");
        let pom = "<project><parent><version>9.9.9</version></parent><artifactId>a</artifactId><version>1.2.3</version><dependencies><dependency><version>5</version></dependency></dependencies></project>";
        let (s, e) = locate("pom.xml", pom).unwrap();
        assert_eq!(&pom[s..e], "1.2.3");
        assert_eq!(locate("Chart.yaml", "apiVersion: v2\nversion: 0.3.1\n").map(|(s, e)| "apiVersion: v2\nversion: 0.3.1\n"[s..e].to_string()), Some("0.3.1".into()));
        assert!(locate("package.json", "{\"name\":\"x\"}").is_none());
    }

    #[test]
    fn tauris_version_pointer_is_not_a_version() {
        let pointer = "{\n  \"productName\": \"App\",\n  \"version\": \"../package.json\",\n  \"identifier\": \"x\"\n}\n";
        assert_eq!(locate("src-tauri/tauri.conf.json", pointer), None);
        let own = "{\n  \"version\": \"2.0.6\"\n}\n";
        assert_eq!(locate("src-tauri/tauri.conf.json", own).map(|(s, e)| &own[s..e]), Some("2.0.6"));
        // A bump reads (and so writes) package.json alone; the pointer goes on pointing at it.
        let root = std::env::temp_dir().join(format!("cf-version-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("src-tauri")).unwrap();
        std::fs::write(root.join("package.json"), "{\"name\": \"app\", \"version\": \"1.4.2\"}").unwrap();
        std::fs::write(root.join("src-tauri/tauri.conf.json"), pointer).unwrap();
        let found = find_versions(&root, &[]);
        assert_eq!(found.iter().map(|f| f.file.as_str()).collect::<Vec<_>>(), ["package.json"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn kill_by_name_takes_the_name_never_the_command_line() {
        assert!(is_named("node", "/usr/local/bin/node", "node"));
        assert!(is_named("Node", "node", " NODE "), "any case, any spaces around it");
        assert!(is_named("chrome.exe", r"C:\Program Files\Google\Chrome\Application\chrome.exe", "chrome"), "with or without .exe");
        assert!(is_named("python3.1", "/opt/homebrew/bin/python3.12", "python3.12"), "a name cut short by the system: the program's file name");
        assert!(!is_named("vim", "vim", "node"), "an editor with node_notes.txt open is not node");
        assert!(!is_named("codeflow", "/Applications/CodeFlow.app/Contents/MacOS/codeflow", "code"), "a part of a name is not the name");
        assert!(!is_named("node", "node", ""), "an empty name names nothing");
    }

    #[test]
    fn bumps() {
        assert_eq!(bump("1.4.2", "patch", "").unwrap(), "1.4.3");
        assert_eq!(bump("1.4.2", "minor", "").unwrap(), "1.5.0");
        assert_eq!(bump("1.4.2", "major", "").unwrap(), "2.0.0");
        assert_eq!(bump("1.4.2", "prerelease", "rc").unwrap(), "1.4.3-rc.0");
        assert_eq!(bump("1.4.3-rc.0", "prerelease", "rc").unwrap(), "1.4.3-rc.1");
        assert_eq!(bump("1.4.3-rc.1", "patch", "").unwrap(), "1.4.3");
        assert_eq!(bump("2.0.0-beta.3", "major", "").unwrap(), "2.0.0");
        assert_eq!(bump("v1.2", "preminor", "beta").unwrap(), "1.3.0-beta.0");
        assert!(bump("no", "patch", "").is_err());
    }

    #[test]
    fn lockfiles_are_read() {
        let npm = r#"{"lockfileVersion":3,"packages":{"":{"name":"app"},"node_modules/lodash":{"version":"4.17.20"},"node_modules/a/node_modules/@scope/b":{"version":"1.0.0"}}}"#;
        let pins = parse_lockfile("package-lock.json", npm);
        assert!(pins.iter().any(|p| p.name == "lodash" && p.version == "4.17.20"));
        assert!(pins.iter().any(|p| p.name == "@scope/b"));
        let pnpm = "lockfileVersion: '9.0'\npackages:\n  '@scope/x@1.2.3':\n    resolution: {}\n  lodash@4.17.21(react@18.0.0):\n    resolution: {}\n";
        let pins = parse_lockfile("pnpm-lock.yaml", pnpm);
        assert!(pins.iter().any(|p| p.name == "@scope/x" && p.version == "1.2.3"), "{pins:?}");
        assert!(pins.iter().any(|p| p.name == "lodash" && p.version == "4.17.21"), "{pins:?}");
        let cargo = "[[package]]\nname = \"codeflow\"\nversion = \"0.1.0\"\n\n[[package]]\nname = \"serde\"\nversion = \"1.0.200\"\nsource = \"registry+https://github.com/rust-lang/crates.io-index\"\n";
        let pins = parse_lockfile("Cargo.lock", cargo);
        assert_eq!(pins.len(), 1, "workspace members are not dependencies");
        assert_eq!(pins[0].name, "serde");
        let yarn = "\"lodash@^4.17.0\", lodash@^4.17.15:\n  version \"4.17.21\"\n  resolved \"x\"\n\n\"@babel/core@^7.0.0\":\n  version \"7.24.0\"\n";
        let pins = parse_lockfile("yarn.lock", yarn);
        assert!(pins.iter().any(|p| p.name == "lodash" && p.version == "4.17.21"), "{pins:?}");
        assert!(pins.iter().any(|p| p.name == "@babel/core" && p.version == "7.24.0"), "{pins:?}");
        assert_eq!(parse_lockfile("requirements.txt", "django==4.2.1  # web\nrequests[socks]==2.31.0\nflask>=2\n").len(), 2);
        let berry = "# This file is generated by running \"yarn install\" inside your project.\n\n__metadata:\n  version: 8\n  cacheKey: 10c0\n\n\
\"@babel/code-frame@npm:^7.0.0, @babel/code-frame@npm:^7.10.4\":\n  version: 7.24.2\n  resolution: \"@babel/code-frame@npm:7.24.2\"\n  dependencies:\n    \"@babel/highlight\": \"npm:^7.24.2\"\n  languageName: node\n  linkType: hard\n\n\
\"lodash@npm:^4.17.20\":\n  version: 4.17.21\n  resolution: \"lodash@npm:4.17.21\"\n  languageName: node\n  linkType: hard\n\n\
\"my-app@workspace:.\":\n  version: 0.0.0-use.local\n  resolution: \"my-app@workspace:.\"\n  languageName: unknown\n  linkType: soft\n\n\
\"typescript@patch:typescript@npm%3A^5.4.0#optional!builtin<compat/typescript>\":\n  version: 5.4.5\n  resolution: \"typescript@patch:typescript@npm%3A5.4.5#optional!builtin<compat/typescript>::version=5.4.5&hash=5adc0c\"\n\n\
\"string-width-cjs@npm:string-width@^4.2.0\":\n  version: 4.2.3\n  resolution: \"string-width@npm:4.2.3\"\n";
        let pins: Vec<(String, String)> = parse_lockfile("yarn.lock", berry).into_iter().map(|p| (p.name, p.version)).collect();
        assert_eq!(
            pins,
            [("@babel/code-frame".to_string(), "7.24.2".to_string()), ("lodash".into(), "4.17.21".into()), ("string-width".into(), "4.2.3".into())],
            "Yarn 2+: registry packages only, an alias by its real name"
        );
        assert_eq!(split_pnpm_key("/@a/b@2.0.0(c@1)"), Some(("@a/b".into(), "2.0.0".into())));
    }
}
