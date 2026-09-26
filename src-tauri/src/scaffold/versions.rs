//! Which versions of a framework or a runtime can be picked, and what each one needs underneath.
//!
//! The initializer's version pickers are built from the registries themselves rather than from a list
//! shipped in the app, because that list would be wrong within weeks: the npm registry for the
//! JavaScript generators, PyPI for Django and friends, Packagist for Laravel, and
//! [endoflife.date](https://endoflife.date) for the runtimes (Node, Python, PHP, Go, Java, .NET).
//!
//! Every answer is folded into **lines** — one row per major (npm, Packagist, the runtimes) or per
//! `major.minor` (PyPI, where Django's `5.2` *is* the release people ask for) — each carrying its
//! newest release and, where the registry says it, what that release needs to run: `engines.node`
//! for an npm package, `requires-python` for PyPI, `require.php` for Packagist. That last field is
//! what lets the environment panel say "Angular 22 needs Node ^22.22.3" *before* the generator
//! refuses to start.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(20);
/// How many lines a picker offers. Older than this and a framework is past anybody's support window.
const MAX_LINES: usize = 6;
/// Registry answers are reused for this long. A picker reopened a minute later should not refetch a
/// megabyte of npm metadata, and a release published in the meantime can wait for the next hour.
const TTL: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum VersionSource {
    Npm { package: String },
    Pypi { package: String },
    Packagist { package: String },
    /// An endoflife.date product id: `nodejs`, `python`, `php`, `go`, `eclipse-temurin`, `dotnet`.
    Runtime { product: String },
}

impl VersionSource {
    fn cache_key(&self) -> String {
        match self {
            Self::Npm { package } => format!("npm:{package}"),
            Self::Pypi { package } => format!("pypi:{package}"),
            Self::Packagist { package } => format!("packagist:{package}"),
            Self::Runtime { product } => format!("runtime:{product}"),
        }
    }
}

/// One pickable line of releases.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VersionLine {
    /// The newest release in this line, exact: `22.2.0`, `5.2.7`, `v12.1.0` → `12.1.0`.
    pub version: String,
    /// The line itself — `22`, `5.2`, `3.13` — which is what a runtime installer is asked for.
    pub line: String,
    /// `latest`, `lts`, `next`, or empty. Set only when the source says so: npm dist-tags,
    /// endoflife.date's `lts`. Framework-specific conventions (Django's x.2 LTS) are the catalogue's.
    pub channel: String,
    /// What this release needs underneath, verbatim from the registry: an npm `engines.node` range,
    /// a PyPI `requires-python`, a Packagist `require.php`. `None` when the registry does not say.
    pub requires: Option<String>,
    /// Past its end of life — still offered for a project that has to match one, but marked.
    pub eol: bool,
}

static CACHE: Mutex<Option<HashMap<String, (Instant, Vec<VersionLine>)>>> = Mutex::new(None);

fn client() -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(TIMEOUT)
                .user_agent("CodeFlow")
                .build()
                .unwrap_or_default()
        })
        .clone()
}

/// A parsed `major.minor.patch[-pre]`, enough to order registry versions. Build metadata is dropped;
/// anything that is not dotted numbers (npm's `0.0.0-insiders.abc` passes, a PEP 440 `6.1a1` does
/// not) is left out of the ordering rather than guessed at. Ordered by [`newest_first`], not derived:
/// a release has to sort ahead of its own prereleases, which no derived ordering of `Option` gives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Semver {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pub pre: Option<String>,
}

pub fn parse_semver(raw: &str) -> Option<Semver> {
    let raw = raw.trim().trim_start_matches('v');
    let raw = raw.split('+').next()?;
    let (core, pre) = match raw.split_once('-') {
        Some((core, pre)) => (core, Some(pre.to_string())),
        None => (raw, None),
    };
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().unwrap_or("0").parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some(Semver { major, minor, patch, pre })
}

/// Descending, with a release ahead of its own prereleases.
fn newest_first(a: &Semver, b: &Semver) -> std::cmp::Ordering {
    (b.major, b.minor, b.patch)
        .cmp(&(a.major, a.minor, a.patch))
        .then_with(|| match (&a.pre, &b.pre) {
            (None, None) => std::cmp::Ordering::Equal,
            (None, Some(_)) => std::cmp::Ordering::Less,
            (Some(_), None) => std::cmp::Ordering::Greater,
            (Some(x), Some(y)) => y.cmp(x),
        })
}

