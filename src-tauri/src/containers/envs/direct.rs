//! What a `devcontainer.json` asks of `docker run` and `docker build` beyond an image, turned into
//! argv and judged before anything runs — the direct path's half of the specification, and the
//! port arithmetic the Dev Containers CLI path needs too.
//!
//! **`runArgs` are parsed, not passed blind.** Each flag is looked up in [`FLAGS`]: its arity (so a
//! value is never read as a flag, nor a flag as the image), and whether CodeFlow keeps it, drops it
//! (`--name`, `-d`, `--rm`: the environment sets those) or refuses it (`--volumes-from`: what it
//! mounts cannot be known before it runs). An unknown flag is refused with the advice to use the
//! CLI, never guessed at. Published ports (`-p`) move by the environment's offset like every other.
//!
//! **Judged by the same rules as everything else.** What the flags, `mounts`, `workspaceMount` and
//! the file's own `privileged`/`capAdd`/`securityOpt` would make of the container is gathered into
//! [`RunFacts`], written as the `inspect` document it would have ([`RunFacts::document`]), and
//! handed to `policy::check_container_at` — the check a running container gets — so the workspace's
//! security policy refuses here exactly what it refuses elsewhere. What it allows but the hardening
//! rules call dangerous (`hardening::audit`'s high and medium findings) is still said, as a
//! warning of the environment.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::devcontainer::{self, DevContainer, HostCommand, MountSpec};
use super::plan::{self, EnvWarning, PortBinding};
use crate::containers::{hardening, manage, policy};

// ------------------------------------------------------------------------------------ facts

/// What a container would be, gathered from its configuration before it exists: the fields of an
/// `inspect` document the hardening rules and the security policy read.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RunFacts {
    pub privileged: bool,
    pub network: String,
    pub pid: String,
    pub ipc: String,
    /// What shares the host the hardening rules have no rule of their own for — `--uts=host`,
    /// `--userns=host`, `--cgroupns=host`, `--security-opt systempaths=unconfined` — judged as
    /// privileged.
    pub escapes: Vec<String>,
    pub cap_add: Vec<String>,
    pub security_opt: Vec<String>,
    pub devices: usize,
    pub user: String,
    /// (type, source, writable).
    pub mounts: Vec<(String, String, bool)>,
    pub memory: i64,
    pub nano_cpus: i64,
    pub pids_limit: i64,
    pub read_only: bool,
    /// (host ip, host port, `port/proto`).
    pub published: Vec<(String, String, String)>,
}

impl RunFacts {
    /// The `inspect` document these facts describe, in the shape `hardening::audit` and
    /// `policy::check_container_at` read.
    pub fn document(&self) -> Value {
        let mut bindings: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        for (ip, host, port) in &self.published {
            bindings.entry(port.clone()).or_default().push(json!({ "HostIp": ip, "HostPort": host }));
        }
        let network = if self.network.trim().is_empty() { "default" } else { self.network.trim() };
        json!({
            "Config": { "User": self.user, "Healthcheck": Value::Null },
            "HostConfig": {
                "Privileged": self.privileged,
                "NetworkMode": network,
                "PidMode": self.pid,
                "IpcMode": self.ipc,
                "CapAdd": self.cap_add,
                "SecurityOpt": self.security_opt,
                "Devices": (0..self.devices).map(|_| json!({})).collect::<Vec<_>>(),
                "ReadonlyRootfs": self.read_only,
                "Memory": self.memory,
                "NanoCpus": self.nano_cpus,
                "PidsLimit": self.pids_limit,
                "PortBindings": bindings,
            },
            "Mounts": self.mounts.iter().map(|(kind, source, rw)| json!({ "Type": kind, "Source": source, "RW": rw })).collect::<Vec<_>>(),
        })
    }
}

/// The hardening rules worth a warning when the policy lets them through.
const DANGEROUS: &[&str] = &["privileged", "engineSocket", "hostMount", "hostNetwork", "hostPid", "hostIpc", "dangerousCap", "seccompOff", "apparmorOff", "devices"];

/// The policy's verdict, and the warnings for what it allows but weakens isolation.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Verdict {
    pub violations: Vec<policy::Violation>,
    pub warnings: Vec<EnvWarning>,
}

impl Verdict {
    pub fn blocked(&self) -> bool {
        policy::blocks(&self.violations)
    }

    /// The refusal, with where it can be changed.
    pub fn refusal(&self) -> String {
        format!("{} — change the workspace's security policy (Containers › Security) if this environment needs it", policy::refusal(&self.violations))
    }
}

/// [`RunFacts`] against the workspace's policy: `policy::check_container_at` on their document, plus
/// [`RunFacts::escapes`] as privileged; then the dangerous findings the policy allowed, as warnings.
pub fn judge(rules: &policy::SecurityPolicy, facts: &RunFacts, known: &policy::Facts, home: Option<&Path>) -> Verdict {
    judge_document(rules, &facts.document(), &facts.escapes, known, home)
}

/// The same for an `inspect` document — a container `devcontainer up` or Compose started.
pub fn judge_document(rules: &policy::SecurityPolicy, doc: &Value, escapes: &[String], known: &policy::Facts, home: Option<&Path>) -> Verdict {
    let mut violations = policy::check_container_at(rules, doc, known, home);
    for escape in escapes {
        if rules.no_privileged {
            let v = policy::Violation { rule: "privileged".into(), detail: escape.clone(), blocking: true };
            if !violations.contains(&v) {
                violations.push(v);
            }
        }
    }
    let mut warnings: Vec<EnvWarning> = Vec::new();
    let mut warn = |subject: String| {
        let w = EnvWarning::new("hardening", subject);
        if !warnings.contains(&w) {
            warnings.push(w);
        }
    };
    for finding in hardening::audit(doc) {
        if DANGEROUS.contains(&finding.rule.as_str()) && finding.severity != "low" {
            warn(if finding.detail.is_empty() { finding.rule.clone() } else { format!("{} {}", finding.rule, finding.detail) });
        }
    }
    for escape in escapes {
        warn(escape.clone());
    }
    Verdict { violations, warnings }
}

