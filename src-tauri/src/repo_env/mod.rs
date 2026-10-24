//! «Entorno» — a repository's environment variables, across every file that sets them.
//!
//! Asked for 2026-10-23: «Variables de entorno de los repos … Detecta `.env`, `.env.example`,
//! `appsettings.*.json` y `launchSettings.json`. Tabla comparativa entre archivos/ambientes: qué
//! variable falta en cuál y cuál está vacía. Avisa si una variable que el código lee no está en
//! `.env.example`. Pasar un secreto al Llavero con un clic». Not the API client's environments —
//! those are request variables; these are the files a program reads at start.
//!
//! - `config` — which files are read (configurable globally and per repository).
//! - `dotenv`, `json`, `yaml`, `properties` — one reader per format, every value with its position.
//! - `edit` — the Llavero reference syntax, and the in-place rewrite.
//! - `usage` — what the code reads, for the "not in the example" check.
//! - `inject` — Services resolving those references when it starts a process.
//!
//! **Values never leave this module on their own.** A scan carries keys, whether each is empty and
//! whether it is a reference — never a value. One value crosses to the webview only through
//! `reveal`, on the user's click on that one cell; nothing here logs or formats a value into an
//! error.

pub mod config;
pub mod dotenv;
pub mod edit;
pub mod inject;
pub mod json;
pub mod properties;
pub mod usage;
pub mod yaml;

use std::path::{Path, PathBuf};

use serde::Serialize;

use config::{Effective, Matcher};
use edit::Edit;

