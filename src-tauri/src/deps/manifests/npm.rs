//! npm, pnpm and Yarn: `package.json` plus whichever lockfile sits nearest above it.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde_json::Value as Json;

use super::{nearest, read, rel, Files};
use crate::deps::{version, Declared, Ecosystem, LockKind, Locked, Lockfile, Scan};

/// The sections that install something. `peerDependencies` is left out: it is a range the *consumer*
/// satisfies, and bumping it narrows who can use the package rather than updating anything.
const SECTIONS: &[&str] = &["dependencies", "devDependencies", "optionalDependencies"];

pub fn package_name(text: &str) -> Option<String> {
    serde_json::from_str::<Json>(text).ok()?.get("name")?.as_str().map(str::to_string)
}

pub fn parse_manifest(text: &str, manifest: &str) -> Vec<Declared> {
    let Ok(json) = serde_json::from_str::<Json>(text) else { return vec![] };
    let mut out = Vec::new();
    for section in SECTIONS {
        let Some(map) = json.get(section).and_then(Json::as_object) else { continue };
        for (name, req) in map {
            let Some(req) = req.as_str() else { continue };
            if version::requirement(Ecosystem::Npm, req).is_none() {
                continue;
            }
            out.push(Declared {
                ecosystem: Ecosystem::Npm,
                name: name.clone(),
                key: name.clone(),
                manifest: manifest.to_string(),
                section: (*section).to_string(),
                requirement: req.to_string(),
                resolved: None,
                property: None,
            });
        }
    }
    out
}

/// One parsed JavaScript lockfile.
#[derive(Debug, Default)]
pub struct JsLock {
    pub kind: Option<LockKind>,
    /// package-lock: `node_modules/a`, `packages/web/node_modules/b` → version.
    paths: HashMap<String, String>,
    /// pnpm: importer (`.`, `packages/web`) → name → version.
    importers: HashMap<String, HashMap<String, String>>,
    /// yarn: `name@range` (and `name@npm:range`) → version.
    specs: HashMap<String, String>,
    pub packages: Vec<(String, String)>,
}

impl JsLock {
    /// What `name` (declared as `requirement`) resolved to for the manifest in `importer`, the
    /// manifest's directory relative to the lockfile's (`""` for the same one).
    pub fn resolve(&self, importer: &str, name: &str, requirement: &str) -> Option<String> {
        match self.kind? {
            LockKind::NpmLock => {
                if !importer.is_empty() {
                    if let Some(v) = self.paths.get(&format!("{importer}/node_modules/{name}")) {
                        return Some(v.clone());
                    }
                }
                self.paths.get(&format!("node_modules/{name}")).cloned()
            }
            LockKind::PnpmLock => {
                let key = if importer.is_empty() { "." } else { importer };
                self.importers.get(key).and_then(|deps| deps.get(name)).cloned()
            }
            LockKind::YarnLock => self
                .specs
                .get(&format!("{name}@{requirement}"))
                .or_else(|| self.specs.get(&format!("{name}@npm:{requirement}")))
                .cloned(),
            _ => None,
        }
    }
}