// --------------------------------------------------------------------------------- runArgs

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Arity {
    Flag,
    Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Fate {
    Keep,
    /// The environment sets it itself.
    Omit,
    /// Cannot be judged before the container exists.
    Refuse,
}

use Arity::{Flag, Value as Val};
use Fate::{Keep, Omit, Refuse};

/// `docker run`'s flags (Podman and nerdctl read the same names): long name, short letter, arity, fate.
const FLAGS: &[(&str, Option<char>, Arity, Fate)] = &[
    ("add-host", None, Val, Keep),
    ("annotation", None, Val, Keep),
    ("blkio-weight", None, Val, Keep),
    ("cap-add", None, Val, Keep),
    ("cap-drop", None, Val, Keep),
    ("cgroup-parent", None, Val, Keep),
    ("cgroupns", None, Val, Keep),
    ("cpu-period", None, Val, Keep),
    ("cpu-quota", None, Val, Keep),
    ("cpu-rt-period", None, Val, Keep),
    ("cpu-rt-runtime", None, Val, Keep),
    ("cpu-shares", Some('c'), Val, Keep),
    ("cpus", None, Val, Keep),
    ("cpuset-cpus", None, Val, Keep),
    ("cpuset-mems", None, Val, Keep),
    ("device", None, Val, Keep),
    ("device-cgroup-rule", None, Val, Keep),
    ("dns", None, Val, Keep),
    ("dns-option", None, Val, Keep),
    ("dns-search", None, Val, Keep),
    ("domainname", None, Val, Keep),
    ("entrypoint", None, Val, Keep),
    ("env", Some('e'), Val, Keep),
    ("env-file", None, Val, Keep),
    ("expose", None, Val, Keep),
    ("gpus", None, Val, Keep),
    ("group-add", None, Val, Keep),
    ("health-cmd", None, Val, Keep),
    ("health-interval", None, Val, Keep),
    ("health-retries", None, Val, Keep),
    ("health-start-period", None, Val, Keep),
    ("health-timeout", None, Val, Keep),
    ("hostname", Some('h'), Val, Keep),
    ("ip", None, Val, Keep),
    ("ip6", None, Val, Keep),
    ("ipc", None, Val, Keep),
    ("isolation", None, Val, Keep),
    ("label", Some('l'), Val, Keep),
    ("label-file", None, Val, Keep),
    ("link", None, Val, Keep),
    ("link-local-ip", None, Val, Keep),
    ("log-driver", None, Val, Keep),
    ("log-opt", None, Val, Keep),
    ("mac-address", None, Val, Keep),
    ("memory", Some('m'), Val, Keep),
    ("memory-reservation", None, Val, Keep),
    ("memory-swap", None, Val, Keep),
    ("memory-swappiness", None, Val, Keep),
    ("mount", None, Val, Keep),
    ("network", None, Val, Keep),
    ("net", None, Val, Keep),
    ("network-alias", None, Val, Keep),
    ("net-alias", None, Val, Keep),
    ("oom-score-adj", None, Val, Keep),
    ("pid", None, Val, Keep),
    ("pids-limit", None, Val, Keep),
    ("platform", None, Val, Keep),
    ("publish", Some('p'), Val, Keep),
    ("pull", None, Val, Keep),
    ("restart", None, Val, Keep),
    ("runtime", None, Val, Keep),
    ("security-opt", None, Val, Keep),
    ("shm-size", None, Val, Keep),
    ("stop-signal", None, Val, Keep),
    ("stop-timeout", None, Val, Keep),
    ("storage-opt", None, Val, Keep),
    ("sysctl", None, Val, Keep),
    ("tmpfs", None, Val, Keep),
    ("ulimit", None, Val, Keep),
    ("user", Some('u'), Val, Keep),
    ("userns", None, Val, Keep),
    ("uts", None, Val, Keep),
    ("volume", Some('v'), Val, Keep),
    ("volume-driver", None, Val, Keep),
    ("workdir", Some('w'), Val, Keep),
    ("init", None, Flag, Keep),
    ("interactive", Some('i'), Flag, Keep),
    ("tty", Some('t'), Flag, Keep),
    ("oom-kill-disable", None, Flag, Keep),
    ("no-healthcheck", None, Flag, Keep),
    ("publish-all", Some('P'), Flag, Keep),
    ("read-only", None, Flag, Keep),
    ("privileged", None, Flag, Keep),
    ("quiet", Some('q'), Flag, Keep),
    ("name", None, Val, Omit),
    ("cidfile", None, Val, Omit),
    ("attach", Some('a'), Val, Omit),
    ("detach-keys", None, Val, Omit),
    ("detach", Some('d'), Flag, Omit),
    ("rm", None, Flag, Omit),
    ("sig-proxy", None, Flag, Omit),
    ("volumes-from", None, Val, Refuse),
];

fn by_long(name: &str) -> Option<(&'static str, Arity, Fate)> {
    FLAGS.iter().find(|f| f.0 == name).map(|f| (f.0, f.2, f.3))
}

fn by_short(c: char) -> Option<(&'static str, Arity, Fate)> {
    FLAGS.iter().find(|f| f.1 == Some(c)).map(|f| (f.0, f.2, f.3))
}

/// `-it` → `-i -t`: a group of short boolean flags, one by one.
fn expand_shorts(raw: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for token in raw {
        let t = token.trim();
        let group = t.strip_prefix('-').filter(|rest| !rest.starts_with('-') && rest.chars().count() > 1);
        match group {
            Some(rest) if rest.chars().all(|c| by_short(c).is_some_and(|f| f.1 == Flag)) => out.extend(rest.chars().map(|c| format!("-{c}"))),
            _ => out.push(t.to_string()),
        }
    }
    out
}

/// What `runArgs` became: the argv to append to `run`, the ports they publish (moved), and what was
/// left out because the environment sets it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RunArgsPlan {
    pub args: Vec<String>,
    pub ports: Vec<PortBinding>,
    pub dropped: Vec<String>,
}

const CLI_ADVICE: &str = "run this devcontainer with the Dev Containers CLI instead";

/// A size as the engines read it: `512m`, `2g`, `1.5G`, `1024` (bytes), `512mb`.
pub fn size_bytes(text: &str) -> Result<i64, String> {
    let t = text.trim().to_ascii_lowercase();
    let t = t.strip_suffix('b').filter(|rest| rest.ends_with(|c: char| c.is_ascii_alphabetic())).unwrap_or(&t);
    let (number, unit) = match t.char_indices().find(|(_, c)| c.is_ascii_alphabetic()) {
        Some((at, _)) => (&t[..at], &t[at..]),
        None => (t, ""),
    };
    let scale: f64 = match unit {
        "" | "b" => 1.0,
        "k" => 1024.0,
        "m" => 1024.0 * 1024.0,
        "g" => 1024.0 * 1024.0 * 1024.0,
        "t" => 1024f64.powi(4),
        _ => return Err(format!("\"{text}\" is not a size")),
    };
    let n: f64 = number.trim().parse().map_err(|_| format!("\"{text}\" is not a size"))?;
    if !n.is_finite() || n < 0.0 {
        return Err(format!("\"{text}\" is not a size"));
    }
    Ok((n * scale) as i64)
}

