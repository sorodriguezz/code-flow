//! What each public registry says about a package: every version with its publish date, and the
//! licence.
//!
//! Asked over HTTPS directly — never through `npm view`, `cargo search` or any other binary. Each
//! answer is cached on disk for the configured TTL (12 h by default) and an expired one is still
//! used when the registry cannot be reached, so a report taken on a train is the last one that
//! worked rather than a wall of errors.
//!
//! crates.io's crawler policy asks for an identifying User-Agent with a contact and at most about
//! one request per second; its lookups get their own two-slot gate below while the others share
//! eight.

use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;

use super::version::Published;
use super::{license, now_ms, parse_time, Ecosystem};

const TIMEOUT: Duration = Duration::from_secs(20);

pub fn user_agent() -> String {
    format!("CodeFlow/{} (dependency health; +https://getcodeflow.vercel.app)", env!("CARGO_PKG_VERSION"))
}

pub fn client() -> reqwest::Client {
    crate::http_clients::cached("deps-registry", || reqwest::Client::builder().timeout(TIMEOUT).user_agent(user_agent()))
        .unwrap_or_default()
}

/// What a registry knows about one package.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageInfo {
    pub versions: Vec<Published>,
    /// SPDX where the registry gives one; PyPI's free text normalized.
    pub license: Option<String>,
    /// Whether this registry reports licences at all — the Go proxy and Maven search do not.
    pub license_known: bool,
    /// The registry's page for the package, for the row's link.
    pub url: Option<String>,
}

// ---------------------------------------------------------------------------------------------
// Parsers (pure).

fn npm_license(v: &Json) -> Option<String> {
    match v.get("license") {
        Some(Json::String(s)) => Some(s.clone()),
        Some(obj @ Json::Object(_)) => obj.get("type").and_then(Json::as_str).map(str::to_string),
        _ => v.get("licenses").and_then(Json::as_array).and_then(|a| {
            let ids: Vec<&str> = a.iter().filter_map(|l| l.get("type").and_then(Json::as_str)).collect();
            (!ids.is_empty()).then(|| ids.join(" OR "))
        }),
    }
}

pub fn parse_npm(json: &Json) -> PackageInfo {
    let time = json.get("time").and_then(Json::as_object);
    let mut versions = Vec::new();
    if let Some(map) = json.get("versions").and_then(Json::as_object) {
        for (v, meta) in map {
            versions.push(Published {
                version: v.clone(),
                published: time.and_then(|t| t.get(v)).and_then(Json::as_str).and_then(parse_time),
                yanked: meta.get("deprecated").is_some_and(|d| !d.is_null() && d != &Json::Bool(false)),
            });
        }
    }
    let latest = json.get("dist-tags").and_then(|t| t.get("latest")).and_then(Json::as_str);
    let license = latest
        .and_then(|l| json.get("versions").and_then(|v| v.get(l)))
        .and_then(npm_license)
        .or_else(|| npm_license(json));
    let name = json.get("name").and_then(Json::as_str).unwrap_or("");
    PackageInfo { versions, license, license_known: true, url: Some(format!("https://www.npmjs.com/package/{name}")) }
}

pub fn parse_crates(json: &Json) -> PackageInfo {
    let list = json.get("versions").and_then(Json::as_array).cloned().unwrap_or_default();
    let versions = list
        .iter()
        .filter_map(|v| {
            Some(Published {
                version: v.get("num")?.as_str()?.to_string(),
                published: v.get("created_at").and_then(Json::as_str).and_then(parse_time),
                yanked: v.get("yanked").and_then(Json::as_bool).unwrap_or(false),
            })
        })
        .collect();
    // Newest first in the API's answer; the newest non-yanked one carries the current licence.
    let license = list
        .iter()
        .find(|v| !v.get("yanked").and_then(Json::as_bool).unwrap_or(false))
        .and_then(|v| v.get("license"))
        .and_then(Json::as_str)
        .map(str::to_string);
    let name = json.get("crate").and_then(|c| c.get("id")).and_then(Json::as_str).unwrap_or("");
    PackageInfo { versions, license, license_known: true, url: Some(format!("https://crates.io/crates/{name}")) }
}

