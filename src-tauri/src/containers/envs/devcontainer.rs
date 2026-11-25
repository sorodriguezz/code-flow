//! `devcontainer.json`, read well enough to run it without the Dev Containers CLI.
//!
//! When `devcontainer` is installed, an environment can simply call `devcontainer up` and get the
//! whole specification — CodeFlow hands it an override config with the ports moved by the
//! environment's offset (see `direct::cli_override`). Without it the common shapes are run directly
//! with the engine's own commands:
//!
//! - **image** (`"image"`) → `run -d` with the checkout mounted at `workspaceFolder` (or as
//!   `workspaceMount` says), `mounts`, `runArgs` (parsed and judged, see `direct`), the
//!   `forwardPorts` and `appPort` published on localhost at `port + offset`, `containerEnv`,
//!   `privileged` / `capAdd` / `securityOpt` / `init`.
//! - **Dockerfile** (`"build": { "dockerfile", "context", "args", "target", "options", "cacheFrom" }`)
//!   → `build` first, then the same `run`.
//! - **Compose** (`"dockerComposeFile"`) → the Compose case, with `service` as the one the lifecycle
//!   commands run in.
//!
//! `initializeCommand` runs on the host, in the checkout, before anything is created or started;
//! then `onCreateCommand`, `updateContentCommand` and `postCreateCommand` the first time and
//! `postStartCommand` every time, through `exec`. **Not run directly:** `features` (the CLI's own
//! installer — CodeFlow does not reimplement it; an environment either uses the CLI or is created
//! explicitly "without features") and `postAttachCommand` (nothing attaches).
//!
//! Variables (`${localWorkspaceFolder}`, `${containerWorkspaceFolder}`, `${localEnv:VAR}`,
//! `${devcontainerId}`, `…Basename`) are replaced in every string by [`substitute_config`] — the
//! discovery of a repository reads the file without them, as it is written.
//!
//! JSONC is read by [`strip_jsonc`] (comments and trailing commas out, strings untouched), then by
//! `serde_json` — the format's only differences from JSON are those two.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

/// Comments (`//`, `/* */`) and trailing commas removed, every string copied as it is — a `"//"`
/// inside a URL stays.
pub fn strip_jsonc(text: &str) -> String {
    let chars: Vec<char> = text.trim_start_matches('\u{feff}').chars().collect();
    // Pass one: comments out, strings untouched.
    let mut plain = String::with_capacity(text.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '"' {
            plain.push(c);
            i += 1;
            while i < chars.len() {
                plain.push(chars[i]);
                if chars[i] == '\\' && i + 1 < chars.len() {
                    plain.push(chars[i + 1]);
                    i += 2;
                    continue;
                }
                i += 1;
                if chars[i - 1] == '"' {
                    break;
                }
            }
            continue;
        }
        if c == '/' && chars.get(i + 1) == Some(&'/') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && chars.get(i + 1) == Some(&'*') {
            i += 2;
            while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                i += 1;
            }
            i += 2;
            plain.push(' ');
            continue;
        }
        plain.push(c);
        i += 1;
    }
    // Pass two: a comma whose next meaningful character closes the object or array goes.
    let chars: Vec<char> = plain.chars().collect();
    let mut out = String::with_capacity(plain.len());
    let mut in_string = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if in_string {
            out.push(c);
            if c == '\\' && i + 1 < chars.len() {
                out.push(chars[i + 1]);
                i += 2;
                continue;
            }
            if c == '"' {
                in_string = false;
            }
        } else if c == '"' {
            in_string = true;
            out.push(c);
        } else if c == ',' && matches!(chars[i + 1..].iter().find(|ch| !ch.is_whitespace()), Some('}') | Some(']') | None) {
            // dropped
        } else {
            out.push(c);
        }
        i += 1;
    }
    out
}

/// Where a devcontainer's containers come from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Source {
    Image { image: String },
    /// Paths relative to the `devcontainer.json`'s folder, as the file writes them.
    #[serde(rename_all = "camelCase")]
    Dockerfile {
        dockerfile: String,
        context: String,
        args: BTreeMap<String, String>,
        /// `build.target`: the stage to stop at.
        target: Option<String>,
        /// `build.options`: extra `build` flags, judged by `direct::build_args`.
        options: Vec<String>,
        cache_from: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    Compose { files: Vec<String>, service: String, run_services: Vec<String> },
    /// None of the three: nothing this can run (the CLI may).
    Unknown,
}

/// A lifecycle command as argv lists, in the order they run (an object's commands run one by one).
pub type Lifecycle = Vec<Vec<String>>;

/// A command for the host (`initializeCommand`): a string is a shell's, a list is argv as it is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum HostCommand {
    Shell(String),
    Argv(Vec<String>),
}

impl HostCommand {
    /// The command as the create dialog shows it — and as it is approved, word for word.
    pub fn display(&self) -> String {
        match self {
            HostCommand::Shell(text) => text.clone(),
            HostCommand::Argv(argv) => argv
                .iter()
                .map(|word| if word.is_empty() || word.contains(|c: char| c.is_whitespace() || c == '"' || c == '\'') { format!("{word:?}") } else { word.clone() })
                .collect::<Vec<_>>()
                .join(" "),
        }
    }
}