/// A path a flag reads on the host (`--env-file`), relative to the checkout, and kept inside it: a
/// repository's file must not point CodeFlow at the user's own secrets.
fn checkout_file(root: &Path, value: &str, flag: &str) -> Result<String, String> {
    let path = Path::new(value.trim());
    let joined = if path.is_absolute() { super::lexical(path) } else { super::lexical(&root.join(path)) };
    if !joined.starts_with(super::lexical(root)) {
        return Err(format!("runArgs: {flag} {value} reads a file outside the checkout"));
    }
    Ok(joined.to_string_lossy().into_owned())
}

/// `-v src:dst[:opts]`: a bind's source made absolute (`./x` against the checkout), a volume's name
/// checked; the facts gain the mount.
fn volume_value(value: &str, root: &Path, facts: &mut RunFacts) -> Result<String, String> {
    let parts: Vec<&str> = value.split(':').collect();
    let (source, target, opts) = match parts[..] {
        [target] => ("", target, ""),
        [source, target] => (source, target, ""),
        [source, target, opts] => (source, target, opts),
        _ => return Err(format!("runArgs: \"-v {value}\" is not source:target[:options]")),
    };
    if !target.starts_with('/') {
        return Err(format!("runArgs: \"-v {value}\" mounts at a relative path"));
    }
    let writable = !opts.split(',').any(|o| o.trim() == "ro" || o.trim() == "readonly");
    if source.is_empty() {
        facts.mounts.push(("volume".into(), String::new(), writable));
        return Ok(value.to_string());
    }
    if source.starts_with('~') {
        return Err(format!("runArgs: \"-v {value}\": ~ is not expanded here; use ${{localEnv:HOME}}"));
    }
    let bind = source.starts_with('/') || source.starts_with('.');
    let source = if bind {
        let abs = if source.starts_with('/') { super::lexical(Path::new(source)) } else { super::lexical(&root.join(source)) };
        abs.to_string_lossy().into_owned()
    } else {
        manage::check_name(source, "volume")?;
        source.to_string()
    };
    facts.mounts.push((if bind { "bind" } else { "volume" }.into(), source.clone(), writable));
    Ok(if opts.is_empty() { format!("{source}:{target}") } else { format!("{source}:{target}:{opts}") })
}

fn csv_field(key: &str, value: &str) -> String {
    let field = if value.is_empty() { key.to_string() } else { format!("{key}={value}") };
    if field.contains(',') || field.contains('"') {
        format!("\"{}\"", field.replace('"', "\"\""))
    } else {
        field
    }
}

const MOUNT_EXTRA: &[&str] = &[
    "consistency", "bind-propagation", "bind-nonrecursive", "bind-recursive", "volume-nocopy", "volume-subpath", "volume-opt", "volume-driver", "tmpfs-size",
    "tmpfs-mode",
];

/// One `mounts` entry (or `workspaceMount`) as a `--mount` value, checked: a bind's source is an
/// absolute path, a volume's a name, a tmpfs has none, and the target is a folder in the container.
/// The facts gain the mount.
pub fn mount_value(spec: &MountSpec, facts: &mut RunFacts) -> Result<String, String> {
    if !spec.target.starts_with('/') {
        return Err(format!("the mount target \"{}\" is not a folder inside the container", spec.target));
    }
    let source = spec.source.trim();
    match spec.kind.as_str() {
        "bind" if !Path::new(source).is_absolute() || source.contains('\0') => {
            return Err(format!("the bind mount source \"{source}\" is not an absolute path (write it with ${{localWorkspaceFolder}})"));
        }
        "bind" => {}
        "volume" if !source.is_empty() => manage::check_name(source, "volume")?,
        "volume" => {}
        "tmpfs" if !source.is_empty() => return Err("a tmpfs mount has no source".into()),
        "tmpfs" => {}
        other => return Err(format!("a \"{other}\" mount is not run directly: {CLI_ADVICE}")),
    }
    if let Some((key, _)) = spec.extra.iter().find(|(k, _)| !MOUNT_EXTRA.contains(&k.as_str())) {
        return Err(format!("the mount option \"{key}\" is not one --mount takes"));
    }
    let source = if spec.kind == "bind" { super::lexical(Path::new(source)).to_string_lossy().into_owned() } else { source.to_string() };
    facts.mounts.push((spec.kind.clone(), source.clone(), !spec.read_only));
    let mut fields = vec![csv_field("type", &spec.kind)];
    if !source.is_empty() {
        fields.push(csv_field("source", &source));
    }
    fields.push(csv_field("target", &spec.target));
    if spec.read_only {
        fields.push("readonly".into());
    }
    for (key, value) in &spec.extra {
        fields.push(csv_field(key, value));
    }
    Ok(fields.join(","))
}

/// A `-p` value: `C`, `H:C`, `IP:H:C`, `IP::C`, `[v6]:H:C`, each with `/proto` and ranges.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Publish {
    pub ip: String,
    pub host: Option<String>,
    pub container: String,
    pub protocol: String,
}

fn port_text(text: &str) -> bool {
    let ok = |p: &str| p.trim().parse::<u16>().is_ok_and(|n| n > 0);
    match text.split_once('-') {
        Some((a, b)) => ok(a) && ok(b),
        None => ok(text),
    }
}

pub fn parse_publish(text: &str) -> Result<Publish, String> {
    let bad = || format!("\"{text}\" is not a port to publish");
    let (spec, protocol) = match text.trim().rsplit_once('/') {
        Some((spec, proto)) if matches!(proto, "tcp" | "udp" | "sctp") => (spec, proto.to_string()),
        Some(_) => return Err(bad()),
        None => (text.trim(), "tcp".to_string()),
    };
    let (ip, rest) = if let Some(after) = spec.strip_prefix('[') {
        let (ip, rest) = after.split_once("]:").ok_or_else(bad)?;
        (ip.to_string(), rest)
    } else {
        match spec.matches(':').count() {
            0 | 1 => (String::new(), spec),
            2 => {
                let (ip, rest) = spec.split_once(':').ok_or_else(bad)?;
                (ip.to_string(), rest)
            }
            _ => return Err(bad()),
        }
    };
    let (host, container) = match rest.split_once(':') {
        Some((host, container)) => (Some(host.to_string()).filter(|h| !h.is_empty()), container.to_string()),
        None => (None, rest.to_string()),
    };
    if !port_text(&container) || host.as_deref().is_some_and(|h| !port_text(h)) {
        return Err(bad());
    }
    Ok(Publish { ip, host, container, protocol })
}