pub fn parse_package_lock(text: &str) -> JsLock {
    let mut lock = JsLock { kind: Some(LockKind::NpmLock), ..Default::default() };
    let Ok(json) = serde_json::from_str::<Json>(text) else { return lock };
    if let Some(packages) = json.get("packages").and_then(Json::as_object) {
        for (key, entry) in packages {
            if key.is_empty() || entry.get("link").and_then(Json::as_bool) == Some(true) {
                continue;
            }
            let Some(v) = entry.get("version").and_then(Json::as_str) else { continue };
            let Some(at) = key.rfind("node_modules/") else { continue };
            let name = entry.get("name").and_then(Json::as_str).unwrap_or(&key[at + "node_modules/".len()..]);
            lock.paths.insert(key.clone(), v.to_string());
            if version::parse(v).is_some() {
                lock.packages.push((name.to_string(), v.to_string()));
            }
        }
    } else if let Some(deps) = json.get("dependencies").and_then(Json::as_object) {
        // lockfileVersion 1: a nested tree instead of a flat map of paths.
        fn walk(prefix: &str, deps: &serde_json::Map<String, Json>, lock: &mut JsLock) {
            for (name, entry) in deps {
                let path = format!("{prefix}node_modules/{name}");
                if let Some(v) = entry.get("version").and_then(Json::as_str) {
                    lock.paths.insert(path.clone(), v.to_string());
                    if version::parse(v).is_some() {
                        lock.packages.push((name.clone(), v.to_string()));
                    }
                }
                if let Some(nested) = entry.get("dependencies").and_then(Json::as_object) {
                    walk(&format!("{path}/"), nested, lock);
                }
            }
        }
        walk("", deps, &mut lock);
    }
    lock
}

/// `1.2.3(react@18.2.0)` → `1.2.3`; `link:../x` → nothing.
fn pnpm_version(raw: &str) -> Option<String> {
    let v = raw.split('(').next().unwrap_or("").trim();
    version::parse(v).map(|_| v.to_string())
}

/// `/@scope/name@1.2.3(peer)`, `name@1.2.3`, or v5's `/name/1.2.3_peer` → (name, version).
fn pnpm_key(key: &str) -> Option<(String, String)> {
    let k = key.trim_start_matches('/');
    let k = k.split('(').next().unwrap_or(k);
    if let Some(at) = k.get(1..).and_then(|s| s.rfind('@')).map(|i| i + 1) {
        let (name, v) = (&k[..at], &k[at + 1..]);
        if version::parse(v).is_some() && !name.is_empty() {
            return Some((name.to_string(), v.to_string()));
        }
    }
    let slash = k.rfind('/')?;
    let v = k[slash + 1..].split('_').next().unwrap_or("");
    version::parse(v)?;
    Some((k[..slash].to_string(), v.to_string()))
}

pub fn parse_pnpm_lock(text: &str) -> JsLock {
    use yaml_rust2::{Yaml, YamlLoader};
    let mut lock = JsLock { kind: Some(LockKind::PnpmLock), ..Default::default() };
    let Ok(docs) = YamlLoader::load_from_str(text) else { return lock };
    let Some(doc) = docs.first() else { return lock };

    let read_deps = |node: &Yaml, into: &mut HashMap<String, String>| {
        for section in ["dependencies", "devDependencies", "optionalDependencies"] {
            let Some(map) = node[section].as_hash() else { continue };
            for (name, entry) in map {
                let Some(name) = name.as_str() else { continue };
                // v6+: `{ specifier, version }`; v5: the version string itself.
                let raw = entry["version"].as_str().or_else(|| entry.as_str());
                if let Some(v) = raw.and_then(pnpm_version) {
                    into.insert(name.to_string(), v);
                }
            }
        }
    };
    if let Some(importers) = doc["importers"].as_hash() {
        for (path, node) in importers {
            let Some(path) = path.as_str() else { continue };
            let mut deps = HashMap::new();
            read_deps(node, &mut deps);
            lock.importers.insert(path.to_string(), deps);
        }
    } else {
        let mut deps = HashMap::new();
        read_deps(doc, &mut deps);
        lock.importers.insert(".".into(), deps);
    }
    if let Some(packages) = doc["packages"].as_hash() {
        for key in packages.keys() {
            if let Some(pair) = key.as_str().and_then(pnpm_key) {
                lock.packages.push(pair);
            }
        }
    }
    lock
}

/// `"@scope/name@npm:^1.0.0"` → `@scope/name`.
fn yarn_spec_name(spec: &str) -> Option<&str> {
    let at = spec.get(1..)?.find('@')? + 1;
    Some(&spec[..at])
}

