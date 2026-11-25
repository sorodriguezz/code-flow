//! «Seguridad» — an image's known vulnerabilities, from a scanner already installed on this computer.
//!
//! Like everything else in the manager, **found, not embedded**: Trivy or Grype when one is on the
//! PATH, run against the engine's own copy of the image. The image never leaves the computer — the
//! scanner downloads its vulnerability database the first time, and nothing else. Without either,
//! the page says how to install one instead.
//!
//! Each scan is kept (`container_scans`, the last [`KEPT_PER_IMAGE`] of each image), so the page
//! can show how an image's findings moved between two scans — a rebuild, a new base image — and
//! not only the last one. Kept on this machine only: they are about the images of this machine's
//! engines, and a scan is a command away anywhere else.
//!
//! The same scanners write an image's **SBOM** (its inventory of packages) as CycloneDX or SPDX:
//! Trivy, or Syft — Grype's sibling, which Grype itself cannot stand in for.

use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::cli;
use super::engine::{check_ref, is_local_endpoint, EngineKind, Target};

/// The first scan also fetches the scanner's database (a few hundred MB for Trivy).
const SCAN_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Scanner {
    /// `trivy` or `grype`.
    pub id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub id: String,
    /// `critical`, `high`, `medium`, `low`, `unknown`.
    pub severity: String,
    pub package: String,
    pub installed: String,
    /// The version that fixes it, `""` when there is none yet.
    pub fixed: String,
    pub title: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub scanner: String,
    pub findings: Vec<Finding>,
    /// The row it was kept as; empty until [`record`] keeps it.
    pub id: String,
    /// RFC 3339.
    pub scanned_at: String,
    /// The image's id at the time (`sha256:…`), so two scans of `app:latest` can tell a rebuild.
    pub image_id: String,
}

/// One kept scan, without its findings — a row of the history.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    pub id: String,
    pub image: String,
    pub image_id: String,
    pub scanner: String,
    pub scanned_at: String,
    pub critical: u32,
    pub high: u32,
    pub medium: u32,
    pub low: u32,
    pub unknown: u32,
}

/// What changed from one scan to a later one.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ScanComparison {
    /// In the later scan only: introduced since.
    pub added: Vec<Finding>,
    /// In the earlier scan only: fixed (or gone with the package) since.
    pub fixed: Vec<Finding>,
    /// In both.
    pub kept: u32,
}

/// How many scans of one image are kept: enough for a few months of rebuilds, little enough that
/// the table never matters.
pub const KEPT_PER_IMAGE: usize = 20;

/// The scanner to use: Trivy first, else Grype.
pub fn detect() -> Option<Scanner> {
    ["trivy", "grype"].iter().find_map(|id| cli::find(id).map(|path| Scanner { id: id.to_string(), path: path.to_string_lossy().into_owned() }))
}

