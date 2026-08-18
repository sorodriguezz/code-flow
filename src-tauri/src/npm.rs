//! What the npm registry knows about a package: which version is current, which exist, and what
//! matches a search.
//!
//! # Why this is in Rust and not a `fetch` in the editor
//!
//! The webview ships no CSP (`tauri.conf.json` sets `csp: null`) and the registry answers with
//! `Access-Control-Allow-Origin: *`, so a direct `fetch` would in fact work. It is here anyway,
//! because that is the seam every other outbound call in this app already goes through — GitHub,
//! GitLab, Azure DevOps, Supabase, the AI quota probes — and the reasons are the same ones: one
//! place that owns the timeout, one place that turns a network failure into a sentence, and a
//! frontend that never has to care whether a host sets permissive CORS headers this week.
//!
//! # The name is checked before it is a URL
//!
//! Every entry point runs `valid_package_name` first. A dependency name arrives from a
//! `package.json` **on disk**, which is a file this app did not write and a repository may have
//! received from anywhere. `../../-/v1/search` is a perfectly good string to find in a JSON object
//! and a path traversal once it is pasted into a registry URL, and a name carrying `?` or `#`
//! rewrites the query rather than the path. The grammar below is npm's own, so nothing legitimate
//! is refused and nothing else is ever concatenated.
//!
//! The same check is what later makes an install safe to type at a shell — see
//! `lib/packageScripts.ts`, which argues the identical case for script names — so it is deliberately
//! stricter than "no slashes": no spaces, no quotes, no shell metacharacters, ever.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

/// The public registry. Not configurable *yet*: a private registry needs auth, a scope map and a
/// `.npmrc` reader, and shipping a half of that would be a box that silently reports the public
/// version of a package the user does not install.
const REGISTRY: &str = "https://registry.npmjs.org";

/// How long any one registry call may take.
///
/// Short on purpose. This feeds an annotation floating over a line of JSON: an answer that lands
/// after the user has scrolled away is worth nothing, and the batch below is only as fast as its
/// slowest member.
const TIMEOUT: Duration = Duration::from_secs(10);

/// The largest dependency list we will look up in one go.
///
/// A `package.json` with more entries than this is real — a monorepo root reaches it — but the box
/// reports a block, and a block of 200 rows is not read, it is scrolled past. The cap keeps one
/// keystroke from becoming two hundred outbound requests.
const MAX_BATCH: usize = 100;

/// How many of those may be in flight at once. Enough to make a normal manifest feel instant,
/// low enough to stay a well-behaved client of a service nobody is paying for.
const CONCURRENCY: usize = 8;

fn client() -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(TIMEOUT)
                // The registry identifies clients, and an anonymous one gets treated as a scraper.
                .user_agent("CodeFlow")
                .build()
                .unwrap_or_default()
        })
        .clone()
}

/// npm's own rule for a package name, applied before the name is allowed near a URL or a shell.
///
/// Unscoped: lowercase letters, digits, and `-` `_` `.`, not starting with `.` or `_`.
/// Scoped: `@scope/name`, where both halves follow the same rule.
///
/// 214 characters is the registry's documented limit, scope included.
pub fn valid_package_name(name: &str) -> bool {
    fn part(segment: &str) -> bool {
        !segment.is_empty()
            && !segment.starts_with('.')
            && !segment.starts_with('_')
            && segment
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_' | '.'))
    }

    if name.is_empty() || name.len() > 214 {
        return false;
    }
    match name.strip_prefix('@') {
        // A scoped name is exactly two parts. `@a/b/c` splitting into three is the traversal case.
        Some(rest) => match rest.split_once('/') {
            Some((scope, package)) => part(scope) && part(package) && !package.contains('/'),
            None => false,
        },
        None => part(name),
    }
}

/// `@scope/name` as one path segment. The slash is the only character the grammar allows that a URL
/// would otherwise read as structure.
fn path_segment(name: &str) -> String {
    name.replace('/', "%2F")
}

/// One package, as the box shows it.
#[derive(Debug, Clone, Serialize)]
pub struct PackageVersions {
    pub name: String,
    /// The `latest` dist-tag — what `npm install <name>` would give you today. Empty when the
    /// registry answered without one, which a package can genuinely do.
    pub latest: String,
    /// Every published version, newest first as the registry ordered them reversed. The picker
    /// shows these; nothing here judges which is *newer*, because semver ordering belongs with the
    /// code that already parses ranges rather than in a transport module.
    pub versions: Vec<String>,
    /// The registry's one-line summary, for the search list and the hover.
    pub description: String,
}

