//! «Endurecimiento» — what in a container's own configuration weakens its isolation, read from its
//! `inspect` document: privileged mode, the engine's socket mounted inside, the host's network or
//! processes shared, capabilities that amount to root on the host, no limits.
//!
//! Rules, not a scanner: each one is a fact the inspect document states, checked the same way on
//! Docker and Podman (Podman's inspect keeps Docker's `HostConfig` names). The findings carry a
//! rule id and the detail that triggered it; the page words them. The same rules are what a
//! workspace policy will enforce before an agent's container starts.
//!
//! Also here: a Dockerfile's problems, from `hadolint` when it is installed — found, not embedded,
//! like the vulnerability scanners.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use super::cli;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HardeningFinding {
    /// `privileged`, `engineSocket`, `hostMount`, `hostNetwork`, `hostPid`, `hostIpc`, `dangerousCap`,
    /// `seccompOff`, `apparmorOff`, `devices`, `rootUser`, `newPrivileges`, `writableRoot`,
    /// `noMemoryLimit`, `noCpuLimit`, `noPidsLimit`, `noHealthcheck`, `allInterfaces`.
    pub rule: String,
    /// `high`, `medium` or `low`.
    pub severity: String,
    /// What triggered it — a path, a capability, a port — or empty.
    pub detail: String,
}

/// Capabilities that are root on the host, or close enough to it.
const DANGEROUS_CAPS: [&str; 7] = ["ALL", "SYS_ADMIN", "SYS_MODULE", "SYS_PTRACE", "SYS_RAWIO", "DAC_READ_SEARCH", "NET_ADMIN"];

/// Host folders whose mount into a container hands it the host.
const HOST_PATHS: [&str; 10] = ["/", "/etc", "/proc", "/sys", "/boot", "/dev", "/root", "/var/run", "/run", "/var/lib/docker"];

fn at<'a>(doc: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter().try_fold(doc, |value, key| value.get(*key)).filter(|v| !v.is_null())
}

fn text_at(doc: &Value, path: &[&str]) -> String {
    at(doc, path).and_then(Value::as_str).unwrap_or_default().trim().to_string()
}

fn number_at(doc: &Value, path: &[&str]) -> i64 {
    at(doc, path).and_then(Value::as_i64).unwrap_or(0)
}