/// The abbreviated npm document: dist-tags and, per version, what it needs.
#[derive(Deserialize)]
struct NpmDoc {
    #[serde(default, rename = "dist-tags")]
    dist_tags: HashMap<String, String>,
    #[serde(default)]
    versions: HashMap<String, NpmVersion>,
}

#[derive(Deserialize)]
struct NpmVersion {
    #[serde(default)]
    engines: Option<serde_json::Value>,
    #[serde(default)]
    deprecated: Option<serde_json::Value>,
}

/// npm's answer folded into majors. `latest` names the default; a `vN-lts` tag (Angular publishes
/// one per supported major) marks that major LTS; `next`, when it is ahead of `latest`, is offered
/// as its own line so a prerelease can be chosen on purpose and never by accident.
fn npm_lines(doc: NpmDoc) -> Vec<VersionLine> {
    let engines_of = |version: &str| -> Option<String> {
        let engines = doc.versions.get(version)?.engines.as_ref()?;
        engines.get("node")?.as_str().map(str::to_string)
    };
    let latest = doc.dist_tags.get("latest").and_then(|v| parse_semver(v));
    let lts_majors: Vec<u64> = doc
        .dist_tags
        .iter()
        .filter(|(tag, _)| tag.ends_with("-lts"))
        .filter_map(|(_, version)| parse_semver(version).map(|v| v.major))
        .collect();

    let mut stable: Vec<Semver> = doc
        .versions
        .iter()
        .filter(|(_, meta)| meta.deprecated.as_ref().map_or(true, |d| d.is_null() || d == &serde_json::Value::Bool(false)))
        .filter_map(|(raw, _)| parse_semver(raw))
        .filter(|v| v.pre.is_none())
        // Nothing past `latest`: a package can publish a higher major under another tag (a canary
        // line, a botched release it then re-tagged), and that is not what "newest" means here.
        .filter(|v| latest.as_ref().map_or(true, |latest| (v.major, v.minor, v.patch) <= (latest.major, latest.minor, latest.patch)))
        .collect();
    stable.sort_by(newest_first);

    let mut lines: Vec<VersionLine> = Vec::new();
    for version in stable {
        if lines.iter().any(|line| line.line == version.major.to_string()) {
            continue;
        }
        let exact = format!("{}.{}.{}", version.major, version.minor, version.patch);
        let channel = if latest.as_ref().is_some_and(|l| l.major == version.major) {
            "latest"
        } else if lts_majors.contains(&version.major) {
            "lts"
        } else {
            ""
        };
        lines.push(VersionLine {
            requires: engines_of(&exact),
            line: version.major.to_string(),
            channel: channel.into(),
            eol: false,
            version: exact,
        });
        if lines.len() == MAX_LINES {
            break;
        }
    }

    if let (Some(next_raw), Some(latest)) = (doc.dist_tags.get("next"), latest.as_ref()) {
        if let Some(next) = parse_semver(next_raw) {
            if newest_first(&next, latest) == std::cmp::Ordering::Less {
                lines.insert(
                    0,
                    VersionLine {
                        version: next_raw.trim_start_matches('v').to_string(),
                        line: next.major.to_string(),
                        channel: "next".into(),
                        requires: engines_of(next_raw),
                        eol: false,
                    },
                );
            }
        }
    }
    lines
}

async fn npm(package: &str) -> Result<Vec<VersionLine>, String> {
    if !crate::npm::valid_package_name(package) {
        return Err(format!("Not a package name: {package}"));
    }
    let url = format!("https://registry.npmjs.org/{}", package.replace('/', "%2F"));
    let response = client()
        .get(&url)
        .header("Accept", "application/vnd.npm.install-v1+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("npm answered {}", response.status()));
    }
    let doc: NpmDoc = response.json().await.map_err(|e| e.to_string())?;
    Ok(npm_lines(doc))
}

/// PyPI's simple JSON index — the light one: every version and every file, where each file says
/// which Pythons it supports. The per-release JSON would be one request per version.
#[derive(Deserialize)]
struct PypiIndex {
    #[serde(default)]
    versions: Vec<String>,
    #[serde(default)]
    files: Vec<PypiFile>,
}

#[derive(Deserialize)]
struct PypiFile {
    filename: String,
    #[serde(default, rename = "requires-python")]
    requires_python: Option<String>,
    #[serde(default)]
    yanked: serde_json::Value,
}