/// One entry of `mounts` (or `workspaceMount`), its variables already replaced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MountSpec {
    /// `bind`, `volume` or `tmpfs` (what `--mount` defaults to when unsaid: `volume`).
    pub kind: String,
    pub source: String,
    pub target: String,
    pub read_only: bool,
    /// The other `key=value` pairs (`consistency`, `bind-propagation`, `volume-opt`…), in order.
    pub extra: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevContainer {
    pub name: String,
    pub source: Source,
    pub workspace_folder: Option<String>,
    /// `forwardPorts` numbers, and `appPort` mappings, as (host, container) before the offset.
    pub ports: Vec<(u16, u16)>,
    /// `appPort` alone — the only ones the Dev Containers CLI publishes by itself.
    pub app_ports: Vec<(u16, u16)>,
    pub container_env: BTreeMap<String, String>,
    pub remote_env: BTreeMap<String, String>,
    pub container_user: Option<String>,
    pub remote_user: Option<String>,
    pub override_command: bool,
    /// `runArgs`, as written: `direct::parse_run_args` judges them before they reach `run`.
    pub run_args: Vec<String>,
    pub mounts: Vec<MountSpec>,
    pub workspace_mount: Option<MountSpec>,
    pub privileged: bool,
    pub cap_add: Vec<String>,
    pub security_opt: Vec<String>,
    pub init: bool,
    pub initialize: Vec<HostCommand>,
    pub on_create: Lifecycle,
    pub update_content: Lifecycle,
    pub post_create: Lifecycle,
    pub post_start: Lifecycle,
    /// The ids of `features` — installed only by the CLI.
    pub features: Vec<String>,
    /// The keys this file sets that change how it runs, in [`TRACKED`] order.
    pub present: Vec<String>,
}

/// The keys whose presence the create dialog reports as honoured or ignored, on each path.
pub const TRACKED: &[&str] = &[
    "image", "build", "build.args", "build.target", "build.options", "build.cacheFrom", "dockerComposeFile", "runServices", "workspaceFolder",
    "workspaceMount", "mounts", "runArgs", "forwardPorts", "appPort", "containerEnv", "remoteEnv", "containerUser", "remoteUser", "overrideCommand",
    "privileged", "capAdd", "securityOpt", "init", "initializeCommand", "onCreateCommand", "updateContentCommand", "postCreateCommand",
    "postStartCommand", "postAttachCommand", "features",
];

/// What the direct run of one container (an image or a Dockerfile) applies.
const DIRECT_SINGLE: &[&str] = &[
    "image", "build", "build.args", "build.target", "build.options", "build.cacheFrom", "workspaceFolder", "workspaceMount", "mounts", "runArgs",
    "forwardPorts", "appPort", "containerEnv", "remoteEnv", "containerUser", "remoteUser", "overrideCommand", "privileged", "capAdd", "securityOpt",
    "init", "initializeCommand", "onCreateCommand", "updateContentCommand", "postCreateCommand", "postStartCommand",
];

/// What the direct run of a Compose devcontainer applies: the Compose files say the rest.
const DIRECT_COMPOSE: &[&str] = &[
    "dockerComposeFile", "runServices", "workspaceFolder", "remoteEnv", "containerUser", "remoteUser", "initializeCommand", "onCreateCommand",
    "updateContentCommand", "postCreateCommand", "postStartCommand",
];

impl DevContainer {
    fn is_compose(&self) -> bool {
        matches!(self.source, Source::Compose { .. })
    }

    /// The keys present that the direct path applies (`features` aside: it has its own notice).
    pub fn honoured_direct(&self) -> Vec<String> {
        let applies = if self.is_compose() { DIRECT_COMPOSE } else { DIRECT_SINGLE };
        self.present.iter().filter(|k| applies.contains(&k.as_str())).cloned().collect()
    }

    /// The keys present that the direct path leaves out.
    pub fn ignored_direct(&self) -> Vec<String> {
        let applies = if self.is_compose() { DIRECT_COMPOSE } else { DIRECT_SINGLE };
        self.present.iter().filter(|k| k.as_str() != "features" && !applies.contains(&k.as_str())).cloned().collect()
    }

    /// The keys present that `devcontainer up` leaves out: for a Compose devcontainer it publishes
    /// what the Compose files publish, not `forwardPorts`.
    pub fn ignored_cli(&self) -> Vec<String> {
        self.present.iter().filter(|k| self.is_compose() && k.as_str() == "forwardPorts").cloned().collect()
    }

    pub fn honoured_cli(&self) -> Vec<String> {
        let ignored = self.ignored_cli();
        self.present.iter().filter(|k| !ignored.contains(k)).cloned().collect()
    }

    /// `initializeCommand` as shown and approved.
    pub fn initialize_display(&self) -> Vec<String> {
        self.initialize.iter().map(HostCommand::display).collect()
    }
}

// ------------------------------------------------------------------------------- variables

/// What `${…}` stands for in one environment's `devcontainer.json`.
#[derive(Debug, Clone, Default)]
pub struct Vars {
    /// The branch's checkout.
    pub local_workspace_folder: String,
    pub container_workspace_folder: String,
    pub devcontainer_id: String,
    /// `${localEnv:…}`: this process's environment, taken once.
    pub env: BTreeMap<String, String>,
}

impl Vars {
    /// For a checkout: `containerWorkspaceFolder` is the spec's default until the file says another.
    pub fn new(checkout: &Path, devcontainer_id: String, env: BTreeMap<String, String>) -> Self {
        Vars { local_workspace_folder: checkout.to_string_lossy().into_owned(), container_workspace_folder: default_workspace_folder(checkout), devcontainer_id, env }
    }
}

fn basename(path: &str) -> String {
    path.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or_default().to_string()
}