/// NuGet's registration index. Pages are inlined for small packages; a big one lists page URLs,
/// which the caller fetches and passes through [`nuget_page_items`].
pub fn parse_nuget(index: &Json, extra_pages: &[Json], id: &str) -> PackageInfo {
    let mut leaves: Vec<&Json> = Vec::new();
    for page in index.get("items").and_then(Json::as_array).into_iter().flatten() {
        leaves.extend(page.get("items").and_then(Json::as_array).into_iter().flatten());
    }
    for page in extra_pages {
        leaves.extend(page.get("items").and_then(Json::as_array).into_iter().flatten());
    }
    let mut versions = Vec::new();
    let mut license = None;
    let mut newest: Option<super::version::Version> = None;
    for leaf in leaves {
        let Some(entry) = leaf.get("catalogEntry") else { continue };
        let Some(v) = entry.get("version").and_then(Json::as_str) else { continue };
        let published = entry.get("published").and_then(Json::as_str).and_then(parse_time);
        // Unlisted packages are stamped 1900-01-01 by nuget.org.
        let unlisted = entry.get("listed").and_then(Json::as_bool) == Some(false) || published.is_some_and(|p| p < 0);
        versions.push(Published { version: v.to_string(), published: published.filter(|p| *p > 0), yanked: unlisted });
        if let Some(parsed) = super::version::parse(v) {
            if !parsed.is_prerelease() && newest.as_ref().is_none_or(|n| super::version::compare(&parsed, n).is_gt()) {
                newest = Some(parsed);
                license = entry
                    .get("licenseExpression")
                    .and_then(Json::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
            }
        }
    }
    PackageInfo { versions, license, license_known: true, url: Some(format!("https://www.nuget.org/packages/{id}")) }
}

/// Page URLs a registration index references without inlining their items.
pub fn nuget_page_urls(index: &Json) -> Vec<String> {
    index
        .get("items")
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
        .filter(|p| p.get("items").is_none())
        .filter_map(|p| p.get("@id").and_then(Json::as_str).map(str::to_string))
        .collect()
}

pub fn parse_pypi(json: &Json) -> PackageInfo {
    let mut versions = Vec::new();
    if let Some(releases) = json.get("releases").and_then(Json::as_object) {
        for (v, files) in releases {
            let files = files.as_array().cloned().unwrap_or_default();
            // A release with no files cannot be installed.
            if files.is_empty() {
                continue;
            }
            let published = files
                .iter()
                .filter_map(|f| f.get("upload_time_iso_8601").or_else(|| f.get("upload_time")).and_then(Json::as_str).and_then(parse_time))
                .min();
            let yanked = files.iter().all(|f| f.get("yanked").and_then(Json::as_bool).unwrap_or(false));
            versions.push(Published { version: v.clone(), published, yanked });
        }
    }
    let info = json.get("info");
    let expression = info.and_then(|i| i.get("license_expression")).and_then(Json::as_str).filter(|s| !s.trim().is_empty());
    let classifier = info
        .and_then(|i| i.get("classifiers"))
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
        .filter_map(Json::as_str)
        .filter(|c| c.starts_with("License ::") && *c != "License :: OSI Approved")
        .map(license::normalize)
        .collect::<Vec<_>>();
    let free = info
        .and_then(|i| i.get("license"))
        .and_then(Json::as_str)
        .map(str::trim)
        // Some packages paste the whole licence text here; the first line is the name, if anything.
        .filter(|s| !s.is_empty() && s.len() < 100)
        .map(license::normalize);
    let license = expression.map(str::to_string).or_else(|| (!classifier.is_empty()).then(|| classifier.join(" OR "))).or(free);
    let name = info.and_then(|i| i.get("name")).and_then(Json::as_str).unwrap_or("");
    PackageInfo { versions, license, license_known: true, url: Some(format!("https://pypi.org/project/{name}/")) }
}

/// The proxy's `@v/list`: one version per line, no dates.
pub fn parse_go_list(text: &str) -> Vec<String> {
    text.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect()
}

/// `example.com/Foo` → `example.com/!foo`: the proxy's case encoding.
pub fn go_escape(module: &str) -> String {
    let mut out = String::with_capacity(module.len());
    for c in module.chars() {
        if c.is_ascii_uppercase() {
            out.push('!');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

pub fn parse_maven_search(json: &Json, coordinate: &str) -> PackageInfo {
    let versions = json
        .get("response")
        .and_then(|r| r.get("docs"))
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
        .filter_map(|d| {
            Some(Published { version: d.get("v")?.as_str()?.to_string(), published: d.get("timestamp").and_then(Json::as_i64), yanked: false })
        })
        .collect();
    let url = coordinate.split_once(':').map(|(g, a)| format!("https://central.sonatype.com/artifact/{g}/{a}"));
    PackageInfo { versions, license: None, license_known: false, url }
}

/// `maven-metadata.xml`'s `<version>` list — the fallback when search is down. No dates.
pub fn parse_maven_metadata(xml: &str) -> Vec<String> {
    let re = regex::Regex::new(r"<version>\s*([^<]+?)\s*</version>").unwrap();
    re.captures_iter(xml).map(|c| c[1].to_string()).collect()
}

// ---------------------------------------------------------------------------------------------
// Cache.

#[derive(Serialize, Deserialize)]
struct Cached {
    fetched: i64,
    info: PackageInfo,
}

fn cache_path(eco: Ecosystem, name: &str) -> PathBuf {
    let digest = Sha256::digest(eco.normalize(name).as_bytes());
    let hex: String = digest.iter().take(16).map(|b| format!("{b:02x}")).collect();
    crate::paths::cache_dir().join("deps").join("registry").join(eco.id()).join(format!("{hex}.json"))
}

fn read_cache(eco: Ecosystem, name: &str) -> Option<Cached> {
    let raw = std::fs::read(cache_path(eco, name)).ok()?;
    serde_json::from_slice(&raw).ok()
}

fn write_cache(eco: Ecosystem, name: &str, info: &PackageInfo) {
    let path = cache_path(eco, name);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(bytes) = serde_json::to_vec(&Cached { fetched: now_ms(), info: info.clone() }) {
        let _ = std::fs::write(path, bytes);
    }
}

/// The answer for one package, and whether it came from an expired cache because the registry
/// could not be reached.
pub struct Lookup {
    pub info: Option<PackageInfo>,
    pub stale: bool,
    pub error: Option<String>,
}

fn gate(eco: Ecosystem) -> &'static Semaphore {
    static CRATES: OnceLock<Semaphore> = OnceLock::new();
    static OTHERS: OnceLock<Semaphore> = OnceLock::new();
    match eco {
        Ecosystem::Cargo => CRATES.get_or_init(|| Semaphore::new(2)),
        _ => OTHERS.get_or_init(|| Semaphore::new(8)),
    }
}

/// Names reach a URL only after this: they come from files on disk the app did not write (the
/// argument `npm.rs` makes for `valid_package_name`).
fn safe_name(eco: Ecosystem, name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 300
        && !name.contains("..")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '@' | '/' | ':' | '~' | '+'))
        && (eco == Ecosystem::Npm || eco == Ecosystem::Go || !name.contains('/'))
        && (eco == Ecosystem::Maven || !name.contains(':'))
}

pub async fn lookup(eco: Ecosystem, name: &str, ttl_hours: u32) -> Lookup {
    let cached = read_cache(eco, name);
    if let Some(c) = &cached {
        if now_ms() - c.fetched < i64::from(ttl_hours) * 3_600_000 {
            return Lookup { info: Some(c.info.clone()), stale: false, error: None };
        }
    }
    if !safe_name(eco, name) {
        return Lookup { info: None, stale: false, error: Some(format!("Not a package name: {name}")) };
    }
    let _permit = gate(eco).acquire().await;
    match fetch(eco, name).await {
        Ok(info) => {
            write_cache(eco, name, &info);
            Lookup { info: Some(info), stale: false, error: None }
        }
        Err(error) => match cached {
            Some(c) => Lookup { info: Some(c.info), stale: true, error: Some(error) },
            None => Lookup { info: None, stale: false, error: Some(error) },
        },
    }
}

async fn get_json(url: &str) -> Result<Json, String> {
    let response = client().get(url).header("Accept", "application/json").send().await.map_err(|e| e.to_string())?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("not on the registry".into());
    }
    if !response.status().is_success() {
        return Err(format!("registry answered {}", response.status()));
    }
    response.json::<Json>().await.map_err(|e| e.to_string())
}