fn text(value: &Value, names: &[&str]) -> String {
    names.iter().find_map(|n| value.get(*n)).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn severity_of(raw: &str) -> String {
    match raw.trim().to_lowercase().as_str() {
        s @ ("critical" | "high" | "medium" | "low") => s.to_string(),
        "negligible" => "low".into(),
        _ => "unknown".into(),
    }
}

/// One finding per vulnerability and package — a scanner may list a package twice (two layers).
fn dedupe(mut findings: Vec<Finding>) -> Vec<Finding> {
    let rank = |s: &str| match s {
        "critical" => 0,
        "high" => 1,
        "medium" => 2,
        "low" => 3,
        _ => 4,
    };
    findings.sort_by(|a, b| rank(&a.severity).cmp(&rank(&b.severity)).then(a.id.cmp(&b.id)).then(a.package.cmp(&b.package)));
    findings.dedup_by(|a, b| a.id == b.id && a.package == b.package && a.installed == b.installed);
    findings
}

/// `trivy image --format json`: `Results[].Vulnerabilities[]`.
pub fn parse_trivy(text_out: &str) -> Result<Vec<Finding>, String> {
    let doc: Value = serde_json::from_str(text_out.trim()).map_err(|e| format!("could not read Trivy's report: {e}"))?;
    let mut out = Vec::new();
    for result in doc.get("Results").and_then(Value::as_array).into_iter().flatten() {
        for v in result.get("Vulnerabilities").and_then(Value::as_array).into_iter().flatten() {
            out.push(Finding {
                id: text(v, &["VulnerabilityID"]),
                severity: severity_of(&text(v, &["Severity"])),
                package: text(v, &["PkgName"]),
                installed: text(v, &["InstalledVersion"]),
                fixed: text(v, &["FixedVersion"]),
                title: text(v, &["Title", "Description"]).chars().take(240).collect(),
                url: text(v, &["PrimaryURL"]),
            });
        }
    }
    Ok(dedupe(out))
}

/// `grype -o json`: `matches[]` of a `vulnerability` and the `artifact` it was found in.
pub fn parse_grype(text_out: &str) -> Result<Vec<Finding>, String> {
    let doc: Value = serde_json::from_str(text_out.trim()).map_err(|e| format!("could not read Grype's report: {e}"))?;
    let mut out = Vec::new();
    for m in doc.get("matches").and_then(Value::as_array).into_iter().flatten() {
        let vuln = m.get("vulnerability").cloned().unwrap_or(Value::Null);
        let artifact = m.get("artifact").cloned().unwrap_or(Value::Null);
        let fixed = vuln
            .get("fix")
            .and_then(|f| f.get("versions"))
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "))
            .unwrap_or_default();
        out.push(Finding {
            id: text(&vuln, &["id"]),
            severity: severity_of(&text(&vuln, &["severity"])),
            package: text(&artifact, &["name"]),
            installed: text(&artifact, &["version"]),
            fixed,
            title: text(&vuln, &["description"]).chars().take(240).collect(),
            url: text(&vuln, &["dataSource"]),
        });
    }
    Ok(dedupe(out))
}

/// The image's id as the engine knows it now; empty when it does not answer.
async fn image_id(target: &Target, image: &str) -> String {
    target.run(&["image", "inspect", "--format", "{{.Id}}", image], super::engine::LIST_TIMEOUT).await.map(|out| out.trim().to_string()).unwrap_or_default()
}

pub async fn scan(target: &Target, image: &str) -> Result<ScanResult, String> {
    check_ref(image)?;
    let scanner = detect().ok_or_else(|| "no scanner".to_string())?;
    let engine = target.engine()?;
    if engine == EngineKind::Ctr {
        return Err("unsupported".into());
    }
    // The engine the page reads, not whichever the scanner would find on its own.
    let endpoint = target.endpoint().await.unwrap_or_default();
    let local = endpoint.is_empty() || is_local_endpoint(&endpoint);
    if !local {
        return Err("remote".into());
    }
    let mut env: Vec<(String, String)> = vec![];
    let args: Vec<String> = match (scanner.id.as_str(), engine) {
        ("trivy", EngineKind::Podman) => vec!["image".into(), "--quiet".into(), "--format".into(), "json".into(), "--image-src".into(), "podman".into(), image.into()],
        ("trivy", _) => {
            let mut args: Vec<String> = vec!["image".into(), "--quiet".into(), "--format".into(), "json".into(), "--image-src".into(), "docker".into()];
            if endpoint.starts_with("unix://") || endpoint.starts_with("npipe://") {
                args.extend(["--docker-host".into(), endpoint.clone()]);
            }
            args.push(image.into());
            args
        }
        (_, EngineKind::Podman) => vec![format!("podman:{image}"), "-o".into(), "json".into(), "-q".into()],
        _ => {
            if !endpoint.is_empty() {
                env.push(("DOCKER_HOST".into(), endpoint.clone()));
            }
            vec![format!("docker:{image}"), "-o".into(), "json".into(), "-q".into()]
        }
    };
    let out = cli::run_with(&scanner.path, &args, None, SCAN_TIMEOUT, &env).await?;
    if !out.ok() {
        return Err(out.complaint());
    }
    let findings = if scanner.id == "trivy" { parse_trivy(&out.stdout)? } else { parse_grype(&out.stdout)? };
    Ok(ScanResult { scanner: scanner.id, findings, id: String::new(), scanned_at: chrono::Utc::now().to_rfc3339(), image_id: image_id(target, image).await })
}

// ------------------------------------------------------------------------------------ history

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS container_scans (
            id         TEXT PRIMARY KEY,
            image      TEXT NOT NULL,
            image_id   TEXT NOT NULL DEFAULT '',
            scanner    TEXT NOT NULL,
            scanned_at TEXT NOT NULL,
            findings   TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_container_scans_image ON container_scans(image, scanned_at);",
    )
}

