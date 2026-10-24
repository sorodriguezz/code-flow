//! One repository's dependency report: scan → registries → OSV → rows, saved to disk so the
//! section and the workspace view open on the last report without asking anyone again.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

use serde::{Deserialize, Serialize};

use super::config::DepsConfig;
use super::license::{self, LicenseStatus};
use super::osv::{self, Advisory, Query};
use super::registry::{self, Lookup};
use super::version::{self, UpdateKind};
use super::{manifests, now_ms, Declared, Ecosystem, Lockfile, Scan};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepRow {
    pub ecosystem: Ecosystem,
    pub name: String,
    pub key: String,
    pub manifest: String,
    pub section: String,
    pub requirement: String,
    #[serde(default)]
    pub property: Option<String>,
    /// The version in use: the lockfile's when there is one, else the requirement's own.
    pub current: Option<String>,
    /// Whether `current` came from a lockfile (otherwise it is the requirement's lower bound).
    pub locked: bool,
    pub latest: Option<String>,
    pub compatible: Option<String>,
    pub too_recent: Option<String>,
    pub update: UpdateKind,
    pub compatible_update: UpdateKind,
    /// The requirement rewritten for `latest` / `compatible`; `None` when it is not one we rewrite.
    pub bump_latest: Option<String>,
    pub bump_compatible: Option<String>,
    pub license: Option<String>,
    pub license_status: LicenseStatus,
    pub advisories: Vec<Advisory>,
    pub url: Option<String>,
    pub error: Option<String>,
    /// The registry could not be reached and an expired answer was used.
    pub stale: bool,
}

/// A vulnerable package only a lockfile mentions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitiveVuln {
    pub ecosystem: Ecosystem,
    pub name: String,
    pub version: String,
    pub lockfile: String,
    pub advisories: Vec<Advisory>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoReport {
    pub project_id: String,
    pub analyzed_at: i64,
    pub manifests: Vec<String>,
    pub lockfiles: Vec<Lockfile>,
    pub rows: Vec<DepRow>,
    pub transitive: Vec<TransitiveVuln>,
    pub locked_count: usize,
    pub warnings: Vec<String>,
    /// OSV could not be asked: the vulnerability column is unknown, not empty.
    pub osv_error: Option<String>,
    pub min_release_age_days: u32,
}

/// Whether a declared version is a version in use and not just a floor — only those are asked of
/// OSV, or `>=1.0` would report every advisory 1.0 ever had.
fn pinned(d: &Declared) -> Option<String> {
    if let Some(r) = &d.resolved {
        return Some(r.clone());
    }
    let req = version::requirement(d.ecosystem, &d.requirement)?;
    let exact = req.simple
        && match d.ecosystem {
            Ecosystem::Cargo => req.op == "=",
            Ecosystem::Pypi => req.op == "==" || req.op == "===",
            _ => req.op.is_empty() || req.op == "=" || req.op == "[",
        };
    exact.then_some(req.version)
}

/// The queries one scan makes of OSV: every pinned declared version and every locked package.
pub fn queries(scan: &Scan) -> Vec<Query> {
    let mut out: Vec<Query> = scan
        .declared
        .iter()
        .filter_map(|d| pinned(d).map(|v| Query { ecosystem: d.ecosystem, name: d.name.clone(), version: v }))
        .collect();
    out.extend(scan.locked.iter().map(|l| Query { ecosystem: l.ecosystem, name: l.name.clone(), version: l.version.clone() }));
    out.sort_by(|a, b| (a.ecosystem, &a.name, &a.version).cmp(&(b.ecosystem, &b.name, &b.version)));
    out.dedup();
    out
}

