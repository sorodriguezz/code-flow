//! The engine operations the manager adds beyond list-and-act: live stats for every running
//! container, resource limits, creating volumes and networks, an image's layers, disk usage, and a
//! remote Docker engine as a context.
//!
//! Docker and nerdctl print `--format '{{json .}}'` as one object per line with Go-template keys and
//! every value as text (`"MemUsage": "8.3MiB / 7.8GiB"`); Podman prints `--format json` as one array
//! with keys of its own (`"mem_usage"`, `"RawSize"`). Each parser here reads both.

use serde::Serialize;
use serde_json::Value;

use super::cli;
use super::engine::{self, EngineKind, Target};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContainerStats {
    /// As the engine prints it (often the short id): match by prefix.
    pub id: String,
    pub name: String,
    pub cpu_percent: f64,
    pub mem_usage: u64,
    pub mem_limit: u64,
    pub mem_percent: f64,
    pub net_rx: u64,
    pub net_tx: u64,
    pub block_read: u64,
    pub block_write: u64,
    pub pids: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImageLayer {
    pub id: String,
    pub created: String,
    pub created_by: String,
    pub size: u64,
    pub comment: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsageRow {
    /// `images`, `containers`, `volumes` or `buildCache`.
    pub kind: String,
    pub count: u64,
    pub active: u64,
    pub size: u64,
    pub reclaimable: u64,
}

// ---------------------------------------------------------------------------------- checking

/// A container, volume or network name both Docker and Podman take: a letter or digit, then letters,
/// digits, `_`, `.` and `-`.
pub fn check_name(value: &str, what: &str) -> Result<(), String> {
    let valid = value.len() <= 255 && value.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'));
    if valid {
        Ok(())
    } else {
        Err(format!("\"{value}\" is not a {what} name: a letter or digit, then letters, digits, _ . -"))
    }
}

/// A memory limit in whole MB. Six is the least Docker and Podman accept; a terabyte is more than
/// any machine this runs on would give one container.
fn memory_megabytes(mb: f64) -> Result<u64, String> {
    if !mb.is_finite() {
        return Err("the memory limit is not a number".into());
    }
    let whole = mb.round();
    if !(6.0..=1_048_576.0).contains(&whole) {
        return Err(format!("{mb} MB is not a memory limit (6 MB to 1 TB)"));
    }
    Ok(whole as u64)
}

/// A memory limit as the engines take it: `512m`.
pub fn memory_value(mb: f64) -> Result<String, String> {
    Ok(format!("{}m", memory_megabytes(mb)?))
}

/// A CPU limit as the engines take it (`1.5`, `0.25`): more than none, at most 1024.
pub fn cpus_value(cpus: f64) -> Result<String, String> {
    if !cpus.is_finite() || cpus <= 0.0 || cpus > 1024.0 {
        return Err(format!("{cpus} is not a CPU limit (more than 0, at most 1024)"));
    }
    // Hundredths are as fine as the engines' own minimum (0.01); fewer digits read better.
    let text = format!("{:.2}", (cpus * 100.0).round() / 100.0);
    let text = text.trim_end_matches('0').trim_end_matches('.');
    if text == "0" {
        return Err(format!("{cpus} is not a CPU limit (at least 0.01)"));
    }
    Ok(text.to_string())
}

/// A volume or network driver: `local`, `bridge`, or a plugin's `vieux/sshfs:latest`.
fn check_driver(driver: &str) -> Result<(), String> {
    let valid = driver.len() <= 255 && driver.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) && driver.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | '/' | ':'));
    if valid {
        Ok(())
    } else {
        Err(format!("\"{driver}\" is not a driver"))
    }
}

/// ctr has none of what this file does; nerdctl, containerd's Docker-like client, has all of it.
fn not_ctr(target: &Target, what: &str) -> Result<EngineKind, String> {
    match target.engine()? {
        EngineKind::Ctr => Err(format!("ctr has no {what}; install nerdctl for that")),
        engine => Ok(engine),
    }
}

/// `--format` for one JSON object per row: Podman's own word, or the Go template the others read.
fn json_format(engine: EngineKind) -> &'static str {
    if engine == EngineKind::Podman {
        "json"
    } else {
        "{{json .}}"
    }
}

// ----------------------------------------------------------------------------------- reading