/// Keeps `result` as a scan of `image`, and drops that image's scans beyond [`KEPT_PER_IMAGE`].
pub fn record(conn: &Connection, image: &str, result: &mut ScanResult) -> rusqlite::Result<()> {
    result.id = uuid::Uuid::new_v4().simple().to_string();
    let findings = serde_json::to_string(&result.findings).unwrap_or_else(|_| "[]".into());
    conn.execute(
        "INSERT INTO container_scans (id, image, image_id, scanner, scanned_at, findings) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![result.id, image, result.image_id, result.scanner, result.scanned_at, findings],
    )?;
    conn.execute(
        "DELETE FROM container_scans WHERE image = ?1 AND id NOT IN
           (SELECT id FROM container_scans WHERE image = ?1 ORDER BY scanned_at DESC, rowid DESC LIMIT ?2)",
        params![image, KEPT_PER_IMAGE as i64],
    )?;
    Ok(())
}

fn summary_of(id: String, image: String, image_id: String, scanner: String, scanned_at: String, findings: &[Finding]) -> ScanSummary {
    let count = |severity: &str| findings.iter().filter(|f| f.severity == severity).count() as u32;
    ScanSummary { id, image, image_id, scanner, scanned_at, critical: count("critical"), high: count("high"), medium: count("medium"), low: count("low"), unknown: count("unknown") }
}

/// The kept scans of `image`, newest first.
pub fn history(conn: &Connection, image: &str) -> rusqlite::Result<Vec<ScanSummary>> {
    let mut statement = conn.prepare("SELECT id, image, image_id, scanner, scanned_at, findings FROM container_scans WHERE image = ?1 ORDER BY scanned_at DESC, rowid DESC")?;
    let rows = statement.query_map(params![image], |row| {
        let findings: Vec<Finding> = serde_json::from_str(&row.get::<_, String>(5)?).unwrap_or_default();
        Ok(summary_of(row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, &findings))
    })?;
    rows.collect()
}

/// One kept scan with its findings.
pub fn get(conn: &Connection, id: &str) -> rusqlite::Result<Option<ScanResult>> {
    conn.query_row("SELECT scanner, findings, id, scanned_at, image_id FROM container_scans WHERE id = ?1", params![id], |row| {
        Ok(ScanResult {
            scanner: row.get(0)?,
            findings: serde_json::from_str(&row.get::<_, String>(1)?).unwrap_or_default(),
            id: row.get(2)?,
            scanned_at: row.get(3)?,
            image_id: row.get(4)?,
        })
    })
    .optional()
}

pub fn delete_history(conn: &Connection, image: &str) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM container_scans WHERE image = ?1", params![image])
}

/// `later` against `earlier`, a finding being the same one when its id and package are: a package
/// upgraded without fixing it is still the same finding.
pub fn compare(earlier: &[Finding], later: &[Finding]) -> ScanComparison {
    let key = |f: &Finding| (f.id.clone(), f.package.clone());
    let before: std::collections::HashSet<_> = earlier.iter().map(key).collect();
    let after: std::collections::HashSet<_> = later.iter().map(key).collect();
    ScanComparison {
        added: later.iter().filter(|f| !before.contains(&key(f))).cloned().collect(),
        fixed: earlier.iter().filter(|f| !after.contains(&key(f))).cloned().collect(),
        kept: later.iter().filter(|f| before.contains(&key(f))).count() as u32,
    }
}