/// `text` with the spec's variables replaced. `${localEnv:NAME:default}` takes its default when
/// `NAME` is unset (and is empty without one); `${containerEnv:…}` and anything unknown stay as
/// written — the first is the container's to resolve.
pub fn substitute(text: &str, vars: &Vars) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("${") {
        out.push_str(&rest[..at]);
        let after = &rest[at + 2..];
        let Some(close) = after.find('}') else {
            out.push_str(&rest[at..]);
            return out;
        };
        let inner = &after[..close];
        let value = match inner {
            "localWorkspaceFolder" => Some(vars.local_workspace_folder.clone()),
            "localWorkspaceFolderBasename" => Some(basename(&vars.local_workspace_folder)),
            "containerWorkspaceFolder" => Some(vars.container_workspace_folder.clone()),
            "containerWorkspaceFolderBasename" => Some(basename(&vars.container_workspace_folder)),
            "devcontainerId" => Some(vars.devcontainer_id.clone()),
            _ => inner.strip_prefix("localEnv:").or_else(|| inner.strip_prefix("env:")).map(|spec| {
                let (name, default) = spec.split_once(':').unwrap_or((spec, ""));
                vars.env.get(name.trim()).cloned().unwrap_or_else(|| default.to_string())
            }),
        };
        match value {
            Some(value) => out.push_str(&value),
            None => out.push_str(&rest[at..at + 2 + close + 1]),
        }
        rest = &after[close + 1..];
    }
    out.push_str(rest);
    out
}

fn substitute_value(value: &Value, vars: &Vars) -> Value {
    match value {
        Value::String(s) => Value::String(substitute(s, vars)),
        Value::Array(items) => Value::Array(items.iter().map(|v| substitute_value(v, vars)).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), substitute_value(v, vars))).collect()),
        other => other.clone(),
    }
}

/// Every string of the configuration with its variables replaced — except `mounts` and
/// `workspaceMount`, which are split into fields first (a path with a comma must not split them),
/// and whose fields [`parse_mount_text`] replaces. `containerWorkspaceFolder` follows the file's
/// own `workspaceFolder` when it has one. The variables as they then stand are returned with it.
pub fn substitute_config(raw: &Value, vars: &Vars) -> (Value, Vars) {
    let mut vars = vars.clone();
    if let Some(folder) = raw.get("workspaceFolder").and_then(Value::as_str).map(str::trim).filter(|f| !f.is_empty()) {
        vars.container_workspace_folder = substitute(folder, &vars);
    }
    let doc = match raw {
        Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), if k == "mounts" || k == "workspaceMount" { v.clone() } else { substitute_value(v, &vars) })).collect()),
        other => other.clone(),
    };
    (doc, vars)
}

/// `${devcontainerId}` as the Dev Containers CLI makes it from its id labels: the SHA-256 of the
/// labels as JSON with sorted keys, as one number in base 32, padded to 52 digits — so a volume
/// named with it is the same one whichever path started the environment.
pub fn devcontainer_id(labels: &BTreeMap<String, String>) -> String {
    use sha2::{Digest, Sha256};
    let json = serde_json::to_string(labels).unwrap_or_default();
    let hash = Sha256::digest(json.as_bytes());
    const DIGITS: &[u8; 32] = b"0123456789abcdefghijklmnopqrstuv";
    let bit = |k: usize| -> u8 { if k >= 256 { 0 } else { (hash[31 - k / 8] >> (k % 8)) & 1 } };
    let mut out: Vec<u8> = (0..52).map(|digit| {
        let value = (0..5).fold(0u8, |acc, b| acc | (bit(digit * 5 + b) << b));
        DIGITS[value as usize]
    }).collect();
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

// ---------------------------------------------------------------------------------- mounts

/// Splits on commas outside double quotes, as `--mount` (a CSV record) does; `""` inside quotes is one `"`.
fn csv_fields(text: &str) -> Vec<String> {
    let mut fields = vec![String::new()];
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if quoted && chars.peek() == Some(&'"') => {
                chars.next();
                fields.last_mut().unwrap().push('"');
            }
            '"' => quoted = !quoted,
            ',' if !quoted => fields.push(String::new()),
            other => fields.last_mut().unwrap().push(other),
        }
    }
    fields.into_iter().map(|f| f.trim().to_string()).filter(|f| !f.is_empty()).collect()
}

fn truthy(value: &str) -> Result<bool, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "" | "true" | "1" => Ok(true),
        "false" | "0" => Ok(false),
        other => Err(format!("\"{other}\" is not true or false")),
    }
}

/// `type=bind,source=${localWorkspaceFolder}/cache,target=/cache,readonly`, each field's variables
/// replaced when `vars` are given.
pub fn parse_mount_text(text: &str, vars: Option<&Vars>) -> Result<MountSpec, String> {
    let sub = |v: &str| vars.map(|vars| substitute(v, vars)).unwrap_or_else(|| v.to_string());
    let mut spec = MountSpec { kind: "volume".into(), source: String::new(), target: String::new(), read_only: false, extra: vec![] };
    for field in csv_fields(text) {
        let (key, value) = field.split_once('=').map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string())).unwrap_or((field.trim().to_ascii_lowercase(), String::new()));
        match key.as_str() {
            "type" => spec.kind = value.to_ascii_lowercase(),
            "source" | "src" => spec.source = sub(&value),
            "target" | "destination" | "dst" => spec.target = sub(&value),
            "readonly" | "ro" => spec.read_only = truthy(&value).map_err(|e| format!("mount \"{text}\": {e}"))?,
            // The CLI's own marker for a volume it must not create; the engine has no such key.
            "external" => {}
            _ => spec.extra.push((key, sub(&value))),
        }
    }
    if spec.target.is_empty() {
        return Err(format!("the mount \"{text}\" has no target"));
    }
    Ok(spec)
}

