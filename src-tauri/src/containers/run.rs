//! «Ejecutar contenedor»: a `docker run -d` built from a form — ports, variables, volumes, restart
//! policy, limits — for any of the Docker-compatible engines.
//!
//! The form's rows arrive as typed: an empty row (the blank one a list keeps at its end) is skipped,
//! a half-filled one is refused with what it lacks. Everything is one argv entry per value, never a
//! shell line, so a value can hold any character but the NUL no argv can carry.

use std::net::{Ipv4Addr, Ipv6Addr};
use std::path::Path;

use serde::Deserialize;

use super::cli;
use super::engine::{self, EngineKind, Target};
use super::manage::{check_name, cpus_value, memory_value};

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RunPort {
    /// `8080`, `127.0.0.1:8080`, or empty for a port the engine picks.
    pub host: String,
    pub container: String,
    /// `tcp` or `udp`.
    pub protocol: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RunVolume {
    /// `volume` (a named volume) or `bind` (a folder of this computer).
    pub kind: String,
    pub source: String,
    pub target: String,
    pub read_only: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RunEnv {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RunSpec {
    pub image: String,
    pub name: String,
    pub ports: Vec<RunPort>,
    pub publish_all: bool,
    pub env: Vec<RunEnv>,
    pub volumes: Vec<RunVolume>,
    /// `no`, `always`, `unless-stopped` or `on-failure`.
    pub restart: String,
    pub auto_remove: bool,
    /// `missing` or `always`.
    pub pull: String,
    /// Replaces the image's command, split the way a shell would; empty keeps it.
    pub command: String,
    pub workdir: String,
    /// A network to join; empty is the engine's default.
    pub network: String,
    pub memory_mb: Option<f64>,
    pub cpus: Option<f64>,
    /// `--read-only`: the container's own filesystem cannot be written; volumes and tmpfs still can.
    pub read_only: bool,
    /// `--user`: `1000`, `1000:1000`, `app` or `app:staff`; empty keeps the image's.
    pub user: String,
    /// `--cap-drop` / `--cap-add`: `NET_ADMIN`, `CAP_NET_ADMIN` or `ALL`.
    pub cap_drop: Vec<String>,
    pub cap_add: Vec<String>,
    /// `--security-opt no-new-privileges`: no setuid binary can raise what a process may do.
    pub no_new_privileges: bool,
    /// `--security-opt seccomp=…`: empty is the engine's default profile, `unconfined` none, or the
    /// full path of a profile on this computer (the CLI reads it and sends its contents).
    pub seccomp: String,
    /// `--tmpfs /run` or `--tmpfs /tmp:size=64m,mode=1777`, one per row.
    pub tmpfs: Vec<String>,
    pub pids_limit: Option<f64>,
    pub shm_size_mb: Option<f64>,
    pub health: RunHealth,
}

/// A container's healthcheck, replacing the image's (`HEALTHCHECK` in its Dockerfile).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RunHealth {
    /// Run by the container's shell (`CMD-SHELL`); empty keeps the image's check.
    pub command: String,
    pub interval_s: Option<f64>,
    pub timeout_s: Option<f64>,
    pub start_period_s: Option<f64>,
    pub retries: Option<f64>,
    /// `--no-healthcheck`: turns the image's own check off. Wins over a command.
    pub disabled: bool,
}

/// A Linux capability as the engines take it, upper case and without its `CAP_` (both spellings are
/// read by every engine; one is shown). `ALL` is every one.
pub fn capability(raw: &str) -> Result<String, String> {
    let upper = raw.trim().to_ascii_uppercase();
    let name = upper.strip_prefix("CAP_").unwrap_or(&upper);
    let valid = !name.is_empty() && name.len() <= 32 && name.chars().next().is_some_and(|c| c.is_ascii_uppercase()) && name.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
    if valid {
        Ok(name.to_string())
    } else {
        Err(format!("{raw} is not a Linux capability (NET_ADMIN, SYS_TIME, ALL…)"))
    }
}

/// `--user`'s value: a name or number, and optionally `:` a group's.
fn check_user(user: &str) -> Result<(), String> {
    let part = |p: &str| p.chars().next().is_some_and(|c| c.is_ascii_alphanumeric() || c == '_') && p.len() <= 64 && p.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'));
    let valid = match user.split_once(':') {
        Some((who, group)) => part(who) && part(group),
        None => part(user),
    };
    if valid {
        Ok(())
    } else {
        Err(format!("{user} is not a user (1000, 1000:1000, app or app:staff)"))
    }
}

/// One `--tmpfs`, or `None` for an empty row: a path in the container and its mount options.
fn tmpfs_arg(raw: &str) -> Result<Option<String>, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    let (path, options) = raw.split_once(':').unwrap_or((raw, ""));
    if !path.starts_with('/') || path.contains(|c: char| c.is_whitespace() || c.is_control()) {
        return Err(format!("{path} is not a path inside the container (it starts with /)"));
    }
    if raw.contains(':') && (options.is_empty() || !options.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '=' | ',' | '.' | '_' | '-'))) {
        return Err(format!("{options} are not tmpfs options (size=64m,mode=1777)"));
    }
    Ok(Some(raw.to_string()))
}

