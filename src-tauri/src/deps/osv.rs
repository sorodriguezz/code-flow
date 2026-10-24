//! Vulnerabilities from OSV.dev — one free API for npm, crates.io, NuGet, PyPI, Go and Maven,
//! asked with the exact package and version a lockfile pins.
//!
//! Chosen over running `npm audit` / `cargo audit` / `dotnet list package --vulnerable` (user,
//! 2026-10-23): those are three binaries with three output formats, two of which need a network
//! round-trip of their own anyway, and the app does not run tools it finds on disk.
//!
//! `querybatch` answers ids only; each advisory's details are a second request, cached on disk by id
//! for a day, so the daily alert check costs one batch plus whatever is genuinely new.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};

use super::version::{self, Version};
use super::{now_ms, Ecosystem};

const QUERY_BATCH: &str = "https://api.osv.dev/v1/querybatch";
/// OSV accepts up to 1000 queries per batch; smaller batches keep one slow answer from holding up
/// the whole report.
const CHUNK: usize = 400;
const DETAIL_TTL_MS: i64 = 24 * 3_600_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Unknown,
    Low,
    Medium,
    High,
    Critical,
}

impl Severity {
    pub fn from_score(score: f64) -> Self {
        if score >= 9.0 {
            Severity::Critical
        } else if score >= 7.0 {
            Severity::High
        } else if score >= 4.0 {
            Severity::Medium
        } else if score > 0.0 {
            Severity::Low
        } else {
            Severity::Unknown
        }
    }

    fn from_label(label: &str) -> Self {
        match label.to_ascii_uppercase().as_str() {
            "CRITICAL" => Severity::Critical,
            "HIGH" => Severity::High,
            "MODERATE" | "MEDIUM" => Severity::Medium,
            "LOW" => Severity::Low,
            _ => Severity::Unknown,
        }
    }
}

/// One advisory as it applies to one package version.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Advisory {
    pub id: String,
    pub aliases: Vec<String>,
    pub summary: String,
    pub severity: Severity,
    /// CVSS v3 base score, when the advisory carries a v3 vector.
    pub score: Option<f64>,
    pub url: String,
    /// The smallest fixed version above the one in use.
    pub fixed: Option<String>,
    pub published: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Query {
    pub ecosystem: Ecosystem,
    pub name: String,
    pub version: String,
}

/// OSV's spelling of a version: Go versions are SemVer without the `v`.
fn osv_version(eco: Ecosystem, v: &str) -> String {
    if eco == Ecosystem::Go { v.trim_start_matches('v').to_string() } else { v.to_string() }
}

pub fn batch_body(queries: &[Query]) -> Json {
    json!({
        "queries": queries
            .iter()
            .map(|q| json!({"package": {"name": q.name, "ecosystem": q.ecosystem.osv()}, "version": osv_version(q.ecosystem, &q.version)}))
            .collect::<Vec<_>>()
    })
}

/// The ids OSV answered per query, in the queries' order.
pub fn parse_batch(json: &Json) -> Vec<Vec<String>> {
    json.get("results")
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
        .map(|r| {
            r.get("vulns")
                .and_then(Json::as_array)
                .into_iter()
                .flatten()
                .filter_map(|v| v.get("id").and_then(Json::as_str).map(str::to_string))
                .collect()
        })
        .collect()
}