/// What the abbreviated metadata document gives us. Asked for by `Accept` header: the full document
/// for a package like `react` is megabytes of per-version manifests, and this one is a few KB.
#[derive(Deserialize)]
struct Abbreviated {
    #[serde(default, rename = "dist-tags")]
    dist_tags: HashMap<String, String>,
    #[serde(default)]
    versions: HashMap<String, serde_json::Value>,
    #[serde(default)]
    description: String,
}

/// Everything published for one package.
#[tauri::command]
pub async fn npm_package_versions(name: String) -> Result<PackageVersions, String> {
    if !valid_package_name(&name) {
        return Err(format!("Not a package name: {name}"));
    }
    let url = format!("{REGISTRY}/{}", path_segment(&name));
    let response = client()
        .get(&url)
        .header("Accept", "application/vnd.npm.install-v1+json")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(format!("{name} is not on the registry"));
    }
    if !response.status().is_success() {
        return Err(format!("Registry answered {}", response.status()));
    }

    let body: Abbreviated = response.json().await.map_err(|e| e.to_string())?;
    let mut versions: Vec<String> = body.versions.into_keys().collect();
    // Lexicographic, which is *not* semver order — `1.10.0` sorts before `1.9.0`. Sorted anyway so
    // the list is stable between calls rather than in `HashMap` order, and left for the frontend to
    // order properly; saying so here so nobody reads this as a version comparison.
    versions.sort();
    Ok(PackageVersions {
        latest: body.dist_tags.get("latest").cloned().unwrap_or_default(),
        versions,
        description: body.description,
        name,
    })
}

/// One row of the batch: what is installed against what is current.
#[derive(Debug, Clone, Serialize)]
pub struct LatestVersion {
    pub name: String,
    /// Empty when the lookup failed, which is not the same as "up to date" and must not be drawn
    /// as such — `error` is what says which happened.
    pub latest: String,
    pub description: String,
    /// The registry's or the network's own sentence. Empty on success.
    pub error: String,
}

/// The current version of many packages at once — the whole `dependencies` block in one call.
///
/// Never fails as a whole: one package that 404s (a private name, a typo, something unpublished)
/// reports its own error and leaves every other row intact. A batch that resolved to `Err` because
/// one entry was missing would blank the annotation for a manifest that is almost entirely fine.
#[tauri::command]
pub async fn npm_latest_versions(names: Vec<String>) -> Result<Vec<LatestVersion>, String> {
    use futures_util::stream::{self, StreamExt};

    let names: Vec<String> = names.into_iter().take(MAX_BATCH).collect();
    Ok(stream::iter(names)
        .map(|name| async move {
            match npm_package_versions(name.clone()).await {
                Ok(found) => LatestVersion {
                    name: found.name,
                    latest: found.latest,
                    description: found.description,
                    error: String::new(),
                },
                Err(error) => LatestVersion {
                    name,
                    latest: String::new(),
                    description: String::new(),
                    error,
                },
            }
        })
        .buffer_unordered(CONCURRENCY)
        .collect()
        .await)
}

/// One search result.
#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub name: String,
    pub version: String,
    pub description: String,
    pub publisher: String,
}

#[derive(Deserialize)]
struct SearchResponse {
    #[serde(default)]
    objects: Vec<SearchObject>,
}

#[derive(Deserialize)]
struct SearchObject {
    package: SearchPackage,
}

#[derive(Deserialize)]
struct SearchPackage {
    #[serde(default)]
    name: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    publisher: Option<SearchPublisher>,
}

#[derive(Deserialize)]
struct SearchPublisher {
    #[serde(default)]
    username: String,
}

/// Search the registry, the way `npm search` does.
///
/// The query is sent as a query *parameter* rather than interpolated, so it needs no grammar of its
/// own — a user typing `react hooks` or `@types/` is asking a search engine a question, and refusing
/// characters here would only refuse legitimate searches. The names that come *back* are checked,
/// because those are what a later install would act on.
#[tauri::command]
pub async fn npm_search(text: String, limit: Option<u32>) -> Result<Vec<SearchHit>, String> {
    let query = text.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let size = limit.unwrap_or(25).clamp(1, 50);
    let response = client()
        .get(format!("{REGISTRY}/-/v1/search"))
        .query(&[("text", query), ("size", &size.to_string())])
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        return Err(format!("Registry answered {}", response.status()));
    }

    let body: SearchResponse = response.json().await.map_err(|e| e.to_string())?;
    Ok(body
        .objects
        .into_iter()
        // A result whose name would not survive `valid_package_name` is dropped rather than shown.
        // Nothing on the public registry should fail this, and a row the user cannot safely install
        // is worse than a row that is missing.
        .filter(|object| valid_package_name(&object.package.name))
        .map(|object| SearchHit {
            name: object.package.name,
            version: object.package.version,
            description: object.package.description,
            publisher: object.package.publisher.map(|p| p.username).unwrap_or_default(),
        })
        .collect())
}