/// The object form: `{ "type": "volume", "source": "cache-${devcontainerId}", "target": "/cache" }`.
fn parse_mount_object(map: &serde_json::Map<String, Value>, vars: Option<&Vars>) -> Result<MountSpec, String> {
    let sub = |v: &str| vars.map(|vars| substitute(v, vars)).unwrap_or_else(|| v.to_string());
    let text = |key: &str| map.get(key).and_then(Value::as_str).map(str::trim).unwrap_or_default().to_string();
    let target = sub(&text("target"));
    if target.is_empty() {
        return Err("a mount of devcontainer.json has no target".into());
    }
    let kind = text("type").to_ascii_lowercase();
    Ok(MountSpec {
        kind: if kind.is_empty() { "volume".into() } else { kind },
        source: sub(&text("source")),
        target,
        read_only: map.get("readonly").or_else(|| map.get("readOnly")).and_then(Value::as_bool).unwrap_or(false),
        extra: vec![],
    })
}

// ----------------------------------------------------------------------------------- parse

fn lifecycle(value: Option<&Value>) -> Lifecycle {
    let one = |v: &Value| -> Option<Vec<String>> {
        match v {
            Value::String(s) if !s.trim().is_empty() => Some(vec!["/bin/sh".into(), "-c".into(), s.clone()]),
            Value::Array(items) => {
                let argv: Vec<String> = items.iter().filter_map(Value::as_str).map(str::to_string).collect();
                (!argv.is_empty()).then_some(argv)
            }
            _ => None,
        }
    };
    match value {
        Some(Value::Object(map)) => map.values().filter_map(one).collect(),
        Some(other) => one(other).into_iter().collect(),
        None => Vec::new(),
    }
}

fn host_commands(value: Option<&Value>) -> Vec<HostCommand> {
    let one = |v: &Value| -> Option<HostCommand> {
        match v {
            Value::String(s) if !s.trim().is_empty() => Some(HostCommand::Shell(s.clone())),
            Value::Array(items) => {
                let argv: Vec<String> = items.iter().filter_map(Value::as_str).map(str::to_string).collect();
                (!argv.is_empty()).then_some(HostCommand::Argv(argv))
            }
            _ => None,
        }
    };
    match value {
        Some(Value::Object(map)) => map.values().filter_map(one).collect(),
        Some(other) => one(other).into_iter().collect(),
        None => Vec::new(),
    }
}

fn strings(value: Option<&Value>) -> BTreeMap<String, String> {
    value
        .and_then(Value::as_object)
        .map(|m| m.iter().filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string()))).collect())
        .unwrap_or_default()
}

/// A string or a list of strings.
fn string_list(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::String(s)) if !s.trim().is_empty() => vec![s.clone()],
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_str).map(str::to_string).collect(),
        _ => vec![],
    }
}

fn port_number(value: &Value) -> Option<u16> {
    match value {
        Value::Number(n) => n.as_u64().filter(|p| *p > 0 && *p <= u16::MAX as u64).map(|p| p as u16),
        Value::String(s) => s.trim().parse().ok().filter(|p: &u16| *p > 0),
        _ => None,
    }
}

/// `appPort`: `3000`, `"8080:80"`, or a list of either.
fn app_ports(value: Option<&Value>) -> Vec<(u16, u16)> {
    let one = |v: &Value| -> Option<(u16, u16)> {
        if let Some(port) = port_number(v) {
            return Some((port, port));
        }
        let text = v.as_str()?;
        let parts: Vec<&str> = text.split(':').collect();
        let (host, container) = match parts[..] {
            [host, container] | [_, host, container] => (host, container),
            _ => return None,
        };
        let container = container.split('/').next().unwrap_or(container);
        Some((host.trim().parse().ok()?, container.trim().parse().ok()?))
    };
    match value {
        Some(Value::Array(items)) => items.iter().filter_map(one).collect(),
        Some(other) => one(other).into_iter().collect(),
        None => Vec::new(),
    }
}

/// The file as JSON — an object, comments and trailing commas allowed.
pub fn read_json(text: &str) -> Result<Value, String> {
    let doc: Value = serde_json::from_str(&strip_jsonc(text)).map_err(|e| format!("devcontainer.json is not valid JSON: {e}"))?;
    if !doc.is_object() {
        return Err("devcontainer.json is not an object".into());
    }
    Ok(doc)
}

/// The file as it is written, variables left alone — what discovery shows.
pub fn parse(text: &str) -> Result<DevContainer, String> {
    parse_with(text, None)
}

/// The file for one environment: its variables replaced with `vars` when given.
pub fn parse_with(text: &str, vars: Option<&Vars>) -> Result<DevContainer, String> {
    let raw = read_json(text)?;
    match vars {
        Some(vars) => {
            let (doc, vars) = substitute_config(&raw, vars);
            from_value(&doc, Some(&vars))
        }
        None => from_value(&raw, None),
    }
}

fn set(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Object(m)) => !m.is_empty(),
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::String(s)) => !s.trim().is_empty(),
        Some(Value::Bool(b)) => *b,
        Some(_) => true,
    }
}