// ---------------------------------------------------------------------------------------- SBOM

/// What can write an SBOM: Trivy first, else Syft.
pub fn sbom_tool() -> Option<Scanner> {
    ["trivy", "syft"].iter().find_map(|id| cli::find(id).map(|path| Scanner { id: id.to_string(), path: path.to_string_lossy().into_owned() }))
}

/// The command line that writes `image`'s SBOM to `dest` as `format` (`cyclonedx` or `spdx`).
pub fn sbom_args(tool: &str, engine: EngineKind, endpoint: &str, image: &str, format: &str, dest: &str) -> Result<Vec<String>, String> {
    let source = if engine == EngineKind::Podman { "podman" } else { "docker" };
    Ok(match (tool, format) {
        ("trivy", "cyclonedx" | "spdx") => {
            let format = if format == "spdx" { "spdx-json" } else { "cyclonedx" };
            let mut args: Vec<String> = vec!["image".into(), "--quiet".into(), "--format".into(), format.into(), "--output".into(), dest.into(), "--image-src".into(), source.into()];
            if engine != EngineKind::Podman && (endpoint.starts_with("unix://") || endpoint.starts_with("npipe://")) {
                args.extend(["--docker-host".into(), endpoint.into()]);
            }
            args.push(image.into());
            args
        }
        ("syft", "cyclonedx" | "spdx") => {
            let format = if format == "spdx" { "spdx-json" } else { "cyclonedx-json" };
            vec![format!("{source}:{image}"), "-q".into(), "-o".into(), format!("{format}={dest}")]
        }
        (_, other) => return Err(format!("{other} is not an SBOM format (cyclonedx or spdx)")),
    })
}