fn strings_at(doc: &Value, path: &[&str]) -> Vec<String> {
    at(doc, path).and_then(Value::as_array).map(|list| list.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
}

fn engine_socket(path: &str) -> bool {
    ["docker.sock", "podman.sock", "containerd.sock", "buildkitd.sock", "crio.sock"].iter().any(|name| path.ends_with(name))
}

/// Every rule against one container's inspect document (the object, not the array around it),
/// most severe first.
pub fn audit(doc: &Value) -> Vec<HardeningFinding> {
    let mut out = Vec::new();
    let mut add = |rule: &str, severity: &str, detail: String| out.push(HardeningFinding { rule: rule.into(), severity: severity.into(), detail });
    let host = |key: &str| at(doc, &["HostConfig", key]);

    if host("Privileged").and_then(Value::as_bool) == Some(true) {
        add("privileged", "high", String::new());
    }
    for mount in at(doc, &["Mounts"]).and_then(Value::as_array).into_iter().flatten() {
        if mount.get("Type").and_then(Value::as_str) != Some("bind") {
            continue;
        }
        let source = mount.get("Source").and_then(Value::as_str).unwrap_or_default().trim_end_matches('/');
        let source = if source.is_empty() { "/" } else { source };
        if engine_socket(source) {
            add("engineSocket", "high", source.to_string());
        } else if HOST_PATHS.contains(&source) {
            let writable = mount.get("RW").and_then(Value::as_bool).unwrap_or(true);
            add("hostMount", if writable { "high" } else { "medium" }, source.to_string());
        }
    }
    for (key, rule) in [("NetworkMode", "hostNetwork"), ("PidMode", "hostPid"), ("IpcMode", "hostIpc")] {
        if text_at(doc, &["HostConfig", key]) == "host" {
            add(rule, if rule == "hostIpc" { "medium" } else { "high" }, String::new());
        }
    }
    for cap in strings_at(doc, &["HostConfig", "CapAdd"]) {
        let name = cap.trim().to_ascii_uppercase();
        let name = name.strip_prefix("CAP_").unwrap_or(&name).to_string();
        if DANGEROUS_CAPS.contains(&name.as_str()) {
            add("dangerousCap", "high", name);
        }
    }
    let security = strings_at(doc, &["HostConfig", "SecurityOpt"]);
    let opt = |name: &str| security.iter().any(|o| o.replace(':', "=").trim() == name);
    if opt("seccomp=unconfined") {
        add("seccompOff", "high", String::new());
    }
    if opt("apparmor=unconfined") {
        add("apparmorOff", "medium", String::new());
    }
    let devices = host("Devices").and_then(Value::as_array).map(Vec::len).unwrap_or(0);
    if devices > 0 {
        add("devices", "medium", devices.to_string());
    }
    let user = text_at(doc, &["Config", "User"]);
    let who = user.split(':').next().unwrap_or_default();
    if who.is_empty() || who == "0" || who == "root" {
        add("rootUser", "medium", String::new());
    }
    if !security.iter().any(|o| o.starts_with("no-new-privileges") && !o.ends_with("false")) {
        add("newPrivileges", "low", String::new());
    }
    if host("ReadonlyRootfs").and_then(Value::as_bool) != Some(true) {
        add("writableRoot", "low", String::new());
    }
    if number_at(doc, &["HostConfig", "Memory"]) <= 0 {
        add("noMemoryLimit", "low", String::new());
    }
    if number_at(doc, &["HostConfig", "NanoCpus"]) <= 0 && number_at(doc, &["HostConfig", "CpuQuota"]) <= 0 {
        add("noCpuLimit", "low", String::new());
    }
    if number_at(doc, &["HostConfig", "PidsLimit"]) <= 0 {
        add("noPidsLimit", "low", String::new());
    }
    let check = strings_at(doc, &["Config", "Healthcheck", "Test"]);
    if check.is_empty() || check.first().map(String::as_str) == Some("NONE") {
        add("noHealthcheck", "low", String::new());
    }
    let mut open: Vec<String> = Vec::new();
    if let Some(bindings) = host("PortBindings").and_then(Value::as_object) {
        for (port, list) in bindings {
            for binding in list.as_array().into_iter().flatten() {
                let ip = binding.get("HostIp").and_then(Value::as_str).unwrap_or_default();
                if matches!(ip, "" | "0.0.0.0" | "::") {
                    let host_port = binding.get("HostPort").and_then(Value::as_str).unwrap_or_default();
                    open.push(if host_port.is_empty() { port.clone() } else { format!("{host_port}→{port}") });
                }
            }
        }
    }
    if !open.is_empty() {
        open.sort();
        open.dedup();
        add("allInterfaces", "low", open.join(", "));
    }

    let rank = |s: &str| match s {
        "high" => 0,
        "medium" => 1,
        _ => 2,
    };
    out.sort_by_key(|f| rank(&f.severity));
    out
}

// ------------------------------------------------------------------------------------ hadolint

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LintFinding {
    pub line: u32,
    /// `DL3008`, `SC2086`…
    pub code: String,
    /// `error`, `warning`, `info` or `style`.
    pub level: String,
    pub message: String,
}

const LINT_TIMEOUT: Duration = Duration::from_secs(60);

pub fn hadolint() -> Option<String> {
    cli::find("hadolint").map(|p| p.to_string_lossy().into_owned())
}

/// `hadolint --format json`: one array of `{line, code, message, level, file, column}`.
pub fn parse_hadolint(out: &str) -> Result<Vec<LintFinding>, String> {
    let doc: Value = serde_json::from_str(out.trim()).map_err(|e| format!("could not read hadolint's report: {e}"))?;
    let mut findings: Vec<LintFinding> = doc
        .as_array()
        .into_iter()
        .flatten()
        .map(|v| LintFinding {
            line: v.get("line").and_then(Value::as_u64).unwrap_or(0) as u32,
            code: v.get("code").and_then(Value::as_str).unwrap_or_default().to_string(),
            level: v.get("level").and_then(Value::as_str).unwrap_or("info").to_string(),
            message: v.get("message").and_then(Value::as_str).unwrap_or_default().to_string(),
        })
        .collect();
    findings.sort_by_key(|f| f.line);
    Ok(findings)
}

/// A Dockerfile's problems. hadolint exits non-zero when it finds any, so its report is read
/// whatever the exit code, and only an empty report with a complaint is a failure.
pub async fn lint_dockerfile(path: &str) -> Result<Vec<LintFinding>, String> {
    let program = hadolint().ok_or_else(|| "no hadolint".to_string())?;
    if !std::path::Path::new(path).is_file() {
        return Err(format!("{path} is not a file on this computer"));
    }
    let args: Vec<String> = vec!["--format".into(), "json".into(), "--no-fail".into(), path.into()];
    let out = cli::run(&program, &args, None, LINT_TIMEOUT).await?;
    if out.stdout.trim().is_empty() {
        return if out.ok() { Ok(vec![]) } else { Err(out.complaint()) };
    }
    parse_hadolint(&out.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rules(doc: &Value) -> Vec<(String, String, String)> {
        audit(doc).into_iter().map(|f| (f.rule, f.severity, f.detail)).collect()
    }

    #[test]
    fn a_hardened_container_has_nothing_to_say() {
        let doc = json!({
            "Config": {"User": "1000:1000", "Healthcheck": {"Test": ["CMD-SHELL", "true"]}},
            "HostConfig": {"Privileged": false, "NetworkMode": "bridge", "CapAdd": ["NET_BIND_SERVICE"], "SecurityOpt": ["no-new-privileges"],
                "ReadonlyRootfs": true, "Memory": 536870912, "NanoCpus": 1000000000, "PidsLimit": 256,
                "PortBindings": {"80/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8080"}]}},
            "Mounts": [{"Type": "volume", "Source": "/var/lib/docker/volumes/x/_data"}]
        });
        assert_eq!(rules(&doc), vec![]);
    }

    #[test]
    fn what_a_default_run_leaves_open() {
        let doc = json!({"Config": {"User": ""}, "HostConfig": {"NetworkMode": "default", "PortBindings": {"80/tcp": [{"HostIp": "", "HostPort": "8080"}]}}});
        let found: Vec<String> = audit(&doc).into_iter().map(|f| f.rule).collect();
        assert_eq!(found, vec!["rootUser", "newPrivileges", "writableRoot", "noMemoryLimit", "noCpuLimit", "noPidsLimit", "noHealthcheck", "allInterfaces"]);
    }

    #[test]
    fn the_ways_out_of_a_container() {
        let doc = json!({
            "Config": {"User": "root", "Healthcheck": {"Test": ["NONE"]}},
            "HostConfig": {"Privileged": true, "NetworkMode": "host", "PidMode": "host", "IpcMode": "host", "CapAdd": ["cap_sys_admin", "CHOWN"],
                "SecurityOpt": ["seccomp:unconfined", "apparmor=unconfined", "no-new-privileges=false"], "Devices": [{"PathOnHost": "/dev/fuse"}]},
            "Mounts": [
                {"Type": "bind", "Source": "/var/run/docker.sock", "RW": true},
                {"Type": "bind", "Source": "/", "RW": false},
                {"Type": "bind", "Source": "/etc/", "RW": true},
                {"Type": "bind", "Source": "/Users/me/app", "RW": true}
            ]
        });
        let found = rules(&doc);
        let high: Vec<&str> = found.iter().filter(|f| f.1 == "high").map(|f| f.0.as_str()).collect();
        assert_eq!(high, vec!["privileged", "engineSocket", "hostMount", "hostNetwork", "hostPid", "dangerousCap", "seccompOff"]);
        assert!(found.contains(&("hostMount".into(), "medium".into(), "/".into())), "read-only root of the host is still medium");
        assert!(found.contains(&("hostMount".into(), "high".into(), "/etc".into())));
        assert!(found.contains(&("dangerousCap".into(), "high".into(), "SYS_ADMIN".into())));
        assert!(found.contains(&("devices".into(), "medium".into(), "1".into())));
        assert!(found.iter().any(|f| f.0 == "newPrivileges"), "no-new-privileges=false is not set");
        assert!(!found.iter().any(|f| f.2 == "/Users/me/app"), "a project folder is not the host");
    }

    #[test]
    fn hadolint_report() {
        let findings = parse_hadolint(
            r#"[{"code":"DL3008","column":1,"file":"Dockerfile","level":"warning","line":7,"message":"Pin versions in apt get install."},
                {"code":"DL3006","column":1,"file":"Dockerfile","level":"warning","line":1,"message":"Always tag the version of an image explicitly"}]"#,
        )
        .unwrap();
        assert_eq!(findings.iter().map(|f| f.line).collect::<Vec<_>>(), vec![1, 7]);
        assert_eq!(findings[1].code, "DL3008");
        assert!(parse_hadolint("[]").unwrap().is_empty());
        assert!(parse_hadolint("not json").is_err());
    }
}