/// A field under any of the spellings the engines use, as text.
fn field(value: &Value, names: &[&str]) -> String {
    match names.iter().find_map(|name| value.get(*name)) {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

/// A count printed as a number (Podman) or as digits (Docker).
fn number(value: &Value, names: &[&str]) -> u64 {
    match names.iter().find_map(|name| value.get(*name)) {
        Some(Value::Number(n)) => n.as_u64().unwrap_or(0),
        Some(Value::String(s)) => s.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

/// A size in bytes: an exact count where one is printed (`RawSize`, a number), else the text one
/// (`1.2GB`, `800MB (66%)`) read with its unit.
fn size(value: &Value, exact: &[&str], text: &[&str]) -> u64 {
    if let Some(n) = exact.iter().find_map(|name| value.get(*name)).and_then(Value::as_u64) {
        return n;
    }
    match text.iter().find_map(|name| value.get(*name)) {
        Some(Value::Number(n)) => n.as_u64().unwrap_or(0),
        Some(Value::String(s)) => {
            let s = s.split(" (").next().unwrap_or_default().trim();
            s.parse().ok().or_else(|| engine::bytes_of(s)).unwrap_or(0)
        }
        _ => 0,
    }
}

/// `8.3MiB / 7.8GiB` as both sides in bytes; `--` (an engine with nothing to say) as zero.
fn pair(text: &str) -> (u64, u64) {
    let (left, right) = text.split_once('/').unwrap_or((text, ""));
    (engine::bytes_of(left).unwrap_or(0), engine::bytes_of(right).unwrap_or(0))
}

fn percent(text: &str) -> f64 {
    text.trim().trim_end_matches('%').trim().parse::<f64>().ok().filter(|p| p.is_finite()).unwrap_or(0.0)
}

pub fn parse_stats(out: &str) -> Vec<ContainerStats> {
    cli::json_values(out)
        .iter()
        .filter_map(|value| {
            let id = field(value, &["ID", "id", "Container"]);
            if id.is_empty() {
                return None;
            }
            let (mem_usage, mem_limit) = pair(&field(value, &["MemUsage", "mem_usage"]));
            let (net_rx, net_tx) = pair(&field(value, &["NetIO", "net_io"]));
            let (block_read, block_write) = pair(&field(value, &["BlockIO", "block_io"]));
            Some(ContainerStats {
                id,
                name: field(value, &["Name", "name"]).trim_start_matches('/').to_string(),
                cpu_percent: percent(&field(value, &["CPUPerc", "cpu_percent"])),
                mem_usage,
                mem_limit,
                mem_percent: percent(&field(value, &["MemPerc", "mem_percent"])),
                net_rx,
                net_tx,
                block_read,
                block_write,
                pids: field(value, &["PIDs", "pids"]).parse().ok(),
            })
        })
        .collect()
}

pub fn parse_history(out: &str) -> Vec<ImageLayer> {
    cli::json_values(out)
        .iter()
        .map(|value| {
            let created = match ["CreatedAt", "created", "Created"].iter().find_map(|name| value.get(*name)) {
                Some(Value::Number(n)) => n.as_i64().and_then(|s| chrono::DateTime::from_timestamp(s, 0)).map(|d| d.to_rfc3339()).unwrap_or_default(),
                Some(Value::String(s)) if !s.trim().is_empty() => s.trim().to_string(),
                _ => field(value, &["CreatedSince"]),
            };
            ImageLayer {
                // nerdctl calls a layer's id its snapshot.
                id: field(value, &["ID", "Id", "id", "Snapshot"]).trim_start_matches("sha256:").to_string(),
                created,
                created_by: field(value, &["CreatedBy", "createdBy", "created_by"]),
                size: size(value, &[], &["Size", "size"]),
                comment: field(value, &["Comment", "comment"]),
            }
        })
        .collect()
}

pub fn parse_disk_usage(out: &str) -> Vec<DiskUsageRow> {
    cli::json_values(out)
        .iter()
        .filter_map(|value| {
            let kind = match field(value, &["Type", "type"]).to_lowercase().as_str() {
                "images" => "images",
                "containers" => "containers",
                "local volumes" | "volumes" => "volumes",
                "build cache" => "buildCache",
                _ => return None,
            };
            Some(DiskUsageRow {
                kind: kind.into(),
                count: number(value, &["TotalCount", "Total"]),
                active: number(value, &["Active"]),
                size: size(value, &["RawSize"], &["Size"]),
                reclaimable: size(value, &["RawReclaimable"], &["Reclaimable"]),
            })
        })
        .collect()
}

// ------------------------------------------------------------------------------ command lines

pub fn stats_args(engine: EngineKind, ids: &[String]) -> Result<Vec<String>, String> {
    for id in ids {
        engine::check_ref(id)?;
    }
    let mut args: Vec<String> = vec!["stats".into(), "--no-stream".into(), "--format".into(), json_format(engine).into()];
    args.extend(ids.iter().cloned());
    Ok(args)
}

/// `update` with new limits. Docker refuses a memory limit above the swap limit a container already
/// has — twice its old memory, by default — so a raise alone fails ("Memory limit should be smaller
/// than already set memoryswap limit"), and the swap limit is set with it: to twice the new memory,
/// as `run --memory` sets it. Not to `-1` (unlimited): Docker takes that, but never passes it on to a
/// running container's runtime, and runc then measures the new memory against the old swap and
/// refuses ("memory+swap limit should be >= memory limit", seen on cgroup v2).
pub fn limit_args(id: &str, memory_mb: Option<f64>, cpus: Option<f64>) -> Result<Vec<String>, String> {
    if memory_mb.is_none() && cpus.is_none() {
        return Err("choose a memory or CPU limit to change".into());
    }
    engine::check_ref(id)?;
    let mut args: Vec<String> = vec!["update".into()];
    if let Some(mb) = memory_mb {
        let mb = memory_megabytes(mb)?;
        args.extend(["--memory".into(), format!("{mb}m"), "--memory-swap".into(), format!("{}m", mb * 2)]);
    }
    if let Some(cpus) = cpus {
        args.extend(["--cpus".into(), cpus_value(cpus)?]);
    }
    args.push(id.into());
    Ok(args)
}

pub fn volume_args(engine: EngineKind, name: &str, driver: &str) -> Result<Vec<String>, String> {
    check_name(name, "volume")?;
    let mut args: Vec<String> = vec!["volume".into(), "create".into()];
    let driver = driver.trim();
    if !driver.is_empty() {
        check_driver(driver)?;
        // nerdctl makes local volumes only, and has no `--driver` to say so.
        match engine {
            EngineKind::Nerdctl if driver == "local" => {}
            EngineKind::Nerdctl => return Err(format!("nerdctl makes local volumes only, not {driver}")),
            _ => args.extend(["--driver".into(), driver.into()]),
        }
    }
    args.push(name.into());
    Ok(args)
}

pub fn network_args(name: &str, driver: &str) -> Result<Vec<String>, String> {
    check_name(name, "network")?;
    let mut args: Vec<String> = vec!["network".into(), "create".into()];
    let driver = driver.trim();
    if !driver.is_empty() {
        check_driver(driver)?;
        args.extend(["--driver".into(), driver.into()]);
    }
    args.push(name.into());
    Ok(args)
}

/// `docker context create`. The name follows Docker's rule for one; the address is one of the
/// schemes a Docker endpoint takes, with nothing that would add a field to `--docker`'s
/// comma-separated value (`host=…,skip-tls-verify=true`).
pub fn context_args(name: &str, host: &str, description: &str) -> Result<Vec<String>, String> {
    let name = name.trim();
    let valid_name = name.len() <= 255 && name.chars().next().is_some_and(|c| c.is_ascii_alphanumeric()) && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '+' | '-'));
    if !valid_name {
        return Err(format!("\"{name}\" is not a context name: a letter or digit, then letters, digits, _ . + -"));
    }
    if name == "default" {
        return Err("default is Docker's own context; choose another name".into());
    }
    let host = host.trim();
    // `get`, not an index: a slice through a multi-byte character would panic.
    let scheme = ["ssh://", "tcp://", "unix://", "npipe://"].iter().find(|scheme| host.len() > scheme.len() && host.get(..scheme.len()).is_some_and(|start| start.eq_ignore_ascii_case(scheme)));
    if scheme.is_none() {
        return Err(format!("\"{host}\" is not an engine address: ssh://user@host, tcp://host:2376, unix:///path or npipe:////./pipe/name"));
    }
    if host.contains([',', '"', '\'']) || host.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(format!("\"{host}\" holds a character an engine address cannot"));
    }
    let mut args: Vec<String> = vec!["context".into(), "create".into(), name.into(), "--docker".into(), format!("host={host}")];
    let description = description.trim();
    if !description.is_empty() {
        if description.contains('\0') {
            return Err("the description holds a NUL character".into());
        }
        args.push(format!("--description={description}"));
    }
    Ok(args)
}

/// Runs `args` on the target and insists on success.
async fn run_ok(target: &Target, args: Vec<String>, timeout: std::time::Duration) -> Result<String, String> {
    let output = target.run_owned(args, timeout).await?;
    if output.ok() {
        Ok(output.stdout)
    } else {
        Err(output.complaint())
    }
}

// ----------------------------------------------------------------------------------- running

/// Stats of `ids`, or of every running container when there are none.
pub async fn stats_all(target: &Target, ids: &[String]) -> Result<Vec<ContainerStats>, String> {
    let engine = not_ctr(target, "live stats")?;
    // `--no-stream` still samples for a couple of seconds: the list's own limit is room enough.
    let out = run_ok(target, stats_args(engine, ids)?, engine::LIST_TIMEOUT).await?;
    Ok(parse_stats(&out))
}

/// New memory (MB) and CPU limits for a running container; `None` leaves one as it is.
pub async fn update_limits(target: &Target, id: &str, memory_mb: Option<f64>, cpus: Option<f64>) -> Result<(), String> {
    not_ctr(target, "limits to change")?;
    run_ok(target, limit_args(id.trim(), memory_mb, cpus)?, engine::ACTION_TIMEOUT).await.map(|_| ())
}

pub async fn create_volume(target: &Target, name: &str, driver: &str) -> Result<(), String> {
    let engine = not_ctr(target, "volumes")?;
    run_ok(target, volume_args(engine, name.trim(), driver)?, engine::ACTION_TIMEOUT).await.map(|_| ())
}

pub async fn create_network(target: &Target, name: &str, driver: &str) -> Result<(), String> {
    not_ctr(target, "networks")?;
    run_ok(target, network_args(name.trim(), driver)?, engine::ACTION_TIMEOUT).await.map(|_| ())
}

pub async fn image_history(target: &Target, image: &str) -> Result<Vec<ImageLayer>, String> {
    let engine = not_ctr(target, "image history")?;
    let image = image.trim();
    engine::check_ref(image)?;
    let args: Vec<String> = vec!["image".into(), "history".into(), "--no-trunc".into(), "--format".into(), json_format(engine).into(), image.into()];
    Ok(parse_history(&run_ok(target, args, engine::LIST_TIMEOUT).await?))
}

pub async fn disk_usage(target: &Target) -> Result<Vec<DiskUsageRow>, String> {
    let engine = not_ctr(target, "disk usage summary")?;
    let args: Vec<String> = vec!["system".into(), "df".into(), "--format".into(), json_format(engine).into()];
    // Sizing every image, container and volume takes a while on a full engine.
    Ok(parse_disk_usage(&run_ok(target, args, engine::ACTION_TIMEOUT).await?))
}

/// A remote Docker engine (`ssh://user@host`, `tcp://host:2376`) as a Docker context.
///
/// Docker only: the command takes no runtime, and Podman's equivalent — a connection, `podman system
/// connection add <name> ssh://…` — is a different command this does not run.
pub async fn add_docker_context(name: &str, host: &str, description: &str) -> Result<(), String> {
    let args = context_args(name, host, description)?;
    let docker = Target { runtime: EngineKind::Docker.id().into(), context: None };
    run_ok(&docker, args, engine::ACTION_TIMEOUT).await.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `docker stats --no-stream --format '{{json .}}'` (nerdctl prints the same keys).
    const DOCKER_STATS: &str = r#"{"BlockIO":"1.2MB / 0B","CPUPerc":"0.15%","Container":"4f2c1a9b8d7e","ID":"4f2c1a9b8d7e","MemPerc":"0.10%","MemUsage":"8.3MiB / 7.8GiB","Name":"cf-test-web","NetIO":"1.3kB / 0B","PIDs":"11"}
{"BlockIO":"--","CPUPerc":"--","Container":"9a8b","ID":"9a8b","MemPerc":"--","MemUsage":"-- / --","Name":"/stopped","NetIO":"--","PIDs":"--"}"#;

    /// `podman stats --no-stream --format json`.
    const PODMAN_STATS: &str = r#"[
 {
  "id": "e8b2b5a2d6e4",
  "name": "db",
  "cpu_time": "26.43ms",
  "cpu_percent": "12.5%",
  "avg_cpu": "0.08%",
  "mem_usage": "1.585MB / 4.087GB",
  "mem_percent": "0.04%",
  "net_io": "1.142kB / 1.076kB",
  "block_io": "0B / 4.096kB",
  "pids": "3"
 }
]"#;

    #[test]
    fn stats_in_both_dialects() {
        let docker = parse_stats(DOCKER_STATS);
        assert_eq!(
            docker[0],
            ContainerStats {
                id: "4f2c1a9b8d7e".into(),
                name: "cf-test-web".into(),
                cpu_percent: 0.15,
                mem_usage: 8_703_181,
                mem_limit: 8_375_186_227,
                mem_percent: 0.10,
                net_rx: 1_300,
                net_tx: 0,
                block_read: 1_200_000,
                block_write: 0,
                pids: Some(11),
            }
        );
        assert_eq!((docker[1].name.as_str(), docker[1].cpu_percent, docker[1].mem_limit, docker[1].pids), ("stopped", 0.0, 0, None), "`--` reads as nothing");
        let podman = parse_stats(PODMAN_STATS);
        assert_eq!(podman.len(), 1);
        assert_eq!(podman[0].id, "e8b2b5a2d6e4");
        assert_eq!(podman[0].cpu_percent, 12.5);
        assert_eq!((podman[0].mem_usage, podman[0].mem_limit), (1_585_000, 4_087_000_000));
        assert_eq!((podman[0].net_rx, podman[0].net_tx, podman[0].block_read, podman[0].block_write), (1_142, 1_076, 0, 4_096));
        assert_eq!(podman[0].pids, Some(3));
        assert!(parse_stats("").is_empty() && parse_stats("[]").is_empty());
    }

    #[test]
    fn stats_command_lines() {
        assert_eq!(stats_args(EngineKind::Docker, &[]).unwrap(), vec!["stats", "--no-stream", "--format", "{{json .}}"]);
        assert_eq!(stats_args(EngineKind::Podman, &["a".into(), "b".into()]).unwrap(), vec!["stats", "--no-stream", "--format", "json", "a", "b"]);
        assert!(stats_args(EngineKind::Docker, &["-a".into()]).is_err());
    }

    #[test]
    fn limits_raise_swap_with_memory() {
        assert_eq!(limit_args("web", Some(512.0), None).unwrap(), vec!["update", "--memory", "512m", "--memory-swap", "1024m", "web"]);
        assert_eq!(limit_args("web", None, Some(2.0)).unwrap(), vec!["update", "--cpus", "2", "web"]);
        assert_eq!(limit_args("web", Some(6.0), Some(0.333)).unwrap(), vec!["update", "--memory", "6m", "--memory-swap", "12m", "--cpus", "0.33", "web"]);
        assert!(limit_args("web", None, None).is_err());
        assert!(limit_args("--all", Some(64.0), None).is_err());
        for mb in [0.0, 5.4, -1.0, f64::INFINITY, 2_000_000.0] {
            assert!(limit_args("web", Some(mb), None).is_err(), "{mb} MB is refused");
        }
        for cpus in [0.0, -1.0, 0.004, 1024.5, f64::NAN] {
            assert!(limit_args("web", None, Some(cpus)).is_err(), "{cpus} CPUs are refused");
        }
        assert_eq!(cpus_value(1024.0).unwrap(), "1024");
        assert_eq!(cpus_value(0.5).unwrap(), "0.5");
        assert_eq!(cpus_value(0.01).unwrap(), "0.01");
    }

    #[test]
    fn volumes_and_networks_by_name_and_driver() {
        assert_eq!(volume_args(EngineKind::Docker, "cf-data", "").unwrap(), vec!["volume", "create", "cf-data"]);
        assert_eq!(volume_args(EngineKind::Podman, "cf-data", "local").unwrap(), vec!["volume", "create", "--driver", "local", "cf-data"]);
        assert_eq!(volume_args(EngineKind::Docker, "cf.data_2", "vieux/sshfs:latest").unwrap(), vec!["volume", "create", "--driver", "vieux/sshfs:latest", "cf.data_2"]);
        assert_eq!(volume_args(EngineKind::Nerdctl, "cf-data", "local").unwrap(), vec!["volume", "create", "cf-data"]);
        assert!(volume_args(EngineKind::Nerdctl, "cf-data", "nfs").is_err());
        assert_eq!(network_args("cf-net", "bridge").unwrap(), vec!["network", "create", "--driver", "bridge", "cf-net"]);
        assert_eq!(network_args("cf-net", " ").unwrap(), vec!["network", "create", "cf-net"]);
        for bad in ["", "-x", "_x", "a b", "a/b", "ñ", "a:b"] {
            assert!(volume_args(EngineKind::Docker, bad, "").is_err(), "volume {bad:?} is refused");
            assert!(network_args(bad, "").is_err(), "network {bad:?} is refused");
        }
        assert!(network_args("cf-net", "--internal").is_err());
        assert!(volume_args(EngineKind::Docker, "cf-data", "a b").is_err());
    }

    #[test]
    fn layers_in_both_dialects() {
        let docker = parse_history(
            r#"{"Comment":"buildkit.dockerfile.v0","CreatedAt":"2026-08-14T22:06:16+02:00","CreatedBy":"CMD [\"nginx\" \"-g\" \"daemon off;\"]","CreatedSince":"7 weeks ago","ID":"<missing>","Size":"0B"}
{"Comment":"","CreatedAt":"2026-08-14T20:00:00+02:00","CreatedBy":"/bin/sh -c #(nop) ADD file:abc in / ","CreatedSince":"7 weeks ago","ID":"sha256:9234e8fb04c47cfe0f49931e4ac7eb76fa904e33b7f8576aec0501c085f02516","Size":"7.8MB"}"#,
        );
        assert_eq!(docker[0], ImageLayer { id: "<missing>".into(), created: "2026-08-14T22:06:16+02:00".into(), created_by: "CMD [\"nginx\" \"-g\" \"daemon off;\"]".into(), size: 0, comment: "buildkit.dockerfile.v0".into() });
        assert_eq!(docker[1].id, "9234e8fb04c47cfe0f49931e4ac7eb76fa904e33b7f8576aec0501c085f02516");
        assert_eq!(docker[1].size, 7_800_000);
        let podman = parse_history(r#"[{"id":"sha256:e2a1","created":"2026-08-14T20:00:00.123Z","CreatedBy":"/bin/sh -c apk add curl","size":5242880,"comment":"FROM alpine"},{"id":"<missing>","created":"2026-08-01T00:00:00Z","size":0}]"#);
        assert_eq!(podman[0], ImageLayer { id: "e2a1".into(), created: "2026-08-14T20:00:00.123Z".into(), created_by: "/bin/sh -c apk add curl".into(), size: 5_242_880, comment: "FROM alpine".into() });
        assert_eq!((podman[1].created_by.as_str(), podman[1].comment.as_str()), ("", ""));
        let nerdctl = parse_history(r#"{"Snapshot":"sha256:abc","CreatedAt":"","CreatedSince":"2 weeks ago","CreatedBy":"RUN x","Size":"12.5 kB","Comment":""}"#);
        assert_eq!((nerdctl[0].id.as_str(), nerdctl[0].created.as_str(), nerdctl[0].size), ("abc", "2 weeks ago", 12_500));
    }

    #[test]
    fn disk_usage_in_both_dialects() {
        let docker = parse_disk_usage(
            r#"{"Active":"2","Reclaimable":"1.051GB (61%)","Size":"1.701GB","TotalCount":"12","Type":"Images"}
{"Active":"2","Reclaimable":"0B (0%)","Size":"1.093kB","TotalCount":"2","Type":"Containers"}
{"Active":"1","Reclaimable":"0B (0%)","Size":"41.1MB","TotalCount":"1","Type":"Local Volumes"}
{"Active":"0","Reclaimable":"812MB","Size":"812MB","TotalCount":"30","Type":"Build Cache"}"#,
        );
        assert_eq!(docker.iter().map(|r| r.kind.as_str()).collect::<Vec<_>>(), vec!["images", "containers", "volumes", "buildCache"]);
        assert_eq!(docker[0], DiskUsageRow { kind: "images".into(), count: 12, active: 2, size: 1_701_000_000, reclaimable: 1_051_000_000 });
        assert_eq!((docker[3].size, docker[3].reclaimable), (812_000_000, 812_000_000));
        let podman = parse_disk_usage(
            r#"[{"Type":"Images","Total":3,"Active":1,"RawSize":338657853,"RawReclaimable":121045318,"TotalCount":3,"Size":"338.7MB","Reclaimable":"121MB (36%)"},
{"Type":"Containers","Total":1,"Active":1,"RawSize":0,"RawReclaimable":0,"TotalCount":1,"Size":"0B","Reclaimable":"0B (0%)"},
{"Type":"Local Volumes","Total":0,"Active":0,"RawSize":0,"RawReclaimable":0,"TotalCount":0,"Size":"0B","Reclaimable":"0B (0%)"}]"#,
        );
        assert_eq!(podman[0], DiskUsageRow { kind: "images".into(), count: 3, active: 1, size: 338_657_853, reclaimable: 121_045_318 }, "the exact sizes win over the rounded text");
        assert_eq!(podman[2].kind, "volumes");
        assert!(parse_disk_usage(r#"{"Type":"Something new","TotalCount":"1"}"#).is_empty());
    }

    #[test]
    fn remote_engines_as_contexts() {
        assert_eq!(context_args("build-box", "ssh://deploy@build.example.com", "").unwrap(), vec!["context", "create", "build-box", "--docker", "host=ssh://deploy@build.example.com"]);
        assert_eq!(
            context_args(" lab.2+x ", "tcp://10.0.0.5:2376", " the lab ").unwrap(),
            vec!["context", "create", "lab.2+x", "--docker", "host=tcp://10.0.0.5:2376", "--description=the lab"]
        );
        assert!(context_args("pipe", "npipe:////./pipe/docker_engine", "").is_ok() && context_args("sock", "unix:///var/run/docker.sock", "").is_ok());
        for (name, host) in [
            ("", "ssh://a@b"),
            ("-x", "ssh://a@b"),
            ("a b", "ssh://a@b"),
            ("default", "ssh://a@b"),
            ("ok", "http://b"),
            ("ok", "ssh://"),
            ("ok", "b.example.com"),
            ("ok", "tcp://b:2376,skip-tls-verify=true"),
            ("ok", "ssh://a@b -oProxyCommand=x"),
            ("ok", "ssh://\"a\"@b"),
            ("ok", "aññññ://x"),
        ] {
            assert!(context_args(name, host, "").is_err(), "{name:?} at {host:?} is refused");
        }
    }

    #[test]
    fn names_as_the_engines_take_them() {
        assert!(check_name("cf-test-1", "volume").is_ok() && check_name("a", "volume").is_ok() && check_name("A.b_c-1", "container").is_ok());
        assert!(check_name(&"a".repeat(256), "network").is_err());
        assert_eq!(memory_value(1023.5).unwrap(), "1024m");
        assert!(memory_value(f64::NAN).is_err());
    }

    /// Against the Docker on this computer: `CODEFLOW_LIVE_CONTAINERS=1 cargo test --lib
    /// containers::manage::tests::live_docker -- --ignored --nocapture`. Makes, and removes, only
    /// `cf-test-*` objects; pulls `alpine:3` and `registry.k8s.io/pause:3.10` (no shell at all).
    #[tokio::test]
    #[ignore]
    async fn live_docker() {
        use crate::containers::{files, run};
        if std::env::var("CODEFLOW_LIVE_CONTAINERS").is_err() {
            return;
        }
        let target = Target { runtime: "docker".into(), context: None };
        let clean = || async {
            let _ = target.run(&["rm", "-f", "cf-test-run", "cf-test-shell-less"], engine::ACTION_TIMEOUT).await;
            let _ = target.run(&["volume", "rm", "cf-test-vol"], engine::ACTION_TIMEOUT).await;
            let _ = target.run(&["network", "rm", "cf-test-net"], engine::ACTION_TIMEOUT).await;
        };
        clean().await;
        create_volume(&target, "cf-test-vol", "local").await.unwrap();
        create_network(&target, "cf-test-net", "bridge").await.unwrap();
        let spec = run::RunSpec {
            image: "alpine:3".into(),
            name: "cf-test-run".into(),
            ports: vec![run::RunPort { host: "127.0.0.1:18089".into(), container: "80".into(), protocol: "tcp".into() }],
            env: vec![run::RunEnv { key: "GREETING".into(), value: "hello there".into() }],
            volumes: vec![run::RunVolume { kind: "volume".into(), source: "cf-test-vol".into(), target: "/data".into(), read_only: false }],
            restart: "unless-stopped".into(),
            pull: "always".into(),
            command: r#"sh -c 'echo "$GREETING" > greeting && ln -s /etc etc-link && ln -s greeting note-link && mkdir -p "a|b dir" .hidden && exec sleep 600'"#.into(),
            workdir: "/data".into(),
            network: "cf-test-net".into(),
            memory_mb: Some(300.0),
            cpus: Some(0.5),
            ..Default::default()
        };
        let id = run::run(&target, &spec).await.expect("run");
        println!("run: {id}");
        let again = run::run(&target, &spec).await.unwrap_err();
        println!("run again: {again}");
        assert!(again.contains("already in use"), "{again}");
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;

        let stats = stats_all(&target, &[]).await.unwrap();
        let mine = stats.iter().find(|s| id.starts_with(&s.id)).expect("its stats");
        println!("stats: {mine:?}");
        assert_eq!(mine.mem_limit, 300 * 1024 * 1024);
        assert_eq!(stats_all(&target, std::slice::from_ref(&id)).await.unwrap().len(), 1);
        let naive = target.run(&["update", "--memory", "1024m", id.as_str()], engine::ACTION_TIMEOUT).await;
        println!("update without swap: {naive:?}");
        update_limits(&target, &id, Some(1024.0), Some(1.0)).await.unwrap();
        let doc: Value = serde_json::from_str(&engine::inspect(&target, "container", &id).await.unwrap()).unwrap();
        assert_eq!(doc.pointer("/HostConfig/Memory").and_then(Value::as_u64), Some(1024 * 1024 * 1024));
        assert_eq!(doc.pointer("/HostConfig/MemorySwap").and_then(Value::as_u64), Some(2048 * 1024 * 1024));
        assert_eq!(doc.pointer("/HostConfig/NanoCpus").and_then(Value::as_u64), Some(1_000_000_000));
        update_limits(&target, &id, Some(64.0), None).await.unwrap();

        let listing = files::browse(&target, &id, "/data/../data/").await.unwrap();
        println!("listing: {listing:#?}");
        let entry = |name: &str| listing.iter().find(|e| e.name == name).cloned().unwrap_or_else(|| panic!("{name} listed"));
        assert_eq!(entry("greeting").size, Some(12));
        assert!(entry("etc-link").dir && entry("etc-link").link);
        assert!(entry("note-link").link && !entry("note-link").dir && entry("note-link").size == Some(12));
        assert!(entry("a|b dir").dir && entry(".hidden").dir);
        assert!(files::browse(&target, &id, "/").await.unwrap().iter().any(|e| e.name == "etc" && e.dir));
        assert!(files::browse(&target, &id, "/etc/hostname").await.unwrap_err().contains("not a folder"));
        assert!(files::browse(&target, &id, "/nowhere").await.unwrap_err().contains("not a folder"));

        let host = std::env::temp_dir().join(format!("cf-test-files-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&host).unwrap();
        let upload = host.join("cf-test-upload.txt");
        std::fs::write(&upload, "from the host").unwrap();
        files::upload(&target, &id, "/data", &[upload.to_string_lossy().into_owned()]).await.unwrap();
        assert!(files::browse(&target, &id, "/data").await.unwrap().iter().any(|e| e.name == "cf-test-upload.txt" && e.size == Some(13)));
        let downloads = host.join("downloads");
        std::fs::create_dir_all(&downloads).unwrap();
        let dir = downloads.to_string_lossy().into_owned();
        let first = files::download(&target, &id, "/data/greeting", &dir).await.unwrap();
        let second = files::download(&target, &id, "/data/greeting", &dir).await.unwrap();
        println!("downloads: {first} then {second}");
        assert!(second.ends_with("greeting (2)"));
        assert_eq!(std::fs::read_to_string(&second).unwrap(), "hello there\n");
        let folder = files::download(&target, &id, "/data/a|b dir", &dir).await.unwrap();
        assert!(std::path::Path::new(&folder).is_dir());
        files::delete(&target, &id, "/data/greeting").await.unwrap();
        assert!(!files::browse(&target, &id, "/data").await.unwrap().iter().any(|e| e.name == "greeting"));
        assert!(files::delete(&target, &id, "/..").await.is_err());

        let shell_less = run::RunSpec { image: "registry.k8s.io/pause:3.10".into(), name: "cf-test-shell-less".into(), ..Default::default() };
        let pause = run::run(&target, &shell_less).await.expect("run pause");
        let no_shell = files::browse(&target, &pause, "/").await.unwrap_err();
        println!("no shell: {no_shell}");
        assert!(no_shell.contains("no shell"));
        assert!(std::path::Path::new(&files::download(&target, &pause, "/pause", &dir).await.unwrap()).is_file(), "cp needs no shell");

        let layers = image_history(&target, "alpine:3").await.unwrap();
        println!("layers: {layers:#?}");
        assert!(layers.iter().any(|l| l.size > 1_000_000));
        let usage = disk_usage(&target).await.unwrap();
        println!("disk usage: {usage:#?}");
        assert!(usage.iter().any(|r| r.kind == "images" && r.count >= 2 && r.size > 0));
        assert!(usage.iter().any(|r| r.kind == "volumes" && r.active >= 1));

        let _ = std::fs::remove_dir_all(&host);
        clean().await;
    }
}