/// Writes `image`'s SBOM to `dest`; the tool that wrote it.
pub async fn sbom(target: &Target, image: &str, format: &str, dest: &str) -> Result<String, String> {
    check_ref(image)?;
    if !std::path::Path::new(dest).is_absolute() || dest.contains('\0') {
        return Err(format!("{dest} is not a full path"));
    }
    let tool = sbom_tool().ok_or_else(|| "no sbom tool".to_string())?;
    let engine = target.engine()?;
    if engine == EngineKind::Ctr {
        return Err("unsupported".into());
    }
    let endpoint = target.endpoint().await.unwrap_or_default();
    if !(endpoint.is_empty() || is_local_endpoint(&endpoint)) {
        return Err("remote".into());
    }
    let args = sbom_args(&tool.id, engine, &endpoint, image, format, dest)?;
    let env: Vec<(String, String)> = if tool.id == "syft" && engine != EngineKind::Podman && !endpoint.is_empty() { vec![("DOCKER_HOST".into(), endpoint)] } else { vec![] };
    let out = cli::run_with(&tool.path, &args, None, SCAN_TIMEOUT, &env).await?;
    if !out.ok() {
        return Err(out.complaint());
    }
    Ok(tool.id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trivy_report() {
        let findings = parse_trivy(
            r#"{"Results":[{"Target":"debian","Vulnerabilities":[
                {"VulnerabilityID":"CVE-2024-1","PkgName":"openssl","InstalledVersion":"3.0.1","FixedVersion":"3.0.2","Severity":"HIGH","Title":"bad","PrimaryURL":"https://x"},
                {"VulnerabilityID":"CVE-2024-2","PkgName":"zlib","InstalledVersion":"1.2","Severity":"CRITICAL"},
                {"VulnerabilityID":"CVE-2024-1","PkgName":"openssl","InstalledVersion":"3.0.1","FixedVersion":"3.0.2","Severity":"HIGH"}]},
              {"Target":"node","Vulnerabilities":null}]}"#,
        )
        .unwrap();
        assert_eq!(findings.len(), 2);
        assert_eq!(findings[0].severity, "critical");
        assert_eq!(findings[1].fixed, "3.0.2");
    }

    #[test]
    fn grype_report() {
        let findings = parse_grype(
            r#"{"matches":[{"vulnerability":{"id":"GHSA-1","severity":"Negligible","fix":{"versions":["1.1"],"state":"fixed"},"dataSource":"https://g"},"artifact":{"name":"lodash","version":"1.0"}}]}"#,
        )
        .unwrap();
        assert_eq!(findings[0].severity, "low");
        assert_eq!(findings[0].fixed, "1.1");
        assert_eq!(findings[0].package, "lodash");
    }

    fn finding(id: &str, package: &str, severity: &str) -> Finding {
        Finding { id: id.into(), severity: severity.into(), package: package.into(), installed: "1".into(), fixed: String::new(), title: String::new(), url: String::new() }
    }

    fn result(findings: Vec<Finding>, at: &str) -> ScanResult {
        ScanResult { scanner: "trivy".into(), findings, id: String::new(), scanned_at: at.into(), image_id: "sha256:a".into() }
    }

    #[test]
    fn scans_are_kept_counted_and_trimmed_per_image() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap();
        let mut first = result(vec![finding("CVE-1", "openssl", "critical"), finding("CVE-2", "zlib", "low")], "2026-11-01T00:00:00Z");
        record(&conn, "web:1", &mut first).unwrap();
        assert_eq!(first.id.len(), 32);
        for day in 2..=(KEPT_PER_IMAGE + 3) {
            record(&conn, "web:1", &mut result(vec![], &format!("2026-11-{day:02}T00:00:00Z"))).unwrap();
        }
        record(&conn, "db:1", &mut result(vec![finding("CVE-3", "libc", "high")], "2026-10-01T00:00:00Z")).unwrap();
        let web = history(&conn, "web:1").unwrap();
        assert_eq!(web.len(), KEPT_PER_IMAGE, "older scans of the image are dropped");
        assert!(web[0].scanned_at > web[1].scanned_at, "newest first");
        assert!(get(&conn, &first.id).unwrap().is_none(), "the oldest went first");
        let db = history(&conn, "db:1").unwrap();
        assert_eq!((db.len(), db[0].high, db[0].critical), (1, 1, 0), "another image's scans are its own");
        let kept = get(&conn, &db[0].id).unwrap().unwrap();
        assert_eq!(kept.findings[0].package, "libc");
        assert_eq!(delete_history(&conn, "db:1").unwrap(), 1);
    }

    #[test]
    fn a_comparison_says_what_came_and_went() {
        let earlier = vec![finding("CVE-1", "openssl", "high"), finding("CVE-2", "zlib", "low")];
        let mut upgraded = finding("CVE-1", "openssl", "high");
        upgraded.installed = "2".into();
        let later = vec![upgraded, finding("CVE-9", "curl", "critical")];
        let diff = compare(&earlier, &later);
        assert_eq!(diff.added.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(), vec!["CVE-9"]);
        assert_eq!(diff.fixed.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(), vec!["CVE-2"]);
        assert_eq!(diff.kept, 1, "an upgrade that did not fix it is the same finding");
    }

    #[test]
    fn sbom_command_lines() {
        assert_eq!(
            sbom_args("trivy", EngineKind::Docker, "unix:///var/run/docker.sock", "web:1", "cyclonedx", "/tmp/web.json").unwrap(),
            vec!["image", "--quiet", "--format", "cyclonedx", "--output", "/tmp/web.json", "--image-src", "docker", "--docker-host", "unix:///var/run/docker.sock", "web:1"]
        );
        assert_eq!(sbom_args("syft", EngineKind::Podman, "", "web:1", "spdx", "/tmp/web.spdx.json").unwrap(), vec!["podman:web:1", "-q", "-o", "spdx-json=/tmp/web.spdx.json"]);
        assert!(sbom_args("trivy", EngineKind::Docker, "", "web:1", "xml", "/tmp/x").is_err());
    }
}