/// `--security-opt seccomp=…`, or `None` for the engine's default profile.
fn seccomp_opt(raw: &str) -> Result<Option<String>, String> {
    let raw = raw.trim();
    match raw {
        "" | "default" => Ok(None),
        "unconfined" => Ok(Some("seccomp=unconfined".into())),
        path => {
            if !Path::new(path).is_absolute() || path.contains('\0') {
                return Err(format!("{path} is not a full path to a seccomp profile"));
            }
            if !Path::new(path).is_file() {
                return Err(format!("{path} is not a file on this computer"));
            }
            Ok(Some(format!("seccomp={path}")))
        }
    }
}

/// A count of seconds as the engines take a duration: `30s`, `1.5s`.
fn seconds(value: f64, what: &str) -> Result<String, String> {
    if !value.is_finite() || value <= 0.0 || value > 86_400.0 {
        return Err(format!("{value} is not a {what} in seconds (more than 0, at most a day)"));
    }
    let text = format!("{:.3}", value);
    Ok(format!("{}s", text.trim_end_matches('0').trim_end_matches('.')))
}

/// A whole number from a form's number field, within `range`.
fn whole(value: f64, what: &str, range: std::ops::RangeInclusive<f64>) -> Result<u64, String> {
    if !value.is_finite() || value.fract() != 0.0 || !range.contains(&value) {
        return Err(format!("{value} is not a {what} ({} to {})", range.start(), range.end()));
    }
    Ok(value as u64)
}

/// The healthcheck's flags, in the order `docker run --help` lists them.
fn health_args(health: &RunHealth) -> Result<Vec<String>, String> {
    if health.disabled {
        return Ok(vec!["--no-healthcheck".into()]);
    }
    let command = health.command.trim();
    let mut args = Vec::new();
    if !command.is_empty() {
        if command.contains('\0') {
            return Err("the healthcheck holds a NUL character".into());
        }
        // Joined with `=`: a check that starts with `-` stays the flag's value.
        args.push(format!("--health-cmd={command}"));
    }
    if let Some(s) = health.interval_s {
        args.push(format!("--health-interval={}", seconds(s, "healthcheck interval")?));
    }
    if let Some(s) = health.timeout_s {
        args.push(format!("--health-timeout={}", seconds(s, "healthcheck timeout")?));
    }
    if let Some(s) = health.start_period_s {
        args.push(format!("--health-start-period={}", seconds(s, "start period")?));
    }
    if let Some(n) = health.retries {
        args.push(format!("--health-retries={}", whole(n, "number of retries", 1.0..=100.0)?));
    }
    Ok(args)
}

/// `80` or `8000-8010`: each port 1 to 65535, a range low to high.
fn check_ports(text: &str) -> Result<(), String> {
    let port = |p: &str| -> Option<u32> {
        // Digits only: Rust's own parser would take `+80`, which no engine does.
        if p.is_empty() || p.len() > 5 || !p.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        p.parse().ok().filter(|n| (1..=65_535).contains(n))
    };
    let valid = match text.split_once('-') {
        Some((low, high)) => matches!((port(low), port(high)), (Some(low), Some(high)) if low <= high),
        None => port(text).is_some(),
    };
    if valid {
        Ok(())
    } else {
        Err(format!("{text} is not a port (1 to 65535)"))
    }
}

/// The host side of a `-p`, with its trailing colon: `8080:`, `127.0.0.1:8080:`, `[::1]:8080:`, or
/// `127.0.0.1::` for an address with a port the engine picks.
fn host_side(host: &str) -> Result<String, String> {
    if host.is_empty() {
        return Ok(String::new());
    }
    if host.chars().all(|c| c.is_ascii_digit() || c == '-') {
        check_ports(host)?;
        return Ok(format!("{host}:"));
    }
    let (address, port) = match host.strip_prefix('[') {
        Some(rest) => {
            let (address, after) = rest.split_once(']').ok_or_else(|| format!("{host} is missing its closing ]"))?;
            address.parse::<Ipv6Addr>().map_err(|_| format!("{address} is not an IPv6 address"))?;
            let port = match after {
                "" => "",
                _ => after.strip_prefix(':').ok_or_else(|| format!("{host} is not an address and port"))?,
            };
            (format!("[{address}]"), port)
        }
        None => {
            let (address, port) = host.split_once(':').unwrap_or((host, ""));
            if port.contains(':') {
                return Err(format!("{host}: write an IPv6 address in brackets, [::1]:8080"));
            }
            // An engine publishes on an address, never a name: `localhost` would be refused there.
            address.parse::<Ipv4Addr>().map_err(|_| format!("{address} is not an IP address (this computer alone is 127.0.0.1)"))?;
            (address.to_string(), port)
        }
    };
    if !port.is_empty() {
        check_ports(port)?;
    }
    Ok(format!("{address}:{port}:"))
}

