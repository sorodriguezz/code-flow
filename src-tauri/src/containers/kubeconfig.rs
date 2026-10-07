//! Clusters anywhere: a kubeconfig file, Azure AKS, AWS EKS, Google GKE or a server typed in —
//! written into CodeFlow's own kubeconfig (and, when asked, the user's `~/.kube/config` too), which
//! every `kubectl` the app runs reads alongside the user's.
//!
//! **Two kinds of file, one list.** CodeFlow's kubeconfig ([`app_path`], 0600) is appended to the
//! user's `KUBECONFIG` for every command the app runs (`cli::engine_env`), so its contexts sit next
//! to the user's in the panel while the user's own files stay untouched. kubectl merges that list
//! "first file to define a name wins", and the user's files come first: a name of theirs is never
//! shadowed, and one already taken is suffixed here instead (`-2`) — otherwise the added cluster
//! would be the invisible one.
//!
//! **The clouds' own CLIs write the credentials.** `az aks get-credentials`, `aws eks
//! update-kubeconfig` and `gcloud container clusters get-credentials` know their auth plugins'
//! arguments better than this file could. Each writes into a private scratch kubeconfig and only
//! what it wrote is merged from there, which keeps three things true: `kubelogin
//! convert-kubeconfig` rewrites this cluster's user and nobody else's, no cloud CLI switches the
//! user's current context, and a name clash is settled by one rule for every source.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use futures_util::StreamExt as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use yaml_rust2::Yaml;

use super::{cli, kube};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KubeTools {
    pub kubectl: bool,
    pub az: bool,
    pub aws: bool,
    pub gcloud: bool,
    pub kubelogin: bool,
    pub gke_auth_plugin: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudAccount {
    /// An Azure subscription id, an AWS profile, a Google Cloud project id.
    pub id: String,
    pub name: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloudCluster {
    pub name: String,
    /// The region or zone.
    pub location: String,
    /// AKS: its resource group. GKE: its project. EKS: its region.
    pub group: String,
    pub version: String,
    /// The subscription, profile or project it was listed under.
    pub account: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", tag = "source")]
pub enum KubeAddRequest {
    #[serde(rename = "file", rename_all = "camelCase")]
    File {
        path: String,
        #[serde(default)]
        to_user_config: bool,
    },
    #[serde(rename = "aks", rename_all = "camelCase")]
    Aks {
        #[serde(default)]
        subscription: String,
        resource_group: String,
        name: String,
        #[serde(default)]
        admin: bool,
        #[serde(default)]
        to_user_config: bool,
    },
    #[serde(rename = "eks", rename_all = "camelCase")]
    Eks {
        region: String,
        name: String,
        #[serde(default)]
        profile: String,
        #[serde(default)]
        to_user_config: bool,
    },
    #[serde(rename = "gke", rename_all = "camelCase")]
    Gke {
        #[serde(default)]
        project: String,
        location: String,
        name: String,
        #[serde(default)]
        to_user_config: bool,
    },
    #[serde(rename = "manual", rename_all = "camelCase")]
    Manual {
        name: String,
        server: String,
        #[serde(default)]
        token: String,
        #[serde(default)]
        certificate_authority: String,
        #[serde(default)]
        insecure: bool,
        #[serde(default)]
        client_certificate: String,
        #[serde(default)]
        client_key: String,
        #[serde(default)]
        namespace: String,
        #[serde(default)]
        to_user_config: bool,
    },
}

impl KubeAddRequest {
    fn to_user_config(&self) -> bool {
        match self {
            KubeAddRequest::File { to_user_config, .. }
            | KubeAddRequest::Aks { to_user_config, .. }
            | KubeAddRequest::Eks { to_user_config, .. }
            | KubeAddRequest::Gke { to_user_config, .. }
            | KubeAddRequest::Manual { to_user_config, .. } => *to_user_config,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KubeAdded {
    pub contexts: Vec<String>,
    /// The kubeconfig file the contexts were written to.
    pub file: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KubeContextOrigin {
    pub context: String,
    pub file: String,
    /// In CodeFlow's own kubeconfig — the only ones the app removes.
    pub managed: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KubeTest {
    pub ok: bool,
    pub version: Option<String>,
    pub error: Option<String>,
    /// What to do about the error, when it is a known one (a missing `kubelogin`, an expired login).
    pub hint: Option<String>,
}

/// A cloud CLI reaching its API to list something.
const LIST_TIMEOUT: Duration = Duration::from_secs(30);
/// A cloud CLI fetching credentials: `az aks get-credentials` alone can take twenty seconds.
const CREDENTIALS_TIMEOUT: Duration = Duration::from_secs(90);
/// `kubelogin convert-kubeconfig`, `aws --version`: local work.
const PLUGIN_TIMEOUT: Duration = Duration::from_secs(30);
/// `kubectl version`: its request gives up at 8 s, and an auth plugin may take a few more.
const TEST_TIMEOUT: Duration = Duration::from_secs(25);
/// How many `aws eks describe-cluster` run at once.
const DESCRIBE_AT_ONCE: usize = 4;
/// A kubeconfig is a few kilobytes: a file this large is something else, picked by mistake.
const MAX_FILE: u64 = 4 * 1024 * 1024;
/// A kubeconfig's three named lists, in the order a merge must settle them: contexts name the others.
const LISTS: [&str; 3] = ["clusters", "users", "contexts"];
/// The private folders the cloud CLIs write into, beside CodeFlow's kubeconfig.
const SCRATCH_PREFIX: &str = ".adding-";

/// Adds and removals rewrite whole files: one at a time.
static WRITING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

// ------------------------------------------------------------------------------------ the files

/// CodeFlow's own kubeconfig. State, not cache: it holds credentials nothing can fetch again by
/// itself (a token typed in, a file since deleted). Never in a backup, which is the database alone.
pub fn app_path() -> PathBuf {
    crate::paths::state_dir().join("containers").join("kubeconfig")
}

/// `KUBECONFIG`'s separator: `;` on Windows, `:` elsewhere.
pub fn list_separator() -> char {
    if cfg!(windows) {
        ';'
    } else {
        ':'
    }
}

/// The user's kubeconfig files in kubectl's order: `KUBECONFIG`'s list when it is set, else
/// `~/.kube/config` — listed whether or not they exist yet.
pub fn user_files(var: Option<&str>, home: Option<&Path>) -> Vec<PathBuf> {
    match var.map(str::trim).filter(|v| !v.is_empty()) {
        Some(list) => list.split(list_separator()).map(str::trim).filter(|p| !p.is_empty()).map(PathBuf::from).collect(),
        None => home.map(|h| vec![h.join(".kube").join("config")]).unwrap_or_default(),
    }
}

/// The `KUBECONFIG` every command gets once CodeFlow has a kubeconfig of its own: the user's list as
/// it stands (or `~/.kube/config`, when there is one), then CodeFlow's — last, so that it never
/// shadows a name of theirs nor takes their current context.
pub fn compose(var: Option<&str>, home: Option<&Path>, app: &Path) -> String {
    let separator = list_separator();
    let mut parts: Vec<String> = match var.map(str::trim).filter(|v| !v.is_empty()) {
        // As written, missing entries included: kubectl skips those itself.
        Some(list) => list.split(separator).filter(|p| !p.trim().is_empty()).map(str::to_string).collect(),
        None => user_files(None, home).into_iter().filter(|p| p.is_file()).map(|p| p.to_string_lossy().into_owned()).collect(),
    };
    if !parts.iter().any(|p| Path::new(p) == app) {
        parts.push(app.to_string_lossy().into_owned());
    }
    parts.join(&separator.to_string())
}

/// The files one change reads and writes — the real ones, or a test's.
struct Files {
    /// CodeFlow's own kubeconfig.
    app: PathBuf,
    /// The user's, as [`user_files`] lists them.
    user: Vec<PathBuf>,
}

impl Files {
    fn new(app: PathBuf, var: Option<&str>, home: Option<&Path>) -> Files {
        Files { app, user: user_files(var, home) }
    }

    async fn current() -> Files {
        let var = cli::login_var("KUBECONFIG").await;
        Files::new(app_path(), var.as_deref(), dirs::home_dir().as_deref())
    }

    /// Every file kubectl reads here, in its order — [`compose`]'s list, the ones that exist.
    fn read_order(&self) -> Vec<PathBuf> {
        let mut order = self.user.clone();
        if !order.contains(&self.app) {
            order.push(self.app.clone());
        }
        order.retain(|p| p.is_file());
        order
    }

    /// Where "also in ~/.kube/config" writes: the file kubectl itself would give a new entry — the
    /// first listed that exists, else the last listed.
    fn user_target(&self) -> Option<PathBuf> {
        let own: Vec<&PathBuf> = self.user.iter().filter(|p| **p != self.app).collect();
        own.iter().find(|p| p.is_file()).or(own.last()).map(|p| (*p).clone())
    }
}

/// Creates `dir` (and its parents) when it is missing, readable by its owner only on Unix.
fn private_dir(dir: &Path) -> Result<(), String> {
    if dir.is_dir() {
        return Ok(());
    }
    #[cfg(unix)]
    let made = {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)
    };
    #[cfg(not(unix))]
    let made = std::fs::create_dir_all(dir);
    made.map_err(|e| format!("{}: {e}", dir.display()))
}

/// A kubeconfig on disk as JSON. A missing file reads as an empty one; one that does not parse is
/// an error — and is therefore never written over.
fn load(path: &Path) -> Result<Value, String> {
    let meta = match std::fs::metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(json!({})),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    if !meta.is_file() {
        return Err(format!("{} is not a file", path.display()));
    }
    if meta.len() > MAX_FILE {
        return Err(format!("{} is too large to be a kubeconfig", path.display()));
    }
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let text = String::from_utf8(bytes).map_err(|_| format!("{} is not a text file", path.display()))?;
    parse(&text).map_err(|e| format!("{}: {e}", path.display()))
}

/// Writes `doc` in place of the file at `path` all at once — a temporary file beside it, renamed
/// over it — so a crash mid-write never leaves a half kubeconfig that every kubectl would refuse.
/// Through a link to the file it names (a kubeconfig kept in a dotfiles checkout stays linked), and
/// with the file's own permissions: 0600 for a new one, the credentials it holds being its owner's.
fn save(path: &Path, doc: &Value) -> Result<(), String> {
    let real = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let dir = real.parent().filter(|d| !d.as_os_str().is_empty()).map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));
    private_dir(&dir)?;
    let name = real.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "kubeconfig".into());
    let temp = dir.join(format!(".{name}.codeflow-{}", uuid::Uuid::new_v4().simple()));
    let written = write_new(&temp, render(doc).as_bytes(), &real).and_then(|()| std::fs::rename(&temp, &real).map_err(|e| e.to_string()));
    if written.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    written.map_err(|e| format!("{}: {e}", real.display()))
}

/// A new file holding `bytes`, with the permissions `like` has (0600 when it has none yet).
fn write_new(path: &Path, bytes: &[u8], like: &Path) -> Result<(), String> {
    use std::io::Write as _;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    file.write_all(bytes).and_then(|()| file.sync_all()).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = std::fs::metadata(like) {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(meta.permissions().mode() & 0o7777)).map_err(|e| e.to_string())?;
        }
    }
    #[cfg(not(unix))]
    let _ = like;
    Ok(())
}

// ------------------------------------------------------------------------------- reading YAML

/// A kubeconfig's text as JSON — YAML, or JSON (which is YAML too); its first document.
fn parse(text: &str) -> Result<Value, String> {
    let docs = yaml_rust2::YamlLoader::load_from_str(text.trim_start_matches('\u{feff}')).map_err(|e| format!("not valid YAML: {e}"))?;
    match docs.first().map(from_yaml).unwrap_or(Value::Null) {
        Value::Null => Ok(json!({})),
        doc @ Value::Object(_) => Ok(booleans(doc)),
        _ => Err("not a kubeconfig: it is not a map of settings".into()),
    }
}

fn from_yaml(yaml: &Yaml) -> Value {
    match yaml {
        Yaml::String(text) => Value::String(text.clone()),
        Yaml::Integer(n) => json!(n),
        Yaml::Real(text) => text.parse::<f64>().ok().and_then(serde_json::Number::from_f64).map_or_else(|| Value::String(text.clone()), Value::Number),
        Yaml::Boolean(b) => Value::Bool(*b),
        Yaml::Array(list) => Value::Array(list.iter().map(from_yaml).collect()),
        Yaml::Hash(hash) => Value::Object(
            hash.iter()
                .map(|(key, value)| {
                    let key = match key {
                        Yaml::String(text) | Yaml::Real(text) => text.clone(),
                        Yaml::Integer(n) => n.to_string(),
                        Yaml::Boolean(b) => b.to_string(),
                        _ => String::new(),
                    };
                    (key, from_yaml(value))
                })
                .collect(),
        ),
        Yaml::Alias(_) | Yaml::Null | Yaml::BadValue => Value::Null,
    }
}

/// The few boolean settings a kubeconfig has, as kubectl reads them. kubectl's YAML is 1.1, where
/// `yes` and `on` are true; this parser's is 1.2, where they are text — and written back as text,
/// kubectl would refuse the whole file.
fn booleans(mut doc: Value) -> Value {
    fn fix(slot: Option<&mut Value>) {
        if let Some(value) = slot {
            let read = value.as_str().map(str::to_ascii_lowercase);
            match read.as_deref() {
                Some("y" | "yes" | "on" | "true") => *value = Value::Bool(true),
                Some("n" | "no" | "off" | "false") => *value = Value::Bool(false),
                _ => {}
            }
        }
    }
    for entry in list_mut(&mut doc, "clusters") {
        fix(entry.pointer_mut("/cluster/insecure-skip-tls-verify"));
        fix(entry.pointer_mut("/cluster/disable-compression"));
    }
    for entry in list_mut(&mut doc, "users") {
        fix(entry.pointer_mut("/user/exec/provideClusterInfo"));
    }
    fix(doc.pointer_mut("/preferences/colors"));
    doc
}

// ------------------------------------------------------------------------------- writing YAML

/// A string as YAML that every reader takes back as the same string — kubectl's YAML 1.1, the
/// Python the cloud CLIs read it with, this file's 1.2: plain only when it could not be anything
/// else, double-quoted otherwise (JSON's escapes, which YAML shares). Stricter than a YAML library's
/// rule on purpose: `1_000` and `0b101` are numbers to kubectl and text to a 1.2 emitter.
fn scalar(text: &str) -> String {
    let plain = text.starts_with(|c: char| c.is_ascii_alphabetic() || c == '/')
        && text.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | '@' | '+' | '=' | '-'))
        && !matches!(text.to_ascii_lowercase().as_str(), "y" | "n" | "yes" | "no" | "on" | "off" | "true" | "false" | "null");
    if plain {
        text.to_string()
    } else {
        serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into())
    }
}