fn pypi_lines(index: PypiIndex) -> Vec<VersionLine> {
    // PEP 440 prereleases (`6.1a1`, `6.1rc1`) fail `parse_semver` on their own, which is exactly the
    // filter wanted; a two-part final release (`6.1`) parses as `6.1.0`.
    let mut releases: Vec<(Semver, String)> = index
        .versions
        .iter()
        .filter(|raw| raw.chars().all(|c| c.is_ascii_digit() || c == '.'))
        .filter_map(|raw| parse_semver(raw).map(|v| (v, raw.clone())))
        .collect();
    releases.sort_by(|a, b| newest_first(&a.0, &b.0));

    let requires_for = |raw: &str| -> Option<String> {
        let needle_wheel = format!("-{raw}-").to_ascii_lowercase();
        let needle_sdist = format!("-{raw}.").to_ascii_lowercase();
        index
            .files
            .iter()
            .filter(|file| file.yanked == serde_json::Value::Bool(false) || file.yanked.is_null())
            .find(|file| {
                let name = file.filename.to_ascii_lowercase();
                name.contains(&needle_wheel) || name.contains(&needle_sdist)
            })
            .and_then(|file| file.requires_python.clone())
            .filter(|spec| !spec.trim().is_empty())
    };

    let mut lines: Vec<VersionLine> = Vec::new();
    for (version, raw) in releases {
        let line = format!("{}.{}", version.major, version.minor);
        if lines.iter().any(|existing| existing.line == line) {
            continue;
        }
        lines.push(VersionLine {
            channel: if lines.is_empty() { "latest".into() } else { String::new() },
            requires: requires_for(&raw),
            eol: false,
            version: raw,
            line,
        });
        if lines.len() == MAX_LINES {
            break;
        }
    }
    lines
}

async fn pypi(package: &str) -> Result<Vec<VersionLine>, String> {
    if package.is_empty() || !package.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) {
        return Err(format!("Not a package name: {package}"));
    }
    let response = client()
        .get(format!("https://pypi.org/simple/{package}/"))
        .header("Accept", "application/vnd.pypi.simple.v1+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("PyPI answered {}", response.status()));
    }
    let index: PypiIndex = response.json().await.map_err(|e| e.to_string())?;
    Ok(pypi_lines(index))
}

/// Packagist's `p2` format is **minified**: each entry lists only what changed from the one before
/// it, and `"__unset"` removes a key. So `require` — where the PHP constraint lives — is absent on
/// most entries and has to be carried forward from the last one that had it.
fn packagist_lines(package: &str, body: &serde_json::Value) -> Vec<VersionLine> {
    let Some(entries) = body.get("packages").and_then(|p| p.get(package)).and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let mut current: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
    let mut releases: Vec<(Semver, String, Option<String>)> = Vec::new();
    for entry in entries {
        let Some(object) = entry.as_object() else { continue };
        for (key, value) in object {
            if value.as_str() == Some("__unset") {
                current.remove(key);
            } else {
                current.insert(key.clone(), value.clone());
            }
        }
        let Some(raw) = current.get("version").and_then(|v| v.as_str()) else { continue };
        let Some(version) = parse_semver(raw) else { continue };
        if version.pre.is_some() {
            continue;
        }
        let php = current
            .get("require")
            .and_then(|r| r.get("php"))
            .and_then(|p| p.as_str())
            .map(str::to_string);
        releases.push((version, raw.trim_start_matches('v').to_string(), php));
    }
    releases.sort_by(|a, b| newest_first(&a.0, &b.0));

    let mut lines: Vec<VersionLine> = Vec::new();
    for (version, raw, php) in releases {
        let line = version.major.to_string();
        if lines.iter().any(|existing| existing.line == line) {
            continue;
        }
        lines.push(VersionLine {
            channel: if lines.is_empty() { "latest".into() } else { String::new() },
            requires: php,
            eol: false,
            version: raw,
            line,
        });
        if lines.len() == MAX_LINES {
            break;
        }
    }
    lines
}