/// One `-p`, or `None` for an empty row.
fn port_arg(port: &RunPort) -> Result<Option<String>, String> {
    let (host, container) = (port.host.trim(), port.container.trim());
    if host.is_empty() && container.is_empty() {
        return Ok(None);
    }
    if container.is_empty() {
        return Err(format!("the port {host} needs the container's port it leads to"));
    }
    check_ports(container)?;
    let protocol = match port.protocol.trim().to_lowercase().as_str() {
        "" | "tcp" => "",
        "udp" => "/udp",
        "sctp" => "/sctp",
        other => return Err(format!("{other} is not a protocol (tcp or udp)")),
    };
    Ok(Some(format!("{}{container}{protocol}", host_side(host)?)))
}

/// One `-e KEY=VALUE`, or `None` for an empty row. A name is a letter or `_`, then letters, digits,
/// `_`, `.` or `-` — the dots and dashes are Spring's and Java's (`spring.profiles.active`).
fn env_arg(env: &RunEnv) -> Result<Option<String>, String> {
    let key = env.key.trim();
    if key.is_empty() {
        return if env.value.is_empty() { Ok(None) } else { Err(format!("the value \"{}\" needs a variable name", env.value)) };
    }
    let valid = key.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && key.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'));
    if !valid {
        return Err(format!("{key} is not a variable name: a letter or _, then letters, digits, _ . -"));
    }
    if env.value.contains('\0') {
        return Err(format!("the value of {key} holds a NUL character"));
    }
    Ok(Some(format!("{key}={}", env.value)))
}

/// A Windows drive letter's colon is the one `-v` reads past; any other splits the mount.
fn stray_colon(path: &str) -> bool {
    let rest = match path.as_bytes() {
        [drive, b':', ..] if cfg!(windows) && drive.is_ascii_alphabetic() => &path[2..],
        _ => path,
    };
    rest.contains(':')
}

/// One `-v source:target[:ro]`, or `None` for an empty row. A named volume left without a name is an
/// anonymous one (`-v /data`).
fn volume_arg(volume: &RunVolume) -> Result<Option<String>, String> {
    let (source, target) = (volume.source.trim(), volume.target.trim());
    if source.is_empty() && target.is_empty() {
        return Ok(None);
    }
    if target.is_empty() {
        return Err(format!("{source} needs the path inside the container to mount it at"));
    }
    if !target.starts_with('/') || target.contains(':') || target.contains('\0') {
        return Err(format!("{target} is not a path inside the container (it starts with /)"));
    }
    let kind = match volume.kind.trim() {
        "" if source.starts_with('/') || Path::new(source).is_absolute() => "bind",
        "" => "volume",
        kind => kind,
    };
    let mount = match kind {
        "bind" => {
            if source.is_empty() {
                return Err(format!("choose the folder of this computer to mount at {target}"));
            }
            // Relative to what? The app's own folder is nobody's answer, and `~` is a shell's.
            if !Path::new(source).is_absolute() {
                return Err(format!("{source} is not a full path: choose the folder of this computer"));
            }
            if stray_colon(source) || source.contains('\0') {
                return Err(format!("{source} holds a ':', which a mount cannot take"));
            }
            format!("{source}:{target}")
        }
        "volume" if source.is_empty() => target.to_string(),
        "volume" => {
            check_name(source, "volume")?;
            format!("{source}:{target}")
        }
        other => return Err(format!("{other} is not a kind of mount (volume or bind)")),
    };
    Ok(Some(if volume.read_only { format!("{mount}:ro") } else { mount }))
}

/// `--restart`'s value, or `None` for the engine's own default (`no`).
fn restart_policy(policy: &str) -> Result<Option<String>, String> {
    let policy = policy.trim();
    match policy {
        "" | "no" => Ok(None),
        "always" | "unless-stopped" | "on-failure" => Ok(Some(policy.to_string())),
        _ => match policy.strip_prefix("on-failure:") {
            Some(retries) if !retries.is_empty() && retries.len() <= 6 && retries.chars().all(|c| c.is_ascii_digit()) => Ok(Some(policy.to_string())),
            _ => Err(format!("{policy} is not a restart policy (no, always, unless-stopped, on-failure)")),
        },
    }
}