/// A kubeconfig as block YAML, in the layout kubectl writes (a list at its key's indentation).
fn render(doc: &Value) -> String {
    fn leaf(value: &Value) -> String {
        match value {
            Value::Null => "null".into(),
            Value::Bool(b) => b.to_string(),
            Value::Number(n) => n.to_string(),
            Value::String(text) => scalar(text),
            Value::Array(_) => "[]".into(),
            Value::Object(_) => "{}".into(),
        }
    }
    fn walk(value: &Value, indent: usize, out: &mut String) {
        let pad = " ".repeat(indent);
        match value {
            Value::Object(map) => {
                for (key, child) in map {
                    let key = scalar(key);
                    match child {
                        Value::Object(inner) if !inner.is_empty() => {
                            out.push_str(&format!("{pad}{key}:\n"));
                            walk(child, indent + 2, out);
                        }
                        Value::Array(list) if !list.is_empty() => {
                            out.push_str(&format!("{pad}{key}:\n"));
                            walk(child, indent, out);
                        }
                        _ => out.push_str(&format!("{pad}{key}: {}\n", leaf(child))),
                    }
                }
            }
            Value::Array(list) => {
                for child in list {
                    match child {
                        Value::Object(inner) if !inner.is_empty() => {
                            // Its first key on the dash's line: drawn one level in, then pulled back.
                            let mut lines = String::new();
                            walk(child, indent + 2, &mut lines);
                            out.push_str(&format!("{pad}- {}", &lines[indent + 2..]));
                        }
                        Value::Array(inner) if !inner.is_empty() => {
                            out.push_str(&format!("{pad}-\n"));
                            walk(child, indent + 2, out);
                        }
                        _ => out.push_str(&format!("{pad}- {}\n", leaf(child))),
                    }
                }
            }
            other => out.push_str(&format!("{pad}{}\n", leaf(other))),
        }
    }
    match doc {
        Value::Object(map) if !map.is_empty() => {
            let mut out = String::new();
            walk(doc, 0, &mut out);
            out
        }
        _ => "{}\n".into(),
    }
}

// ----------------------------------------------------------------------------------- entries

fn str_at(value: &Value, pointer: &str) -> String {
    value.pointer(pointer).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn entries<'a>(doc: &'a Value, list: &str) -> impl Iterator<Item = &'a Value> {
    doc.get(list).and_then(Value::as_array).into_iter().flatten()
}

fn list_mut<'a>(doc: &'a mut Value, list: &str) -> impl Iterator<Item = &'a mut Value> {
    doc.get_mut(list).and_then(Value::as_array_mut).into_iter().flatten()
}

fn name_of(entry: &Value) -> &str {
    entry.get("name").and_then(Value::as_str).unwrap_or_default()
}

fn find<'a>(doc: &'a Value, list: &str, name: &str) -> Option<&'a Value> {
    entries(doc, list).find(|e| name_of(e) == name)
}

fn names(doc: &Value, list: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for name in entries(doc, list).map(name_of).filter(|n| !n.is_empty()) {
        if !out.iter().any(|seen| seen == name) {
            out.push(name.to_string());
        }
    }
    out
}

/// An entry without its name: what two entries of one name are compared by.
fn body(entry: &Value) -> Value {
    let mut copy = entry.clone();
    if let Some(map) = copy.as_object_mut() {
        map.remove("name");
    }
    copy
}

/// What a name already taken means for the entry that wants it.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Clash {
    /// An imported file: a name holding anything different gets a suffix, wherever it is.
    Rename,
    /// A cloud's cluster or one typed in: the same name in a file being written is this cluster's
    /// earlier copy and is refreshed, as the clouds' own CLIs do — a suffix only for a name another
    /// file holds, which would shadow the new entry (or be shadowed by it).
    Replace,
}

/// Settles the names `fragment`'s entries will be written under, against every kubeconfig kubectl
/// reads (`world`): a name stays when it is free, or holds the same thing, or (`Replace`) is held only
/// in a file being written; otherwise `name-2`, `name-3`… Contexts follow their cluster and user to
/// their new names before they are compared. Answers the contexts renamed, as (asked, given).
fn settle(fragment: &mut Value, world: &[(PathBuf, Value)], targets: &[PathBuf], clash: Clash) -> Vec<(String, String)> {
    let mut renamed = Vec::new();
    let mut moved: HashMap<&str, HashMap<String, String>> = HashMap::new();
    for list in LISTS {
        if list == "contexts" {
            for entry in list_mut(fragment, "contexts") {
                for (field, of) in [("cluster", "clusters"), ("user", "users")] {
                    let pointer = format!("/context/{field}");
                    let new = entry.pointer(&pointer).and_then(Value::as_str).and_then(|old| moved.get(of)?.get(old)).cloned();
                    if let (Some(new), Some(slot)) = (new, entry.pointer_mut(&pointer)) {
                        *slot = Value::String(new);
                    }
                }
            }
        }
        let mut chosen: HashSet<String> = HashSet::new();
        let mut map = HashMap::new();
        for entry in list_mut(fragment, list) {
            let name = name_of(entry).to_string();
            if name.is_empty() {
                continue;
            }
            let mine = body(entry);
            let free = |candidate: &str| {
                !chosen.contains(candidate)
                    && world.iter().all(|(path, doc)| match find(doc, list, candidate) {
                        None => true,
                        Some(theirs) => body(theirs) == mine || (clash == Clash::Replace && targets.contains(path)),
                    })
            };
            let mut settled = name.clone();
            let mut suffix = 2;
            while !free(settled.as_str()) {
                settled = format!("{name}-{suffix}");
                suffix += 1;
            }
            chosen.insert(settled.clone());
            if settled != name {
                entry["name"] = Value::String(settled.clone());
                if list == "contexts" {
                    renamed.push((name.clone(), settled.clone()));
                }
                map.insert(name, settled);
            }
        }
        moved.insert(list, map);
    }
    renamed
}

/// `fragment`'s entries into `doc`: one of the same name replaced, any other appended.
fn upsert(doc: &mut Value, fragment: &Value) {
    if !doc.is_object() {
        *doc = json!({});
    }
    let Some(map) = doc.as_object_mut() else { return };
    map.entry("apiVersion").or_insert_with(|| json!("v1"));
    map.entry("kind").or_insert_with(|| json!("Config"));
    for list in LISTS {
        let slot = map.entry(list).or_insert_with(|| json!([]));
        if !slot.is_array() {
            *slot = json!([]);
        }
        let Some(items) = slot.as_array_mut() else { continue };
        for entry in entries(fragment, list) {
            let name = name_of(entry);
            if name.is_empty() {
                continue;
            }
            match items.iter_mut().find(|e| name_of(e) == name) {
                Some(existing) => *existing = entry.clone(),
                None => items.push(entry.clone()),
            }
        }
    }
}

/// Contexts naming a cluster or a user no kubeconfig defines — kubectl would refuse them.
fn dangling(fragment: &Value, world: &[(PathBuf, Value)]) -> Vec<String> {
    let defined = |list: &str, name: &str| find(fragment, list, name).is_some() || world.iter().any(|(_, doc)| find(doc, list, name).is_some());
    let mut out = Vec::new();
    for context in entries(fragment, "contexts") {
        for (field, list, what) in [("cluster", "clusters", "cluster"), ("user", "users", "user")] {
            let target = str_at(context, &format!("/context/{field}"));
            if !target.is_empty() && !defined(list, &target) {
                out.push(format!("Context «{}» names the {what} «{target}», which no kubeconfig defines.", name_of(context)));
            }
        }
    }
    out
}

/// An imported file must read as a kubeconfig with at least one context.
fn check_kubeconfig(doc: &Value) -> Result<(), String> {
    if let Some(kind) = doc.get("kind").and_then(Value::as_str) {
        if kind != "Config" {
            return Err(format!("not a kubeconfig: it is a {kind}"));
        }
    }
    for list in LISTS {
        if doc.get(list).is_some_and(|v| !v.is_array() && !v.is_null()) {
            return Err(format!("not a kubeconfig: «{list}» is not a list"));
        }
    }
    if names(doc, "contexts").is_empty() {
        return Err("the file defines no contexts".into());
    }
    Ok(())
}