/// A `-p` value moved by `offset`, published on localhost unless it names an address, and its binding.
pub fn shift_publish(text: &str, offset: u16) -> Result<(String, PortBinding), String> {
    let p = parse_publish(text)?;
    let ip = if p.ip.is_empty() { "127.0.0.1".to_string() } else { p.ip.clone() };
    let target: u16 = p.container.split('-').next().and_then(|c| c.trim().parse().ok()).unwrap_or(0);
    let mut binding = PortBinding { service: "dev".into(), target, protocol: p.protocol.clone(), host_ip: ip.clone(), base: None, host: None, host_end: None };
    let host_text = match &p.host {
        Some(host) => {
            let (moved, first, end) = plan::shift_published(host, offset)?;
            binding.base = host.split('-').next().and_then(|h| h.trim().parse().ok());
            binding.host = Some(first);
            binding.host_end = end;
            moved
        }
        None => String::new(),
    };
    let ip_text = if ip.contains(':') { format!("[{ip}]") } else { ip };
    let proto = if p.protocol == "tcp" { String::new() } else { format!("/{}", p.protocol) };
    Ok((format!("{ip_text}:{host_text}:{}{proto}", p.container), binding))
}

fn flag_bool(name: &str, inline: Option<&str>) -> Result<bool, String> {
    match inline {
        None => Ok(true),
        Some(v) => match v.trim().to_ascii_lowercase().as_str() {
            "true" | "1" => Ok(true),
            "false" | "0" => Ok(false),
            _ => Err(format!("runArgs: --{name}={v} is not true or false")),
        },
    }
}

/// `runArgs` (and the flags the file's `privileged`, `capAdd`, `securityOpt` and `init` stand for,
/// see [`config_flags`]) parsed against [`FLAGS`], judged into `facts`, and rewritten: values a
/// flag reads as paths made absolute, `-p` moved by `offset` onto localhost, CodeFlow's own flags
/// dropped. `root` is the branch's checkout.
pub fn parse_run_args(raw: &[String], offset: u16, root: &Path, facts: &mut RunFacts) -> Result<RunArgsPlan, String> {
    let tokens = expand_shorts(raw);
    let mut plan = RunArgsPlan::default();
    let mut i = 0;
    while i < tokens.len() {
        let token = tokens[i].clone();
        i += 1;
        if token.is_empty() {
            continue;
        }
        let (flag, inline): ((&str, Arity, Fate), Option<String>) = if let Some(long) = token.strip_prefix("--") {
            let (name, inline) = match long.split_once('=') {
                Some((n, v)) => (n, Some(v.to_string())),
                None => (long, None),
            };
            (by_long(name).ok_or_else(|| format!("runArgs: \"--{name}\" is not a flag CodeFlow runs directly — {CLI_ADVICE}"))?, inline)
        } else if let Some(short) = token.strip_prefix('-').filter(|s| !s.is_empty()) {
            let c = short.chars().next().unwrap_or_default();
            let found = by_short(c).ok_or_else(|| format!("runArgs: \"-{c}\" is not a flag CodeFlow runs directly — {CLI_ADVICE}"))?;
            let rest = &short[c.len_utf8()..];
            let inline = (!rest.is_empty()).then(|| rest.trim_start_matches('=').to_string());
            (found, inline)
        } else {
            return Err(format!("runArgs: \"{token}\" is not a flag (an image or a command cannot be given there)"));
        };
        let (long, arity, fate) = flag;
        let value = match arity {
            Val => match inline.clone() {
                Some(v) => Some(v),
                None => {
                    let next = tokens.get(i).cloned().ok_or_else(|| format!("runArgs: --{long} needs a value"))?;
                    i += 1;
                    Some(next)
                }
            },
            Flag => None,
        };
        match fate {
            Refuse => return Err(format!("runArgs: --{long} cannot be judged before the container runs — {CLI_ADVICE}")),
            Omit => {
                plan.dropped.push(match &value {
                    Some(v) => format!("--{long} {v}"),
                    None => format!("--{long}"),
                });
                continue;
            }
            Keep => {}
        }
        if arity == Flag {
            let on = flag_bool(long, inline.as_deref())?;
            match long {
                "privileged" => facts.privileged = on,
                "read-only" => facts.read_only = on,
                _ => {}
            }
            plan.args.push(match &inline {
                Some(v) => format!("--{long}={v}"),
                None => format!("--{long}"),
            });
            continue;
        }
        let value = value.unwrap_or_default();
        let trimmed = value.trim().to_string();
        let written = match long {
            "network" | "net" => {
                facts.network = trimmed.clone();
                value
            }
            "pid" => {
                facts.pid = trimmed.clone();
                value
            }
            "ipc" => {
                facts.ipc = trimmed.clone();
                value
            }
            "uts" | "userns" | "cgroupns" => {
                if trimmed == "host" {
                    facts.escapes.push(format!("--{long}=host"));
                }
                value
            }
            "cap-add" => {
                facts.cap_add.push(trimmed.clone());
                value
            }
            "security-opt" => {
                let normal = trimmed.replacen(':', "=", 1);
                if normal == "systempaths=unconfined" {
                    facts.escapes.push(format!("--security-opt {trimmed}"));
                }
                facts.security_opt.push(trimmed.clone());
                value
            }
            "device" => {
                facts.devices += 1;
                value
            }
            "user" => {
                facts.user = trimmed.clone();
                value
            }
            "memory" => {
                facts.memory = size_bytes(&trimmed)?;
                value
            }
            "cpus" => {
                let cpus: f64 = trimmed.parse().map_err(|_| format!("runArgs: --cpus {value} is not a number"))?;
                facts.nano_cpus = (cpus * 1e9) as i64;
                value
            }
            "pids-limit" => {
                facts.pids_limit = trimmed.parse().map_err(|_| format!("runArgs: --pids-limit {value} is not a number"))?;
                value
            }
            "volume" => volume_value(&trimmed, root, facts)?,
            "mount" => mount_value(&devcontainer::parse_mount_text(&trimmed, None)?, facts)?,
            "env-file" | "label-file" => checkout_file(root, &trimmed, &format!("--{long}"))?,
            "label" => {
                if trimmed.starts_with(super::ENV_LABEL) || trimmed.starts_with("codeflow.") {
                    return Err(format!("runArgs: the label {trimmed} is CodeFlow's own"));
                }
                value
            }
            "publish" => {
                let (moved, binding) = shift_publish(&trimmed, offset)?;
                if let Some(host) = binding.host {
                    facts.published.push((binding.host_ip.clone(), host.to_string(), format!("{}/{}", binding.target, binding.protocol)));
                }
                plan.ports.push(binding);
                moved
            }
            _ => value,
        };
        plan.args.extend([format!("--{long}"), written]);
    }
    Ok(plan)
}