/// A command line split into words the way a POSIX shell splits it: blanks separate, `'…'` keeps
/// everything, `"…"` keeps everything but `\"`, `\\`, `\$` and `` \` ``, and a backslash outside
/// quotes keeps the character after it (a backslash-newline joins two lines). Nothing is expanded
/// or interpreted — `$HOME`, `*`, `~`, `#`, `|` and `;` reach the container as written.
pub fn split_command(line: &str) -> Result<Vec<String>, String> {
    if line.contains('\0') {
        return Err("the command holds a NUL character".into());
    }
    let mut words = Vec::new();
    let mut word = String::new();
    // `''` is a word, an empty one: being inside one is not the same as having characters.
    let mut in_word = false;
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        match c {
            ' ' | '\t' | '\n' | '\r' => {
                if in_word {
                    words.push(std::mem::take(&mut word));
                    in_word = false;
                }
            }
            '\'' => {
                in_word = true;
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some(c) => word.push(c),
                        None => return Err("a ' in the command is never closed".into()),
                    }
                }
            }
            '"' => {
                in_word = true;
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some('\\') => match chars.next() {
                            Some(c @ ('"' | '\\' | '$' | '`')) => word.push(c),
                            Some('\n') => {}
                            Some(c) => {
                                word.push('\\');
                                word.push(c);
                            }
                            None => return Err("a \" in the command is never closed".into()),
                        },
                        Some(c) => word.push(c),
                        None => return Err("a \" in the command is never closed".into()),
                    }
                }
            }
            '\\' => match chars.next() {
                Some('\n') => {}
                Some(c) => {
                    in_word = true;
                    word.push(c);
                }
                None => return Err("the command ends in a lone \\".into()),
            },
            c => {
                in_word = true;
                word.push(c);
            }
        }
    }
    if in_word {
        words.push(word);
    }
    Ok(words)
}

/// The arguments after the program (and its global flags) that run `spec` detached.
pub fn run_args(engine: EngineKind, spec: &RunSpec) -> Result<Vec<String>, String> {
    if engine == EngineKind::Ctr {
        return Err("ctr cannot run a container from a form; install nerdctl for that".into());
    }
    let image = spec.image.trim();
    if image.is_empty() {
        return Err("choose the image to run".into());
    }
    engine::check_ref(image)?;
    let mut args: Vec<String> = vec!["run".into(), "-d".into()];
    let name = spec.name.trim();
    if !name.is_empty() {
        check_name(name, "container")?;
        args.extend(["--name".into(), name.into()]);
    }
    for port in &spec.ports {
        if let Some(port) = port_arg(port)? {
            args.extend(["-p".into(), port]);
        }
    }
    if spec.publish_all {
        args.push("-P".into());
    }
    for env in &spec.env {
        if let Some(env) = env_arg(env)? {
            args.extend(["-e".into(), env]);
        }
    }
    for volume in &spec.volumes {
        if let Some(volume) = volume_arg(volume)? {
            args.extend(["-v".into(), volume]);
        }
    }
    // The engines refuse `--rm` with a restart policy: a container that removes itself when it
    // stops cannot also be restarted. Removing wins, as the form shows it.
    if spec.auto_remove {
        args.push("--rm".into());
    } else if let Some(policy) = restart_policy(&spec.restart)? {
        args.extend(["--restart".into(), policy]);
    }
    match spec.pull.trim() {
        "" | "missing" => {}
        // Joined with `=`, the one spelling every engine reads as the flag's value: a CLI that lets
        // `--pull` stand alone would read a separate `always` as the image.
        policy @ ("always" | "never") => args.push(format!("--pull={policy}")),
        other => return Err(format!("{other} is not a pull policy (missing or always)")),
    }
    let workdir = spec.workdir.trim();
    if !workdir.is_empty() {
        if !workdir.starts_with('/') || workdir.contains('\0') {
            return Err(format!("{workdir} is not a folder inside the container (it starts with /)"));
        }
        args.extend(["-w".into(), workdir.into()]);
    }
    let network = spec.network.trim();
    if !network.is_empty() {
        engine::check_ref(network)?;
        args.extend(["--network".into(), network.into()]);
    }
    if let Some(mb) = spec.memory_mb {
        args.extend(["--memory".into(), memory_value(mb)?]);
    }
    if let Some(cpus) = spec.cpus {
        args.extend(["--cpus".into(), cpus_value(cpus)?]);
    }
    if let Some(pids) = spec.pids_limit {
        args.extend(["--pids-limit".into(), whole(pids, "process limit", 1.0..=4_194_304.0)?.to_string()]);
    }
    if let Some(mb) = spec.shm_size_mb {
        args.extend(["--shm-size".into(), memory_value(mb)?]);
    }
    let user = spec.user.trim();
    if !user.is_empty() {
        check_user(user)?;
        args.extend(["--user".into(), user.into()]);
    }
    if spec.read_only {
        args.push("--read-only".into());
    }
    for raw in &spec.tmpfs {
        if let Some(tmpfs) = tmpfs_arg(raw)? {
            args.extend(["--tmpfs".into(), tmpfs]);
        }
    }
    // Dropped before added, as the engines apply them: `--cap-drop ALL --cap-add NET_BIND_SERVICE`
    // is the hardened way to keep one.
    for (flag, list) in [("--cap-drop", &spec.cap_drop), ("--cap-add", &spec.cap_add)] {
        for raw in list.iter().filter(|c| !c.trim().is_empty()) {
            args.extend([flag.into(), capability(raw)?]);
        }
    }
    if spec.no_new_privileges {
        args.extend(["--security-opt".into(), "no-new-privileges".into()]);
    }
    if let Some(opt) = seccomp_opt(&spec.seccomp)? {
        args.extend(["--security-opt".into(), opt]);
    }
    args.extend(health_args(&spec.health)?);
    // After the image everything is the container's: a `--flag` there is the command's own.
    args.push(image.into());
    args.extend(split_command(&spec.command)?);
    Ok(args)
}