async fn get_text(url: &str) -> Result<String, String> {
    let response = client().get(url).send().await.map_err(|e| e.to_string())?;
    if response.status() == reqwest::StatusCode::NOT_FOUND || response.status() == reqwest::StatusCode::GONE {
        return Err("not on the registry".into());
    }
    if !response.status().is_success() {
        return Err(format!("registry answered {}", response.status()));
    }
    response.text().await.map_err(|e| e.to_string())
}

async fn fetch(eco: Ecosystem, name: &str) -> Result<PackageInfo, String> {
    match eco {
        Ecosystem::Npm => get_json(&format!("https://registry.npmjs.org/{}", name.replace('/', "%2F"))).await.map(|j| parse_npm(&j)),
        Ecosystem::Cargo => get_json(&format!("https://crates.io/api/v1/crates/{name}")).await.map(|j| parse_crates(&j)),
        Ecosystem::Nuget => {
            let id = name.to_ascii_lowercase();
            let index = get_json(&format!("https://api.nuget.org/v3/registration5-gz-semver2/{id}/index.json")).await?;
            let mut pages = Vec::new();
            // Big packages page their history; the newest pages are last and the only ones worth reading.
            for url in nuget_page_urls(&index).into_iter().rev().take(3) {
                if url.starts_with("https://api.nuget.org/") {
                    if let Ok(page) = get_json(&url).await {
                        pages.push(page);
                    }
                }
            }
            Ok(parse_nuget(&index, &pages, name))
        }
        Ecosystem::Pypi => get_json(&format!("https://pypi.org/pypi/{name}/json")).await.map(|j| parse_pypi(&j)),
        Ecosystem::Go => fetch_go(name).await,
        Ecosystem::Maven => fetch_maven(name).await,
    }
}

