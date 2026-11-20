//! «Seguridad» — an image's known vulnerabilities, from a scanner already installed on this computer.
//!
//! Like everything else in the manager, **found, not embedded**: Trivy or Grype when one is on the
//! PATH, run against the engine's own copy of the image. The image never leaves the computer — the
//! scanner downloads its vulnerability database the first time, and nothing else. Without either,
//! the page says how to install one instead.

use std::time::Duration;

use serde::Serialize;
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

#[derive(Debug, Clone, Serialize, PartialEq)]
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
}

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
    Ok(ScanResult { scanner: scanner.id, findings })
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
}