/// One variable as a file sets it.
#[derive(Debug, Clone)]
pub struct Entry {
    pub key: String,
    pub value: String,
    /// 1-based.
    pub line: usize,
    /// The Llavero item id, when the file holds a reference instead of a value.
    pub reference: Option<String>,
    /// The launch profile or Compose service it belongs to.
    pub sub: Option<String>,
    pub edit: Edit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Format {
    Dotenv,
    Appsettings,
    LaunchSettings,
    Compose,
    Properties,
    Yaml,
    Json,
}

/// Which reader a file gets, from its name alone.
pub fn format_of(rel: &str) -> Format {
    let name = rel.rsplit('/').next().unwrap_or(rel).to_ascii_lowercase();
    if name == "launchsettings.json" {
        Format::LaunchSettings
    } else if name.ends_with(".json") {
        if name.starts_with("appsettings") {
            Format::Appsettings
        } else {
            Format::Json
        }
    } else if name.ends_with(".yml") || name.ends_with(".yaml") {
        if name.starts_with("docker-compose") || name.starts_with("compose") {
            Format::Compose
        } else {
            Format::Yaml
        }
    } else if name.ends_with(".properties") {
        Format::Properties
    } else {
        Format::Dotenv
    }
}

/// Parses `text` as `format`. A launch file and a Compose file also name their profiles / services,
/// so a profile with no variables still gets a column.
pub fn parse(format: Format, text: &str) -> Result<(Vec<String>, Vec<Entry>), String> {
    match format {
        Format::Dotenv => Ok((Vec::new(), dotenv::parse(text))),
        Format::Appsettings | Format::Json => Ok((Vec::new(), json::parse_settings(text)?)),
        Format::LaunchSettings => json::parse_launch(text),
        Format::Compose => Ok(yaml::parse_compose(text)),
        Format::Yaml => Ok((Vec::new(), yaml::parse_flat(text))),
        Format::Properties => Ok((Vec::new(), properties::parse(text))),
    }
}

// ---------------------------------------------------------------------------------------------
// Finding the files
// ---------------------------------------------------------------------------------------------

pub const MAX_DEPTH: usize = 8;
pub const MAX_DIRS: usize = 6000;
pub const MAX_FILES: usize = 300;
pub const MAX_BYTES: u64 = 1024 * 1024;

/// The files the patterns match under `root`, plus the ones added by hand, minus the ignored ones —
/// normalized relative paths, sorted. `true` when a budget cut the walk short.
pub fn find_files(root: &Path, eff: &Effective, matcher: &Matcher) -> (Vec<String>, bool) {
    let exclude: Vec<String> = eff.exclude.iter().map(|e| e.to_ascii_lowercase()).collect();
    let mut found: Vec<String> = Vec::new();
    let mut truncated = false;
    let mut queue: std::collections::VecDeque<(PathBuf, String, usize)> = std::collections::VecDeque::new();
    queue.push_back((root.to_path_buf(), String::new(), 0));
    let mut dirs = 0;
    while let Some((dir, rel, depth)) = queue.pop_front() {
        dirs += 1;
        if dirs > MAX_DIRS {
            truncated = true;
            break;
        }
        let Ok(read) = std::fs::read_dir(&dir) else { continue };
        let mut children: Vec<_> = read.flatten().collect();
        children.sort_by_key(|e| e.file_name());
        for child in children {
            let Ok(kind) = child.file_type() else { continue };
            if kind.is_symlink() {
                continue;
            }
            let name = child.file_name().to_string_lossy().into_owned();
            let child_rel = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            if kind.is_dir() {
                if exclude.contains(&name.to_ascii_lowercase()) {
                    continue;
                }
                if depth + 1 < MAX_DEPTH {
                    queue.push_back((child.path(), child_rel, depth + 1));
                } else {
                    truncated = true;
                }
            } else if kind.is_file() && matcher.is_match(&child_rel) && !eff.ignore.contains(&child_rel) {
                if found.len() >= MAX_FILES {
                    truncated = true;
                    continue;
                }
                found.push(child_rel);
            }
        }
    }
    for manual in &eff.files {
        if !found.contains(manual) && !eff.ignore.contains(manual) && safe_join(root, manual).is_some_and(|p| p.is_file()) {
            found.push(manual.clone());
        }
    }
    found.sort();
    (found, truncated)
}

/// `root/rel`, refused if `rel` climbs out of `root` — every path here comes from the webview.
pub fn safe_join(root: &Path, rel: &str) -> Option<PathBuf> {
    let rel = config::normalize(rel);
    if rel.is_empty() || Path::new(&rel).is_absolute() || rel.split('/').any(|seg| seg == ".." || seg.contains(':')) {
        return None;
    }
    Some(root.join(rel.split('/').collect::<PathBuf>()))
}

// ---------------------------------------------------------------------------------------------
// Sources: what the table's columns are
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryView {
    pub key: String,
    pub line: usize,
    pub empty: bool,
    pub reference: Option<String>,
    /// `None` when it can be moved into the Llavero; otherwise the i18n key saying why not.
    pub refused: Option<String>,
}

/// One column: a file, or one profile / service inside one.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceView {
    /// `path`, or `path#sub`.
    pub id: String,
    pub path: String,
    pub sub: Option<String>,
    pub format: Format,
    /// Sources compared with each other share it: same folder, same kind of file (and, for
    /// Compose, the same service).
    pub group: String,
    /// The folder the group is about, `""` for the repository root.
    pub dir: String,
    /// `dotenv` · `dotnet` · `launch` · `compose` · `spring` · `yaml` · `json`.
    pub family: String,
    pub environment: String,
    /// What the name alone says, for "reset" after a rename.
    pub environment_auto: String,
    pub example: bool,
    pub entries: Vec<EntryView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileView {
    pub path: String,
    pub format: Format,
    pub manual: bool,
    pub variables: usize,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scan {
    pub files: Vec<FileView>,
    pub sources: Vec<SourceView>,
    pub config: Effective,
    pub invalid_patterns: Vec<String>,
    pub truncated: bool,
}

pub fn scan(root: &Path, eff: Effective) -> Scan {
    let matcher = Matcher::new(&eff.patterns);
    let (paths, truncated) = find_files(root, &eff, &matcher);
    let mut files = Vec::new();
    let mut sources = Vec::new();
    for rel in paths {
        let format = format_of(&rel);
        let manual = eff.files.contains(&rel) && !matcher.is_match(&rel);
        let read = read_text(root, &rel);
        let (subs, entries) = match read.and_then(|text| parse(format, &text)) {
            Ok(parsed) => parsed,
            Err(error) => {
                files.push(FileView { path: rel, format, manual, variables: 0, error: Some(error) });
                continue;
            }
        };
        files.push(FileView { path: rel.clone(), format, manual, variables: entries.len(), error: None });
        sources.extend(sources_of(&rel, format, subs, entries, &eff));
    }
    Scan { files, sources, invalid_patterns: matcher.invalid, config: eff, truncated }
}

/// A file's text — capped, and never a value in the error.
pub fn read_text(root: &Path, rel: &str) -> Result<String, String> {
    let path = safe_join(root, rel).ok_or_else(|| "that path is outside the repository".to_string())?;
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_BYTES {
        return Err(format!("larger than {} KB — not read", MAX_BYTES / 1024));
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|_| "not UTF-8 text — not read".to_string())
}

fn dir_of(rel: &str) -> String {
    rel.rsplit_once('/').map(|(d, _)| d.to_string()).unwrap_or_default()
}

/// The folder a group is named after: a launch file's project (above `Properties/`), a Spring
/// module (above `src/main/resources`), otherwise the file's own folder.
fn group_dir(rel: &str, format: Format) -> String {
    let dir = dir_of(rel);
    let strip = |dir: &str, suffix: &str| -> Option<String> {
        if dir.eq_ignore_ascii_case(suffix) {
            Some(String::new())
        } else {
            let lower = dir.to_ascii_lowercase();
            lower.ends_with(&format!("/{}", suffix.to_ascii_lowercase())).then(|| dir[..dir.len() - suffix.len() - 1].to_string())
        }
    };
    match format {
        Format::LaunchSettings => strip(&dir, "Properties").unwrap_or(dir),
        Format::Yaml | Format::Properties => strip(&dir, "src/main/resources").or_else(|| strip(&dir, "config")).unwrap_or(dir),
        _ => dir,
    }
}

fn family_of(rel: &str, format: Format) -> &'static str {
    let name = rel.rsplit('/').next().unwrap_or(rel).to_ascii_lowercase();
    match format {
        Format::Dotenv => "dotenv",
        Format::Appsettings => "dotnet",
        Format::LaunchSettings => "launch",
        Format::Compose => "compose",
        Format::Properties => "spring",
        Format::Yaml if name.starts_with("application") || name.starts_with("bootstrap") => "spring",
        Format::Yaml => "yaml",
        Format::Json => "json",
    }
}

fn sources_of(rel: &str, format: Format, subs: Vec<String>, entries: Vec<Entry>, eff: &Effective) -> Vec<SourceView> {
    let dir = group_dir(rel, format);
    let family = family_of(rel, format);
    let view = |e: &Entry| EntryView {
        key: e.key.clone(),
        line: e.line,
        empty: e.reference.is_none() && e.value.trim().is_empty(),
        reference: e.reference.clone(),
        refused: match &e.edit {
            Edit::Refused(key) => Some(key.to_string()),
            _ => None,
        },
    };
    let make = |sub: Option<String>, list: Vec<EntryView>, auto: String| {
        let id = match &sub {
            Some(s) => format!("{rel}#{s}"),
            None => rel.to_string(),
        };
        let group = match (format, &sub) {
            (Format::Compose, Some(s)) => format!("{dir}|compose|{s}"),
            _ => format!("{dir}|{family}"),
        };
        let environment = eff.environments.get(&id).cloned().filter(|e| !e.trim().is_empty()).unwrap_or_else(|| auto.clone());
        SourceView {
            example: environment == "example",
            id,
            path: rel.to_string(),
            sub,
            format,
            group,
            dir: dir.clone(),
            family: family.to_string(),
            environment,
            environment_auto: auto,
            entries: list,
        }
    };
    match format {
        Format::LaunchSettings | Format::Compose => subs
            .into_iter()
            .map(|sub| {
                let mine: Vec<&Entry> = entries.iter().filter(|e| e.sub.as_deref() == Some(sub.as_str())).collect();
                let auto = if format == Format::LaunchSettings {
                    let named = mine
                        .iter()
                        .find(|e| e.key.eq_ignore_ascii_case("ASPNETCORE_ENVIRONMENT") || e.key.eq_ignore_ascii_case("DOTNET_ENVIRONMENT"))
                        .map(|e| e.value.clone())
                        .filter(|v| !v.is_empty());
                    normalize_env(&named.unwrap_or_else(|| sub.clone()))
                } else {
                    environment_of(rel, format)
                };
                make(Some(sub), mine.into_iter().map(view).collect(), auto)
            })
            .collect(),
        _ => vec![make(None, entries.iter().map(view).collect(), environment_of(rel, format))],
    }
}

/// The environment a file is for, from its name: `.env.production` → `prod`,
/// `appsettings.Development.json` → `dev`, `application-qa.yml` → `qa`, `.env.example` → `example`.
/// A file with no qualifier is `base`.
pub fn environment_of(rel: &str, format: Format) -> String {
    let name = rel.rsplit('/').next().unwrap_or(rel).to_ascii_lowercase();
    let qualifier: String = match format {
        Format::Dotenv => {
            if let Some(rest) = name.strip_prefix(".env") {
                rest.trim_start_matches('.').to_string()
            } else if let Some(stem) = name.strip_suffix(".env") {
                stem.to_string()
            } else {
                name.clone()
            }
        }
        Format::Appsettings | Format::Json => {
            let stem = name.strip_suffix(".json").unwrap_or(&name);
            stem.split_once('.').map(|(_, q)| q.to_string()).unwrap_or_default()
        }
        Format::Compose | Format::Yaml | Format::Properties => {
            let stem = name.rsplit_once('.').map(|(s, _)| s).unwrap_or(&name);
            let stem = stem.strip_prefix("docker-compose").or_else(|| stem.strip_prefix("compose")).or_else(|| stem.strip_prefix("application")).or_else(|| stem.strip_prefix("bootstrap")).unwrap_or(stem);
            stem.trim_start_matches(['.', '-', '_']).to_string()
        }
        Format::LaunchSettings => String::new(),
    };
    if qualifier.is_empty() {
        return "base".into();
    }
    qualifier.split(['.', '-', '_']).filter(|t| !t.is_empty()).map(normalize_env).collect::<Vec<_>>().join(".")
}

fn normalize_env(token: &str) -> String {
    let lower = token.trim().to_ascii_lowercase();
    match lower.as_str() {
        "development" | "develop" | "dev" => "dev".into(),
        "production" | "prod" | "prd" => "prod".into(),
        "staging" | "stage" | "stg" => "staging".into(),
        "testing" | "test" => "test".into(),
        "example" | "sample" | "template" | "dist" | "defaults" | "default" | "tpl" => "example".into(),
        _ => lower,
    }
}

/// The one entry `source_id` + `key` names, read fresh from disk.
pub fn find_entry(root: &Path, source_id: &str, key: &str) -> Result<(String, Format, String, Entry), String> {
    let (rel, sub) = match source_id.split_once('#') {
        Some((p, s)) => (config::normalize(p), Some(s.to_string())),
        None => (config::normalize(source_id), None),
    };
    let format = format_of(&rel);
    let text = read_text(root, &rel)?;
    let (_, entries) = parse(format, &text)?;
    let entry = entries
        .into_iter()
        .rev()
        .find(|e| e.key == key && e.sub == sub)
        .ok_or_else(|| format!("{key} is no longer in {rel}"))?;
    Ok((rel, format, text, entry))
}

/// Writes `text` over `rel` through a sibling temporary file, so a crash mid-write cannot leave half
/// a configuration file.
pub fn write_atomically(root: &Path, rel: &str, text: &str) -> Result<(), String> {
    let path = safe_join(root, rel).ok_or_else(|| "that path is outside the repository".to_string())?;
    let tmp = path.with_extension(format!("cf-tmp-{}", std::process::id()));
    std::fs::write(&tmp, text).map_err(|e| format!("{rel} could not be written: {e}"))?;
    if let Ok(meta) = std::fs::metadata(&path) {
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
    }
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("{rel} could not be written: {e}")
    })
}