/// Builds the rows from what each source said. Pure, so the whole judgement is testable offline.
pub fn build_rows(
    scan: &Scan,
    lookups: &HashMap<(Ecosystem, String), Lookup>,
    vulns: &HashMap<Query, Vec<Advisory>>,
    config: &DepsConfig,
    now: i64,
) -> (Vec<DepRow>, Vec<TransitiveVuln>) {
    let mut rows = Vec::new();
    for d in &scan.declared {
        let pinned_version = pinned(d);
        let current = pinned_version.clone().or_else(|| version::requirement(d.ecosystem, &d.requirement).map(|r| r.version));
        let lookup = lookups.get(&(d.ecosystem, d.ecosystem.normalize(&d.name)));
        let info = lookup.and_then(|l| l.info.as_ref());
        let parsed = current.as_deref().and_then(version::parse);
        let candidates = match (&parsed, info) {
            (Some(cur), Some(info)) => version::pick(cur, &info.versions, now, config.min_release_age_days),
            _ => Default::default(),
        };
        let kind = |target: &Option<String>| match (&parsed, target.as_deref().and_then(version::parse)) {
            (Some(cur), Some(t)) => version::classify(cur, &t),
            _ => UpdateKind::None,
        };
        let update = kind(&candidates.latest);
        let compatible_update = kind(&candidates.compatible);
        let bump_for = |target: &Option<String>| target.as_deref().and_then(|t| version::bump(d.ecosystem, &d.requirement, t));
        let advisories = pinned_version
            .as_ref()
            .and_then(|v| vulns.get(&Query { ecosystem: d.ecosystem, name: d.name.clone(), version: v.clone() }))
            .cloned()
            .unwrap_or_default();
        let (license_text, license_status) = match info {
            Some(i) if i.license_known => (i.license.clone(), license::judge(i.license.as_deref(), config)),
            Some(_) => (None, LicenseStatus::Unavailable),
            None => (None, LicenseStatus::Unavailable),
        };
        rows.push(DepRow {
            ecosystem: d.ecosystem,
            name: d.name.clone(),
            key: d.key.clone(),
            manifest: d.manifest.clone(),
            section: d.section.clone(),
            requirement: d.requirement.clone(),
            property: d.property.clone(),
            locked: d.resolved.is_some(),
            current,
            bump_latest: bump_for(&candidates.latest),
            bump_compatible: bump_for(&candidates.compatible),
            latest: candidates.latest,
            compatible: candidates.compatible,
            too_recent: candidates.too_recent,
            update,
            compatible_update,
            license: license_text,
            license_status,
            advisories,
            url: info.and_then(|i| i.url.clone()),
            error: lookup.and_then(|l| if l.info.is_none() { l.error.clone() } else { None }),
            stale: lookup.is_some_and(|l| l.stale),
        });
    }
    let direct: std::collections::HashSet<(Ecosystem, String, String)> = rows
        .iter()
        .filter_map(|r| r.current.as_ref().filter(|_| !r.advisories.is_empty() || r.locked).map(|v| (r.ecosystem, r.ecosystem.normalize(&r.name), v.clone())))
        .collect();
    let mut transitive = Vec::new();
    for l in &scan.locked {
        if direct.contains(&(l.ecosystem, l.ecosystem.normalize(&l.name), l.version.clone())) {
            continue;
        }
        if let Some(advisories) = vulns.get(&Query { ecosystem: l.ecosystem, name: l.name.clone(), version: l.version.clone() }) {
            if !advisories.is_empty() {
                transitive.push(TransitiveVuln {
                    ecosystem: l.ecosystem,
                    name: l.name.clone(),
                    version: l.version.clone(),
                    lockfile: l.lockfile.clone(),
                    advisories: advisories.clone(),
                });
            }
        }
    }
    rows.sort_by(|a, b| (a.ecosystem, a.name.to_ascii_lowercase(), &a.manifest).cmp(&(b.ecosystem, b.name.to_ascii_lowercase(), &b.manifest)));
    transitive.sort_by(|a, b| (a.ecosystem, &a.name, &a.version).cmp(&(b.ecosystem, &b.name, &b.version)));
    (rows, transitive)
}