/// The paths a kubeconfig names are relative to its own folder — kubectl resolves them so. Copied
/// into another file they would point somewhere else, so they are made absolute first. An exec
/// plugin is looked up on PATH unless its command names a path (`./bin/auth`), as client-go does.
fn absolutize(doc: &mut Value, base: &Path) {
    let fix = |slot: Option<&mut Value>| {
        if let Some(Value::String(text)) = slot {
            if !text.is_empty() && !text.starts_with('~') && Path::new(text.as_str()).is_relative() {
                *text = base.join(text.as_str()).to_string_lossy().into_owned();
            }
        }
    };
    for entry in list_mut(doc, "clusters") {
        fix(entry.pointer_mut("/cluster/certificate-authority"));
    }
    for entry in list_mut(doc, "users") {
        for field in ["client-certificate", "client-key", "tokenFile"] {
            fix(entry.pointer_mut(&format!("/user/{field}")));
        }
        if str_at(entry, "/user/exec/command").contains(std::path::MAIN_SEPARATOR) {
            fix(entry.pointer_mut("/user/exec/command"));
        }
    }
}

// ------------------------------------------------------------------------------------- tools

/// A tool's path, or why it cannot be used.
fn need(name: &str) -> Result<String, String> {
    cli::find(name).map(|p| p.to_string_lossy().into_owned()).ok_or_else(|| format!("`{name}` is not installed"))
}

/// A tool installed beside another — the plugins `gcloud components install` puts in the SDK's own
/// `bin`, which no PATH has to name (gcloud then writes the plugin's full path into the kubeconfig).
fn beside(tool: &Path, name: &str) -> Option<PathBuf> {
    let real = std::fs::canonicalize(tool).ok()?;
    let dir = real.parent()?;
    let extensions: &[&str] = if cfg!(windows) { &[".exe", ".cmd", ".bat"] } else { &[""] };
    extensions.iter().map(|ext| dir.join(format!("{name}{ext}"))).find(|p| p.is_file())
}

fn gke_plugin(gcloud: Option<&Path>) -> Option<PathBuf> {
    cli::find("gke-gcloud-auth-plugin").or_else(|| gcloud.and_then(|g| beside(g, "gke-gcloud-auth-plugin")))
}

/// A value handed to a CLI as one argument: never empty, never readable as a flag, one line.
fn check_arg(what: &str, value: &str) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("the {what} is missing"));
    }
    if value.starts_with('-') || value.chars().any(char::is_control) {
        return Err(format!("\"{value}\" is not a {what}"));
    }
    Ok(())
}

fn strings<const N: usize>(items: [&str; N]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

/// What each cloud CLI is run with besides the panel's own environment: the AWS CLI's pager off, and
/// gcloud never stopping at a prompt — both would wait on a terminal nobody is at.
fn cloud_env(source: &str) -> Vec<(String, String)> {
    match source {
        "eks" => vec![("AWS_PAGER".into(), String::new())],
        "gke" => vec![("CLOUDSDK_CORE_DISABLE_PROMPTS".into(), "1".into())],
        _ => vec![],
    }
}

/// Runs a cloud CLI and insists on success — its complaint, with the way out named, otherwise.
async fn run_cloud(source: &str, program: &str, args: &[String], extra: &[(String, String)], timeout: Duration, profile: &str) -> Result<String, String> {
    let mut env = cloud_env(source);
    env.extend(extra.iter().cloned());
    let out = cli::run_with(program, args, None, timeout, &env).await?;
    if out.ok() {
        Ok(out.stdout)
    } else {
        Err(cloud_error(source, &out.complaint(), profile))
    }
}

/// Signed out, said any of the ways each cloud says it.
fn signed_out(source: &str, text: &str) -> bool {
    let t = text.to_lowercase();
    match source {
        "aks" => t.contains("az login") || t.contains("aadsts") || t.contains("interactive authentication is needed") || t.contains("no subscription found"),
        "eks" => {
            t.contains("unable to locate credentials")
                || t.contains("token has expired")
                || t.contains("expiredtoken")
                || t.contains("sso session")
                || t.contains("error loading sso token")
                || t.contains("security token included in the request is expired")
        }
        "gke" => {
            t.contains("gcloud auth login")
                || t.contains("do not currently have an active account")
                || t.contains("reauthentication")
                || t.contains("invalid_grant")
        }
        _ => false,
    }
}

/// A cloud CLI's complaint, with the one known way out named when there is one.
fn cloud_error(source: &str, complaint: &str, profile: &str) -> String {
    let complaint = complaint.trim();
    if !signed_out(source, complaint) {
        return if complaint.is_empty() { "the command failed without saying why".into() } else { complaint.to_string() };
    }
    let with_profile = if profile.trim().is_empty() { String::new() } else { format!(" --profile {}", profile.trim()) };
    match source {
        "aks" => "Not signed in to Azure — run `az login` in a terminal.".into(),
        "eks" if complaint.to_lowercase().contains("unable to locate credentials") => {
            format!("No AWS credentials — run `aws configure{with_profile}` (or `aws sso login{with_profile}`) in a terminal.")
        }
        "eks" => format!("The AWS sign-in expired — run `aws sso login{with_profile}` in a terminal."),
        _ => "Not signed in to Google Cloud — run `gcloud auth login` in a terminal.".into(),
    }
}

/// Which of the tools a cluster may need are installed.
pub async fn tools() -> KubeTools {
    tokio::task::spawn_blocking(|| {
        let gcloud = cli::find("gcloud");
        KubeTools {
            kubectl: cli::find("kubectl").is_some(),
            az: cli::find("az").is_some(),
            aws: cli::find("aws").is_some(),
            kubelogin: cli::find("kubelogin").is_some(),
            gke_auth_plugin: gke_plugin(gcloud.as_deref()).is_some(),
            gcloud: gcloud.is_some(),
        }
    })
    .await
    .unwrap_or(KubeTools { kubectl: false, az: false, aws: false, gcloud: false, kubelogin: false, gke_auth_plugin: false })
}

// ---------------------------------------------------------------------------------- accounts

/// `az account list -o json`, the default subscription first.
fn parse_az_accounts(text: &str) -> Vec<CloudAccount> {
    let mut out: Vec<CloudAccount> = cli::json_values(text)
        .iter()
        .filter(|a| !matches!(a.get("state").and_then(Value::as_str), Some("Disabled" | "Deleted")))
        .filter_map(|a| {
            let id = str_at(a, "/id");
            if id.is_empty() {
                return None;
            }
            let name = str_at(a, "/name");
            Some(CloudAccount { name: if name.is_empty() { id.clone() } else { name }, is_default: a.get("isDefault").and_then(Value::as_bool).unwrap_or(false), id })
        })
        .collect();
    out.sort_by(|a, b| b.is_default.cmp(&a.is_default).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    out
}

/// `aws configure list-profiles`: one name a line.
fn parse_aws_profiles(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for name in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
        if !out.iter().any(|seen| seen == name) {
            out.push(name.to_string());
        }
    }
    out
}

/// The profiles `~/.aws/config` (`[default]`, `[profile name]`) and `~/.aws/credentials` (`[name]`)
/// define — for an AWS CLI too old to list them itself.
fn parse_aws_ini(config: &str, credentials: &str) -> Vec<String> {
    let section = |line: &str| line.trim().strip_prefix('[').and_then(|l| l.strip_suffix(']')).map(|s| s.trim().to_string());
    let mut out: Vec<String> = Vec::new();
    let mut add = |name: String| {
        if !name.is_empty() && !out.contains(&name) {
            out.push(name);
        }
    };
    for name in config.lines().filter_map(section) {
        if name == "default" {
            add(name);
        } else if let Some(profile) = name.strip_prefix("profile ") {
            add(profile.trim().to_string());
        }
    }
    for name in credentials.lines().filter_map(section) {
        add(name);
    }
    out
}

/// Profiles as accounts: the one in use first — `AWS_PROFILE`, else `default` — then the rest.
fn order_profiles(mut names: Vec<String>, current: Option<&str>) -> Vec<CloudAccount> {
    let chosen = current.map(str::trim).filter(|c| !c.is_empty()).map(str::to_string).or_else(|| names.iter().find(|n| *n == "default").cloned());
    if let Some(chosen) = &chosen {
        if !names.contains(chosen) {
            names.push(chosen.clone());
        }
    }
    names.sort_by(|a, b| {
        let rank = |n: &String| (Some(n) != chosen.as_ref(), n != "default", n.to_lowercase());
        rank(a).cmp(&rank(b))
    });
    names.into_iter().map(|n| CloudAccount { is_default: Some(&n) == chosen.as_ref(), name: n.clone(), id: n }).collect()
}

/// `gcloud projects list --format=json` (active ones), the configured project first.
fn parse_gcloud_projects(text: &str, current: Option<&str>) -> Vec<CloudAccount> {
    let mut out: Vec<CloudAccount> = cli::json_values(text)
        .iter()
        .filter(|p| p.get("lifecycleState").and_then(Value::as_str).is_none_or(|s| s == "ACTIVE"))
        .filter_map(|p| {
            let id = str_at(p, "/projectId");
            if id.is_empty() {
                return None;
            }
            let name = str_at(p, "/name");
            Some(CloudAccount { name: if name.is_empty() { id.clone() } else { name }, is_default: current == Some(id.as_str()), id })
        })
        .collect();
    if let Some(current) = current.filter(|c| !c.is_empty()) {
        if !out.iter().any(|a| a.id == current) {
            out.push(CloudAccount { id: current.into(), name: current.into(), is_default: true });
        }
    }
    out.sort_by(|a, b| b.is_default.cmp(&a.is_default).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    out
}

/// The subscriptions (`aks`), profiles (`eks`) or projects (`gke`) the provider's CLI is signed into.
pub async fn accounts(source: &str) -> Result<Vec<CloudAccount>, String> {
    match source {
        "aks" => {
            let az = need("az")?;
            let out = cli::run(&az, &strings(["account", "list", "-o", "json"]), None, LIST_TIMEOUT).await?;
            if !out.ok() {
                return Err(cloud_error("aks", &out.complaint(), ""));
            }
            let list = parse_az_accounts(&out.stdout);
            // Signed out, `az account list` answers `[]` and says so on stderr — with success.
            if list.is_empty() && signed_out("aks", &out.stderr) {
                return Err(cloud_error("aks", &out.stderr, ""));
            }
            Ok(list)
        }
        "eks" => {
            let aws = need("aws")?;
            let mut names = match cli::run(&aws, &strings(["configure", "list-profiles"]), None, LIST_TIMEOUT).await {
                Ok(out) if out.ok() => parse_aws_profiles(&out.stdout),
                _ => vec![],
            };
            if names.is_empty() {
                let home = dirs::home_dir().unwrap_or_default();
                let config = cli::login_var("AWS_CONFIG_FILE").await.map(PathBuf::from).unwrap_or_else(|| home.join(".aws").join("config"));
                let credentials = cli::login_var("AWS_SHARED_CREDENTIALS_FILE").await.map(PathBuf::from).unwrap_or_else(|| home.join(".aws").join("credentials"));
                names = parse_aws_ini(&std::fs::read_to_string(config).unwrap_or_default(), &std::fs::read_to_string(credentials).unwrap_or_default());
            }
            Ok(order_profiles(names, cli::login_var("AWS_PROFILE").await.as_deref()))
        }
        "gke" => {
            let gcloud = need("gcloud")?;
            let env = cloud_env("gke");
            let list_args = strings(["projects", "list", "--format=json"]);
            let current_args = strings(["config", "get-value", "project"]);
            let (list, current) = tokio::join!(
                cli::run_with(&gcloud, &list_args, None, LIST_TIMEOUT, &env),
                cli::run_with(&gcloud, &current_args, None, LIST_TIMEOUT, &env),
            );
            let current = current.ok().filter(cli::Output::ok).map(|o| o.stdout.trim().to_string()).filter(|p| !p.is_empty() && p != "(unset)");
            let list = list?;
            if list.ok() {
                return Ok(parse_gcloud_projects(&list.stdout, current.as_deref()));
            }
            let complaint = list.complaint();
            // Allowed to use a project without being allowed to list them: the configured one still is.
            match current {
                Some(project) if !signed_out("gke", &complaint) => Ok(vec![CloudAccount { id: project.clone(), name: project, is_default: true }]),
                _ => Err(cloud_error("gke", &complaint, "")),
            }
        }
        other => Err(format!("{other} is not a cloud this panel reads")),
    }
}

// ---------------------------------------------------------------------------------- clusters

fn by_name(mut clusters: Vec<CloudCluster>) -> Vec<CloudCluster> {
    clusters.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.location.cmp(&b.location)));
    clusters
}