/// The flags the file's own `privileged`, `capAdd`, `securityOpt` and `init` stand for — run through
/// [`parse_run_args`] with `runArgs`, so they are judged the same way.
pub fn config_flags(dev: &DevContainer) -> Vec<String> {
    let mut out = Vec::new();
    if dev.privileged {
        out.push("--privileged".to_string());
    }
    for cap in &dev.cap_add {
        out.extend(["--cap-add".to_string(), cap.clone()]);
    }
    for opt in &dev.security_opt {
        out.extend(["--security-opt".to_string(), opt.clone()]);
    }
    if dev.init {
        out.push("--init".to_string());
    }
    out
}

/// The host ports `runArgs` publish, before any offset — for the proposal's preview. Best effort:
/// what does not parse is left to [`parse_run_args`] to refuse.
pub fn run_args_hosts(raw: &[String]) -> Vec<u16> {
    let tokens = expand_shorts(raw);
    let mut out = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        let t = &tokens[i];
        let value = if t == "-p" || t == "--publish" {
            i += 1;
            tokens.get(i).cloned()
        } else {
            t.strip_prefix("--publish=").or_else(|| t.strip_prefix("-p")).filter(|v| !v.is_empty()).map(|v| v.trim_start_matches('=').to_string())
        };
        if let Some(host) = value.and_then(|v| parse_publish(&v).ok()).and_then(|p| p.host).and_then(|h| h.split('-').next().and_then(|h| h.parse().ok())) {
            out.push(host);
        }
        i += 1;
    }
    out
}

/// Only the `-p` values of `runArgs` moved by `offset`, everything else as written — for the CLI's
/// override config, where the CLI itself reads every other flag.
pub fn shift_publish_args(raw: &[String], offset: u16) -> Result<(Vec<String>, Vec<PortBinding>), String> {
    let mut out = Vec::with_capacity(raw.len());
    let mut ports = Vec::new();
    let mut i = 0;
    while i < raw.len() {
        let t = raw[i].trim();
        if t == "-p" || t == "--publish" {
            let value = raw.get(i + 1).ok_or_else(|| format!("runArgs: {t} needs a value"))?;
            let (moved, binding) = shift_publish(value, offset)?;
            out.extend([t.to_string(), moved]);
            ports.push(binding);
            i += 2;
            continue;
        }
        let inline = t.strip_prefix("--publish=").map(|v| ("--publish=", v)).or_else(|| t.strip_prefix("-p").filter(|v| !v.is_empty()).map(|v| ("-p", v.trim_start_matches('='))));
        match inline {
            Some((flag, value)) => {
                let (moved, binding) = shift_publish(value, offset)?;
                out.push(if flag == "-p" { format!("-p{moved}") } else { format!("{flag}{moved}") });
                ports.push(binding);
            }
            None => out.push(raw[i].clone()),
        }
        i += 1;
    }
    Ok((out, ports))
}

// ----------------------------------------------------------------------------------- build

/// `build.options` CodeFlow passes to `build`: what changes how an image is built, not what the
/// build may read of the host (`--secret`, `--ssh`) or where its result goes (`--output`).
const BUILD_FLAGS: &[(&str, Arity)] = &[
    ("add-host", Val),
    ("network", Val),
    ("platform", Val),
    ("progress", Val),
    ("label", Val),
    ("build-arg", Val),
    ("cache-from", Val),
    ("target", Val),
    ("shm-size", Val),
    ("ulimit", Val),
    ("pull", Flag),
    ("no-cache", Flag),
    ("quiet", Flag),
];

/// What `build` is given for a Dockerfile devcontainer.
pub struct BuildPlan<'a> {
    pub tag: &'a str,
    pub dockerfile: &'a Path,
    pub context: &'a Path,
    pub args: &'a BTreeMap<String, String>,
    pub target: Option<&'a str>,
    pub options: &'a [String],
    pub cache_from: &'a [String],
}

/// `build -t <tag> -f <file> --build-arg K=V… [--target t] [--cache-from c]… <options…> <context>`,
/// and a warning for a build on the host's network.
pub fn build_args(plan: &BuildPlan) -> Result<(Vec<String>, Vec<EnvWarning>), String> {
    let mut args: Vec<String> = vec!["build".into(), "-t".into(), plan.tag.into(), "-f".into(), plan.dockerfile.to_string_lossy().into_owned()];
    let mut warnings = Vec::new();
    for (key, value) in plan.args {
        if !key.is_empty() && !key.contains('=') {
            args.extend(["--build-arg".into(), format!("{key}={value}")]);
        }
    }
    if let Some(target) = plan.target {
        crate::containers::engine::check_ref(target).map_err(|_| format!("build.target \"{target}\" is not a stage name"))?;
        args.extend(["--target".into(), target.into()]);
    }
    for cache in plan.cache_from {
        crate::containers::engine::check_ref(cache).map_err(|_| format!("build.cacheFrom \"{cache}\" is not an image"))?;
        args.extend(["--cache-from".into(), cache.clone()]);
    }
    let mut i = 0;
    while i < plan.options.len() {
        let token = plan.options[i].trim().to_string();
        i += 1;
        let Some(long) = token.strip_prefix("--") else {
            return Err(format!("build.options: \"{token}\" is not a flag CodeFlow builds with — {CLI_ADVICE}"));
        };
        let (name, inline) = match long.split_once('=') {
            Some((n, v)) => (n, Some(v.to_string())),
            None => (long, None),
        };
        let Some((_, arity)) = BUILD_FLAGS.iter().find(|f| f.0 == name) else {
            return Err(format!("build.options: \"--{name}\" is not a flag CodeFlow builds with — {CLI_ADVICE}"));
        };
        match arity {
            Flag => args.push(token.clone()),
            Val => {
                let value = match inline {
                    Some(v) => v,
                    None => {
                        let next = plan.options.get(i).cloned().ok_or_else(|| format!("build.options: --{name} needs a value"))?;
                        i += 1;
                        next
                    }
                };
                if name == "network" && value.trim() == "host" {
                    warnings.push(EnvWarning::new("hardening", "hostNetwork (build)"));
                }
                args.extend([format!("--{name}"), value]);
            }
        }
    }
    args.push(plan.context.to_string_lossy().into_owned());
    Ok((args, warnings))
}