pub async fn analyze(project_id: &str, repo: &Path, config: &DepsConfig, progress: impl Fn(&str, usize, usize) + Send + Sync) -> RepoReport {
    use futures_util::stream::{self, StreamExt};

    progress("scan", 0, 0);
    let root = repo.to_path_buf();
    let scan = tokio::task::spawn_blocking(move || manifests::scan(&root)).await.unwrap_or_default();

    let mut packages: Vec<(Ecosystem, String, String)> = scan.declared.iter().map(|d| (d.ecosystem, d.ecosystem.normalize(&d.name), d.name.clone())).collect();
    packages.sort();
    packages.dedup_by(|a, b| a.0 == b.0 && a.1 == b.1);
    let total = packages.len();
    let done = AtomicUsize::new(0);
    progress("registry", 0, total);
    let ttl = config.cache_ttl_hours;
    let lookups: HashMap<(Ecosystem, String), Lookup> = stream::iter(packages)
        .map(|(eco, norm, name)| {
            let done = &done;
            let progress = &progress;
            async move {
                let found = registry::lookup(eco, &name, ttl).await;
                let n = done.fetch_add(1, Ordering::Relaxed) + 1;
                progress("registry", n, total);
                ((eco, norm), found)
            }
        })
        .buffer_unordered(12)
        .collect()
        .await;

    let queries = queries(&scan);
    progress("osv", 0, queries.len());
    let (vulns, osv_error) = match osv::check(&queries).await {
        Ok(v) => (v, None),
        Err(e) => (HashMap::new(), Some(e)),
    };
    let (rows, transitive) = build_rows(&scan, &lookups, &vulns, config, now_ms());
    let report = RepoReport {
        project_id: project_id.to_string(),
        analyzed_at: now_ms(),
        manifests: scan.manifests.clone(),
        lockfiles: scan.lockfiles.clone(),
        locked_count: scan.locked.len(),
        rows,
        transitive,
        warnings: scan.warnings.clone(),
        osv_error,
        min_release_age_days: config.min_release_age_days,
    };
    progress("done", total, total);
    report
}

fn reports_dir() -> PathBuf {
    crate::paths::state_dir().join("deps").join("reports")
}

fn report_path(project_id: &str) -> PathBuf {
    let safe: String = project_id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    reports_dir().join(format!("{safe}.json"))
}