/// `az aks list -o json`. Listed under the default subscription (`account` empty), each names its
/// own in its id — which is the one `get-credentials` must be given.
fn parse_aks_clusters(text: &str, account: &str) -> Vec<CloudCluster> {
    cli::json_values(text)
        .iter()
        .filter_map(|c| {
            let name = str_at(c, "/name");
            if name.is_empty() {
                return None;
            }
            let version = [str_at(c, "/currentKubernetesVersion"), str_at(c, "/kubernetesVersion")].into_iter().find(|v| !v.is_empty()).unwrap_or_default();
            let from_id = str_at(c, "/id").split('/').skip_while(|part| !part.eq_ignore_ascii_case("subscriptions")).nth(1).unwrap_or_default().to_string();
            Some(CloudCluster {
                name,
                location: str_at(c, "/location"),
                group: str_at(c, "/resourceGroup"),
                version,
                account: if account.is_empty() { from_id } else { account.to_string() },
            })
        })
        .collect()
}

/// `aws eks list-clusters --output json`: `{"clusters": ["a", "b"]}`.
fn parse_eks_names(text: &str) -> Vec<String> {
    let doc: Value = serde_json::from_str(text.trim()).unwrap_or(Value::Null);
    doc.get("clusters").and_then(Value::as_array).map(|list| list.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
}

/// `aws eks describe-cluster --output json`: the Kubernetes version (`1.33`).
fn parse_eks_version(text: &str) -> String {
    let doc: Value = serde_json::from_str(text.trim()).unwrap_or(Value::Null);
    str_at(&doc, "/cluster/version")
}

/// `gcloud container clusters list --format=json`. Listed under the configured project (`project`
/// empty), each names its own in its `selfLink`.
fn parse_gke_clusters(text: &str, project: &str) -> Vec<CloudCluster> {
    cli::json_values(text)
        .iter()
        .filter_map(|c| {
            let name = str_at(c, "/name");
            if name.is_empty() {
                return None;
            }
            let location = [str_at(c, "/location"), str_at(c, "/zone")].into_iter().find(|v| !v.is_empty()).unwrap_or_default();
            let link = str_at(c, "/selfLink");
            let from_link = link.split('/').skip_while(|part| *part != "projects").nth(1).unwrap_or_default().to_string();
            let project = if project.is_empty() { from_link } else { project.to_string() };
            Some(CloudCluster { name, location, group: project.clone(), version: str_at(c, "/currentMasterVersion"), account: project })
        })
        .collect()
}

/// The clusters of one account (and, for EKS, one region).
pub async fn clouds(source: &str, account: &str, region: &str) -> Result<Vec<CloudCluster>, String> {
    let (account, region) = (account.trim(), region.trim());
    match source {
        "aks" => {
            let az = need("az")?;
            let mut args = strings(["aks", "list", "-o", "json"]);
            if !account.is_empty() {
                check_arg("subscription", account)?;
                args.extend(["--subscription".into(), account.into()]);
            }
            let out = run_cloud("aks", &az, &args, &[], LIST_TIMEOUT, "").await?;
            Ok(by_name(parse_aks_clusters(&out, account)))
        }
        "eks" => {
            if region.is_empty() {
                return Err("choose a region: EKS lists the clusters of one region at a time".into());
            }
            check_arg("region", region)?;
            let aws = need("aws")?;
            let mut scope = vec!["--region".to_string(), region.to_string(), "--output".into(), "json".into()];
            if !account.is_empty() {
                check_arg("profile", account)?;
                scope.extend(["--profile".into(), account.into()]);
            }
            let mut args = strings(["eks", "list-clusters"]);
            args.extend(scope.iter().cloned());
            let names = parse_eks_names(&run_cloud("eks", &aws, &args, &[], LIST_TIMEOUT, account).await?);
            // The list has no versions: one `describe-cluster` each, a few at a time. One that fails
            // still lists its cluster, without a version.
            let describe: Vec<Vec<String>> = names
                .iter()
                .map(|name| {
                    let mut args = strings(["eks", "describe-cluster", "--name"]);
                    args.push(name.clone());
                    args.extend(scope.iter().cloned());
                    args
                })
                .collect();
            // Owned arguments in, so each future borrows nothing the command's must outlive.
            let versions: Vec<String> = futures_util::stream::iter(describe.into_iter().map(|args| {
                let aws = aws.clone();
                async move { run_cloud("eks", &aws, &args, &[], LIST_TIMEOUT, "").await.map(|out| parse_eks_version(&out)).unwrap_or_default() }
            }))
            .buffered(DESCRIBE_AT_ONCE)
            .collect()
            .await;
            Ok(by_name(
                names
                    .into_iter()
                    .zip(versions)
                    .map(|(name, version)| CloudCluster { name, location: region.into(), group: region.into(), version, account: account.into() })
                    .collect(),
            ))
        }
        "gke" => {
            let gcloud = need("gcloud")?;
            let mut args = strings(["container", "clusters", "list", "--format=json"]);
            if !account.is_empty() {
                check_arg("project", account)?;
                args.extend(["--project".into(), account.into()]);
            }
            let out = run_cloud("gke", &gcloud, &args, &[], LIST_TIMEOUT, "").await?;
            Ok(by_name(parse_gke_clusters(&out, account)))
        }
        other => Err(format!("{other} is not a cloud this panel reads")),
    }
}

// ------------------------------------------------------------------------------- the fragments

/// A private folder for what one cloud CLI writes, removed with it: the credentials it holds never
/// outlive the add that fetched them.
struct Scratch(PathBuf);

impl Scratch {
    fn new(beside: &Path) -> Result<Scratch, String> {
        let dir = beside.join(format!("{SCRATCH_PREFIX}{}", uuid::Uuid::new_v4().simple()));
        private_dir(&dir)?;
        Ok(Scratch(dir))
    }

    fn kubeconfig(&self) -> PathBuf {
        self.0.join("kubeconfig")
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// What an add that never finished left behind (the app quit mid-way), swept before the next one.
fn sweep_scratch(dir: &Path) {
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        if entry.file_name().to_string_lossy().starts_with(SCRATCH_PREFIX) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

fn kubelogin_install() -> &'static str {
    if cfg!(target_os = "macos") {
        "brew install Azure/kubelogin/kubelogin"
    } else {
        "az aks install-cli"
    }
}

/// A user signing in through Microsoft Entra ID: kubelogin's exec plugin, or the `azure`
/// auth-provider kubectl dropped in 1.26 (which `kubelogin convert-kubeconfig` replaces).
fn signs_in_with_entra(doc: &Value) -> bool {
    entries(doc, "users").any(|user| exec_stem(user) == "kubelogin" || str_at(user, "/user/auth-provider/name") == "azure")
}

/// An exec plugin's program, without its folder or extension (`kubelogin`, `aws`).
fn exec_stem(user: &Value) -> String {
    Path::new(&str_at(user, "/user/exec/command")).file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default()
}

async fn aks_fragment(az: &str, subscription: &str, group: &str, name: &str, admin: bool, scratch: &Scratch, warnings: &mut Vec<String>) -> Result<Value, String> {
    check_arg("resource group", group)?;
    check_arg("cluster", name)?;
    let file = scratch.kubeconfig().to_string_lossy().into_owned();
    let mut args = strings(["aks", "get-credentials", "--resource-group", group.trim(), "--name", name.trim(), "--file", &file, "--overwrite-existing"]);
    if !subscription.trim().is_empty() {
        check_arg("subscription", subscription)?;
        args.extend(["--subscription".into(), subscription.trim().into()]);
    }
    if admin {
        args.push("--admin".into());
    }
    run_cloud("aks", az, &args, &[], CREDENTIALS_TIMEOUT, "").await?;
    let mut doc = load(&scratch.kubeconfig())?;
    // kubelogin's default login is a device code — a prompt in a terminal nobody is at. Converted
    // to `azurecli`, kubectl reuses the `az login` that just listed this cluster.
    let entra = signs_in_with_entra(&doc);
    let kubelogin = cli::find("kubelogin");
    if entra || (!admin && kubelogin.is_some()) {
        match kubelogin {
            Some(kubelogin) => {
                let args = strings(["convert-kubeconfig", "-l", "azurecli", "--kubeconfig", &file]);
                match cli::run_ok(&kubelogin.to_string_lossy(), &args, None, PLUGIN_TIMEOUT).await {
                    Ok(_) => doc = load(&scratch.kubeconfig())?,
                    Err(e) => warnings.push(format!("kubelogin could not switch the cluster to the Azure CLI's sign-in: {}", e.lines().next().unwrap_or_default())),
                }
            }
            None => warnings.push(format!("This cluster signs in with Microsoft Entra ID, which needs kubelogin — install it with `{}`.", kubelogin_install())),
        }
    }
    Ok(doc)
}

async fn eks_fragment(aws: &str, region: &str, name: &str, profile: &str, scratch: &Scratch, warnings: &mut Vec<String>) -> Result<Value, String> {
    check_arg("region", region)?;
    check_arg("cluster", name)?;
    let file = scratch.kubeconfig().to_string_lossy().into_owned();
    let mut args = strings(["eks", "update-kubeconfig", "--name", name.trim(), "--region", region.trim(), "--kubeconfig", &file]);
    if !profile.trim().is_empty() {
        check_arg("profile", profile)?;
        args.extend(["--profile".into(), profile.trim().into()]);
    }
    run_cloud("eks", aws, &args, &[], CREDENTIALS_TIMEOUT, profile).await?;
    let doc = load(&scratch.kubeconfig())?;
    // AWS CLI v1 before 1.24 asks for `client.authentication.k8s.io/v1alpha1`, which kubectl 1.24
    // stopped accepting: the context would fail on every use with an API-version error.
    if entries(&doc, "users").any(|u| str_at(u, "/user/exec/apiVersion").ends_with("/v1alpha1")) {
        let version = cli::run(aws, &strings(["--version"]), None, PLUGIN_TIMEOUT).await.map(|o| format!("{}{}", o.stdout, o.stderr)).unwrap_or_default();
        let found = version.split_whitespace().next().unwrap_or("this AWS CLI").to_string();
        warnings.push(format!("{found} writes an exec API version (v1alpha1) kubectl no longer accepts — update the AWS CLI to v2 and add the cluster again."));
    }
    Ok(doc)
}

/// A GKE location is a zone when it ends in one letter (`europe-west1-b`), a region otherwise.
fn is_zone(location: &str) -> bool {
    location.trim().rsplit_once('-').is_some_and(|(_, last)| last.len() == 1 && last.chars().all(|c| c.is_ascii_lowercase()))
}

async fn gke_fragment(gcloud: &str, project: &str, location: &str, name: &str, scratch: &Scratch, warnings: &mut Vec<String>) -> Result<Value, String> {
    check_arg("location", location)?;
    check_arg("cluster", name)?;
    // `--zone`/`--region` rather than `--location`: an older SDK has only those.
    let flag = if is_zone(location) { "--zone" } else { "--region" };
    let mut args = strings(["container", "clusters", "get-credentials", name.trim(), flag, location.trim()]);
    if !project.trim().is_empty() {
        check_arg("project", project)?;
        args.extend(["--project".into(), project.trim().into()]);
    }
    let file = scratch.kubeconfig().to_string_lossy().into_owned();
    // gcloud writes the first file of KUBECONFIG; the variable also makes an SDK from before the
    // plugin became the default write the plugin rather than the `gcp` auth-provider kubectl dropped.
    let extra = [("KUBECONFIG".to_string(), file), ("USE_GKE_GCLOUD_AUTH_PLUGIN".to_string(), "True".to_string())];
    run_cloud("gke", gcloud, &args, &extra, CREDENTIALS_TIMEOUT, "").await?;
    let doc = load(&scratch.kubeconfig())?;
    let written = entries(&doc, "users").map(|u| str_at(u, "/user/exec/command")).find(|c| !c.is_empty());
    let found = written.as_deref().is_some_and(|c| Path::new(c).is_absolute() && Path::new(c).is_file()) || gke_plugin(cli::find("gcloud").as_deref()).is_some();
    if !found {
        warnings.push("kubectl reaches GKE through gke-gcloud-auth-plugin, which is not installed — run `gcloud components install gke-gcloud-auth-plugin`.".into());
    }
    Ok(doc)
}

/// A name kubectl takes for a context, cluster or user, and that reads the same in every shell.
fn valid_name(name: &str) -> bool {
    name.len() <= 253
        && name.starts_with(|c: char| c.is_ascii_alphanumeric())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '@' | ':' | '-'))
}

/// A PEM block as a kubeconfig's `*-data` field holds it: base64 of the PEM text. Pasted as PEM, or
/// as the base64 another kubeconfig already holds it in.
fn pem_data(text: &str, label: &str, what: &str) -> Result<String, String> {
    let engine = base64::engine::general_purpose::STANDARD;
    let text = text.trim();
    let pem = if text.contains("-----BEGIN") {
        text.replace("\r\n", "\n")
    } else {
        let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
        engine
            .decode(compact)
            .ok()
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .filter(|decoded| decoded.contains("-----BEGIN"))
            .ok_or_else(|| format!("the {what} is not a PEM block (-----BEGIN {label}-----)"))?
    };
    if !pem.contains(&format!("{label}-----")) {
        return Err(format!("the {what} is not a PEM {label}"));
    }
    Ok(engine.encode(format!("{}\n", pem.trim_end())))
}

struct ManualSpec<'a> {
    name: &'a str,
    server: &'a str,
    token: &'a str,
    certificate_authority: &'a str,
    insecure: bool,
    client_certificate: &'a str,
    client_key: &'a str,
    namespace: &'a str,
}

