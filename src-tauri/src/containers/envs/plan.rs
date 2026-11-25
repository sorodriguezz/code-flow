//! The arithmetic of an environment, apart from any engine: its names, its port offset, and the
//! Compose override that moves every published port by that offset.
//!
//! **Why an override file and not edited copies.** Compose already merges `-f a -f b`, so the
//! repository's own files stay exactly as the branch has them and the override is the only thing
//! CodeFlow writes. It is generated from `docker compose config --format json` — the effective
//! configuration, every variant file, `.env` interpolation and short port syntax already resolved
//! by Compose itself — rather than from reading the YAML here, which would get ranges, `${PORT}`
//! and long syntax wrong sooner or later.
//!
//! **Why `!override`.** Compose *appends* the `ports` of a later file to the earlier ones, so an
//! override that only listed the new ports would publish both and collide with the environment of
//! the next branch on the old one. The `!override` tag (Compose 2.24.4+) replaces the list instead.
//! [`compose_supports_override`] checks the version before the file is used.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// How far apart environments' ports are suggested: `main` on 8080, the next on 8180, then 8280.
pub const OFFSET_STEP: u16 = 100;
/// Compose's own limit is none, but a project name is also a container-name prefix and a label.
const PROJECT_MAX: usize = 63;

/// Lowercase ASCII letters and digits, everything else one `-`, trimmed — `feature/Payment_v2` →
/// `feature-payment-v2`. At most `max` characters; empty when nothing is left.
pub fn slug(text: &str, max: usize) -> String {
    let mut out = String::new();
    for c in text.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let mut out: String = out.trim_matches('-').chars().take(max).collect();
    while out.ends_with('-') {
        out.pop();
    }
    out
}

/// `<repo>-<branch>`, as Compose takes a project name: lowercase letters, digits, `-` and `_`,
/// starting with a letter or digit.
pub fn compose_project_name(repo: &str, branch: &str) -> String {
    let repo = slug(repo, 30);
    let branch = slug(branch, PROJECT_MAX);
    let joined = match (repo.is_empty(), branch.is_empty()) {
        (true, true) => "env".to_string(),
        (true, false) => branch,
        (false, true) => repo,
        (false, false) => format!("{repo}-{branch}"),
    };
    let mut name: String = joined.chars().take(PROJECT_MAX).collect();
    while name.ends_with('-') {
        name.pop();
    }
    name
}

pub fn valid_compose_project(name: &str) -> bool {
    let mut chars = name.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
        && name.len() <= PROJECT_MAX
}

/// The smallest multiple of [`OFFSET_STEP`] no other environment of the repository uses, that keeps
/// every port in range and lands none of them on a port already taken (`busy`). `None` when nothing
/// fits — six hundred tries, more environments than anyone runs.
pub fn suggest_offset(base_ports: &[u16], taken: &[u16], busy: impl Fn(u16) -> bool) -> Option<u16> {
    for step in 1..=600u32 {
        let offset = step * OFFSET_STEP as u32;
        if offset > u16::MAX as u32 {
            break;
        }
        if taken.contains(&(offset as u16)) {
            continue;
        }
        let fits = base_ports.iter().all(|&port| {
            let moved = port as u32 + offset;
            moved <= u16::MAX as u32 && !busy(moved as u16)
        });
        if fits {
            return Some(offset as u16);
        }
    }
    None
}

/// One published port of an environment: where it is inside, where it was, where it is now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortBinding {
    pub service: String,
    /// The port inside the container (the first of a range).
    pub target: u16,
    pub protocol: String,
    pub host_ip: String,
    /// What the repository's files publish, before the offset (`None`: a random port).
    pub base: Option<u16>,
    /// What this environment publishes (the first of a range).
    pub host: Option<u16>,
    /// The last port of a published range.
    pub host_end: Option<u16>,
}