/// What one installed package weighs.
#[derive(Debug, Clone, Serialize)]
pub struct PackageWeight {
    pub name: String,
    /// Bytes on disk under `node_modules/<name>`, its own `node_modules` included.
    pub bytes: u64,
    pub files: u32,
    /// Empty when the package is not installed, which is not a size of zero and must not be drawn
    /// as one.
    pub error: String,
}

/// How deep the walk goes before it stops.
///
/// A guard against a symlink loop rather than a real limit — `node_modules` nests, but not like
/// this, and a package this deep is pathological either way.
const MAX_DEPTH: usize = 24;

fn directory_size(path: &Path, depth: usize) -> (u64, u32) {
    if depth > MAX_DEPTH {
        return (0, 0);
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return (0, 0);
    };
    let mut bytes = 0u64;
    let mut files = 0u32;
    for entry in entries.flatten() {
        // `DirEntry::metadata` deliberately does **not** traverse a symlink, which is the behaviour
        // this needs: pnpm's store makes `node_modules` a forest of links, and following them would
        // count the same package once per dependent — and hang outright on a cycle. A link is
        // therefore skipped rather than measured; under pnpm that means the number is the size of
        // what is really laid down here, not of the store it points into.
        let Ok(meta) = entry.metadata() else { continue };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            let (child_bytes, child_files) = directory_size(&entry.path(), depth + 1);
            bytes += child_bytes;
            files += child_files;
        } else {
            bytes += meta.len();
            files += 1;
        }
    }
    (bytes, files)
}

/// The installed size of each named package, for the weight shown beside an import.
///
/// # What this number is, and what it deliberately is not
///
/// It is the size of the package **as installed on disk**. It is *not* the bundle cost — the figure
/// the `import-cost` extension shows, which comes from actually bundling the imported symbols and
/// minifying them, so that `import { debounce } from "lodash"` reports the few kilobytes that
/// survive tree-shaking rather than the whole library.
///
/// Doing that properly means running a bundler per import, per keystroke, and reporting a number
/// that depends on the project's own bundler settings to be right. Reporting the disk size and
/// **calling it the disk size** is a true statement that answers the question people are usually
/// asking — "how heavy is this dependency" — while a bundle figure produced by the wrong bundler
/// would be a precise-looking answer that is quietly false.
///
/// A package that is not installed reports an error rather than zero: "nothing" and "not there" are
/// different answers and the annotation must be able to tell them apart.
#[tauri::command]
pub async fn npm_package_sizes(repo_path: String, names: Vec<String>) -> Result<Vec<PackageWeight>, String> {
    let root = Path::new(&repo_path).join("node_modules");
    let mut weights = Vec::new();
    for name in names.into_iter().take(MAX_BATCH) {
        if !valid_package_name(&name) {
            weights.push(PackageWeight { name, bytes: 0, files: 0, error: "not a package name".into() });
            continue;
        }
        // A scoped name is two path segments here, unlike in a URL — the grammar already proved it
        // contains exactly one slash and no traversal.
        let mut path = root.clone();
        for segment in name.split('/') {
            path.push(segment);
        }
        if !path.is_dir() {
            weights.push(PackageWeight { name, bytes: 0, files: 0, error: "not installed".into() });
            continue;
        }
        let (bytes, files) = directory_size(&path, 0);
        weights.push(PackageWeight { name, bytes, files, error: String::new() });
    }
    Ok(weights)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_names_the_registry_accepts() {
        assert!(valid_package_name("react"));
        assert!(valid_package_name("@types/node"));
        assert!(valid_package_name("lodash.merge"));
        assert!(valid_package_name("some-pkg_2"));
    }

    #[test]
    fn refuses_anything_that_would_leave_the_path() {
        assert!(!valid_package_name("../../etc/passwd"));
        assert!(!valid_package_name("@a/b/c"));
        assert!(!valid_package_name("foo/bar"));
        assert!(!valid_package_name("@scope"));
        assert!(!valid_package_name("@/name"));
    }

    #[test]
    fn refuses_what_a_shell_would_read_as_syntax() {
        for name in ["a;rm -rf /", "a b", "a$(id)", "a`id`", "a|b", "a&b", "a>b", "a'b", "a\"b"] {
            assert!(!valid_package_name(name), "{name} should be refused");
        }
    }

    #[test]
    fn refuses_the_edges() {
        assert!(!valid_package_name(""));
        assert!(!valid_package_name(".hidden"));
        assert!(!valid_package_name("_private"));
        assert!(!valid_package_name("UPPER"));
        assert!(!valid_package_name(&"a".repeat(215)));
    }

    #[test]
    fn scoped_names_travel_as_one_segment() {
        assert_eq!(path_segment("@types/node"), "@types%2Fnode");
        assert_eq!(path_segment("react"), "react");
    }
}