/// A cluster typed in, as the entries `kubectl config set-cluster`, `set-credentials` and
/// `set-context` would write — built here instead of by running them, so the token never sits in a
/// process's arguments (where any local user's `ps` reads it) and no PEM needs a file of its own
/// first. The token and the key do land in the kubeconfig in clear: that is how a kubeconfig holds a
/// credential, which is why the file is 0600.
fn manual_fragment(spec: &ManualSpec, warnings: &mut Vec<String>) -> Result<Value, String> {
    let name = spec.name.trim();
    if !valid_name(name) {
        return Err(format!("\"{name}\" is not a context name: letters, digits and _ . @ : - — starting with a letter or a digit"));
    }
    let server = spec.server.trim().trim_end_matches('/');
    let url = url::Url::parse(server).map_err(|_| format!("\"{server}\" is not an address (https://host:6443)"))?;
    if url.host_str().is_none_or(str::is_empty) {
        return Err(format!("\"{server}\" names no host"));
    }
    match url.scheme() {
        "https" => {}
        "http" => warnings.push("The server is reached over http://: the token travels unencrypted.".into()),
        other => return Err(format!("the server must be https:// (not {other}://)")),
    }
    let mut cluster = json!({ "server": server });
    if spec.insecure {
        // kubectl refuses a CA together with skipping the check, so the box wins.
        cluster["insecure-skip-tls-verify"] = json!(true);
    } else if !spec.certificate_authority.trim().is_empty() {
        cluster["certificate-authority-data"] = json!(pem_data(spec.certificate_authority, "CERTIFICATE", "CA")?);
    }
    let mut user = json!({});
    let token = spec.token.trim();
    if !token.is_empty() {
        if token.contains(char::is_whitespace) {
            return Err("the token has spaces or line breaks in it".into());
        }
        user["token"] = json!(token);
    }
    match (spec.client_certificate.trim().is_empty(), spec.client_key.trim().is_empty()) {
        (true, true) => {}
        (false, false) => {
            user["client-certificate-data"] = json!(pem_data(spec.client_certificate, "CERTIFICATE", "client certificate")?);
            user["client-key-data"] = json!(pem_data(spec.client_key, "PRIVATE KEY", "client key")?);
        }
        _ => return Err("a client certificate goes with its key: give both, or neither".into()),
    }
    if token.is_empty() && spec.client_certificate.trim().is_empty() {
        warnings.push("No token and no client certificate: the cluster will be asked anonymously.".into());
    }
    let mut context = json!({ "cluster": name, "user": name });
    let namespace = spec.namespace.trim();
    if !namespace.is_empty() {
        let label = namespace.len() <= 63
            && namespace.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
            && !namespace.starts_with('-')
            && !namespace.ends_with('-');
        if !label {
            return Err(format!("\"{namespace}\" is not a namespace name"));
        }
        context["namespace"] = json!(namespace);
    }
    Ok(json!({
        "apiVersion": "v1",
        "kind": "Config",
        "clusters": [{ "name": name, "cluster": cluster }],
        "users": [{ "name": name, "user": user }],
        "contexts": [{ "name": name, "context": context }],
    }))
}

fn file_fragment(path: &str, files: &Files) -> Result<Value, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("choose a kubeconfig file".into());
    }
    let path = std::fs::canonicalize(path).map_err(|e| format!("{path}: {e}"))?;
    let same = |other: &Path| std::fs::canonicalize(other).is_ok_and(|o| o == path);
    if same(&files.app) {
        return Err("that is CodeFlow's own kubeconfig".into());
    }
    if files.user.iter().any(|p| same(p)) {
        return Err(format!("kubectl reads {} already: its contexts are in the panel", path.display()));
    }
    let mut doc = load(&path)?;
    check_kubeconfig(&doc)?;
    absolutize(&mut doc, path.parent().unwrap_or(Path::new("/")));
    Ok(doc)
}

/// The entries one request adds, and how a name clash is settled for them.
async fn fragment_for(request: &KubeAddRequest, files: &Files, dir: &Path, warnings: &mut Vec<String>) -> Result<(Value, Clash), String> {
    let doc = match request {
        KubeAddRequest::File { path, .. } => return Ok((file_fragment(path, files)?, Clash::Rename)),
        KubeAddRequest::Manual { name, server, token, certificate_authority, insecure, client_certificate, client_key, namespace, .. } => {
            let spec = ManualSpec { name, server, token, certificate_authority, insecure: *insecure, client_certificate, client_key, namespace };
            manual_fragment(&spec, warnings)?
        }
        KubeAddRequest::Aks { subscription, resource_group, name, admin, .. } => {
            let az = need("az")?;
            let scratch = Scratch::new(dir)?;
            aks_fragment(&az, subscription, resource_group, name, *admin, &scratch, warnings).await?
        }
        KubeAddRequest::Eks { region, name, profile, .. } => {
            let aws = need("aws")?;
            let scratch = Scratch::new(dir)?;
            eks_fragment(&aws, region, name, profile, &scratch, warnings).await?
        }
        KubeAddRequest::Gke { project, location, name, .. } => {
            let gcloud = need("gcloud")?;
            let scratch = Scratch::new(dir)?;
            gke_fragment(&gcloud, project, location, name, &scratch, warnings).await?
        }
    };
    Ok((doc, Clash::Replace))
}

// ------------------------------------------------------------------------------------- adding

pub async fn add(request: KubeAddRequest) -> Result<KubeAdded, String> {
    let files = Files::current().await;
    let _writing = WRITING.lock().await;
    add_into(&files, &request).await
}

async fn add_into(files: &Files, request: &KubeAddRequest) -> Result<KubeAdded, String> {
    let mut warnings = Vec::new();
    let dir = files.app.parent().map(Path::to_path_buf).ok_or("CodeFlow's kubeconfig has no folder")?;
    private_dir(&dir)?;
    sweep_scratch(&dir);
    let (mut fragment, clash) = fragment_for(request, files, &dir, &mut warnings).await?;
    // Which context the source meant (a cloud CLI makes its cluster current): listed first. Never
    // carried over — the user's current context is theirs to change.
    let main = str_at(&fragment, "/current-context");
    if let Some(map) = fragment.as_object_mut() {
        map.remove("current-context");
        map.remove("preferences");
    }
    if names(&fragment, "contexts").is_empty() {
        return Err("no context was written for this cluster".into());
    }

    let user_target = if request.to_user_config() { files.user_target() } else { None };
    if request.to_user_config() && user_target.is_none() {
        warnings.push("There is no ~/.kube/config to write to: the cluster was added to CodeFlow's kubeconfig only.".into());
    }
    let targets: Vec<PathBuf> = std::iter::once(files.app.clone()).chain(user_target).collect();
    // Every file to be written is read before any is: one that does not read as a kubeconfig is
    // never overwritten — the add stops instead.
    let mut docs = Vec::new();
    for target in &targets {
        docs.push(load(target)?);
    }
    let world: Vec<(PathBuf, Value)> = files
        .read_order()
        .into_iter()
        .filter_map(|path| match targets.iter().position(|t| *t == path) {
            Some(at) => Some((path, docs[at].clone())),
            None => load(&path).ok().map(|doc| (path, doc)),
        })
        .collect();
    let renamed = settle(&mut fragment, &world, &targets, clash);
    for (asked, given) in &renamed {
        warnings.push(format!("A context named «{asked}» already exists: this one was added as «{given}»."));
    }
    warnings.extend(dangling(&fragment, &world));
    let main = renamed.iter().find(|(asked, _)| *asked == main).map(|(_, given)| given.clone()).unwrap_or(main);
    let mut contexts = names(&fragment, "contexts");
    if let Some(at) = contexts.iter().position(|c| *c == main) {
        let first = contexts.remove(at);
        contexts.insert(0, first);
    }

    // CodeFlow's file first: once it is written the cluster is in the panel, whatever the user's
    // file then says.
    let mut file = files.app.clone();
    for (index, (target, mut doc)) in targets.iter().zip(docs).enumerate() {
        upsert(&mut doc, &fragment);
        let users = index > 0;
        // A user's file with no current context (a new one) gets this one, as the clouds' CLIs would
        // do; one that has a current context keeps it.
        if users && str_at(&doc, "/current-context").is_empty() {
            doc["current-context"] = Value::String(contexts[0].clone());
        }
        match save(target, &doc) {
            Ok(()) if users => file = target.clone(),
            Ok(()) => {}
            Err(e) if users => warnings.push(format!("{} was not written: {e}", target.display())),
            Err(e) => return Err(e),
        }
    }
    Ok(KubeAdded { contexts, file: file.to_string_lossy().into_owned(), warnings })
}

// ------------------------------------------------------------------------------ origins, removal

/// Where each context comes from — the first file to define it, which is the definition kubectl uses.
fn origins_of(files: &Files) -> Vec<KubeContextOrigin> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for path in files.read_order() {
        let Ok(doc) = load(&path) else { continue };
        for context in names(&doc, "contexts") {
            if seen.insert(context.clone()) {
                out.push(KubeContextOrigin { context, file: path.to_string_lossy().into_owned(), managed: path == files.app });
            }
        }
    }
    out
}

pub async fn origins() -> Result<Vec<KubeContextOrigin>, String> {
    Ok(origins_of(&Files::current().await))
}

/// Whether `context` lives in CodeFlow's kubeconfig alone — which a terminal's kubectl never reads,
/// so it cannot be made that kubectl's current context.
pub async fn only_in_app(context: &str) -> bool {
    origins_of(&Files::current().await).iter().any(|o| o.context == context && o.managed)
}

