//! Which files «Entorno» reads: the patterns, the folders it never walks into, and a repository's
//! own changes to both.
//!
//! The user asked for the list to be configurable (2026-10-23: «que se puedan configurar los
//! archivos que detecta»), so there are two layers, both plain settings rows:
//!
//! - `repo_env_patterns` — the app's defaults, `{ patterns, exclude }`. Absent (or a field absent)
//!   means the shipped list, so a release that learns a new file name reaches everybody who never
//!   touched the setting.
//! - `repo_env_patterns:<projectId>` — one repository's changes on top: patterns added or removed,
//!   files added by hand, files ignored, and environment labels renamed. Stored as *changes* rather
//!   than as a copy of the list, so editing the defaults later still reaches a repository that only
//!   ever added one file.
//!
//! A pattern without a `/` matches a file name at any depth (`.env.*`); with one it matches the end
//! of the path (`Properties/launchSettings.json`); a leading `/` anchors it at the repository root.
//! Matching ignores case — `appsettings.Development.json` and Windows both need that.

use std::collections::BTreeMap;

use globset::{GlobBuilder, GlobMatcher};
use serde::{Deserialize, Serialize};

pub const GLOBAL_KEY: &str = "repo_env_patterns";

pub fn repo_key(project_id: &str) -> String {
    format!("{GLOBAL_KEY}:{project_id}")
}

pub const DEFAULT_PATTERNS: &[&str] = &[
    ".env",
    ".env.*",
    "appsettings.json",
    "appsettings.*.json",
    "Properties/launchSettings.json",
    "docker-compose*.yml",
    "docker-compose*.yaml",
    "compose*.yml",
    "compose*.yaml",
    "application*.properties",
    "application*.yml",
    "application*.yaml",
];

/// Folders never walked into: dependencies, build output and tool caches. Not `.gitignore` —
/// a `.env` is ignored in almost every repository, and it is exactly the file this is for.
pub const DEFAULT_EXCLUDE: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "bin",
    "obj",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".cache",
    ".gradle",
    ".idea",
    ".vs",
    ".venv",
    "venv",
    "__pycache__",
    "vendor",
    "coverage",
    "Pods",
    "DerivedData",
];

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct GlobalConfig {
    pub patterns: Option<Vec<String>>,
    pub exclude: Option<Vec<String>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct RepoConfig {
    /// Patterns this repository reads on top of the defaults.
    pub add: Vec<String>,
    /// Default patterns this repository does not read.
    pub remove: Vec<String>,
    /// Files added by hand, relative to the repository root.
    pub files: Vec<String>,
    /// Files never read, relative to the repository root — wins over every pattern.
    pub ignore: Vec<String>,
    /// A source id (`path` or `path#sub`) → the environment it is filed under, when the name-based
    /// guess was wrong.
    pub environments: BTreeMap<String, String>,
}

/// What a scan actually uses, both layers applied.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Effective {
    pub patterns: Vec<String>,
    pub exclude: Vec<String>,
    pub files: Vec<String>,
    pub ignore: Vec<String>,
    pub environments: BTreeMap<String, String>,
}

/// A malformed row is the defaults, never a failed scan: the rows are written by the app, and a
/// hand-edited one should cost its edits, not the view.
pub fn parse_global(raw: Option<&str>) -> GlobalConfig {
    raw.and_then(|text| serde_json::from_str(text).ok()).unwrap_or_default()
}

pub fn parse_repo(raw: Option<&str>) -> RepoConfig {
    raw.and_then(|text| serde_json::from_str(text).ok()).unwrap_or_default()
}

pub fn effective(global: &GlobalConfig, repo: &RepoConfig) -> Effective {
    let base: Vec<String> = match &global.patterns {
        Some(list) => list.clone(),
        None => DEFAULT_PATTERNS.iter().map(|p| p.to_string()).collect(),
    };
    let mut patterns: Vec<String> = Vec::new();
    for pattern in base.into_iter().chain(repo.add.iter().cloned()) {
        let pattern = pattern.trim().to_string();
        if pattern.is_empty() || repo.remove.iter().any(|r| r.trim() == pattern) || patterns.contains(&pattern) {
            continue;
        }
        patterns.push(pattern);
    }
    let exclude = match &global.exclude {
        Some(list) => list.iter().map(|e| e.trim().to_string()).filter(|e| !e.is_empty()).collect(),
        None => DEFAULT_EXCLUDE.iter().map(|e| e.to_string()).collect(),
    };
    Effective {
        patterns,
        exclude,
        files: repo.files.iter().map(|f| normalize(f)).filter(|f| !f.is_empty()).collect(),
        ignore: repo.ignore.iter().map(|f| normalize(f)).filter(|f| !f.is_empty()).collect(),
        environments: repo.environments.clone(),
    }
}