/// The proxy lists versions without dates; dates come one `.info` at a time, so only the newest
/// few are asked — newest first, until one is older than any sensible minimum age.
async fn fetch_go(module: &str) -> Result<PackageInfo, String> {
    let base = format!("https://proxy.golang.org/{}/@v", go_escape(module));
    let mut listed = parse_go_list(&get_text(&format!("{base}/list")).await?);
    listed.sort_by(|a, b| match (super::version::parse(a), super::version::parse(b)) {
        (Some(x), Some(y)) => super::version::compare(&y, &x),
        _ => b.cmp(a),
    });
    let mut versions = Vec::new();
    let mut dated = 0;
    for v in &listed {
        let mut published = None;
        if dated < 6 {
            if let Ok(info) = get_json(&format!("{base}/{v}.info")).await {
                published = info.get("Time").and_then(Json::as_str).and_then(parse_time);
                dated += 1;
                // Older than 90 days: everything below it is older still.
                if published.is_some_and(|p| now_ms() - p > 90 * super::version::DAY_MS) {
                    dated = 6;
                }
            }
        }
        versions.push(Published { version: v.clone(), published, yanked: false });
    }
    Ok(PackageInfo { versions, license: None, license_known: false, url: Some(format!("https://pkg.go.dev/{module}")) })
}