/// Yarn 1 (`version "1.2.3"`) and Berry (`version: 1.2.3`) — the same block shape, two spellings.
pub fn parse_yarn_lock(text: &str) -> JsLock {
    let mut lock = JsLock { kind: Some(LockKind::YarnLock), ..Default::default() };
    let mut current: Vec<String> = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() || line.starts_with('#') {
            continue;
        }
        if !line.starts_with(' ') && line.trim_end().ends_with(':') {
            let header = line.trim_end().trim_end_matches(':');
            current = header.split(", ").map(|s| s.trim().trim_matches('"').to_string()).collect();
            continue;
        }
        let trimmed = line.trim();
        if line.starts_with("  ") && !line.starts_with("    ") {
            if let Some(rest) = trimmed.strip_prefix("version") {
                let v = rest.trim_start_matches(':').trim().trim_matches('"');
                if version::parse(v).is_none() {
                    continue;
                }
                let mut named = None;
                for spec in &current {
                    if spec.contains("@workspace:") || spec.contains("@patch:") || spec.contains("@link:") || spec.contains("@portal:") {
                        continue;
                    }
                    lock.specs.insert(spec.clone(), v.to_string());
                    named = named.or_else(|| yarn_spec_name(spec).map(str::to_string));
                }
                if let Some(name) = named {
                    lock.packages.push((name, v.to_string()));
                }
            }
        }
    }
    lock
}

fn load_lock(path: &Path) -> JsLock {
    let Some(text) = read(path) else { return JsLock::default() };
    match path.file_name().and_then(|n| n.to_str()).unwrap_or("") {
        "pnpm-lock.yaml" => parse_pnpm_lock(&text),
        "yarn.lock" => parse_yarn_lock(&text),
        _ => parse_package_lock(&text),
    }
}