async fn packagist(package: &str) -> Result<Vec<VersionLine>, String> {
    let valid = package.split_once('/').is_some_and(|(vendor, name)| {
        let ok = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.'));
        ok(vendor) && ok(name)
    });
    if !valid {
        return Err(format!("Not a package name: {package}"));
    }
    let response = client()
        .get(format!("https://repo.packagist.org/p2/{package}.json"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Packagist answered {}", response.status()));
    }
    let body: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;
    Ok(packagist_lines(package, &body))
}

/// One cycle as endoflife.date publishes it. `eol` and `lts` are each either a boolean or a date.
#[derive(Deserialize)]
struct Cycle {
    cycle: serde_json::Value,
    #[serde(default)]
    latest: Option<String>,
    #[serde(default)]
    eol: serde_json::Value,
    #[serde(default)]
    lts: serde_json::Value,
}

/// A boolean-or-date field, as of `today` (`YYYY-MM-DD`, which compares correctly as a string).
fn flag_on(value: &serde_json::Value, today: &str) -> bool {
    match value {
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::String(date) => date.as_str() <= today,
        _ => false,
    }
}

fn runtime_lines(cycles: Vec<Cycle>, today: &str) -> Vec<VersionLine> {
    let mut lines: Vec<VersionLine> = cycles
        .into_iter()
        .filter_map(|cycle| {
            let line = match &cycle.cycle {
                serde_json::Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            // Temurin's `latest` carries a build suffix (`25.0.4.1+1`); the part before `+` is the
            // release a person would name.
            let version = cycle.latest.clone().unwrap_or_else(|| line.clone());
            let version = version.split('+').next().unwrap_or(&version).to_string();
            Some(VersionLine {
                channel: if flag_on(&cycle.lts, today) { "lts".into() } else { String::new() },
                eol: flag_on(&cycle.eol, today),
                requires: None,
                version,
                line,
            })
        })
        .collect();
    // Supported lines first, then at most two that have ended — a project pinned to an old runtime
    // still needs to be able to name it, but it should not be the first thing offered.
    let supported: Vec<VersionLine> = lines.iter().filter(|l| !l.eol).cloned().collect();
    let ended: Vec<VersionLine> = lines.drain(..).filter(|l| l.eol).take(2).collect();
    let mut out: Vec<VersionLine> = supported.into_iter().take(MAX_LINES).collect();
    out.extend(ended);
    out
}

async fn runtime(product: &str) -> Result<Vec<VersionLine>, String> {
    if product.is_empty() || !product.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        return Err(format!("Not a product id: {product}"));
    }
    let response = client()
        .get(format!("https://endoflife.date/api/{product}.json"))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("endoflife.date answered {}", response.status()));
    }
    let cycles: Vec<Cycle> = response.json().await.map_err(|e| e.to_string())?;
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    Ok(runtime_lines(cycles, &today))
}