/// Something about the configuration the offset cannot keep apart, said once per environment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvWarning {
    /// `sharedVolume`, `sharedNetwork`, `hostNetwork`, `unsupported`, `noPorts`.
    pub code: String,
    pub subject: String,
}

impl EnvWarning {
    pub fn new(code: &str, subject: impl Into<String>) -> Self {
        Self { code: code.to_string(), subject: subject.into() }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverridePlan {
    pub yaml: String,
    pub ports: Vec<PortBinding>,
    pub warnings: Vec<EnvWarning>,
}

/// `8080` or `8080-8085` moved by `offset`: the new text, its first and its last port.
pub fn shift_published(published: &str, offset: u16) -> Result<(String, u16, Option<u16>), String> {
    let shift = |text: &str| -> Result<u16, String> {
        let port: u32 = text.trim().parse().map_err(|_| format!("\"{published}\" is not a port"))?;
        let moved = port + offset as u32;
        if port == 0 || moved > u16::MAX as u32 {
            return Err(format!("port {port} + {offset} is past 65535: choose a smaller offset"));
        }
        Ok(moved as u16)
    };
    match published.split_once('-') {
        Some((from, to)) => {
            let (a, b) = (shift(from)?, shift(to)?);
            Ok((format!("{a}-{b}"), a, Some(b)))
        }
        None => {
            let a = shift(published)?;
            Ok((a.to_string(), a, None))
        }
    }
}

/// A published port as `config --format json` writes it: text in current Compose, a number in older.
fn published_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn quoted(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into())
}

/// The override that moves every published port of `config` (Compose's effective configuration as
/// JSON) by `offset`, and renames fixed `container_name`s with the project's name so two
/// environments never ask for the same container.
pub fn compose_override(config: &Value, project: &str, offset: u16) -> Result<OverridePlan, String> {
    let mut yaml = format!(
        "# Generated by CodeFlow for the environment {project}: host ports moved by {offset}.\n# Written again before every start — edits here are lost.\nservices:\n"
    );
    let mut ports_out = Vec::new();
    let mut warnings = Vec::new();
    let services = config.get("services").and_then(Value::as_object);
    let mut wrote_any = false;
    for (service, spec) in services.into_iter().flatten() {
        let mut block = String::new();
        if spec.get("network_mode").and_then(Value::as_str) == Some("host") {
            warnings.push(EnvWarning::new("hostNetwork", service.clone()));
        }
        let ports = spec.get("ports").and_then(Value::as_array).cloned().unwrap_or_default();
        if ports.iter().any(|p| published_text(p.get("published")).is_some()) {
            block.push_str("    ports: !override\n");
            for port in &ports {
                let target = port.get("target").and_then(Value::as_u64).filter(|t| *t > 0 && *t <= u16::MAX as u64).ok_or_else(|| format!("a port of {service} has no container port"))? as u16;
                let protocol = port.get("protocol").and_then(Value::as_str).unwrap_or("tcp").to_string();
                let host_ip = port.get("host_ip").and_then(Value::as_str).unwrap_or_default().to_string();
                block.push_str(&format!("      - target: {target}\n        protocol: {}\n", quoted(&protocol)));
                let mut binding = PortBinding { service: service.clone(), target, protocol, host_ip: host_ip.clone(), base: None, host: None, host_end: None };
                if let Some(published) = published_text(port.get("published")) {
                    let (text, first, end) = shift_published(&published, offset)?;
                    binding.base = published.split('-').next().and_then(|p| p.trim().parse().ok());
                    binding.host = Some(first);
                    binding.host_end = end;
                    block.push_str(&format!("        published: {}\n", quoted(&text)));
                }
                if !host_ip.is_empty() {
                    block.push_str(&format!("        host_ip: {}\n", quoted(&host_ip)));
                }
                for key in ["mode", "name", "app_protocol"] {
                    if let Some(value) = port.get(key).and_then(Value::as_str).filter(|v| !v.is_empty()) {
                        block.push_str(&format!("        {key}: {}\n", quoted(value)));
                    }
                }
                ports_out.push(binding);
            }
        }
        if let Some(name) = spec.get("container_name").and_then(Value::as_str).filter(|n| !n.is_empty()) {
            block.push_str(&format!("    container_name: {}\n", quoted(&format!("{name}-{project}"))));
        }
        if !block.is_empty() {
            yaml.push_str(&format!("  {}:\n{block}", quoted(service)));
            wrote_any = true;
        }
    }
    if !wrote_any {
        yaml = yaml.trim_end_matches("services:\n").to_string();
        yaml.push_str("services: {}\n");
    }
    if ports_out.iter().all(|p| p.host.is_none()) {
        warnings.push(EnvWarning::new("noPorts", project));
    }
    for (section, code) in [("volumes", "sharedVolume"), ("networks", "sharedNetwork")] {
        for (key, spec) in config.get(section).and_then(Value::as_object).into_iter().flatten() {
            let external = match spec.get("external") {
                Some(Value::Bool(b)) => *b,
                Some(Value::Object(_)) => true,
                _ => false,
            };
            let name = spec.get("name").and_then(Value::as_str).unwrap_or_default();
            let own = format!("{project}_{key}");
            if external || (!name.is_empty() && name != own) {
                warnings.push(EnvWarning::new(code, if name.is_empty() { key.clone() } else { name.to_string() }));
            }
        }
    }
    Ok(OverridePlan { yaml, ports: ports_out, warnings })
}

/// Whether a Compose version (`2.29.1`, `v2.24.4-desktop.1`) reads the `!override` tag. `None` when
/// the text is not a version (podman-compose prints its own), and the file is then simply tried.
pub fn compose_supports_override(version: &str) -> Option<bool> {
    let text = version.trim().trim_start_matches('v');
    let numbers: Vec<u32> = text.split(|c: char| !c.is_ascii_digit()).take(3).map(|p| p.parse().ok()).collect::<Option<Vec<_>>>()?;
    let [major, minor, patch] = numbers[..] else { return None };
    Some((major, minor, patch) >= (2, 24, 4))
}

/// Where a snapshot's volume goes when restored into another environment: a volume Compose named
/// for the old project (`shop-main_data`) becomes the same volume of the new one (`shop-fix-auth_data`).
pub fn restore_target(snapshot_project: &str, project: &str, volume: &str) -> String {
    match volume.strip_prefix(&format!("{snapshot_project}_")) {
        Some(rest) if !snapshot_project.is_empty() => format!("{project}_{rest}"),
        _ => volume.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn names_are_compose_project_names() {
        assert_eq!(slug("feature/Payment_v2", 40), "feature-payment-v2");
        assert_eq!(slug("--//--", 40), "");
        assert_eq!(slug("ñandú/añejo", 40), "and-a-ejo");
        assert_eq!(compose_project_name("Shop.API", "feature/payment"), "shop-api-feature-payment");
        assert_eq!(compose_project_name("", "main"), "main");
        assert_eq!(compose_project_name("...", "///"), "env");
        let long = compose_project_name("repo", &"x".repeat(200));
        assert!(long.len() <= 63 && valid_compose_project(&long));
        for name in ["shop-main", "a_b", "9lives"] {
            assert!(valid_compose_project(name), "{name}");
        }
        for name in ["", "-x", "Shop", "a b", "a.b"] {
            assert!(!valid_compose_project(name), "{name}");
        }
    }

    #[test]
    fn the_offset_skips_what_is_taken_and_what_is_busy() {
        assert_eq!(suggest_offset(&[8080, 5432], &[], |_| false), Some(100));
        assert_eq!(suggest_offset(&[8080], &[100, 200], |_| false), Some(300));
        assert_eq!(suggest_offset(&[8080], &[], |p| p == 8180), Some(200));
        assert_eq!(suggest_offset(&[], &[100], |_| false), Some(200));
        assert_eq!(suggest_offset(&[65500], &[], |_| false), None);
    }

    #[test]
    fn published_ports_and_ranges_move_by_the_offset() {
        assert_eq!(shift_published("8080", 100).unwrap(), ("8180".into(), 8180, None));
        assert_eq!(shift_published("8000-8002", 10).unwrap(), ("8010-8012".into(), 8010, Some(8012)));
        assert!(shift_published("65500", 100).is_err());
        assert!(shift_published("abc", 1).is_err());
    }

    #[test]
    fn the_override_replaces_ports_and_renames_fixed_containers() {
        let config = json!({
            "name": "shop-main",
            "services": {
                "db": { "ports": [{ "mode": "ingress", "target": 5432, "published": "5432", "protocol": "tcp" }], "container_name": "shop-db" },
                "web": { "ports": [
                    { "target": 80, "published": 8080, "protocol": "tcp", "host_ip": "127.0.0.1" },
                    { "target": 9229, "protocol": "tcp" }
                ] },
                "worker": { "image": "busybox" },
                "agent": { "network_mode": "host" }
            },
            "volumes": { "data": { "name": "shop-main_data" }, "cache": { "name": "global-cache" }, "ext": { "name": "ext", "external": true } },
            "networks": { "default": { "name": "shop-main_default" } }
        });
        let plan = compose_override(&config, "shop-main", 200).unwrap();
        assert!(plan.yaml.contains("  \"db\":\n    ports: !override\n      - target: 5432\n        protocol: \"tcp\"\n        published: \"5632\"\n        mode: \"ingress\"\n    container_name: \"shop-db-shop-main\"\n"), "{}", plan.yaml);
        assert!(plan.yaml.contains("published: \"8280\"\n        host_ip: \"127.0.0.1\"\n"));
        assert!(plan.yaml.contains("      - target: 9229\n        protocol: \"tcp\"\n"), "an unpublished port stays");
        assert!(!plan.yaml.contains("worker"));
        let web: Vec<&PortBinding> = plan.ports.iter().filter(|p| p.service == "web").collect();
        assert_eq!(web[0].base, Some(8080));
        assert_eq!(web[0].host, Some(8280));
        assert_eq!(web[1].host, None);
        let codes: Vec<(&str, &str)> = plan.warnings.iter().map(|w| (w.code.as_str(), w.subject.as_str())).collect();
        assert!(codes.contains(&("hostNetwork", "agent")));
        assert!(codes.contains(&("sharedVolume", "global-cache")));
        assert!(codes.contains(&("sharedVolume", "ext")));
        assert!(!codes.iter().any(|(_, s)| *s == "shop-main_data" || *s == "shop-main_default"));
    }

    #[test]
    fn a_stack_with_nothing_to_move_is_an_empty_override() {
        let plan = compose_override(&json!({ "services": { "job": { "image": "x" } } }), "p", 100).unwrap();
        assert!(plan.yaml.ends_with("services: {}\n"));
        assert!(plan.warnings.iter().any(|w| w.code == "noPorts"));
    }

    #[test]
    fn override_tags_need_a_recent_compose() {
        assert_eq!(compose_supports_override("2.29.1"), Some(true));
        assert_eq!(compose_supports_override("v2.24.4-desktop.1"), Some(true));
        assert_eq!(compose_supports_override("2.24.3"), Some(false));
        assert_eq!(compose_supports_override("1.29.2"), Some(false));
        assert_eq!(compose_supports_override("podman-compose"), None);
    }

    #[test]
    fn a_snapshot_restores_into_the_same_volume_of_another_environment() {
        assert_eq!(restore_target("shop-main", "shop-fix-auth", "shop-main_data"), "shop-fix-auth_data");
        assert_eq!(restore_target("shop-main", "shop-fix-auth", "other"), "other");
        assert_eq!(restore_target("", "p", "x_y"), "x_y");
    }
}