pub fn from_value(doc: &Value, vars: Option<&Vars>) -> Result<DevContainer, String> {
    let obj = doc.as_object().ok_or("devcontainer.json is not an object")?;
    let get = |key: &str| obj.get(key);
    let text_of = |key: &str| get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);

    let build = get("build").and_then(Value::as_object);
    let in_build = |key: &str| build.and_then(|b| b.get(key));
    let mut present: Vec<String> = Vec::new();
    for key in TRACKED {
        let found = match key.strip_prefix("build.") {
            Some(sub) => set(in_build(sub)),
            // `overrideCommand: false` and `init: false` are choices too, but only `true` changes `run`.
            None if *key == "overrideCommand" => get(key).and_then(Value::as_bool) == Some(false),
            None => set(get(key)) || (*key == "build" && get("dockerFile").is_some()),
        };
        if found {
            present.push(key.to_string());
        }
    }

    let dockerfile = in_build("dockerfile").and_then(Value::as_str).map(str::to_string).or_else(|| text_of("dockerFile"));
    let source = if let Some(compose) = get("dockerComposeFile") {
        let files = string_list(Some(compose));
        let service = text_of("service").ok_or("a Compose devcontainer names its \"service\"")?;
        let run_services = get("runServices").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
        Source::Compose { files, service, run_services }
    } else if let Some(image) = text_of("image") {
        Source::Image { image }
    } else if let Some(dockerfile) = dockerfile {
        let context = in_build("context").and_then(Value::as_str).or_else(|| get("context").and_then(Value::as_str)).unwrap_or(".").to_string();
        Source::Dockerfile {
            dockerfile,
            context,
            args: strings(in_build("args")),
            target: in_build("target").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty()).map(str::to_string),
            options: string_list(in_build("options")),
            cache_from: string_list(in_build("cacheFrom")),
        }
    } else {
        Source::Unknown
    };

    let mut ports: Vec<(u16, u16)> = get("forwardPorts").and_then(Value::as_array).map(|a| a.iter().filter_map(port_number).map(|p| (p, p)).collect()).unwrap_or_default();
    let published = app_ports(get("appPort"));
    for mapping in &published {
        if !ports.iter().any(|p| p.1 == mapping.1) {
            ports.push(*mapping);
        }
    }

    let mut mounts = Vec::new();
    for entry in get("mounts").and_then(Value::as_array).into_iter().flatten() {
        match entry {
            Value::String(text) if !text.trim().is_empty() => mounts.push(parse_mount_text(text, vars)?),
            Value::Object(map) => mounts.push(parse_mount_object(map, vars)?),
            Value::String(_) | Value::Null => {}
            other => return Err(format!("{other} is not a mount")),
        }
    }
    let workspace_mount = match get("workspaceMount").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty()) {
        Some(text) => Some(parse_mount_text(text, vars)?),
        None => None,
    };
    let features = get("features").and_then(Value::as_object).map(|m| m.keys().cloned().collect()).unwrap_or_default();

    Ok(DevContainer {
        name: text_of("name").unwrap_or_default(),
        source,
        workspace_folder: text_of("workspaceFolder"),
        ports,
        app_ports: published,
        container_env: strings(get("containerEnv")),
        remote_env: strings(get("remoteEnv")),
        container_user: text_of("containerUser"),
        remote_user: text_of("remoteUser"),
        override_command: get("overrideCommand").and_then(Value::as_bool).unwrap_or(true),
        run_args: get("runArgs").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default(),
        mounts,
        workspace_mount,
        privileged: get("privileged").and_then(Value::as_bool).unwrap_or(false),
        cap_add: string_list(get("capAdd")),
        security_opt: string_list(get("securityOpt")),
        init: get("init").and_then(Value::as_bool).unwrap_or(false),
        initialize: host_commands(get("initializeCommand")),
        on_create: lifecycle(get("onCreateCommand")),
        update_content: lifecycle(get("updateContentCommand")),
        post_create: lifecycle(get("postCreateCommand")),
        post_start: lifecycle(get("postStartCommand")),
        features,
        present,
    })
}

/// The `devcontainer.json` files of a checkout, relative to it: `.devcontainer/devcontainer.json`,
/// `.devcontainer.json`, and each `.devcontainer/<name>/devcontainer.json`.
pub fn find_configs(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for rel in [".devcontainer/devcontainer.json", ".devcontainer.json"] {
        if root.join(rel).is_file() {
            out.push(rel.to_string());
        }
    }
    if let Ok(entries) = std::fs::read_dir(root.join(".devcontainer")) {
        let mut named: Vec<String> = entries
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| root.join(".devcontainer").join(name).join("devcontainer.json").is_file())
            .map(|name| format!(".devcontainer/{name}/devcontainer.json"))
            .collect();
        named.sort();
        out.extend(named);
    }
    out
}

/// What the spec defaults `workspaceFolder` to for a single container: `/workspaces/<folder>`.
pub fn default_workspace_folder(checkout: &Path) -> String {
    let name = checkout.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "workspace".into());
    format!("/workspaces/{name}")
}

/// Keeps a container alive with nothing to do, the way the Dev Containers CLI does with
/// `overrideCommand`, and stops at once on `docker stop`.
pub const KEEP_ALIVE: &str = "trap 'exit 0' TERM; while sleep 1000 & wait $!; do :; done";