/// Lines of a pull's progress, which a run that had to pull prints before anything else.
fn pull_progress(line: &str) -> bool {
    const STARTS: [&str; 11] = [
        "Unable to find image",
        "Digest:",
        "Status:",
        "Trying to pull",
        "Resolved \"",
        "Resolving \"",
        "Getting image source signatures",
        "Copying blob",
        "Copying config",
        "Writing manifest",
        "Storing signatures",
    ];
    const LAYER: [&str; 9] = [": Pulling", ": Waiting", ": Verifying", ": Download", ": Downloading", ": Extracting", ": Pull complete", ": Already exists", ": Retrying"];
    STARTS.iter().any(|s| line.starts_with(s))
        || LAYER.iter().any(|s| line.contains(s))
        // nerdctl's bars: `docker.io/library/alpine:3: resolved |++++++|`, `elapsed: 2.1 s total: …`.
        || (line.ends_with('|') && line.contains(" |"))
        || line.starts_with("elapsed:")
}

/// Why a run failed. One that pulled first prints the pull's progress and then the error, while
/// `complaint` keeps the first lines: here the error is looked for after the progress.
fn failure(output: &cli::Output) -> String {
    let is_error = |line: &str| {
        let lower = line.to_lowercase();
        lower.contains("error") || lower.contains("level=fatal")
    };
    let lines: Vec<&str> = output.stderr.lines().map(str::trim).filter(|line| !line.is_empty() && (is_error(line) || !pull_progress(line))).collect();
    let errors: Vec<&str> = lines.iter().copied().filter(|line| is_error(line)).collect();
    let chosen = if errors.is_empty() { lines } else { errors };
    if chosen.is_empty() {
        output.complaint()
    } else {
        chosen[chosen.len().saturating_sub(6)..].join("\n")
    }
}

/// The new container's id: the last line of what `run -d` printed (a pull's progress goes to stderr,
/// but an engine that printed some to stdout prints the id after it).
fn new_id(stdout: &str) -> Option<String> {
    let lines: Vec<&str> = stdout.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    lines.iter().rev().find(|l| l.len() >= 12 && l.chars().all(|c| c.is_ascii_hexdigit())).or(lines.last()).map(|id| id.to_string())
}