pub fn save(report: &RepoReport) -> Result<(), String> {
    let path = report_path(&report.project_id);
    std::fs::create_dir_all(reports_dir()).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec(report).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

pub fn load(project_id: &str) -> Option<RepoReport> {
    let raw = std::fs::read(report_path(project_id)).ok()?;
    serde_json::from_slice(&raw).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deps::osv::Severity;
    use crate::deps::registry::PackageInfo;
    use crate::deps::version::{Published, DAY_MS};
    use crate::deps::Locked;

    fn declared(eco: Ecosystem, name: &str, req: &str, resolved: Option<&str>) -> Declared {
        Declared {
            ecosystem: eco,
            name: name.into(),
            key: name.into(),
            manifest: "package.json".into(),
            section: "dependencies".into(),
            requirement: req.into(),
            resolved: resolved.map(str::to_string),
            property: None,
        }
    }

    fn advisory(id: &str) -> Advisory {
        Advisory { id: id.into(), aliases: vec![], summary: String::new(), severity: Severity::High, score: Some(7.5), url: String::new(), fixed: Some("4.17.21".into()), published: None }
    }

    #[test]
    fn asks_osv_only_about_versions_in_use() {
        let scan = Scan {
            declared: vec![
                declared(Ecosystem::Npm, "a", "^1.0.0", Some("1.2.0")),
                declared(Ecosystem::Pypi, "b", ">=2.0", None),
                declared(Ecosystem::Pypi, "c", "==3.1", None),
                declared(Ecosystem::Cargo, "d", "1.0", None),
            ],
            locked: vec![Locked { ecosystem: Ecosystem::Npm, name: "a".into(), version: "1.2.0".into(), lockfile: "package-lock.json".into() }],
            ..Default::default()
        };
        let q: Vec<_> = queries(&scan).into_iter().map(|q| (q.name, q.version)).collect();
        assert_eq!(q, vec![("a".to_string(), "1.2.0".to_string()), ("c".to_string(), "3.1".to_string())]);
    }

    #[test]
    fn builds_rows_with_updates_licences_and_transitive_vulnerabilities() {
        let now = 1000 * DAY_MS;
        let scan = Scan {
            declared: vec![declared(Ecosystem::Npm, "lodash", "^4.17.20", Some("4.17.20")), declared(Ecosystem::Npm, "gone", "^1.0.0", None)],
            locked: vec![
                Locked { ecosystem: Ecosystem::Npm, name: "lodash".into(), version: "4.17.20".into(), lockfile: "package-lock.json".into() },
                Locked { ecosystem: Ecosystem::Npm, name: "minimist".into(), version: "1.2.5".into(), lockfile: "package-lock.json".into() },
            ],
            ..Default::default()
        };
        let mut lookups = HashMap::new();
        lookups.insert(
            (Ecosystem::Npm, "lodash".to_string()),
            Lookup {
                info: Some(PackageInfo {
                    versions: vec![
                        Published { version: "4.17.21".into(), published: Some(now - 900 * DAY_MS), yanked: false },
                        Published { version: "5.0.0".into(), published: Some(now - DAY_MS), yanked: false },
                    ],
                    license: Some("MIT".into()),
                    license_known: true,
                    url: None,
                }),
                stale: false,
                error: None,
            },
        );
        lookups.insert((Ecosystem::Npm, "gone".to_string()), Lookup { info: None, stale: false, error: Some("not on the registry".into()) });
        let mut vulns = HashMap::new();
        vulns.insert(Query { ecosystem: Ecosystem::Npm, name: "lodash".into(), version: "4.17.20".into() }, vec![advisory("GHSA-lodash")]);
        vulns.insert(Query { ecosystem: Ecosystem::Npm, name: "minimist".into(), version: "1.2.5".into() }, vec![advisory("GHSA-minimist")]);
        let (rows, transitive) = build_rows(&scan, &lookups, &vulns, &DepsConfig::default(), now);
        let lodash = rows.iter().find(|r| r.name == "lodash").unwrap();
        assert_eq!(lodash.latest.as_deref(), Some("4.17.21"));
        assert_eq!(lodash.too_recent.as_deref(), Some("5.0.0"));
        assert_eq!(lodash.update, UpdateKind::Patch);
        assert_eq!(lodash.bump_latest.as_deref(), Some("^4.17.21"));
        assert_eq!(lodash.license_status, LicenseStatus::Ok);
        assert_eq!(lodash.advisories.len(), 1);
        let gone = rows.iter().find(|r| r.name == "gone").unwrap();
        assert_eq!(gone.error.as_deref(), Some("not on the registry"));
        assert_eq!(transitive.len(), 1);
        assert_eq!(transitive[0].name, "minimist");
    }

    /// Live, against the real registries and OSV — ignored by default (no network in the suite).
    /// `CODEFLOW_HOME=<scratch> CODEFLOW_TEST_DEPS_REPO=<repo> cargo test --lib deps::analysis::tests::analyses_a_real_repository -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn analyses_a_real_repository() {
        let Ok(repo) = std::env::var("CODEFLOW_TEST_DEPS_REPO") else { return };
        let report = analyze("live", Path::new(&repo), &DepsConfig::default(), |phase, done, total| eprintln!("{phase} {done}/{total}")).await;
        let outdated = report.rows.iter().filter(|r| r.update != UpdateKind::None).count();
        let failed: Vec<_> = report.rows.iter().filter(|r| r.error.is_some()).map(|r| format!("{} {:?}", r.name, r.error)).collect();
        eprintln!("manifests {:?}\nlockfiles {}\nrows {} outdated {} vulnerable {} transitive {} locked {} osv {:?}", report.manifests, report.lockfiles.len(), report.rows.len(), outdated, report.rows.iter().filter(|r| !r.advisories.is_empty()).count(), report.transitive.len(), report.locked_count, report.osv_error);
        eprintln!("lookup failures: {failed:?}");
        for r in report.rows.iter().filter(|r| r.update != UpdateKind::None).take(15) {
            eprintln!("  {} {} {:?} -> {:?} ({:?}) compat {:?} young {:?} lic {:?} {:?}", r.ecosystem.id(), r.name, r.current, r.latest, r.update, r.compatible, r.too_recent, r.license, r.license_status);
        }
        for t in report.transitive.iter().take(10) {
            eprintln!("  T {} {} {:?}", t.name, t.version, t.advisories.iter().map(|a| (&a.id, a.severity, &a.fixed)).collect::<Vec<_>>());
        }
        assert!(!report.rows.is_empty());
    }
}