fn remove_from(files: &Files, context: &str) -> Result<(), String> {
    let mut doc = load(&files.app)?;
    let Some(at) = entries(&doc, "contexts").position(|e| name_of(e) == context) else {
        let elsewhere = files.read_order().into_iter().filter(|p| *p != files.app).find(|p| load(p).is_ok_and(|d| find(&d, "contexts", context).is_some()));
        return Err(match elsewhere {
            Some(path) => format!("«{context}» is in {}, which CodeFlow does not manage — remove it there.", path.display()),
            None => format!("There is no context «{context}» in CodeFlow's kubeconfig."),
        });
    };
    let removed = doc.get_mut("contexts").and_then(Value::as_array_mut).map(|list| list.remove(at)).unwrap_or(Value::Null);
    if str_at(&doc, "/current-context") == context {
        if let Some(map) = doc.as_object_mut() {
            map.remove("current-context");
        }
    }
    // Its cluster and its user go with it unless some context still names them — in this file or in
    // any other kubectl reads, which may lean on an entry defined only here.
    let others: Vec<Value> = files.read_order().into_iter().filter(|p| *p != files.app).filter_map(|p| load(&p).ok()).collect();
    for (field, list) in [("cluster", "clusters"), ("user", "users")] {
        let target = str_at(&removed, &format!("/context/{field}"));
        if target.is_empty() {
            continue;
        }
        let used = std::iter::once(&doc).chain(others.iter()).any(|d| entries(d, "contexts").any(|c| str_at(c, &format!("/context/{field}")) == target));
        if !used {
            if let Some(items) = doc.get_mut(list).and_then(Value::as_array_mut) {
                items.retain(|e| name_of(e) != target);
            }
        }
    }
    if LISTS.iter().all(|list| entries(&doc, list).next().is_none()) {
        // Nothing left: without the file every command is back to the environment it always had.
        return std::fs::remove_file(&files.app).map_err(|e| format!("{}: {e}", files.app.display()));
    }
    save(&files.app, &doc)
}

pub async fn remove(context: &str) -> Result<(), String> {
    let files = Files::current().await;
    let _writing = WRITING.lock().await;
    remove_from(&files, context.trim())
}

// ------------------------------------------------------------------------------------- testing

/// How a context's user signs in, as far as a hint for its errors goes.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
enum Login {
    /// A token or a client certificate in the kubeconfig itself.
    #[default]
    Static,
    Aws,
    Azure,
    Google,
    /// Another exec plugin or auth-provider.
    Other,
}

#[derive(Debug, Clone, Default, PartialEq)]
struct Auth {
    login: Login,
    /// The AWS profile its plugin runs with.
    profile: String,
    /// A plugin that waits for a person: kubelogin's device code, an interactive browser login.
    interactive: bool,
}