async fn fetch_maven(coordinate: &str) -> Result<PackageInfo, String> {
    let (group, artifact) = coordinate.split_once(':').ok_or("not a Maven coordinate")?;
    let q = format!("g:\"{group}\" AND a:\"{artifact}\"");
    let url = reqwest::Url::parse_with_params("https://search.maven.org/solrsearch/select", &[("q", q.as_str()), ("core", "gav"), ("rows", "200"), ("wt", "json")])
        .map_err(|e| e.to_string())?;
    match get_json(url.as_str()).await {
        Ok(json) => {
            let info = parse_maven_search(&json, coordinate);
            if !info.versions.is_empty() {
                return Ok(info);
            }
        }
        Err(_) => {}
    }
    let xml = get_text(&format!("https://repo1.maven.org/maven2/{}/{artifact}/maven-metadata.xml", group.replace('.', "/"))).await?;
    let versions = parse_maven_metadata(&xml).into_iter().map(|v| Published { version: v, published: None, yanked: false }).collect();
    Ok(PackageInfo { versions, license: None, license_known: false, url: Some(format!("https://central.sonatype.com/artifact/{group}/{artifact}")) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_the_npm_document() {
        let doc = json!({
            "name": "left-pad",
            "dist-tags": {"latest": "1.3.0"},
            "time": {"created": "2014-01-01T00:00:00.000Z", "1.2.0": "2016-01-01T00:00:00.000Z", "1.3.0": "2018-04-09T00:00:00.000Z"},
            "versions": {"1.2.0": {"license": "WTFPL"}, "1.3.0": {"license": "WTFPL", "deprecated": "use String.prototype.padStart()"}},
            "license": "MIT"
        });
        let info = parse_npm(&doc);
        assert_eq!(info.versions.len(), 2);
        let v13 = info.versions.iter().find(|v| v.version == "1.3.0").unwrap();
        assert!(v13.yanked);
        assert_eq!(v13.published, parse_time("2018-04-09T00:00:00.000Z"));
        assert_eq!(info.license.as_deref(), Some("WTFPL"));
    }

    #[test]
    fn reads_crates_io() {
        let doc = json!({"crate": {"id": "serde"}, "versions": [
            {"num": "1.0.200", "created_at": "2024-05-01T00:00:00Z", "yanked": true, "license": "MIT"},
            {"num": "1.0.199", "created_at": "2024-04-20T00:00:00.123456+00:00", "yanked": false, "license": "MIT OR Apache-2.0"}
        ]});
        let info = parse_crates(&doc);
        assert_eq!(info.license.as_deref(), Some("MIT OR Apache-2.0"));
        assert!(info.versions[0].yanked);
        assert!(info.versions[1].published.is_some());
    }

    #[test]
    fn reads_nuget_registration_with_inline_and_remote_pages() {
        let index = json!({"items": [
            {"@id": "https://api.nuget.org/p1", "lower": "1.0.0", "upper": "2.0.0"},
            {"@id": "https://api.nuget.org/p2", "items": [
                {"catalogEntry": {"version": "13.0.3", "published": "2023-03-08T00:00:00+00:00", "licenseExpression": "MIT", "listed": true}},
                {"catalogEntry": {"version": "13.0.4-beta1", "published": "2024-01-01T00:00:00+00:00", "licenseExpression": "GPL-3.0"}}
            ]}
        ]});
        assert_eq!(nuget_page_urls(&index), vec!["https://api.nuget.org/p1"]);
        let page = json!({"items": [{"catalogEntry": {"version": "1.0.0", "published": "1900-01-01T00:00:00+00:00"}}]});
        let info = parse_nuget(&index, &[page], "Newtonsoft.Json");
        assert_eq!(info.versions.len(), 3);
        assert_eq!(info.license.as_deref(), Some("MIT"), "the newest stable release's licence");
        assert!(info.versions.iter().find(|v| v.version == "1.0.0").unwrap().yanked);
    }

    #[test]
    fn reads_pypi_with_classifiers_and_yanked_releases() {
        let doc = json!({
            "info": {"name": "requests", "license": "", "classifiers": ["License :: OSI Approved :: Apache Software License"]},
            "releases": {
                "2.31.0": [{"upload_time_iso_8601": "2023-05-22T15:12:44.175Z", "yanked": false}],
                "2.32.0": [{"upload_time_iso_8601": "2024-05-20T00:00:00Z", "yanked": true}],
                "0.0.1": []
            }
        });
        let info = parse_pypi(&doc);
        assert_eq!(info.license.as_deref(), Some("Apache-2.0"));
        assert_eq!(info.versions.len(), 2);
        assert!(info.versions.iter().find(|v| v.version == "2.32.0").unwrap().yanked);
    }

    #[test]
    fn reads_go_and_maven_answers() {
        assert_eq!(go_escape("github.com/BurntSushi/toml"), "github.com/!burnt!sushi/toml");
        assert_eq!(parse_go_list("v1.0.0\nv1.1.0\n\n"), vec!["v1.0.0", "v1.1.0"]);
        let search = json!({"response": {"docs": [{"v": "33.0.0-jre", "timestamp": 1700000000000i64}]}});
        let info = parse_maven_search(&search, "com.google.guava:guava");
        assert_eq!(info.versions[0].published, Some(1_700_000_000_000));
        assert!(!info.license_known);
        let xml = "<metadata><versioning><versions><version>1.0</version><version>1.1</version></versions></versioning></metadata>";
        assert_eq!(parse_maven_metadata(xml), vec!["1.0", "1.1"]);
    }

    #[test]
    fn refuses_names_that_would_rewrite_a_url() {
        assert!(safe_name(Ecosystem::Npm, "@scope/pkg"));
        assert!(!safe_name(Ecosystem::Npm, "../../-/v1/search"));
        assert!(!safe_name(Ecosystem::Cargo, "a/b"));
        assert!(!safe_name(Ecosystem::Pypi, "x?y=1"));
        assert!(safe_name(Ecosystem::Maven, "org.slf4j:slf4j-api"));
    }
}