/// The lines for `source`, from the cache when it is fresh.
pub async fn lines(source: VersionSource) -> Result<Vec<VersionLine>, String> {
    let key = source.cache_key();
    if let Ok(cache) = CACHE.lock() {
        if let Some((at, lines)) = cache.as_ref().and_then(|map| map.get(&key)) {
            if at.elapsed() < TTL {
                return Ok(lines.clone());
            }
        }
    }
    let fetched = match &source {
        VersionSource::Npm { package } => npm(package).await,
        VersionSource::Pypi { package } => pypi(package).await,
        VersionSource::Packagist { package } => packagist(package).await,
        VersionSource::Runtime { product } => runtime(product).await,
    }?;
    if let Ok(mut cache) = CACHE.lock() {
        cache.get_or_insert_with(HashMap::new).insert(key, (Instant::now(), fetched.clone()));
    }
    Ok(fetched)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn semver_orders_releases_ahead_of_their_prereleases() {
        let mut versions: Vec<Semver> = ["21.2.24", "22.2.0-rc.0", "22.2.0", "22.1.5", "v9.0.0"]
            .iter()
            .filter_map(|v| parse_semver(v))
            .collect();
        versions.sort_by(newest_first);
        let printed: Vec<String> = versions
            .iter()
            .map(|v| format!("{}.{}.{}{}", v.major, v.minor, v.patch, v.pre.as_deref().map(|p| format!("-{p}")).unwrap_or_default()))
            .collect();
        assert_eq!(printed, ["22.2.0", "22.2.0-rc.0", "22.1.5", "21.2.24", "9.0.0"]);
    }

    #[test]
    fn npm_folds_into_majors_with_latest_lts_and_next() {
        let doc: NpmDoc = serde_json::from_value(json!({
            "dist-tags": { "latest": "22.2.0", "next": "23.0.0-rc.1", "v21-lts": "21.2.24" },
            "versions": {
                "22.2.0": { "engines": { "node": "^22.22.3 || >=24.15.0" } },
                "22.1.0": {},
                "21.2.24": { "engines": { "node": "^20.19.0 || >=22.12.0" } },
                "21.0.0": {},
                "20.3.37": {},
                "23.0.0-rc.1": { "engines": { "node": ">=24.15.0" } },
                "22.3.0-next.1": {}
            }
        }))
        .unwrap();
        let lines = npm_lines(doc);
        let summary: Vec<(&str, &str, &str)> =
            lines.iter().map(|l| (l.line.as_str(), l.version.as_str(), l.channel.as_str())).collect();
        assert_eq!(
            summary,
            [("23", "23.0.0-rc.1", "next"), ("22", "22.2.0", "latest"), ("21", "21.2.24", "lts"), ("20", "20.3.37", "")]
        );
        assert_eq!(lines[1].requires.as_deref(), Some("^22.22.3 || >=24.15.0"));
        assert_eq!(lines[2].requires.as_deref(), Some("^20.19.0 || >=22.12.0"));
    }

    /// A version above `latest` under some other tag is not "the newest".
    #[test]
    fn npm_ignores_stable_versions_past_latest() {
        let doc: NpmDoc = serde_json::from_value(json!({
            "dist-tags": { "latest": "3.2.0" },
            "versions": { "3.2.0": {}, "4.0.0": {}, "2.9.9": {} }
        }))
        .unwrap();
        let lines = npm_lines(doc);
        assert_eq!(lines[0].version, "3.2.0");
        assert!(lines.iter().all(|l| l.line != "4"));
    }

    #[test]
    fn pypi_groups_by_minor_and_reads_requires_python() {
        let index: PypiIndex = serde_json::from_value(json!({
            "versions": ["4.2.20", "5.1.9", "5.2.6", "5.2.7", "6.1a1", "6.0", "6.0.1"],
            "files": [
                { "filename": "Django-5.2.7-py3-none-any.whl", "requires-python": ">=3.10", "yanked": false },
                { "filename": "django-6.0.1.tar.gz", "requires-python": ">=3.12", "yanked": false },
                { "filename": "Django-4.2.20-py3-none-any.whl", "requires-python": ">=3.8", "yanked": false }
            ]
        }))
        .unwrap();
        let lines = pypi_lines(index);
        let summary: Vec<(&str, &str)> = lines.iter().map(|l| (l.line.as_str(), l.version.as_str())).collect();
        assert_eq!(summary, [("6.0", "6.0.1"), ("5.2", "5.2.7"), ("5.1", "5.1.9"), ("4.2", "4.2.20")]);
        assert_eq!(lines[0].requires.as_deref(), Some(">=3.12"));
        assert_eq!(lines[1].requires.as_deref(), Some(">=3.10"));
        assert_eq!(lines[0].channel, "latest");
    }

    /// The minified format: `require` appears once and is inherited until it changes.
    #[test]
    fn packagist_expands_the_minified_format() {
        let body = json!({
            "minified": "composer/2.0",
            "packages": { "laravel/laravel": [
                { "version": "v13.1.0", "require": { "php": "^8.3" } },
                { "version": "v13.0.0" },
                { "version": "v12.4.0", "require": { "php": "^8.2" } },
                { "version": "v12.0.0-beta" },
                { "version": "v11.6.1", "require": "__unset" }
            ]}
        });
        let lines = packagist_lines("laravel/laravel", &body);
        let summary: Vec<(&str, &str, Option<&str>)> =
            lines.iter().map(|l| (l.line.as_str(), l.version.as_str(), l.requires.as_deref())).collect();
        assert_eq!(summary, [("13", "13.1.0", Some("^8.3")), ("12", "12.4.0", Some("^8.2")), ("11", "11.6.1", None)]);
    }

    #[test]
    fn runtimes_mark_lts_and_eol_against_today() {
        let cycles: Vec<Cycle> = serde_json::from_value(json!([
            { "cycle": "26", "latest": "26.10.0", "eol": "2029-04-30", "lts": "2026-10-28" },
            { "cycle": "25", "latest": "25.9.0", "eol": "2026-06-01", "lts": false },
            { "cycle": "24", "latest": "24.21.0", "eol": "2028-04-30", "lts": "2025-10-28" },
            { "cycle": "25", "latest": "25.0.4.1+1", "eol": "2031-09-30", "lts": true }
        ]))
        .unwrap();
        let lines = runtime_lines(cycles, "2026-09-26");
        let summary: Vec<(&str, &str, &str, bool)> =
            lines.iter().map(|l| (l.line.as_str(), l.version.as_str(), l.channel.as_str(), l.eol)).collect();
        assert_eq!(
            summary,
            [
                ("26", "26.10.0", "", false),
                ("24", "24.21.0", "lts", false),
                ("25", "25.0.4.1", "lts", false),
                ("25", "25.9.0", "", true),
            ]
        );
    }
}