fn auth_of_user(user: &Value) -> Auth {
    if user.pointer("/user/exec").is_some() {
        let args: Vec<String> = user.pointer("/user/exec/args").and_then(Value::as_array).map(|l| l.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
        let login = match exec_stem(user).as_str() {
            "aws" | "aws-iam-authenticator" => Login::Aws,
            "kubelogin" => Login::Azure,
            "gke-gcloud-auth-plugin" | "gcloud" => Login::Google,
            _ => Login::Other,
        };
        let from_env = entries(user.pointer("/user/exec").unwrap_or(&Value::Null), "env").find(|e| name_of(e) == "AWS_PROFILE").map(|e| str_at(e, "/value"));
        let from_args = args.iter().position(|a| a == "--profile").and_then(|at| args.get(at + 1)).cloned();
        let profile = from_env.or(from_args).unwrap_or_default();
        let interactive = args.iter().any(|a| matches!(a.as_str(), "devicecode" | "interactive"));
        return Auth { login, profile, interactive };
    }
    match str_at(user, "/user/auth-provider/name").as_str() {
        "" => Auth::default(),
        "azure" => Auth { login: Login::Azure, ..Auth::default() },
        "gcp" => Auth { login: Login::Google, ..Auth::default() },
        _ => Auth { login: Login::Other, ..Auth::default() },
    }
}

/// How `context` signs in, read as kubectl merges: the first file to define the context, then the
/// first to define its user.
fn auth_of(docs: &[Value], context: &str) -> Auth {
    let user = docs.iter().find_map(|d| find(d, "contexts", context)).map(|c| str_at(c, "/context/user")).unwrap_or_default();
    if user.is_empty() {
        return Auth::default();
    }
    docs.iter().find_map(|d| find(d, "users", &user)).map(auth_of_user).unwrap_or_default()
}

/// What to do about a failed `kubectl version` — a key the panel words (`containers.kube.add.hint.*`),
/// `awsLogin` carrying the profile after a colon.
fn hint_for(error: &str, auth: &Auth) -> Option<String> {
    let e = error.to_lowercase();
    let has = |needle: &str| e.contains(needle);
    let missing = has("not found") || has("no such file");
    let timed_out = has("did not answer within");
    let aws_login = || if auth.profile.is_empty() { "awsLogin".to_string() } else { format!("awsLogin:{}", auth.profile) };
    let key = if has("could not start") {
        "kubectl".to_string()
    } else if (has("kubelogin") && missing) || has("azure auth plugin has been removed") {
        "kubelogin".to_string()
    } else if (has("gke-gcloud-auth-plugin") && missing) || has("gcp auth plugin has been removed") {
        "gkePlugin".to_string()
    } else if has("executable aws") && missing {
        "awsCli".to_string()
    } else if has("devicelogin") || has("device code") || (timed_out && auth.interactive) {
        "interactive".to_string()
    } else if has("aadsts") || has("az login") {
        "azLogin".to_string()
    } else if has("expiredtoken") || has("token has expired") || has("sso session") || has("error loading sso token") || has("unable to locate credentials") || (auth.login == Login::Aws && has("expired")) {
        aws_login()
    } else if has("gcloud auth login") || has("reauthentication") || has("invalid_grant") || has("do not currently have an active account") {
        "gcloudLogin".to_string()
    } else if has("unauthorized") || has("must be logged in") || has("provide credentials") {
        match auth.login {
            Login::Aws => aws_login(),
            Login::Azure => "azLogin".to_string(),
            Login::Google => "gcloudLogin".to_string(),
            Login::Static | Login::Other => "credentials".to_string(),
        }
    } else if has("x509") || has("certificate signed by unknown authority") || has("failed to verify certificate") || has("certificate is not trusted") {
        "ca".to_string()
    } else if timed_out && auth.login != Login::Static {
        // A plugin that never returned is more often waiting for a sign-in than a cluster that is down.
        "interactive".to_string()
    } else if timed_out
        || has("connection refused")
        || has("was refused")
        || has("no such host")
        || has("i/o timeout")
        || has("network is unreachable")
        || has("no route to host")
        || has("deadline exceeded")
        || has("client.timeout")
        || has("tls handshake timeout")
        || has("unable to connect to the server")
    {
        "unreachable".to_string()
    } else {
        return None;
    };
    Some(key)
}

/// kubectl's own words, cut to what a line of the panel holds.
fn tidy(error: &str) -> String {
    let lines: Vec<&str> = error.lines().map(str::trim).filter(|l| !l.is_empty()).take(3).collect();
    let text = lines.join("\n");
    let text = text.strip_prefix("error: ").unwrap_or(&text);
    if text.chars().count() > 400 {
        format!("{}…", text.chars().take(400).collect::<String>())
    } else {
        text.to_string()
    }
}

pub async fn test(context: &str) -> KubeTest {
    let context = context.trim();
    let failed = |error: String, hint: Option<String>| KubeTest { ok: false, version: None, error: Some(error), hint };
    if let Err(error) = check_arg("context", context) {
        return failed(error, None);
    }
    let files = Files::current().await;
    let docs: Vec<Value> = files.read_order().iter().filter_map(|p| load(p).ok()).collect();
    let auth = auth_of(&docs, context);
    let args = strings(["--context", context, "version", "-o", "json", "--request-timeout=8s"]);
    let error = match cli::run(&kube::program(), &args, None, TEST_TIMEOUT).await {
        Ok(out) => {
            let doc: Value = serde_json::from_str(out.stdout.trim()).unwrap_or(Value::Null);
            if let Some(version) = doc.pointer("/serverVersion/gitVersion").and_then(Value::as_str) {
                return KubeTest { ok: true, version: Some(version.to_string()), error: None, hint: None };
            }
            out.complaint()
        }
        Err(error) => error,
    };
    let hint = hint_for(&error, &auth);
    failed(tidy(&error), hint)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cf-kubeconfig-{tag}-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    const USERS_CONFIG: &str = "apiVersion: v1
kind: Config
current-context: orbstack
clusters:
- cluster:
    server: https://127.0.0.1:26443
  name: orbstack
- cluster:
    server: https://10.0.0.1:6443
  name: kubernetes
users:
- name: orbstack
  user:
    token: theirs
- name: kubernetes-admin
  user:
    token: admin-a
contexts:
- context:
    cluster: orbstack
    user: orbstack
  name: orbstack
- context:
    cluster: kubernetes
    user: kubernetes-admin
  name: kubernetes-admin@kubernetes
";

    /// A kubeadm-style file whose names collide with the user's `kubernetes` cluster, with a CA
    /// named relative to its own folder.
    const IMPORTED: &str = "apiVersion: v1
kind: Config
current-context: kubernetes-admin@kubernetes
clusters:
- cluster:
    certificate-authority: certs/ca.crt
    server: https://192.168.1.20:6443
  name: kubernetes
users:
- name: kubernetes-admin
  user:
    token: admin-b
contexts:
- context:
    cluster: kubernetes
    user: kubernetes-admin
    namespace: shop
  name: kubernetes-admin@kubernetes
";

    struct Setup {
        root: PathBuf,
        files: Files,
        user_file: PathBuf,
    }

    impl Drop for Setup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    /// A home with `~/.kube/config` holding [`USERS_CONFIG`], and an app kubeconfig not yet made.
    fn setup(tag: &str) -> Setup {
        let root = scratch(tag);
        let home = root.join("home");
        let user_file = home.join(".kube").join("config");
        write(&user_file, USERS_CONFIG);
        let files = Files::new(root.join("state").join("containers").join("kubeconfig"), None, Some(home.as_path()));
        Setup { root, files, user_file }
    }

    fn manual(name: &str, server: &str, token: &str) -> KubeAddRequest {
        KubeAddRequest::Manual {
            name: name.into(),
            server: server.into(),
            token: token.into(),
            certificate_authority: String::new(),
            insecure: false,
            client_certificate: String::new(),
            client_key: String::new(),
            namespace: String::new(),
            to_user_config: false,
        }
    }

    #[test]
    fn the_composed_list_puts_codeflows_file_last() {
        let root = scratch("compose");
        let home = root.join("home");
        let app = root.join("app").join("kubeconfig");
        let sep = list_separator();
        let home = home.as_path();
        assert_eq!(compose(None, Some(home), &app), app.to_string_lossy(), "no ~/.kube/config: CodeFlow's alone");
        write(&home.join(".kube").join("config"), "{}");
        assert_eq!(compose(None, Some(home), &app), format!("{}{sep}{}", home.join(".kube").join("config").display(), app.display()));
        let theirs = format!("/a{sep}{sep}/b");
        assert_eq!(compose(Some(theirs.as_str()), Some(home), &app), format!("/a{sep}/b{sep}{}", app.display()), "the user's list as written, then CodeFlow's");
        let listed = format!("/a{sep}{}", app.display());
        assert_eq!(compose(Some(listed.as_str()), Some(home), &app), listed, "never twice");
        assert_eq!(user_files(Some(theirs.as_str()), Some(home)), vec![PathBuf::from("/a"), PathBuf::from("/b")]);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn yaml_round_trips_and_quotes_what_kubectl_would_misread() {
        let doc = json!({
            "apiVersion": "v1",
            "kind": "Config",
            "clusters": [{"name": "1_000", "cluster": {"server": "https://h:6443", "insecure-skip-tls-verify": true}}],
            "users": [{"name": "yes", "user": {"exec": {"command": "aws", "args": ["--region", "us-east-1", "eks", "get-token"], "env": [{"name": "AWS_PROFILE", "value": "0b101"}]}}}],
            "contexts": [{"name": "arn:aws:eks:us-east-1:1:cluster/x", "context": {"cluster": "1_000", "user": "yes", "namespace": ""}}],
            "preferences": {},
            "extensions": [],
            "odd": "line\nbreak \"quoted\" ñandú",
        });
        let text = render(&doc);
        // Key order is whatever the map keeps (insertion order here): only the lines are pinned.
        assert!(text.contains("clusters:\n- "), "a list at its key's indentation, as kubectl writes it: {text}");
        for line in ["name: \"1_000\"\n", "server: \"https://h:6443\"\n", "insecure-skip-tls-verify: true\n", "- \"--region\"\n", "apiVersion: v1\n", "preferences: {}\n", "extensions: []\n"] {
            assert!(text.contains(line), "{line:?} in {text}");
        }
        assert!(text.contains("name: \"yes\"\n"), "a YAML 1.1 boolean stays text: {text}");
        assert!(text.contains("value: \"0b101\"\n"), "a YAML 1.1 number stays text: {text}");
        assert_eq!(parse(&text).unwrap(), doc, "{text}");
        assert_eq!(render(&json!({})), "{}\n");
    }

    #[test]
    fn booleans_read_the_way_kubectl_reads_them() {
        let doc = parse("clusters:\n- name: a\n  cluster:\n    server: https://a\n    insecure-skip-tls-verify: yes\n- name: b\n  cluster:\n    server: https://b\n    insecure-skip-tls-verify: off\n").unwrap();
        assert_eq!(doc["clusters"][0]["cluster"]["insecure-skip-tls-verify"], json!(true));
        assert_eq!(doc["clusters"][1]["cluster"]["insecure-skip-tls-verify"], json!(false));
        assert_eq!(parse("").unwrap(), json!({}), "an empty file is an empty kubeconfig");
        assert!(parse("- a\n- b\n").is_err());
        assert!(parse("a: [b").is_err());
        assert_eq!(parse("{\"apiVersion\":\"v1\",\"contexts\":[]}").unwrap()["apiVersion"], "v1", "JSON is YAML too");
    }

    #[test]
    fn an_imported_name_is_kept_when_free_or_identical_and_suffixed_when_taken() {
        let world = vec![(PathBuf::from("/home/.kube/config"), parse(USERS_CONFIG).unwrap())];
        let targets = vec![PathBuf::from("/app/kubeconfig")];

        let mut different = parse(IMPORTED).unwrap();
        let renamed = settle(&mut different, &world, &targets, Clash::Rename);
        assert_eq!(renamed, vec![("kubernetes-admin@kubernetes".to_string(), "kubernetes-admin@kubernetes-2".to_string())]);
        assert_eq!(names(&different, "clusters"), vec!["kubernetes-2"]);
        assert_eq!(names(&different, "users"), vec!["kubernetes-admin-2"]);
        assert_eq!(different["contexts"][0]["context"]["cluster"], "kubernetes-2", "the context follows its cluster");
        assert_eq!(different["contexts"][0]["context"]["user"], "kubernetes-admin-2");

        // The same entries again: nothing to rename, nothing duplicated.
        let mut same = parse(USERS_CONFIG).unwrap();
        assert!(settle(&mut same, &world, &targets, Clash::Rename).is_empty());
        assert_eq!(names(&same, "contexts"), vec!["orbstack", "kubernetes-admin@kubernetes"]);
    }

    #[test]
    fn a_cloud_cluster_refreshes_its_own_copy_and_never_hides_behind_the_users() {
        let fresh = || json!({
            "clusters": [{"name": "aks1", "cluster": {"server": "https://aks1:443"}}],
            "users": [{"name": "clusterUser_rg_aks1", "user": {"token": "new"}}],
            "contexts": [{"name": "aks1", "context": {"cluster": "aks1", "user": "clusterUser_rg_aks1"}}],
        });
        let old = json!({
            "clusters": [{"name": "aks1", "cluster": {"server": "https://aks1:443"}}],
            "users": [{"name": "clusterUser_rg_aks1", "user": {"token": "old"}}],
            "contexts": [{"name": "aks1", "context": {"cluster": "aks1", "user": "clusterUser_rg_aks1"}}],
        });
        let app = PathBuf::from("/app/kubeconfig");
        let user = PathBuf::from("/home/.kube/config");

        let mut refresh = fresh();
        assert!(settle(&mut refresh, &[(app.clone(), old.clone())], std::slice::from_ref(&app), Clash::Replace).is_empty(), "its own earlier copy is replaced");

        let mut shadowed = fresh();
        let renamed = settle(&mut shadowed, &[(user.clone(), old.clone())], std::slice::from_ref(&app), Clash::Replace);
        assert_eq!(renamed, vec![("aks1".to_string(), "aks1-2".to_string())], "the user's would win: suffixed instead");
        assert_eq!(shadowed["contexts"][0]["context"]["user"], "clusterUser_rg_aks1-2");

        let mut both = fresh();
        assert!(settle(&mut both, &[(user.clone(), old)], &[app, user], Clash::Replace).is_empty(), "written to the user's file too: refreshed there");
    }

    #[tokio::test]
    async fn an_imported_file_lands_in_codeflows_kubeconfig_and_the_users_is_left_alone() {
        let s = setup("import");
        let import = s.root.join("elsewhere").join("lab.yaml");
        write(&import, IMPORTED);
        let added = add_into(&s.files, &KubeAddRequest::File { path: import.to_string_lossy().into(), to_user_config: false }).await.unwrap();
        assert_eq!(added.contexts, vec!["kubernetes-admin@kubernetes-2"]);
        assert_eq!(added.file, s.files.app.to_string_lossy());
        assert!(added.warnings.iter().any(|w| w.contains("«kubernetes-admin@kubernetes-2»")), "{:?}", added.warnings);
        assert_eq!(std::fs::read_to_string(&s.user_file).unwrap(), USERS_CONFIG, "the user's file is never touched");

        let app = load(&s.files.app).unwrap();
        assert!(app.get("current-context").is_none(), "CodeFlow's file never takes a current context");
        let ca = str_at(find(&app, "clusters", "kubernetes-2").unwrap(), "/cluster/certificate-authority");
        let expected = std::fs::canonicalize(import.parent().unwrap()).unwrap().join("certs/ca.crt");
        assert_eq!(PathBuf::from(&ca), expected, "a path relative to the imported file still points at its file");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&s.files.app).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(std::fs::metadata(s.files.app.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
        }

        // Both files in kubectl's order: the user's first, each context once, CodeFlow's marked.
        let origins = origins_of(&s.files);
        let managed: Vec<(&str, bool)> = origins.iter().map(|o| (o.context.as_str(), o.managed)).collect();
        assert_eq!(managed, vec![("orbstack", false), ("kubernetes-admin@kubernetes", false), ("kubernetes-admin@kubernetes-2", true)]);

        // The same file again adds nothing new.
        let again = add_into(&s.files, &KubeAddRequest::File { path: import.to_string_lossy().into(), to_user_config: false }).await.unwrap();
        assert_eq!(again.contexts, vec!["kubernetes-admin@kubernetes-2"]);
        assert_eq!(names(&load(&s.files.app).unwrap(), "contexts").len(), 1);

        assert!(add_into(&s.files, &KubeAddRequest::File { path: s.user_file.to_string_lossy().into(), to_user_config: false }).await.unwrap_err().contains("already"));
        let manifest = s.root.join("deploy.yaml");
        write(&manifest, "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: x\n");
        assert_eq!(add_into(&s.files, &KubeAddRequest::File { path: manifest.to_string_lossy().into(), to_user_config: false }).await.unwrap_err(), "not a kubeconfig: it is a Deployment");
        assert!(!s.root.join("state").join("containers").read_dir().unwrap().flatten().any(|e| e.file_name().to_string_lossy().starts_with('.')), "no scratch or temporary file stays behind");
    }

    #[tokio::test]
    async fn also_in_the_users_file_writes_both_and_keeps_their_current_context() {
        let s = setup("both");
        let mut request = manual("lab", "https://lab.example.test:6443", "abc.def");
        if let KubeAddRequest::Manual { to_user_config, .. } = &mut request {
            *to_user_config = true;
        }
        let added = add_into(&s.files, &request).await.unwrap();
        assert_eq!(added.file, s.user_file.to_string_lossy());
        let theirs = load(&s.user_file).unwrap();
        assert_eq!(str_at(&theirs, "/current-context"), "orbstack", "their current context stays theirs");
        assert_eq!(str_at(find(&theirs, "users", "lab").unwrap(), "/user/token"), "abc.def");
        assert!(find(&theirs, "contexts", "orbstack").is_some(), "nothing of theirs is lost");
        assert!(find(&load(&s.files.app).unwrap(), "contexts", "lab").is_some());

        // A user without a kubeconfig gets one, with the new context current.
        let fresh = setup("fresh");
        std::fs::remove_file(&fresh.user_file).unwrap();
        let mut request = manual("lab", "https://lab.example.test:6443", "abc");
        if let KubeAddRequest::Manual { to_user_config, .. } = &mut request {
            *to_user_config = true;
        }
        add_into(&fresh.files, &request).await.unwrap();
        assert_eq!(str_at(&load(&fresh.user_file).unwrap(), "/current-context"), "lab");

        // A file of theirs that does not parse is never written over: the add stops first.
        let broken = setup("broken");
        write(&broken.user_file, "clusters: [unclosed\n");
        assert!(add_into(&broken.files, &request).await.is_err());
        assert_eq!(std::fs::read_to_string(&broken.user_file).unwrap(), "clusters: [unclosed\n");
        assert!(!broken.files.app.exists(), "nothing written at all");
    }

    #[test]
    fn a_typed_in_cluster_is_checked_and_built_like_kubectl_config_set() {
        let ca_pem = "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ==\n-----END CERTIFICATE-----";
        let engine = base64::engine::general_purpose::STANDARD;
        let spec = |name: &'static str, server: &'static str| ManualSpec { name, server, token: "t0k3n", certificate_authority: "", insecure: false, client_certificate: "", client_key: "", namespace: "" };
        let mut warnings = vec![];
        let doc = manual_fragment(&ManualSpec { certificate_authority: ca_pem, namespace: "shop", ..spec("lab", "https://lab:6443/") }, &mut warnings).unwrap();
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(doc["clusters"][0], json!({"name": "lab", "cluster": {"server": "https://lab:6443", "certificate-authority-data": engine.encode(format!("{ca_pem}\n"))}}));
        assert_eq!(doc["users"][0], json!({"name": "lab", "user": {"token": "t0k3n"}}));
        assert_eq!(doc["contexts"][0], json!({"name": "lab", "context": {"cluster": "lab", "user": "lab", "namespace": "shop"}}));

        // The CA pasted as the base64 another kubeconfig holds it in reads the same.
        let as_data = engine.encode(format!("{ca_pem}\n"));
        let again = manual_fragment(&ManualSpec { certificate_authority: &as_data, ..spec("lab", "https://lab:6443") }, &mut vec![]).unwrap();
        assert_eq!(again["clusters"][0]["cluster"]["certificate-authority-data"], doc["clusters"][0]["cluster"]["certificate-authority-data"]);

        let insecure = manual_fragment(&ManualSpec { insecure: true, certificate_authority: ca_pem, ..spec("lab", "https://lab") }, &mut vec![]).unwrap();
        assert_eq!(insecure["clusters"][0]["cluster"], json!({"server": "https://lab", "insecure-skip-tls-verify": true}), "the box wins over a CA kubectl would refuse with it");

        let mut warnings = vec![];
        manual_fragment(&spec("lab", "http://127.0.0.1:8080"), &mut warnings).unwrap();
        assert_eq!(warnings.len(), 1, "http is allowed, with a warning");

        assert!(manual_fragment(&spec("-lab", "https://lab"), &mut vec![]).is_err());
        assert!(manual_fragment(&spec("my lab", "https://lab"), &mut vec![]).is_err());
        assert!(manual_fragment(&spec("lab", "ftp://lab"), &mut vec![]).is_err());
        assert!(manual_fragment(&spec("lab", "lab:6443"), &mut vec![]).is_err());
        assert!(manual_fragment(&ManualSpec { certificate_authority: "not a pem", ..spec("lab", "https://lab") }, &mut vec![]).is_err());
        assert!(manual_fragment(&ManualSpec { client_certificate: ca_pem, ..spec("lab", "https://lab") }, &mut vec![]).unwrap_err().contains("both"));
        assert!(manual_fragment(&ManualSpec { token: "a b", ..spec("lab", "https://lab") }, &mut vec![]).is_err());
        assert!(manual_fragment(&ManualSpec { namespace: "Shop", ..spec("lab", "https://lab") }, &mut vec![]).is_err());
        let key = "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEE\n-----END EC PRIVATE KEY-----\n";
        let with_cert = manual_fragment(&ManualSpec { token: "", client_certificate: ca_pem, client_key: key, ..spec("admin@lab", "https://lab") }, &mut vec![]).unwrap();
        assert_eq!(with_cert["users"][0]["user"]["client-key-data"], engine.encode(key));
        assert!(valid_name("arn:aws:eks:us-east-1:1:cluster-x") && !valid_name("") && !valid_name("a/b"));
    }

    #[tokio::test]
    async fn removing_takes_only_codeflows_own_and_what_nothing_else_uses() {
        let s = setup("remove");
        add_into(&s.files, &manual("lab", "https://lab:6443", "a")).await.unwrap();
        // A second context on the same cluster and user.
        let mut doc = load(&s.files.app).unwrap();
        doc["contexts"].as_array_mut().unwrap().push(json!({"name": "lab-system", "context": {"cluster": "lab", "user": "lab", "namespace": "kube-system"}}));
        save(&s.files.app, &doc).unwrap();

        remove_from(&s.files, "lab").unwrap();
        let left = load(&s.files.app).unwrap();
        assert_eq!(names(&left, "contexts"), vec!["lab-system"]);
        assert_eq!(names(&left, "clusters"), vec!["lab"], "still used by lab-system");

        assert!(remove_from(&s.files, "orbstack").unwrap_err().contains("does not manage"), "the user's are refused");
        assert!(remove_from(&s.files, "nope").unwrap_err().contains("no context"));
        assert_eq!(std::fs::read_to_string(&s.user_file).unwrap(), USERS_CONFIG);

        remove_from(&s.files, "lab-system").unwrap();
        assert!(!s.files.app.exists(), "the last one takes the file with it: every command is back to what it was");
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_kubeconfig_is_written_through_its_link() {
        let root = scratch("link");
        let real = root.join("dotfiles").join("kubeconfig");
        write(&real, USERS_CONFIG);
        std::os::unix::fs::symlink(&real, root.join("config")).unwrap();
        let mut doc = load(&root.join("config")).unwrap();
        upsert(&mut doc, &json!({"contexts": [{"name": "x", "context": {"cluster": "orbstack", "user": "orbstack"}}]}));
        save(&root.join("config"), &doc).unwrap();
        assert!(std::fs::symlink_metadata(root.join("config")).unwrap().file_type().is_symlink(), "still a link");
        assert!(find(&load(&real).unwrap(), "contexts", "x").is_some());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn cloud_listings_are_read() {
        let az = r#"[{"cloudName":"AzureCloud","id":"1111","isDefault":false,"name":"Dev","state":"Enabled"},{"id":"2222","isDefault":true,"name":"Prod","state":"Enabled"},{"id":"3333","name":"Old","state":"Disabled"}]"#;
        let accounts = parse_az_accounts(az);
        assert_eq!(accounts.iter().map(|a| (a.id.as_str(), a.is_default)).collect::<Vec<_>>(), vec![("2222", true), ("1111", false)]);

        let aks = r#"[{"id":"/subscriptions/2222/resourcegroups/rg-shop/providers/Microsoft.ContainerService/managedClusters/shop","name":"shop","location":"eastus","resourceGroup":"rg-shop","kubernetesVersion":"1.30","currentKubernetesVersion":"1.30.4"}]"#;
        assert_eq!(parse_aks_clusters(aks, ""), vec![CloudCluster { name: "shop".into(), location: "eastus".into(), group: "rg-shop".into(), version: "1.30.4".into(), account: "2222".into() }]);
        assert_eq!(parse_aks_clusters(aks, "9999")[0].account, "9999");

        assert_eq!(parse_eks_names(r#"{"clusters": ["api", "jobs"]}"#), vec!["api", "jobs"]);
        assert_eq!(parse_eks_version(r#"{"cluster": {"name": "api", "version": "1.33", "status": "ACTIVE"}}"#), "1.33");
        assert!(parse_eks_names("").is_empty());

        let gke = r#"[{"name":"web","location":"europe-west1-b","zone":"europe-west1-b","currentMasterVersion":"1.31.5-gke.100","selfLink":"https://container.googleapis.com/v1/projects/acme-prod/zones/europe-west1-b/clusters/web"}]"#;
        let clusters = parse_gke_clusters(gke, "");
        assert_eq!((clusters[0].group.as_str(), clusters[0].location.as_str(), clusters[0].version.as_str()), ("acme-prod", "europe-west1-b", "1.31.5-gke.100"));

        let projects = r#"[{"projectId":"acme-dev","name":"Acme Dev","lifecycleState":"ACTIVE"},{"projectId":"acme-prod","name":"Acme Prod","lifecycleState":"ACTIVE"},{"projectId":"gone","lifecycleState":"DELETE_REQUESTED"}]"#;
        let read = parse_gcloud_projects(projects, Some("acme-prod"));
        assert_eq!(read.iter().map(|p| (p.id.as_str(), p.is_default)).collect::<Vec<_>>(), vec![("acme-prod", true), ("acme-dev", false)]);

        assert_eq!(parse_aws_profiles("default\nwork\n\nwork\n"), vec!["default", "work"]);
        let ini = parse_aws_ini("[default]\nregion = us-east-1\n[profile work]\n[sso-session corp]\n[services x]\n", "[default]\n[legacy]\n");
        assert_eq!(ini, vec!["default", "work", "legacy"]);
        let ordered = order_profiles(vec!["work".into(), "default".into(), "alpha".into()], Some("work"));
        assert_eq!(ordered.iter().map(|p| (p.id.as_str(), p.is_default)).collect::<Vec<_>>(), vec![("work", true), ("default", false), ("alpha", false)]);
        assert_eq!(order_profiles(vec!["alpha".into(), "default".into()], None)[0].id, "default");

        assert!(is_zone("us-central1-a") && !is_zone("us-central1") && !is_zone("northamerica-northeast1"));
    }

    #[test]
    fn a_signed_out_cloud_names_the_command_that_signs_in() {
        assert_eq!(cloud_error("aks", "ERROR: Please run 'az login' to setup account.", ""), "Not signed in to Azure — run `az login` in a terminal.");
        assert!(cloud_error("eks", "Error when retrieving token from sso: Token has expired and refresh failed", "work").contains("`aws sso login --profile work`"));
        assert!(cloud_error("eks", "Unable to locate credentials. You can configure credentials by running \"aws configure\".", "").contains("`aws configure`"));
        assert!(cloud_error("gke", "ERROR: (gcloud.container.clusters.list) You do not currently have an active account selected.", "").contains("gcloud auth login"));
        assert_eq!(cloud_error("aks", "ERROR: (ResourceGroupNotFound) Resource group 'x' could not be found.", ""), "ERROR: (ResourceGroupNotFound) Resource group 'x' could not be found.");
    }

    #[test]
    fn a_failed_test_points_at_the_way_out() {
        let aws = auth_of_user(&json!({"name": "u", "user": {"exec": {"command": "aws", "args": ["--region", "us-east-1", "eks", "get-token", "--cluster-name", "api"], "env": [{"name": "AWS_PROFILE", "value": "work"}]}}}));
        assert_eq!((aws.login, aws.profile.as_str()), (Login::Aws, "work"));
        let azure = auth_of_user(&json!({"name": "u", "user": {"exec": {"command": "kubelogin", "args": ["get-token", "--login", "devicecode"]}}}));
        assert!(azure.interactive && azure.login == Login::Azure);
        let plain = Auth::default();

        let hint = |error: &str, auth: &Auth| hint_for(error, auth);
        assert_eq!(hint("Unable to connect to the server: getting credentials: exec: executable kubelogin not found", &plain).as_deref(), Some("kubelogin"));
        assert_eq!(hint("exec: executable gke-gcloud-auth-plugin not found", &plain).as_deref(), Some("gkePlugin"));
        assert_eq!(hint("getting credentials: exec: executable aws not found", &plain).as_deref(), Some("awsCli"));
        assert_eq!(hint("Error when retrieving token from sso: Token has expired and refresh failed", &aws).as_deref(), Some("awsLogin:work"));
        assert_eq!(hint("error: You must be logged in to the server (Unauthorized)", &aws).as_deref(), Some("awsLogin:work"));
        assert_eq!(hint("error: You must be logged in to the server (Unauthorized)", &plain).as_deref(), Some("credentials"));
        assert_eq!(hint("AzureCLICredential: ERROR: Please run 'az login' to setup account.", &azure).as_deref(), Some("azLogin"));
        assert_eq!(hint("AADSTS70043: The refresh token has expired", &plain).as_deref(), Some("azLogin"));
        assert_eq!(hint("Unable to connect to the server: tls: failed to verify certificate: x509: certificate signed by unknown authority", &plain).as_deref(), Some("ca"));
        assert_eq!(hint("Unable to connect to the server: dial tcp 10.0.0.1:443: i/o timeout", &plain).as_deref(), Some("unreachable"));
        assert_eq!(hint("dial tcp: lookup x.privatelink.eastus.azmk8s.io: no such host", &plain).as_deref(), Some("unreachable"));
        assert_eq!(hint("The connection to the server localhost:8080 was refused - did you specify the right host or port?", &plain).as_deref(), Some("unreachable"));
        assert_eq!(hint("kubectl did not answer within 25 s", &azure).as_deref(), Some("interactive"));
        assert_eq!(hint("kubectl did not answer within 25 s", &plain).as_deref(), Some("unreachable"));
        assert_eq!(hint("could not start kubectl: No such file or directory", &plain).as_deref(), Some("kubectl"));
        assert_eq!(hint("Error from server (Forbidden): something else", &plain), None);
        assert_eq!(tidy("error: one\n\n two\nthree\nfour"), "one\ntwo\nthree");

        let docs = vec![parse(USERS_CONFIG).unwrap()];
        assert_eq!(auth_of(&docs, "orbstack"), Auth::default());
        assert_eq!(auth_of(&docs, "missing"), Auth::default());
    }

    #[test]
    fn a_value_is_never_read_as_a_flag() {
        assert!(check_arg("cluster", "shop").is_ok());
        assert!(check_arg("cluster", "--all").is_err());
        assert!(check_arg("cluster", "  ").is_err());
        assert!(check_arg("cluster", "a\nb").is_err());
    }
}