/// A line `KEY=` appended to a dotenv file — the "add it to the example" fix. Keeps the file's line
/// ending and adds the missing final newline first.
pub fn append_key(text: &str, key: &str) -> String {
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let mut out = text.to_string();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push_str(newline);
    }
    out.push_str(key);
    out.push('=');
    out.push_str(newline);
    out
}

#[cfg(test)]
pub(crate) fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("cf-repo-env-{name}-{}-{}", std::process::id(), uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, rel: &str, text: &str) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn defaults() -> Effective {
        config::effective(&config::GlobalConfig::default(), &config::RepoConfig::default())
    }

    #[test]
    fn formats_and_environments_come_from_the_name() {
        assert_eq!(format_of("a/.env.local"), Format::Dotenv);
        assert_eq!(format_of("Api/appsettings.Production.json"), Format::Appsettings);
        assert_eq!(format_of("Api/Properties/launchSettings.json"), Format::LaunchSettings);
        assert_eq!(format_of("docker-compose.dev.yml"), Format::Compose);
        assert_eq!(format_of("src/main/resources/application-qa.yml"), Format::Yaml);
        assert_eq!(environment_of(".env", Format::Dotenv), "base");
        assert_eq!(environment_of(".env.example", Format::Dotenv), "example");
        assert_eq!(environment_of(".env.development.local", Format::Dotenv), "dev.local");
        assert_eq!(environment_of("prod.env", Format::Dotenv), "prod");
        assert_eq!(environment_of("appsettings.Development.json", Format::Appsettings), "dev");
        assert_eq!(environment_of("appsettings.json", Format::Appsettings), "base");
        assert_eq!(environment_of("application-staging.properties", Format::Properties), "staging");
        assert_eq!(environment_of("docker-compose.prod.yml", Format::Compose), "prod");
    }

    #[test]
    fn a_scan_walks_past_excluded_folders_and_groups_by_folder_and_kind() {
        let root = temp_dir("scan");
        write(&root, ".env", "A=1\nB=\n");
        write(&root, ".env.example", "A=\nB=\nC=\n");
        write(&root, "node_modules/pkg/.env", "NOPE=1\n");
        write(&root, "src/Api/appsettings.json", "{\"ConnectionStrings\":{\"Default\":\"x\"}}");
        write(&root, "src/Api/Properties/launchSettings.json", r#"{"profiles":{"http":{"environmentVariables":{"ASPNETCORE_ENVIRONMENT":"Development"}}}}"#);
        write(&root, "svc/src/main/resources/application.properties", "server.port=1\n");
        write(&root, "broken/appsettings.json", "{ nope");
        let result = scan(&root, defaults());
        let paths: Vec<&str> = result.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            paths,
            vec![".env", ".env.example", "broken/appsettings.json", "src/Api/Properties/launchSettings.json", "src/Api/appsettings.json", "svc/src/main/resources/application.properties"]
        );
        assert!(result.files[2].error.is_some());
        let groups: Vec<(&str, &str, &str)> = result.sources.iter().map(|s| (s.id.as_str(), s.group.as_str(), s.environment.as_str())).collect();
        assert!(groups.contains(&(".env.example", "|dotenv", "example")));
        assert!(groups.contains(&("src/Api/Properties/launchSettings.json#http", "src/Api|launch", "dev")));
        assert!(groups.contains(&("svc/src/main/resources/application.properties", "svc|spring", "base")));
        let env = result.sources.iter().find(|s| s.id == ".env").unwrap();
        assert!(env.entries.iter().any(|e| e.key == "B" && e.empty));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn manual_files_ignored_files_and_renamed_environments_apply() {
        let root = temp_dir("config");
        write(&root, ".env", "A=1\n");
        write(&root, ".env.ci", "A=1\n");
        write(&root, "conf/vars.txt", "A=2\n");
        let repo = config::parse_repo(Some(r#"{"files":["conf/vars.txt","../outside"],"ignore":[".env.ci"],"environments":{".env":"local"}}"#));
        let eff = config::effective(&config::GlobalConfig::default(), &repo);
        let result = scan(&root, eff);
        let paths: Vec<&str> = result.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec![".env", "conf/vars.txt"]);
        assert!(result.files[1].manual);
        let env = result.sources.iter().find(|s| s.id == ".env").unwrap();
        assert_eq!((env.environment.as_str(), env.environment_auto.as_str()), ("local", "base"));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn paths_from_the_webview_cannot_climb_out() {
        let root = Path::new("/repo");
        assert!(safe_join(root, "../etc/passwd").is_none());
        assert!(safe_join(root, "a/../../b").is_none());
        assert!(safe_join(root, "C:/Windows").is_none());
        assert!(safe_join(root, "").is_none());
        assert!(safe_join(root, "./a/.env").is_some());
    }

    #[test]
    fn appending_a_key_keeps_the_line_endings() {
        assert_eq!(append_key("A=1", "B"), "A=1\nB=\n");
        assert_eq!(append_key("A=1\r\n", "B"), "A=1\r\nB=\r\n");
        assert_eq!(append_key("", "B"), "B=\n");
    }

    #[test]
    fn an_atomic_write_replaces_the_file_whole() {
        let root = temp_dir("write");
        write(&root, ".env", "A=1\n");
        write_atomically(&root, ".env", "A=2\n").unwrap();
        assert_eq!(std::fs::read_to_string(root.join(".env")).unwrap(), "A=2\n");
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1, "no temporary file left behind");
        std::fs::remove_dir_all(root).ok();
    }
}