// ------------------------------------------------------------------------------- the host

/// `initializeCommand` as argv: a string through the shell — `/bin/sh -c`, as the reference Dev
/// Containers CLI runs it, so the same file behaves the same on both paths (`cmd.exe /c` on
/// Windows) — a list as it is.
pub fn host_argv(command: &HostCommand, windows: bool) -> Vec<String> {
    match command {
        HostCommand::Shell(text) if windows => vec!["cmd.exe".into(), "/c".into(), text.clone()],
        HostCommand::Shell(text) => vec!["/bin/sh".into(), "-c".into(), text.clone()],
        HostCommand::Argv(argv) => argv.clone(),
    }
}

// ------------------------------------------------------------------------------ the CLI path

/// The single-container ports: `runArgs`' own first, then `forwardPorts` and `appPort` whose
/// container port `runArgs` did not already publish.
pub fn merge_ports(from_args: &[PortBinding], config: Vec<PortBinding>) -> Vec<PortBinding> {
    let mut out = from_args.to_vec();
    for port in config {
        if !out.iter().any(|p| p.target == port.target && p.protocol == port.protocol) {
            out.push(port);
        }
    }
    out
}

/// What `devcontainer up --override-config` is given: the file's own configuration (JSONC read, its
/// variables left for the CLI) with every host port moved by `offset`:
///
/// - one container: `forwardPorts` and `appPort` become `appPort` entries `127.0.0.1:<port+offset>:<port>`
///   (the CLI publishes `appPort`, and only forwards `forwardPorts` for an editor), and the `-p`
///   of `runArgs` move too;
/// - Compose: `compose_override` (the file [`super::plan_compose`] wrote) is appended to
///   `dockerComposeFile`, absolute, so the CLI's own `compose up` moves the ports with it.
///
/// The CLI reads an override config *instead of* the file but resolves its relative paths
/// (Dockerfile, context, Compose files) against `--config`, so the override can live in the cache.
pub fn cli_override(raw: &Value, dev: &DevContainer, offset: u16, compose_override: Option<&Path>) -> Result<(Value, Vec<PortBinding>), String> {
    let mut doc = raw.clone();
    let obj = doc.as_object_mut().ok_or("devcontainer.json is not an object")?;
    if obj.contains_key("dockerComposeFile") {
        if let Some(path) = compose_override {
            let mut files = match obj.get("dockerComposeFile") {
                Some(Value::String(s)) => vec![Value::String(s.clone())],
                Some(Value::Array(items)) => items.clone(),
                _ => vec![],
            };
            files.push(Value::String(path.to_string_lossy().into_owned()));
            obj.insert("dockerComposeFile".into(), Value::Array(files));
        }
        return Ok((doc, vec![]));
    }
    let mut from_args = Vec::new();
    if let Some(args) = obj.get("runArgs").and_then(Value::as_array) {
        let args: Vec<String> = args.iter().filter_map(Value::as_str).map(str::to_string).collect();
        let (moved, ports) = shift_publish_args(&args, offset)?;
        obj.insert("runArgs".into(), json!(moved));
        from_args = ports;
    }
    let ports = merge_ports(&from_args, super::single_ports(dev, offset)?);
    let app: Vec<Value> = ports
        .iter()
        .filter(|p| !from_args.contains(p))
        .filter_map(|p| p.host.map(|h| Value::String(format!("127.0.0.1:{h}:{}", p.target))))
        .collect();
    if app.is_empty() {
        obj.remove("appPort");
    } else {
        obj.insert("appPort".into(), Value::Array(app));
    }
    Ok((doc, ports))
}

/// The container id `devcontainer up` printed (`{"outcome":"success","containerId":…}`, the last JSON line).
pub fn cli_container_id(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .rev()
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .find_map(|doc| doc.get("containerId").and_then(Value::as_str).map(str::to_string))
        .filter(|id| crate::containers::engine::check_ref(id).is_ok())
}

/// The ports a container really published, from its `inspect` document — each with the base port
/// `planned` gave it, so the map still says where it came from. The IPv6 twin of an IPv4 binding is
/// one port, not two.
pub fn ports_from_inspect(doc: &Value, planned: &[PortBinding]) -> Vec<PortBinding> {
    let mut out: Vec<PortBinding> = Vec::new();
    for (key, list) in doc.pointer("/NetworkSettings/Ports").and_then(Value::as_object).into_iter().flatten() {
        let (port, protocol) = key.split_once('/').unwrap_or((key.as_str(), "tcp"));
        let Ok(target) = port.parse::<u16>() else { continue };
        for binding in list.as_array().into_iter().flatten() {
            let Some(host) = binding.get("HostPort").and_then(Value::as_str).and_then(|h| h.parse::<u16>().ok()) else { continue };
            if out.iter().any(|p| p.target == target && p.protocol == protocol && p.host == Some(host)) {
                continue;
            }
            let ip = binding.get("HostIp").and_then(Value::as_str).unwrap_or_default().to_string();
            let base = planned.iter().find(|p| p.target == target && p.host == Some(host)).and_then(|p| p.base);
            out.push(PortBinding { service: "dev".into(), target, protocol: protocol.to_string(), host_ip: ip, base, host: Some(host), host_end: None });
        }
    }
    out.sort_by_key(|p| (p.host, p.target));
    out
}