/// Runs `spec`; the new container's id.
pub async fn run(target: &Target, spec: &RunSpec) -> Result<String, String> {
    let args = run_args(target.engine()?, spec)?;
    // An image not here yet is pulled first, which takes minutes for a big one.
    let output = target.run_owned(args, engine::PULL_TIMEOUT).await?;
    if !output.ok() {
        return Err(failure(&output));
    }
    new_id(&output.stdout).ok_or_else(|| "the engine started the container without printing its id".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(image: &str) -> RunSpec {
        RunSpec { image: image.into(), ..Default::default() }
    }

    fn port(host: &str, container: &str, protocol: &str) -> RunPort {
        RunPort { host: host.into(), container: container.into(), protocol: protocol.into() }
    }

    fn mount(kind: &str, source: &str, target: &str, read_only: bool) -> RunVolume {
        RunVolume { kind: kind.into(), source: source.into(), target: target.into(), read_only }
    }

    fn args(spec: &RunSpec) -> Vec<String> {
        run_args(EngineKind::Docker, spec).unwrap()
    }

    #[test]
    fn the_bare_minimum() {
        assert_eq!(args(&spec(" redis:7 ")), vec!["run", "-d", "redis:7"]);
        assert!(run_args(EngineKind::Docker, &spec("")).is_err());
        assert!(run_args(EngineKind::Docker, &spec("--privileged")).is_err(), "an image is never a flag");
        assert!(run_args(EngineKind::Ctr, &spec("redis")).unwrap_err().contains("nerdctl"));
        assert_eq!(run_args(EngineKind::Podman, &spec("redis")).unwrap(), vec!["run", "-d", "redis"]);
        assert_eq!(run_args(EngineKind::Nerdctl, &spec("redis")).unwrap(), vec!["run", "-d", "redis"]);
    }

    #[test]
    fn every_option_in_its_place() {
        let full = RunSpec {
            image: "nginx:alpine".into(),
            name: "cf-web".into(),
            ports: vec![port("8080", "80", "tcp"), port("127.0.0.1:8443", "443", ""), port("", "53", "udp"), port("", "", "tcp")],
            publish_all: true,
            env: vec![RunEnv { key: "MODE".into(), value: "a b=c".into() }, RunEnv { key: "".into(), value: "".into() }],
            volumes: vec![mount("volume", "cf-data", "/data", false), mount("bind", "/Users/me/site", "/usr/share/nginx/html", true)],
            restart: "unless-stopped".into(),
            auto_remove: false,
            pull: "always".into(),
            command: "nginx -g 'daemon off;'".into(),
            workdir: "/srv".into(),
            network: "cf-net".into(),
            memory_mb: Some(512.0),
            cpus: Some(1.5),
            ..Default::default()
        };
        assert_eq!(
            args(&full),
            vec![
                "run", "-d", "--name", "cf-web", "-p", "8080:80", "-p", "127.0.0.1:8443:443", "-p", "53/udp", "-P", "-e", "MODE=a b=c", "-v", "cf-data:/data", "-v",
                "/Users/me/site:/usr/share/nginx/html:ro", "--restart", "unless-stopped", "--pull=always", "-w", "/srv", "--network", "cf-net", "--memory", "512m", "--cpus",
                "1.5", "nginx:alpine", "nginx", "-g", "daemon off;",
            ]
        );
    }

    #[test]
    fn ports_every_way_the_form_writes_them() {
        let one = |host: &str, container: &str, protocol: &str| port_arg(&port(host, container, protocol));
        assert_eq!(one("", "80", "").unwrap().as_deref(), Some("80"));
        assert_eq!(one("8080", "80", "TCP").unwrap().as_deref(), Some("8080:80"));
        assert_eq!(one("0.0.0.0:5353", "53", "udp").unwrap().as_deref(), Some("0.0.0.0:5353:53/udp"));
        assert_eq!(one("127.0.0.1", "80", "").unwrap().as_deref(), Some("127.0.0.1::80"), "an address with a port the engine picks");
        assert_eq!(one("[::1]:8080", "80", "").unwrap().as_deref(), Some("[::1]:8080:80"));
        assert_eq!(one("[::1]", "80", "").unwrap().as_deref(), Some("[::1]::80"));
        assert_eq!(one("8000-8002", "8000-8002", "").unwrap().as_deref(), Some("8000-8002:8000-8002"));
        assert_eq!(one(" ", " ", "tcp").unwrap(), None, "an empty row is no port");
        for (host, container, protocol) in [
            ("8080", "", "tcp"),
            ("", "0", ""),
            ("", "65536", ""),
            ("", "+80", ""),
            ("", "eighty", ""),
            ("70000", "80", ""),
            ("", "90-80", ""),
            ("localhost:8080", "80", ""),
            ("::1:8080", "80", ""),
            ("[::1:8080", "80", ""),
            ("[::1]8080", "80", ""),
            ("300.0.0.1:80", "80", ""),
            ("", "80", "icmp"),
            ("-p", "80", ""),
        ] {
            assert!(one(host, container, protocol).is_err(), "{host:?} -> {container:?}/{protocol:?} is refused");
        }
    }

    #[test]
    fn variables_and_their_names() {
        let env = |key: &str, value: &str| env_arg(&RunEnv { key: key.into(), value: value.into() });
        assert_eq!(env("PATH_X", "/a:/b").unwrap().as_deref(), Some("PATH_X=/a:/b"));
        assert_eq!(env("spring.profiles.active", "dev").unwrap().as_deref(), Some("spring.profiles.active=dev"));
        assert_eq!(env("_X", "").unwrap().as_deref(), Some("_X="), "an empty value is a value");
        assert_eq!(env(" EMPTY ", "  spaced  ").unwrap().as_deref(), Some("EMPTY=  spaced  "), "a value is kept as written");
        assert_eq!(env("", "").unwrap(), None);
        for (key, value) in [("", "orphan"), ("1X", "a"), ("A=B", "c"), ("A B", "c"), ("-e", "x"), ("Ñ", "x"), ("OK", "nul\0byte")] {
            assert!(env(key, value).is_err(), "{key:?}={value:?} is refused");
        }
    }

    #[test]
    fn volumes_named_bound_and_anonymous() {
        let one = |kind: &str, source: &str, target: &str, ro: bool| volume_arg(&mount(kind, source, target, ro));
        assert_eq!(one("volume", "pgdata", "/var/lib/postgresql/data", false).unwrap().as_deref(), Some("pgdata:/var/lib/postgresql/data"));
        assert_eq!(one("volume", "", "/cache", false).unwrap().as_deref(), Some("/cache"), "no name is an anonymous volume");
        assert_eq!(one("bind", "/Users/me/app", "/app", true).unwrap().as_deref(), Some("/Users/me/app:/app:ro"));
        assert_eq!(one("", "/Users/me/app", "/app", false).unwrap().as_deref(), Some("/Users/me/app:/app"), "a path is a bind");
        assert_eq!(one("", "data", "/data", false).unwrap().as_deref(), Some("data:/data"), "a word is a volume");
        assert_eq!(one("bind", "", "", false).unwrap(), None);
        for (kind, source, target) in [
            ("bind", "relative/dir", "/app"),
            ("bind", "~/app", "/app"),
            ("bind", "", "/app"),
            ("bind", "/a:b", "/app"),
            ("volume", "-v", "/x"),
            ("volume", "my vol", "/x"),
            ("volume", "data", ""),
            ("volume", "data", "relative"),
            ("volume", "data", "/x:rw"),
            ("tmpfs", "", "/tmp"),
        ] {
            assert!(one(kind, source, target, false).is_err(), "{kind} {source:?} -> {target:?} is refused");
        }
    }

    #[test]
    fn removing_itself_wins_over_restarting() {
        let mut both = spec("redis");
        both.restart = "always".into();
        both.auto_remove = true;
        assert_eq!(args(&both), vec!["run", "-d", "--rm", "redis"]);
        both.auto_remove = false;
        assert_eq!(args(&both), vec!["run", "-d", "--restart", "always", "redis"]);
        both.restart = "on-failure:3".into();
        assert_eq!(args(&both), vec!["run", "-d", "--restart", "on-failure:3", "redis"]);
        both.restart = "no".into();
        assert_eq!(args(&both), vec!["run", "-d", "redis"], "no is the engine's default, left unsaid");
        for bad in ["sometimes", "on-failure:", "on-failure:x", "--rm"] {
            both.restart = bad.into();
            assert!(run_args(EngineKind::Docker, &both).is_err(), "{bad} is refused");
        }
    }

    #[test]
    fn names_pulls_folders_networks_and_limits() {
        let mut s = spec("redis");
        s.name = "-x".into();
        assert!(run_args(EngineKind::Docker, &s).is_err());
        s.name = "a b".into();
        assert!(run_args(EngineKind::Docker, &s).is_err());
        s.name = String::new();
        s.pull = "missing".into();
        assert_eq!(args(&s), vec!["run", "-d", "redis"]);
        s.pull = "sometimes".into();
        assert!(run_args(EngineKind::Docker, &s).is_err());
        s.pull = String::new();
        s.workdir = "app".into();
        assert!(run_args(EngineKind::Docker, &s).is_err(), "a working folder is absolute");
        s.workdir = String::new();
        s.network = "--privileged".into();
        assert!(run_args(EngineKind::Docker, &s).is_err());
        s.network = "container:db".into();
        assert_eq!(args(&s), vec!["run", "-d", "--network", "container:db", "redis"]);
        s.network = String::new();
        s.memory_mb = Some(5.0);
        assert!(run_args(EngineKind::Docker, &s).is_err(), "below the engines' 6 MB floor");
        s.memory_mb = Some(f64::NAN);
        assert!(run_args(EngineKind::Docker, &s).is_err());
        s.memory_mb = Some(1023.6);
        s.cpus = Some(0.25);
        assert_eq!(args(&s), vec!["run", "-d", "--memory", "1024m", "--cpus", "0.25", "redis"]);
        s.cpus = Some(0.0);
        assert!(run_args(EngineKind::Docker, &s).is_err());
    }

    #[test]
    fn the_hardened_options_in_their_place() {
        let mut s = spec("node:22");
        s.memory_mb = Some(512.0);
        s.pids_limit = Some(256.0);
        s.shm_size_mb = Some(64.0);
        s.user = "1000:1000".into();
        s.read_only = true;
        s.tmpfs = vec!["/tmp:size=64m,mode=1777".into(), " ".into(), "/run".into()];
        s.cap_drop = vec!["all".into()];
        s.cap_add = vec!["CAP_NET_BIND_SERVICE".into(), "".into()];
        s.no_new_privileges = true;
        s.seccomp = "unconfined".into();
        s.health = RunHealth { command: "curl -f http://localhost:3000/health || exit 1".into(), interval_s: Some(30.0), timeout_s: Some(2.5), start_period_s: None, retries: Some(3.0), disabled: false };
        assert_eq!(
            args(&s),
            vec![
                "run", "-d", "--memory", "512m", "--pids-limit", "256", "--shm-size", "64m", "--user", "1000:1000", "--read-only", "--tmpfs", "/tmp:size=64m,mode=1777", "--tmpfs", "/run",
                "--cap-drop", "ALL", "--cap-add", "NET_BIND_SERVICE", "--security-opt", "no-new-privileges", "--security-opt", "seccomp=unconfined",
                "--health-cmd=curl -f http://localhost:3000/health || exit 1", "--health-interval=30s", "--health-timeout=2.5s", "--health-retries=3", "node:22",
            ]
        );
        s.health.disabled = true;
        assert!(args(&s).contains(&"--no-healthcheck".to_string()) && !args(&s).iter().any(|a| a.starts_with("--health-")), "off wins over a command");
    }

    #[test]
    fn the_hardened_options_refuse_what_no_engine_reads() {
        let refused = |edit: &dyn Fn(&mut RunSpec)| {
            let mut s = spec("redis");
            edit(&mut s);
            run_args(EngineKind::Docker, &s).is_err()
        };
        assert!(refused(&|s| s.user = "-u".into()));
        assert!(refused(&|s| s.user = "app:".into()));
        assert!(refused(&|s| s.user = "a b".into()));
        assert!(refused(&|s| s.cap_add = vec!["net admin".into()]));
        assert!(refused(&|s| s.cap_drop = vec!["CAP_".into()]));
        assert!(refused(&|s| s.tmpfs = vec!["tmp".into()]));
        assert!(refused(&|s| s.tmpfs = vec!["/tmp:".into()]));
        assert!(refused(&|s| s.tmpfs = vec!["/tmp:size=1m;rm".into()]));
        assert!(refused(&|s| s.seccomp = "profile.json".into()));
        assert!(refused(&|s| s.seccomp = "/nowhere/at/all.json".into()));
        assert!(refused(&|s| s.pids_limit = Some(0.0)));
        assert!(refused(&|s| s.pids_limit = Some(1.5)));
        assert!(refused(&|s| s.shm_size_mb = Some(1.0)));
        assert!(refused(&|s| s.health.interval_s = Some(0.0)));
        assert!(refused(&|s| s.health.retries = Some(0.0)));
        assert!(refused(&|s| s.health.command = "nul\0".into()));
        assert_eq!(capability("sys_time").unwrap(), "SYS_TIME");
        assert_eq!(seconds(90.0, "x").unwrap(), "90s");
        assert_eq!(seccomp_opt("default").unwrap(), None);
        let profile = std::env::temp_dir().join(format!("cf-seccomp-{}.json", std::process::id()));
        std::fs::write(&profile, "{}").unwrap();
        assert_eq!(seccomp_opt(profile.to_str().unwrap()).unwrap(), Some(format!("seccomp={}", profile.display())));
        let _ = std::fs::remove_file(profile);
    }

    #[test]
    fn commands_split_like_a_shell() {
        let split = |line: &str| split_command(line).unwrap();
        assert!(split("").is_empty() && split("   \t\n").is_empty());
        assert_eq!(split("redis-server  --appendonly yes"), vec!["redis-server", "--appendonly", "yes"]);
        assert_eq!(split(r#"sh -c 'echo "$HOME" && ls *'"#), vec!["sh", "-c", r#"echo "$HOME" && ls *"#]);
        assert_eq!(split(r#"echo "a \"quoted\" \$word \\ and \n stays""#), vec!["echo", r#"a "quoted" $word \ and \n stays"#]);
        assert_eq!(split(r"touch a\ b c\'d"), vec!["touch", "a b", "c'd"]);
        assert_eq!(split(r#"x '' "" y"#), vec!["x", "", "", "y"], "empty quotes are empty words");
        assert_eq!(split(r#"a'b c'"d e"f"#), vec!["ab cd ef"], "quotes join into one word");
        assert_eq!(split("one \\\ntwo"), vec!["one", "two"], "a backslash-newline joins lines");
        assert_eq!(split("echo $PATH ~ # not a comment; |"), vec!["echo", "$PATH", "~", "#", "not", "a", "comment;", "|"]);
        assert_eq!(split("señal ünïcode"), vec!["señal", "ünïcode"]);
        for bad in ["echo 'open", "echo \"open", "echo \"open \\\"", "trailing \\", "nul\0"] {
            assert!(split_command(bad).is_err(), "{bad:?} is refused");
        }
    }

    #[test]
    fn a_failed_run_says_its_error_not_its_pull() {
        let output = cli::Output {
            code: Some(125),
            stdout: String::new(),
            stderr: "Unable to find image 'nginx:alpine' locally\nalpine: Pulling from library/nginx\n9824c27679d3: Pulling fs layer\n9824c27679d3: Verifying Checksum\n9824c27679d3: Download complete\n9824c27679d3: Pull complete\nDigest: sha256:abc\nStatus: Downloaded newer image for nginx:alpine\ndocker: Error response from daemon: driver failed programming external connectivity: Bind for 0.0.0.0:8080 failed: port is already allocated.\nRun 'docker run --help' for more information\n".into(),
        };
        assert_eq!(failure(&output), "docker: Error response from daemon: driver failed programming external connectivity: Bind for 0.0.0.0:8080 failed: port is already allocated.");
        let podman = cli::Output {
            code: Some(125),
            stdout: String::new(),
            stderr: "Resolved \"nginx\" as an alias (/etc/containers/registries.conf.d/000-shortnames.conf)\nTrying to pull docker.io/library/nginx:latest...\nGetting image source signatures\nCopying blob sha256:a2318d done   |\nCopying config sha256:39286a done   |\nWriting manifest to image destination\nError: rootlessport listen tcp 0.0.0.0:8080: bind: address already in use\n".into(),
        };
        assert_eq!(failure(&podman), "Error: rootlessport listen tcp 0.0.0.0:8080: bind: address already in use");
        let quiet = cli::Output { code: Some(1), stdout: String::new(), stderr: "unknown flag: --nope\n".into() };
        assert_eq!(failure(&quiet), "unknown flag: --nope");
        let silent = cli::Output { code: Some(2), stdout: String::new(), stderr: String::new() };
        assert_eq!(failure(&silent), "exited with code 2");
    }

    #[test]
    fn the_id_is_the_last_line() {
        let id = "4f2c1a9b8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a";
        assert_eq!(new_id(&format!("{id}\n")).as_deref(), Some(id));
        assert_eq!(new_id(&format!("docker.io/library/alpine:3: resolved |++|\n{id}\n\n")).as_deref(), Some(id));
        assert_eq!(new_id("   \n"), None);
    }
}