/// A relative path the way every comparison here spells it: forward slashes, no leading `./` or `/`.
pub fn normalize(path: &str) -> String {
    let path = path.trim().replace('\\', "/");
    let path = path.trim_start_matches("./").trim_start_matches('/');
    path.to_string()
}

/// The compiled patterns, and the ones that could not be compiled (said in the UI, not fatal).
pub struct Matcher {
    globs: Vec<GlobMatcher>,
    pub invalid: Vec<String>,
}

impl Matcher {
    pub fn new(patterns: &[String]) -> Self {
        let mut globs = Vec::new();
        let mut invalid = Vec::new();
        for pattern in patterns {
            let clean = pattern.trim().replace('\\', "/");
            let clean = clean.trim_start_matches("./");
            if clean.is_empty() {
                continue;
            }
            let glob = match clean.strip_prefix('/') {
                Some(anchored) => anchored.to_string(),
                None => format!("**/{clean}"),
            };
            match GlobBuilder::new(&glob).case_insensitive(true).literal_separator(true).build() {
                Ok(compiled) => globs.push(compiled.compile_matcher()),
                Err(_) => invalid.push(pattern.clone()),
            }
        }
        Self { globs, invalid }
    }

    /// `rel` is a normalized relative path.
    pub fn is_match(&self, rel: &str) -> bool {
        self.globs.iter().any(|glob| glob.is_match(rel))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn nothing_saved_is_the_shipped_lists() {
        let eff = effective(&parse_global(None), &parse_repo(None));
        assert_eq!(eff.patterns, strings(DEFAULT_PATTERNS));
        assert_eq!(eff.exclude, strings(DEFAULT_EXCLUDE));
    }

    #[test]
    fn a_malformed_row_is_the_defaults() {
        let eff = effective(&parse_global(Some("{not json")), &parse_repo(Some("[1,2]")));
        assert_eq!(eff.patterns, strings(DEFAULT_PATTERNS));
    }

    #[test]
    fn a_repository_adds_and_removes_on_top_of_the_defaults() {
        let global = parse_global(Some(r#"{"patterns":[".env",".env.*","appsettings.json"]}"#));
        let repo = parse_repo(Some(r#"{"add":["config/*.env",".env"],"remove":["appsettings.json"],"files":[".\\secrets\\local.env"],"ignore":["/.env.ci"]}"#));
        let eff = effective(&global, &repo);
        assert_eq!(eff.patterns, strings(&[".env", ".env.*", "config/*.env"]));
        assert_eq!(eff.files, strings(&["secrets/local.env"]));
        assert_eq!(eff.ignore, strings(&[".env.ci"]));
        // The global exclude was not set, so it is still the shipped one.
        assert_eq!(eff.exclude, strings(DEFAULT_EXCLUDE));
    }

    #[test]
    fn patterns_match_names_anywhere_paths_by_suffix_and_anchors_at_the_root() {
        let m = Matcher::new(&strings(&[".env.*", "Properties/launchSettings.json", "/root.env", "appsettings.*.json"]));
        assert!(m.is_match(".env.local"));
        assert!(m.is_match("apps/web/.env.production"));
        assert!(!m.is_match(".env"));
        assert!(m.is_match("src/Api/Properties/launchSettings.json"));
        assert!(m.is_match("src/api/properties/LAUNCHSETTINGS.json"), "case is ignored");
        assert!(!m.is_match("src/Api/launchSettings.json"));
        assert!(m.is_match("root.env"));
        assert!(!m.is_match("sub/root.env"));
        assert!(m.is_match("src/Api/appsettings.Development.json"));
        assert!(!m.is_match("src/Api/appsettings.json"));
    }

    #[test]
    fn a_broken_pattern_is_reported_not_fatal() {
        let m = Matcher::new(&strings(&["[unclosed", ".env"]));
        assert_eq!(m.invalid, strings(&["[unclosed"]));
        assert!(m.is_match(".env"));
    }
}