/// Where a generated file of the environment goes: never the checkout.
pub fn override_config_path(work_dir: &Path) -> PathBuf {
    work_dir.join("devcontainer.override.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn parse(list: &[&str]) -> Result<(RunArgsPlan, RunFacts), String> {
        let mut facts = RunFacts::default();
        let plan = parse_run_args(&args(list), 100, Path::new("/w/shop"), &mut facts)?;
        Ok((plan, facts))
    }

    #[test]
    fn run_args_are_parsed_rewritten_and_their_ports_moved() {
        let (plan, facts) = parse(&["-it", "--cap-add=SYS_PTRACE", "-p", "3000:3000", "--publish=0.0.0.0:9229:9229", "-p8080", "-e", "A=1", "--name", "mine", "--rm", "-v", "./cache:/cache:ro", "--env-file", ".devcontainer/dev.env", "--memory", "2g", "--cpus=1.5"]).unwrap();
        assert_eq!(
            plan.args.join(" "),
            "--interactive --tty --cap-add SYS_PTRACE --publish 127.0.0.1:3100:3000 --publish 0.0.0.0:9329:9229 --publish 127.0.0.1::8080 --env A=1 --volume /w/shop/cache:/cache:ro --env-file /w/shop/.devcontainer/dev.env --memory 2g --cpus 1.5"
        );
        assert_eq!(plan.dropped, vec!["--name mine", "--rm"]);
        assert_eq!(plan.ports.iter().map(|p| (p.base, p.host, p.target)).collect::<Vec<_>>(), vec![(Some(3000), Some(3100), 3000), (Some(9229), Some(9329), 9229), (None, None, 8080)]);
        assert_eq!(facts.cap_add, vec!["SYS_PTRACE"]);
        assert_eq!(facts.mounts, vec![("bind".to_string(), "/w/shop/cache".to_string(), false)]);
        assert_eq!((facts.memory, facts.nano_cpus), (2 * 1024 * 1024 * 1024, 1_500_000_000));
    }

    #[test]
    fn what_cannot_be_judged_is_refused() {
        for bad in [
            &["--frobnicate"][..],
            &["-Z"],
            &["ubuntu"],
            &["--volumes-from", "other"],
            &["--env-file", "../../.aws/credentials"],
            &["--env-file", "/etc/environment"],
            &["-v", "~/.ssh:/root/.ssh"],
            &["-v", "relative:target"],
            &["--label", "codeflow.env=someone-else"],
            &["-p"],
            &["--privileged=maybe"],
            &["--mount", "type=npipe,source=x,target=/y"],
        ] {
            assert!(parse(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn dangerous_flags_become_facts() {
        let (_, facts) = parse(&["--privileged", "--network=host", "--pid", "host", "--uts=host", "--security-opt", "systempaths=unconfined", "--device", "/dev/fuse", "-v", "/var/run/docker.sock:/var/run/docker.sock", "--mount", "type=bind,source=/etc,target=/host-etc"]).unwrap();
        assert!(facts.privileged);
        assert_eq!((facts.network.as_str(), facts.pid.as_str(), facts.devices), ("host", "host", 1));
        assert_eq!(facts.escapes, vec!["--uts=host", "--security-opt systempaths=unconfined"]);
        let doc = facts.document();
        assert_eq!(doc["HostConfig"]["Privileged"], true);
        assert_eq!(doc["Mounts"][0]["Source"], "/var/run/docker.sock");
        let (_, off) = parse(&["--privileged=false"]).unwrap();
        assert!(!off.privileged);
    }

    #[test]
    fn the_policy_refuses_what_it_refuses_elsewhere_and_flags_what_it_allows() {
        let home = Path::new("/Users/me");
        let rules = policy::SecurityPolicy::default();
        let (_, mut facts) = parse(&["--privileged", "-v", "/var/run/docker.sock:/var/run/docker.sock", "--uts=host"]).unwrap();
        facts.user = "node".into();
        let verdict = judge(&rules, &facts, &policy::Facts::default(), Some(home));
        assert!(verdict.blocked());
        let rules_hit: Vec<&str> = verdict.violations.iter().map(|v| v.rule.as_str()).collect();
        assert!(rules_hit.contains(&"privileged") && rules_hit.contains(&"engineSocket"), "{rules_hit:?}");
        assert!(verdict.violations.iter().any(|v| v.detail == "--uts=host"));
        assert!(verdict.refusal().contains("security policy"));

        let (_, home_secret) = parse(&["-v", "/Users/me/.ssh:/root/.ssh:ro"]).unwrap();
        assert!(judge(&rules, &home_secret, &policy::Facts::default(), Some(home)).blocked(), "the user's secrets are a host path");

        let open = policy::SecurityPolicy { no_privileged: false, no_engine_socket: false, no_host_mounts: false, ..Default::default() };
        let allowed = judge(&open, &facts, &policy::Facts::default(), Some(home));
        assert!(!allowed.blocked());
        let said: Vec<&str> = allowed.warnings.iter().map(|w| w.subject.as_str()).collect();
        assert!(said.contains(&"privileged") && said.contains(&"engineSocket /var/run/docker.sock") && said.contains(&"--uts=host"), "{said:?}");

        let (_, plain) = parse(&["--cap-add", "CHOWN", "-v", "/w/shop:/src"]).unwrap();
        let fine = judge(&rules, &plain, &policy::Facts::default(), Some(home));
        assert!(!fine.blocked() && fine.warnings.is_empty(), "{fine:?}");
        // A debugger's SYS_PTRACE is a capability the hardening rules call root-like: the default
        // policy refuses it here as it does in the Run dialog.
        let (_, ptrace) = parse(&["--cap-add", "SYS_PTRACE"]).unwrap();
        assert!(judge(&rules, &ptrace, &policy::Facts::default(), Some(home)).blocked());
    }

    #[test]
    fn mounts_become_mount_values() {
        let mut facts = RunFacts::default();
        let spec = |text: &str| devcontainer::parse_mount_text(text, None).unwrap();
        assert_eq!(mount_value(&spec("type=bind,source=/w/shop/../data,target=/data,consistency=cached"), &mut facts).unwrap(), "type=bind,source=/w/data,target=/data,consistency=cached");
        assert_eq!(mount_value(&spec("source=node-modules,target=/w/node_modules,type=volume"), &mut facts).unwrap(), "type=volume,source=node-modules,target=/w/node_modules");
        assert_eq!(mount_value(&spec("type=tmpfs,target=/tmp,tmpfs-size=64m"), &mut facts).unwrap(), "type=tmpfs,target=/tmp,tmpfs-size=64m");
        assert_eq!(mount_value(&spec("type=bind,\"source=/tmp/a,b\",target=/ab,ro"), &mut facts).unwrap(), "type=bind,\"source=/tmp/a,b\",target=/ab,readonly");
        assert_eq!(facts.mounts.len(), 4);
        assert_eq!(facts.mounts[3], ("bind".to_string(), "/tmp/a,b".to_string(), false));
        for bad in ["type=bind,source=relative,target=/x", "type=volume,source=-bad,target=/x", "type=tmpfs,source=x,target=/x", "type=bind,source=/x,target=relative", "type=bind,source=/x,target=/y,evil=1"] {
            assert!(mount_value(&spec(bad), &mut RunFacts::default()).is_err(), "{bad}");
        }
    }

    #[test]
    fn publish_values_are_read_in_every_form() {
        assert_eq!(parse_publish("8080").unwrap(), Publish { ip: "".into(), host: None, container: "8080".into(), protocol: "tcp".into() });
        assert_eq!(parse_publish("127.0.0.1::80/udp").unwrap().protocol, "udp");
        assert_eq!(parse_publish("[::1]:8080:80").unwrap().ip, "::1");
        assert_eq!(shift_publish("8000-8002:8000-8002", 10).unwrap().0, "127.0.0.1:8010-8012:8000-8002");
        assert_eq!(shift_publish("[::1]:8080:80/udp", 1).unwrap().0, "[::1]:8081:80/udp");
        for bad in ["x", "1:2:3:4", "80/icmp", "0:80", "65500:80"] {
            assert!(shift_publish(bad, 100).is_err(), "{bad}");
        }
        assert_eq!(run_args_hosts(&args(&["-p", "3000:3000", "--publish=9000:9", "-p8080", "-p5000:5"])), vec![3000, 9000, 5000]);
    }

    #[test]
    fn build_options_are_allowed_by_name() {
        let args_map = BTreeMap::from([("V".to_string(), "1".to_string())]);
        let (argv, warnings) = build_args(&BuildPlan {
            tag: "t:latest",
            dockerfile: Path::new("/w/Dockerfile"),
            context: Path::new("/w"),
            args: &args_map,
            target: Some("dev"),
            options: &args(&["--network=host", "--platform", "linux/amd64", "--no-cache"]),
            cache_from: &args(&["ghcr.io/x/cache"]),
        })
        .unwrap();
        assert_eq!(argv.join(" "), "build -t t:latest -f /w/Dockerfile --build-arg V=1 --target dev --cache-from ghcr.io/x/cache --network host --platform linux/amd64 --no-cache /w");
        assert_eq!(warnings, vec![EnvWarning::new("hardening", "hostNetwork (build)")]);
        let refuse = |options: &[&str], target: Option<&str>| {
            build_args(&BuildPlan { tag: "t", dockerfile: Path::new("/w/D"), context: Path::new("/w"), args: &BTreeMap::new(), target, options: &args(options), cache_from: &[] }).is_err()
        };
        assert!(refuse(&["--secret", "id=x,src=/Users/me/.npmrc"], None));
        assert!(refuse(&["--output=type=local,dest=/"], None));
        assert!(refuse(&["positional"], None));
        assert!(refuse(&[], Some("--evil")));
    }

    #[test]
    fn host_commands_go_through_sh_or_as_argv() {
        assert_eq!(host_argv(&HostCommand::Shell("echo hi > .env".into()), false), vec!["/bin/sh", "-c", "echo hi > .env"]);
        assert_eq!(host_argv(&HostCommand::Shell("echo hi".into()), true), vec!["cmd.exe", "/c", "echo hi"]);
        assert_eq!(host_argv(&HostCommand::Argv(args(&["./prep.sh", "a b"])), false), vec!["./prep.sh", "a b"]);
    }

    #[test]
    fn the_cli_override_moves_forward_ports_app_ports_and_run_args() {
        let text = r#"{ "image": "node", "forwardPorts": [3000, 5173], "appPort": ["8080:80"], "runArgs": ["--init", "-p", "5173:5173"], "name": "x" }"#;
        let raw = devcontainer::read_json(text).unwrap();
        let dev = devcontainer::parse(text).unwrap();
        let (doc, ports) = cli_override(&raw, &dev, 200, None).unwrap();
        assert_eq!(doc["runArgs"], json!(["--init", "-p", "127.0.0.1:5373:5173"]));
        assert_eq!(doc["appPort"], json!(["127.0.0.1:3200:3000", "127.0.0.1:8280:80"]));
        assert_eq!(doc["forwardPorts"], json!([3000, 5173]), "kept for an editor");
        assert_eq!(doc["name"], "x");
        assert_eq!(ports.iter().map(|p| (p.target, p.host)).collect::<Vec<_>>(), vec![(5173, Some(5373)), (3000, Some(3200)), (80, Some(8280))]);

        let compose_text = r#"{ "dockerComposeFile": "../compose.yml", "service": "app" }"#;
        let (doc, ports) = cli_override(&devcontainer::read_json(compose_text).unwrap(), &devcontainer::parse(compose_text).unwrap(), 100, Some(Path::new("/cache/e1/compose.override.yml"))).unwrap();
        assert_eq!(doc["dockerComposeFile"], json!(["../compose.yml", "/cache/e1/compose.override.yml"]));
        assert!(ports.is_empty() && doc.get("appPort").is_none());
    }

    #[test]
    fn published_ports_are_read_back_from_inspect() {
        let doc = json!({ "NetworkSettings": { "Ports": {
            "3000/tcp": [{ "HostIp": "127.0.0.1", "HostPort": "3100" }],
            "9229/tcp": null,
            "53/udp": [{ "HostIp": "0.0.0.0", "HostPort": "49153" }, { "HostIp": "::", "HostPort": "49153" }]
        } } });
        let planned = vec![PortBinding { service: "dev".into(), target: 3000, protocol: "tcp".into(), host_ip: "127.0.0.1".into(), base: Some(3000), host: Some(3100), host_end: None }];
        let read = ports_from_inspect(&doc, &planned);
        assert_eq!(read.iter().map(|p| (p.target, p.protocol.as_str(), p.host, p.base)).collect::<Vec<_>>(), vec![(3000, "tcp", Some(3100), Some(3000)), (53, "udp", Some(49153), None)]);
        assert_eq!(cli_container_id("[1] Start\n{\"outcome\":\"success\",\"containerId\":\"abc123\",\"remoteUser\":\"node\"}\n").as_deref(), Some("abc123"));
        assert_eq!(cli_container_id("{\"outcome\":\"error\"}"), None);
    }

    #[test]
    fn sizes_read_like_the_engines() {
        assert_eq!(size_bytes("512m").unwrap(), 512 * 1024 * 1024);
        assert_eq!(size_bytes("1.5G").unwrap(), 1536 * 1024 * 1024);
        assert_eq!(size_bytes("512mb").unwrap(), 512 * 1024 * 1024);
        assert_eq!(size_bytes("1024").unwrap(), 1024);
        assert!(size_bytes("lots").is_err());
    }
}