/// CVSS v3.x base score from its vector (FIRST's specification, §7.1 and Appendix A for rounding).
pub fn cvss3_score(vector: &str) -> Option<f64> {
    if !vector.starts_with("CVSS:3") {
        return None;
    }
    let metrics: HashMap<&str, &str> = vector.split('/').skip(1).filter_map(|m| m.split_once(':')).collect();
    let changed = *metrics.get("S")? == "C";
    let av = match *metrics.get("AV")? { "N" => 0.85, "A" => 0.62, "L" => 0.55, "P" => 0.2, _ => return None };
    let ac = match *metrics.get("AC")? { "L" => 0.77, "H" => 0.44, _ => return None };
    let pr = match (*metrics.get("PR")?, changed) {
        ("N", _) => 0.85,
        ("L", false) => 0.62,
        ("L", true) => 0.68,
        ("H", false) => 0.27,
        ("H", true) => 0.5,
        _ => return None,
    };
    let ui = match *metrics.get("UI")? { "N" => 0.85, "R" => 0.62, _ => return None };
    let cia = |k: &str| -> Option<f64> {
        Some(match *metrics.get(k)? { "H" => 0.56, "L" => 0.22, "N" => 0.0, _ => return None })
    };
    let iss = 1.0 - (1.0 - cia("C")?) * (1.0 - cia("I")?) * (1.0 - cia("A")?);
    let impact = if changed { 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02).powi(15) } else { 6.42 * iss };
    let exploitability = 8.22 * av * ac * pr * ui;
    if impact <= 0.0 {
        return Some(0.0);
    }
    let raw = if changed { (1.08 * (impact + exploitability)).min(10.0) } else { (impact + exploitability).min(10.0) };
    let int = (raw * 100_000.0).round() as i64;
    Some(if int % 10_000 == 0 { int as f64 / 100_000.0 } else { ((int / 10_000) + 1) as f64 / 10.0 })
}

/// Reads one advisory as it applies to `name` at `current`.
pub fn parse_advisory(json: &Json, eco: Ecosystem, name: &str, current: Option<&Version>) -> Option<Advisory> {
    let id = json.get("id")?.as_str()?.to_string();
    let aliases = json
        .get("aliases")
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
        .filter_map(Json::as_str)
        .map(str::to_string)
        .collect();
    let summary = json
        .get("summary")
        .and_then(Json::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| json.get("details").and_then(Json::as_str).and_then(|d| d.lines().next()))
        .unwrap_or("")
        .chars()
        .take(300)
        .collect();
    let score = json
        .get("severity")
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
        .filter_map(|s| s.get("score").and_then(Json::as_str))
        .filter_map(cvss3_score)
        .fold(None, |best: Option<f64>, s| Some(best.map_or(s, |b| b.max(s))));
    let label = json
        .get("database_specific")
        .and_then(|d| d.get("severity"))
        .and_then(Json::as_str)
        .map(Severity::from_label)
        .unwrap_or(Severity::Unknown);
    let severity = match score {
        Some(s) if s > 0.0 => Severity::from_score(s),
        _ => label,
    };
    let wanted = eco.normalize(name);
    let mut fixed: Vec<Version> = Vec::new();
    for affected in json.get("affected").and_then(Json::as_array).into_iter().flatten() {
        let pkg = affected.get("package");
        let same_eco = pkg.and_then(|p| p.get("ecosystem")).and_then(Json::as_str).is_some_and(|e| e.starts_with(eco.osv()));
        let same_name = pkg.and_then(|p| p.get("name")).and_then(Json::as_str).is_some_and(|n| eco.normalize(n) == wanted);
        if !(same_eco && same_name) {
            continue;
        }
        for range in affected.get("ranges").and_then(Json::as_array).into_iter().flatten() {
            for event in range.get("events").and_then(Json::as_array).into_iter().flatten() {
                if let Some(v) = event.get("fixed").and_then(Json::as_str).and_then(version::parse) {
                    fixed.push(v);
                }
            }
        }
    }
    fixed.sort_by(version::compare);
    let fixed = match current {
        Some(cur) => fixed.into_iter().find(|f| version::compare(f, cur).is_gt()),
        None => fixed.into_iter().last(),
    }
    .map(|v| if eco == Ecosystem::Go && !v.raw.starts_with('v') { format!("v{}", v.raw) } else { v.raw });
    let url = json
        .get("references")
        .and_then(Json::as_array)
        .into_iter()
        .flatten()
        .find(|r| r.get("type").and_then(Json::as_str) == Some("ADVISORY"))
        .and_then(|r| r.get("url"))
        .and_then(Json::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("https://osv.dev/vulnerability/{id}"));
    let published = json.get("published").and_then(Json::as_str).and_then(super::parse_time);
    Some(Advisory { id, aliases, summary, severity, score, url, fixed, published })
}