/// What `run` needs for an image-based (or built) devcontainer.
pub struct RunPlan<'a> {
    pub name: &'a str,
    pub env_id: &'a str,
    pub project: &'a str,
    pub image: &'a str,
    pub checkout: &'a Path,
    pub workspace_folder: &'a str,
    /// (host after the offset, container).
    pub ports: &'a [(u16, u16)],
    pub env: &'a BTreeMap<String, String>,
    pub user: Option<&'a str>,
    pub override_command: bool,
    /// `workspaceMount` as a `--mount` value, in place of the checkout's `-v`.
    pub workspace_mount: Option<&'a str>,
    /// `mounts`, each a `--mount` value (see `direct::mount_value`).
    pub mounts: &'a [String],
    /// `runArgs` and the flags of `privileged`/`capAdd`/`securityOpt`/`init`, as
    /// `direct::parse_run_args` passed them.
    pub extra: &'a [String],
}

/// `run -d --name … --label codeflow.env=<id> -v <checkout>:<folder> -w <folder> -p 127.0.0.1:h:c …
/// --mount … <runArgs…> <image>` — `runArgs` after CodeFlow's own flags, so a later `-w` of theirs
/// wins as it would with the CLI, and before the entrypoint `overrideCommand` sets.
/// Published on localhost only: a devcontainer's ports are the developer's, not the network's.
pub fn run_args(plan: &RunPlan) -> Result<Vec<String>, String> {
    super::super::engine::check_ref(plan.image)?;
    if !plan.workspace_folder.starts_with('/') || plan.workspace_folder.contains(':') {
        return Err(format!("\"{}\" is not a folder inside a container", plan.workspace_folder));
    }
    let mut args: Vec<String> = vec![
        "run".into(),
        "-d".into(),
        "--name".into(),
        plan.name.into(),
        "--label".into(),
        format!("codeflow.env={}", plan.env_id),
        "--label".into(),
        format!("codeflow.env.project={}", plan.project),
    ];
    match plan.workspace_mount {
        Some(mount) => args.extend(["--mount".into(), mount.into()]),
        None => args.extend(["-v".into(), format!("{}:{}", plan.checkout.to_string_lossy(), plan.workspace_folder)]),
    }
    args.extend(["-w".into(), plan.workspace_folder.into()]);
    for (host, container) in plan.ports {
        args.extend(["-p".into(), format!("127.0.0.1:{host}:{container}")]);
    }
    for (key, value) in plan.env {
        if key.is_empty() || key.contains('=') {
            continue;
        }
        args.extend(["-e".into(), format!("{key}={value}")]);
    }
    if let Some(user) = plan.user.filter(|u| !u.trim().is_empty()) {
        super::super::engine::check_ref(user)?;
        args.extend(["--user".into(), user.into()]);
    }
    for mount in plan.mounts {
        args.extend(["--mount".into(), mount.clone()]);
    }
    args.extend(plan.extra.iter().cloned());
    if plan.override_command {
        args.extend(["--entrypoint".into(), "/bin/sh".into(), plan.image.into(), "-c".into(), KEEP_ALIVE.into()]);
    } else {
        args.push(plan.image.into());
    }
    Ok(args)
}