pub fn scan(root: &Path, files: &Files, out: &mut Scan) {
    let manifests: Vec<&PathBuf> = files.named("package.json").collect();
    // Packages of this same repository refer to each other by name; the registry either does not
    // know them or knows a stranger's package of that name.
    let local: HashSet<String> = manifests.iter().filter_map(|p| read(p)).filter_map(|t| package_name(&t)).collect();
    let mut locks: HashMap<PathBuf, JsLock> = HashMap::new();
    for path in manifests {
        let Some(text) = read(path) else { continue };
        let manifest = rel(root, path);
        let dir = path.parent().unwrap_or(root);
        let mut declared = parse_manifest(&text, &manifest);
        declared.retain(|d| !local.contains(&d.name));
        if let Some(lock_path) = nearest(root, dir, &["pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock"]) {
            let lock = locks.entry(lock_path.clone()).or_insert_with(|| load_lock(&lock_path));
            let importer = rel(lock_path.parent().unwrap_or(root), dir);
            for d in &mut declared {
                d.resolved = lock.resolve(&importer, &d.name, &d.requirement);
            }
        }
        out.manifests.push(manifest);
        out.declared.extend(declared);
    }
    for (path, lock) in locks {
        let lockfile = rel(root, &path);
        if let Some(kind) = lock.kind {
            out.lockfiles.push(Lockfile { path: lockfile.clone(), kind });
        }
        for (name, v) in lock.packages {
            out.locked.push(Locked { ecosystem: Ecosystem::Npm, name, version: v, lockfile: lockfile.clone() });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MANIFEST: &str = r#"{
      "name": "web",
      "dependencies": { "react": "^18.2.0", "lib": "workspace:*", "left-pad": "1.3.0" },
      "devDependencies": { "vite": "~5.0.0" },
      "peerDependencies": { "react-dom": ">=18" }
    }"#;

    #[test]
    fn reads_the_installing_sections_only() {
        let d = parse_manifest(MANIFEST, "packages/web/package.json");
        let mut names: Vec<_> = d.iter().map(|d| (d.name.as_str(), d.section.as_str())).collect();
        names.sort();
        assert_eq!(names, vec![("left-pad", "dependencies"), ("react", "dependencies"), ("vite", "devDependencies")]);
    }

    #[test]
    fn resolves_against_package_lock_v3_with_workspaces() {
        let lock = parse_package_lock(
            r#"{"lockfileVersion":3,"packages":{
              "":{"name":"root"},
              "node_modules/react":{"version":"18.2.0"},
              "packages/web/node_modules/react":{"version":"18.3.1"},
              "node_modules/web":{"resolved":"packages/web","link":true},
              "node_modules/loose-envify/node_modules/js-tokens":{"version":"4.0.0"}
            }}"#,
        );
        assert_eq!(lock.resolve("packages/web", "react", "^18").as_deref(), Some("18.3.1"));
        assert_eq!(lock.resolve("", "react", "^18").as_deref(), Some("18.2.0"));
        assert!(lock.packages.contains(&("js-tokens".into(), "4.0.0".into())));
        assert_eq!(lock.packages.len(), 3);
    }

    #[test]
    fn resolves_against_package_lock_v1() {
        let lock = parse_package_lock(r#"{"lockfileVersion":1,"dependencies":{"a":{"version":"1.0.0","dependencies":{"b":{"version":"2.0.0"}}}}}"#);
        assert_eq!(lock.resolve("", "a", "^1").as_deref(), Some("1.0.0"));
        assert_eq!(lock.packages.len(), 2);
    }

    #[test]
    fn resolves_against_pnpm_lock_v9_and_v5() {
        let v9 = parse_pnpm_lock(
            "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      react:\n        specifier: ^18.2.0\n        version: 18.2.0\n  packages/web:\n    devDependencies:\n      vite:\n        specifier: ^5.0.0\n        version: 5.0.12(@types/node@20.0.0)\n      lib:\n        specifier: workspace:*\n        version: link:../lib\npackages:\n  react@18.2.0:\n    resolution: {integrity: sha512-x}\n  '@types/node@20.0.0':\n    resolution: {integrity: sha512-y}\n",
        );
        assert_eq!(v9.resolve("", "react", "^18.2.0").as_deref(), Some("18.2.0"));
        assert_eq!(v9.resolve("packages/web", "vite", "^5.0.0").as_deref(), Some("5.0.12"));
        assert_eq!(v9.resolve("packages/web", "lib", "workspace:*"), None);
        assert!(v9.packages.contains(&("@types/node".into(), "20.0.0".into())));
        let v5 = parse_pnpm_lock("lockfileVersion: 5.4\ndependencies:\n  ms: 2.1.3\npackages:\n  /ms/2.1.3:\n    dev: false\n  /@babel/core/7.22.0_abc:\n    dev: true\n");
        assert_eq!(v5.resolve("", "ms", "^2").as_deref(), Some("2.1.3"));
        assert!(v5.packages.contains(&("@babel/core".into(), "7.22.0".into())));
    }

    #[test]
    fn resolves_against_yarn_classic_and_berry() {
        let classic = parse_yarn_lock(
            "# yarn lockfile v1\n\n\"@babel/code-frame@^7.0.0\", \"@babel/code-frame@^7.22.0\":\n  version \"7.22.13\"\n  resolved \"https://x\"\n\nms@2.1.3:\n  version \"2.1.3\"\n",
        );
        assert_eq!(classic.resolve("", "@babel/code-frame", "^7.22.0").as_deref(), Some("7.22.13"));
        assert_eq!(classic.resolve("", "ms", "2.1.3").as_deref(), Some("2.1.3"));
        assert_eq!(classic.packages.len(), 2);
        let berry = parse_yarn_lock(
            "__metadata:\n  version: 6\n\n\"react@npm:^18.2.0\":\n  version: 18.2.0\n  resolution: \"react@npm:18.2.0\"\n\n\"web@workspace:.\":\n  version: 0.0.0-use.local\n",
        );
        assert_eq!(berry.resolve("", "react", "^18.2.0").as_deref(), Some("18.2.0"));
        assert_eq!(berry.packages, vec![("react".to_string(), "18.2.0".to_string())]);
    }
}