fn detail_path(id: &str) -> PathBuf {
    let safe: String = id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    crate::paths::cache_dir().join("deps").join("osv").join(format!("{safe}.json"))
}

#[derive(Serialize, Deserialize)]
struct CachedDetail {
    fetched: i64,
    body: Json,
}

async fn detail(id: &str) -> Result<Json, String> {
    let path = detail_path(id);
    let cached: Option<CachedDetail> = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok());
    if let Some(c) = &cached {
        if now_ms() - c.fetched < DETAIL_TTL_MS {
            return Ok(c.body.clone());
        }
    }
    let safe = id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'));
    if !safe {
        return Err(format!("not an advisory id: {id}"));
    }
    let fetched = async {
        let response = super::registry::client().get(format!("https://api.osv.dev/v1/vulns/{id}")).send().await.map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("OSV answered {}", response.status()));
        }
        response.json::<Json>().await.map_err(|e| e.to_string())
    }
    .await;
    match fetched {
        Ok(body) => {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            if let Ok(bytes) = serde_json::to_vec(&CachedDetail { fetched: now_ms(), body: body.clone() }) {
                let _ = std::fs::write(&path, bytes);
            }
            Ok(body)
        }
        Err(e) => cached.map(|c| c.body).ok_or(e),
    }
}