/// `exec [-u user] [-e K=V]… -w <folder> <container> <argv…>` for one lifecycle command.
pub fn exec_args(container: &str, workspace_folder: Option<&str>, user: Option<&str>, env: &BTreeMap<String, String>, argv: &[String]) -> Vec<String> {
    let mut args: Vec<String> = vec!["exec".into()];
    if let Some(user) = user.filter(|u| !u.trim().is_empty() && !u.starts_with('-')) {
        args.extend(["-u".into(), user.into()]);
    }
    for (key, value) in env {
        if !key.is_empty() && !key.contains('=') {
            args.extend(["-e".into(), format!("{key}={value}")]);
        }
    }
    if let Some(folder) = workspace_folder.filter(|f| f.starts_with('/')) {
        args.extend(["-w".into(), folder.into()]);
    }
    args.push(container.into());
    args.extend(argv.iter().cloned());
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jsonc_loses_its_comments_and_trailing_commas_only() {
        let text = "\u{feff}{\n  // the image\n  \"image\": \"mcr.microsoft.com/devcontainers/base\", /* note */\n  \"url\": \"http://x//y\",\n  \"list\": [1, 2, // last\n  ],\n  \"q\": \"a \\\" , }\",\n}\n";
        let doc: Value = serde_json::from_str(&strip_jsonc(text)).unwrap();
        assert_eq!(doc["url"], "http://x//y");
        assert_eq!(doc["list"], serde_json::json!([1, 2]));
        assert_eq!(doc["q"], "a \" , }");
    }

    #[test]
    fn an_image_devcontainer_is_read_with_its_ports_env_and_commands() {
        let dc = parse(
            r#"{
              "name": "App",
              "image": "node:20",
              "forwardPorts": [3000, "5432", "db:6379"],
              "appPort": ["8080:80", 9000],
              "containerEnv": { "NODE_ENV": "development" },
              "remoteUser": "node",
              "postCreateCommand": "npm ci",
              "postStartCommand": ["npm", "run", "dev"],
              "onCreateCommand": { "a": "echo a", "b": ["echo", "b"] },
              "features": { "ghcr.io/devcontainers/features/git:1": {} },
            }"#,
        )
        .unwrap();
        assert_eq!(dc.source, Source::Image { image: "node:20".into() });
        assert_eq!(dc.ports, vec![(3000, 3000), (5432, 5432), (8080, 80), (9000, 9000)]);
        assert_eq!(dc.container_env.get("NODE_ENV").map(String::as_str), Some("development"));
        assert_eq!(dc.post_create, vec![vec!["/bin/sh".to_string(), "-c".into(), "npm ci".into()]]);
        assert_eq!(dc.post_start, vec![vec!["npm".to_string(), "run".into(), "dev".into()]]);
        assert_eq!(dc.on_create.len(), 2);
        assert_eq!(dc.features, vec!["ghcr.io/devcontainers/features/git:1"]);
        assert!(dc.ignored_direct().is_empty(), "{:?}", dc.ignored_direct());
        assert!(dc.present.contains(&"features".to_string()) && dc.honoured_direct().contains(&"appPort".to_string()));
        assert!(dc.override_command);
    }

    #[test]
    fn compose_and_dockerfile_devcontainers_are_told_apart() {
        let compose = parse(r#"{ "dockerComposeFile": ["../compose.yml", "compose.dev.yml"], "service": "app", "runServices": ["app", "db"], "workspaceFolder": "/w" }"#).unwrap();
        assert_eq!(compose.source, Source::Compose { files: vec!["../compose.yml".into(), "compose.dev.yml".into()], service: "app".into(), run_services: vec!["app".into(), "db".into()] });
        assert!(parse(r#"{ "dockerComposeFile": "c.yml" }"#).is_err(), "a service is required");

        let built = parse(r#"{ "build": { "dockerfile": "Dockerfile", "context": "..", "args": { "V": "1" }, "target": "dev" } }"#).unwrap();
        match &built.source {
            Source::Dockerfile { dockerfile, context, args, target, .. } => {
                assert_eq!((dockerfile.as_str(), context.as_str()), ("Dockerfile", ".."));
                assert_eq!(args.get("V").map(String::as_str), Some("1"));
                assert_eq!(target.as_deref(), Some("dev"));
            }
            other => panic!("{other:?}"),
        }
        assert!(built.ignored_direct().is_empty());
        assert_eq!(compose.ignored_direct(), Vec::<String>::new());
        let compose_extra = parse(r#"{ "dockerComposeFile": "c.yml", "service": "app", "runArgs": ["--init"], "forwardPorts": [3000], "postAttachCommand": "x" }"#).unwrap();
        assert_eq!(compose_extra.ignored_direct(), vec!["runArgs", "forwardPorts", "postAttachCommand"]);
        assert_eq!(compose_extra.ignored_cli(), vec!["forwardPorts"]);
        assert_eq!(parse("{}").unwrap().source, Source::Unknown);
        assert!(parse("not json").is_err());
    }

    #[test]
    fn the_run_mounts_the_checkout_and_publishes_on_localhost() {
        let env = BTreeMap::from([("A".to_string(), "1".to_string())]);
        let args = run_args(&RunPlan {
            name: "shop-main-dev",
            env_id: "e1",
            project: "shop-main",
            image: "node:20",
            checkout: Path::new("/w/shop"),
            workspace_folder: "/workspaces/shop",
            ports: &[(3100, 3000)],
            env: &env,
            user: None,
            override_command: true,
            workspace_mount: None,
            mounts: &["type=volume,source=cache,target=/cache".to_string()],
            extra: &["--cap-add".to_string(), "SYS_PTRACE".to_string()],
        })
        .unwrap();
        let line = args.join(" ");
        assert!(line.starts_with("run -d --name shop-main-dev --label codeflow.env=e1"));
        assert!(line.contains("-v /w/shop:/workspaces/shop -w /workspaces/shop"));
        assert!(line.contains("-p 127.0.0.1:3100:3000 -e A=1 --mount type=volume,source=cache,target=/cache --cap-add SYS_PTRACE --entrypoint /bin/sh node:20 -c"), "{line}");
        let mut bad = RunPlan { name: "n", env_id: "e", project: "p", image: "--privileged", checkout: Path::new("/w"), workspace_folder: "/w", ports: &[], env: &env, user: None, override_command: false, workspace_mount: None, mounts: &[], extra: &[] };
        let with_mount = run_args(&RunPlan { image: "x", workspace_mount: Some("type=bind,source=/w/..,target=/src"), ..bad }).unwrap().join(" ");
        assert!(with_mount.contains("--mount type=bind,source=/w/..,target=/src -w /w") && !with_mount.contains("-v "), "{with_mount}");
        assert!(run_args(&bad).is_err());
        bad.image = "x";
        bad.workspace_folder = "relative";
        assert!(run_args(&bad).is_err());

        let exec = exec_args("c1", Some("/w"), Some("node"), &env, &["npm".into(), "ci".into()]);
        assert_eq!(exec.join(" "), "exec -u node -e A=1 -w /w c1 npm ci");
    }

    fn vars() -> Vars {
        let env = BTreeMap::from([("HOME".to_string(), "/Users/me".to_string()), ("TOKEN".to_string(), "t0".to_string())]);
        Vars::new(Path::new("/w/shop-feature"), "abc123".into(), env)
    }

    #[test]
    fn variables_are_replaced_and_unknown_ones_kept() {
        let v = vars();
        assert_eq!(substitute("${localWorkspaceFolder}/x", &v), "/w/shop-feature/x");
        assert_eq!(substitute("${localWorkspaceFolderBasename}", &v), "shop-feature");
        assert_eq!(substitute("${containerWorkspaceFolder}|${containerWorkspaceFolderBasename}", &v), "/workspaces/shop-feature|shop-feature");
        assert_eq!(substitute("vol-${devcontainerId}", &v), "vol-abc123");
        assert_eq!(substitute("${localEnv:HOME}/.cache ${env:TOKEN}", &v), "/Users/me/.cache t0");
        assert_eq!(substitute("${localEnv:NOPE}|${localEnv:NOPE:fallback:x}", &v), "|fallback:x");
        assert_eq!(substitute("${containerEnv:PATH}:${what} ${unclosed", &v), "${containerEnv:PATH}:${what} ${unclosed");
    }

    #[test]
    fn a_config_follows_its_own_workspace_folder() {
        let dc = parse_with(
            r#"{
              "image": "node",
              "workspaceFolder": "/src/${localWorkspaceFolderBasename}",
              "workspaceMount": "source=${localWorkspaceFolder},target=${containerWorkspaceFolder},type=bind,consistency=cached",
              "mounts": [
                "type=volume,source=node-${devcontainerId},target=${containerWorkspaceFolder}/node_modules",
                { "type": "bind", "source": "${localEnv:HOME}/.npmrc", "target": "/home/node/.npmrc" },
                "source=\"/tmp/a,b\",target=/ab,type=bind,readonly"
              ],
              "containerEnv": { "WS": "${containerWorkspaceFolder}" },
              "runArgs": ["--label", "x=${localWorkspaceFolderBasename}"]
            }"#,
            Some(&vars()),
        )
        .unwrap();
        assert_eq!(dc.workspace_folder.as_deref(), Some("/src/shop-feature"));
        let wm = dc.workspace_mount.unwrap();
        assert_eq!((wm.kind.as_str(), wm.source.as_str(), wm.target.as_str()), ("bind", "/w/shop-feature", "/src/shop-feature"));
        assert_eq!(wm.extra, vec![("consistency".to_string(), "cached".to_string())]);
        assert_eq!(dc.mounts[0].source, "node-abc123");
        assert_eq!(dc.mounts[0].target, "/src/shop-feature/node_modules");
        assert_eq!((dc.mounts[1].kind.as_str(), dc.mounts[1].source.as_str()), ("bind", "/Users/me/.npmrc"));
        assert_eq!((dc.mounts[2].source.as_str(), dc.mounts[2].read_only), ("/tmp/a,b", true));
        assert_eq!(dc.container_env.get("WS").map(String::as_str), Some("/src/shop-feature"));
        assert_eq!(dc.run_args, vec!["--label", "x=shop-feature"]);
        assert!(parse_mount_text("type=bind,source=/x", None).is_err(), "a mount needs a target");
        assert!(parse_mount_text("type=bind,source=/x,target=/y,readonly=maybe", None).is_err());
    }

    #[test]
    fn initialize_and_the_flags_of_the_file_are_read() {
        let dc = parse(r#"{ "image": "x", "initializeCommand": ["./scripts/prep.sh", "a b"], "privileged": true, "capAdd": ["SYS_PTRACE"], "securityOpt": ["seccomp=unconfined"], "init": true, "updateContentCommand": "make" }"#).unwrap();
        assert_eq!(dc.initialize, vec![HostCommand::Argv(vec!["./scripts/prep.sh".into(), "a b".into()])]);
        assert_eq!(dc.initialize_display(), vec!["./scripts/prep.sh \"a b\""]);
        assert!(dc.privileged && dc.init);
        assert_eq!((dc.cap_add.len(), dc.security_opt.len(), dc.update_content.len()), (1, 1, 1));
        let shell = parse(r#"{ "image": "x", "initializeCommand": { "a": "echo hi > .env", "b": ["true"] } }"#).unwrap();
        assert_eq!(shell.initialize_display(), vec!["echo hi > .env", "true"]);
    }

    #[test]
    fn the_devcontainer_id_is_the_clis() {
        // The Dev Containers CLI's algorithm: sha256 of the sorted labels' JSON, base 32, 52 digits.
        let id = devcontainer_id(&BTreeMap::from([("codeflow.env".to_string(), "e1".to_string())]));
        assert_eq!(id.len(), 52);
        assert!(id.chars().all(|c| c.is_ascii_digit() || ('a'..='v').contains(&c)));
        // BigInt(`0x${sha256('{"codeflow.env":"e1"}')}`).toString(32).padStart(52, '0'), as the CLI computes it.
        assert_eq!(id, "0nb1loi22evn38mjmaj2di0fbb9mm6k9d0r2kms2so16k9261muh");
        assert_eq!(devcontainer_id(&BTreeMap::new()), "0h0jduhlbcr7h88kdb8muvk697kkvd7s47v7fq1h1g30uoealvsa");
        assert_ne!(id, devcontainer_id(&BTreeMap::from([("codeflow.env".to_string(), "e2".to_string())])));
    }

    #[test]
    fn configs_are_found_in_their_three_places() {
        let root = std::env::temp_dir().join(format!("cf-devc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join(".devcontainer/python")).unwrap();
        std::fs::write(root.join(".devcontainer/devcontainer.json"), "{}").unwrap();
        std::fs::write(root.join(".devcontainer/python/devcontainer.json"), "{}").unwrap();
        std::fs::write(root.join(".devcontainer.json"), "{}").unwrap();
        assert_eq!(find_configs(&root), vec![".devcontainer/devcontainer.json", ".devcontainer.json", ".devcontainer/python/devcontainer.json"]);
        assert_eq!(default_workspace_folder(&root.join("shop")), "/workspaces/shop");
        let _ = std::fs::remove_dir_all(&root);
    }
}