/// Advisories per query. `Err` only when OSV could not be asked at all — the report then says the
/// vulnerability column is unknown rather than "none".
pub async fn check(queries: &[Query]) -> Result<HashMap<Query, Vec<Advisory>>, String> {
    use futures_util::stream::{self, StreamExt};

    let unique: Vec<Query> = {
        let mut seen = HashSet::new();
        queries.iter().filter(|q| seen.insert((*q).clone())).cloned().collect()
    };
    let mut ids_per_query: Vec<(Query, Vec<String>)> = Vec::new();
    for chunk in unique.chunks(CHUNK) {
        let response = super::registry::client().post(QUERY_BATCH).json(&batch_body(chunk)).send().await.map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("OSV answered {}", response.status()));
        }
        let body: Json = response.json().await.map_err(|e| e.to_string())?;
        for (q, ids) in chunk.iter().zip(parse_batch(&body)) {
            if !ids.is_empty() {
                ids_per_query.push((q.clone(), ids));
            }
        }
    }
    let all_ids: Vec<String> = ids_per_query.iter().flat_map(|(_, ids)| ids.iter().cloned()).collect::<HashSet<_>>().into_iter().collect();
    let details: HashMap<String, Json> = stream::iter(all_ids)
        .map(|id| async move { detail(&id).await.ok().map(|d| (id, d)) })
        .buffer_unordered(8)
        .filter_map(|x| async move { x })
        .collect()
        .await;
    let mut out = HashMap::new();
    for (q, ids) in ids_per_query {
        let current = version::parse(&q.version);
        let advisories: Vec<Advisory> = ids
            .iter()
            .filter_map(|id| match details.get(id) {
                Some(d) => parse_advisory(d, q.ecosystem, &q.name, current.as_ref()),
                // The batch said so even if the details could not be read: keep the id.
                None => Some(Advisory {
                    id: id.clone(),
                    aliases: vec![],
                    summary: String::new(),
                    severity: Severity::Unknown,
                    score: None,
                    url: format!("https://osv.dev/vulnerability/{id}"),
                    fixed: None,
                    published: None,
                }),
            })
            .collect();
        out.insert(q, advisories);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_the_batch_request() {
        let body = batch_body(&[
            Query { ecosystem: Ecosystem::Npm, name: "lodash".into(), version: "4.17.20".into() },
            Query { ecosystem: Ecosystem::Go, name: "golang.org/x/net".into(), version: "v0.17.0".into() },
        ]);
        assert_eq!(body["queries"][0]["package"]["ecosystem"], "npm");
        assert_eq!(body["queries"][1]["package"]["ecosystem"], "Go");
        assert_eq!(body["queries"][1]["version"], "0.17.0");
    }

    #[test]
    fn reads_the_batch_answer() {
        let answer = json!({"results": [{"vulns": [{"id": "GHSA-1", "modified": "x"}, {"id": "CVE-2"}]}, {}]});
        assert_eq!(parse_batch(&answer), vec![vec!["GHSA-1".to_string(), "CVE-2".to_string()], vec![]]);
    }

    #[test]
    fn scores_cvss3_vectors() {
        assert_eq!(cvss3_score("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"), Some(9.8));
        assert_eq!(cvss3_score("CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N"), Some(6.1));
        assert_eq!(cvss3_score("CVSS:3.0/AV:L/AC:H/PR:H/UI:R/S:U/C:N/I:N/A:N"), Some(0.0));
        assert_eq!(cvss3_score("AV:N/AC:L/Au:N/C:P/I:P/A:P"), None);
    }

    #[test]
    fn reads_an_advisory_for_the_version_in_use() {
        let doc = json!({
            "id": "GHSA-35jh-r3h4-6jhm",
            "aliases": ["CVE-2021-23337"],
            "summary": "Command Injection in lodash",
            "published": "2021-02-15T00:00:00Z",
            "severity": [{"type": "CVSS_V3", "score": "CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H"}],
            "database_specific": {"severity": "HIGH"},
            "affected": [
                {"package": {"ecosystem": "npm", "name": "lodash"}, "ranges": [{"type": "SEMVER", "events": [{"introduced": "0"}, {"fixed": "4.17.21"}]}]},
                {"package": {"ecosystem": "npm", "name": "lodash-es"}, "ranges": [{"type": "SEMVER", "events": [{"introduced": "0"}, {"fixed": "9.9.9"}]}]}
            ],
            "references": [{"type": "WEB", "url": "https://w"}, {"type": "ADVISORY", "url": "https://nvd.nist.gov/vuln/detail/CVE-2021-23337"}]
        });
        let current = version::parse("4.17.20");
        let a = parse_advisory(&doc, Ecosystem::Npm, "lodash", current.as_ref()).unwrap();
        assert_eq!(a.fixed.as_deref(), Some("4.17.21"));
        assert_eq!(a.score, Some(7.2));
        assert_eq!(a.severity, Severity::High);
        assert_eq!(a.url, "https://nvd.nist.gov/vuln/detail/CVE-2021-23337");
        assert_eq!(a.aliases, vec!["CVE-2021-23337"]);
    }

    #[test]
    fn falls_back_to_the_database_label_and_picks_the_fix_on_the_right_line() {
        let doc = json!({
            "id": "GHSA-x",
            "details": "First line.\nMore.",
            "severity": [{"type": "CVSS_V4", "score": "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N"}],
            "database_specific": {"severity": "MODERATE"},
            "affected": [{"package": {"ecosystem": "PyPI", "name": "Django"}, "ranges": [{"events": [{"introduced": "4.0"}, {"fixed": "4.2.8"}, {"introduced": "5.0"}, {"fixed": "5.0.1"}]}]}]
        });
        let a = parse_advisory(&doc, Ecosystem::Pypi, "django", version::parse("5.0").as_ref()).unwrap();
        assert_eq!(a.severity, Severity::Medium);
        assert_eq!(a.fixed.as_deref(), Some("5.0.1"));
        assert_eq!(a.summary, "First line.");
        assert_eq!(a.url, "https://osv.dev/vulnerability/GHSA-x");
    }
}
