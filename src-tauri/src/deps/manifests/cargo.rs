//! Cargo: `Cargo.toml` (every dependency table, workspace inheritance and renames included) and
//! `Cargo.lock`. The lock reader is also Poetry's and uv's — the same `[[package]]` shape.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::{nearest, read, rel, Files};
use crate::deps::minitoml::{self, Value};
use crate::deps::{Declared, Ecosystem, LockKind, Locked, Lockfile, Scan};

const KINDS: &[&str] = &["dependencies", "dev-dependencies", "build-dependencies"];

pub fn section_label(header: &[String]) -> String {
    match header {
        [w, d] if w == "workspace" => format!("workspace.{d}"),
        [.., d] => d.clone(),
        [] => String::new(),
    }
}

/// One dependency entry's value → (registry name, requirement), when it names a registry version.
/// A `path`, `git` or `workspace = true` entry has nothing for the registry to say about it.
fn registry_dep(key: &str, value: &Value) -> Option<(String, String)> {
    match value {
        Value::Str(req) => Some((key.to_string(), req.clone())),
        Value::Table(_) => {
            if value.get("path").is_some() || value.get("git").is_some() || value.get("workspace").is_some() {
                return None;
            }
            let req = value.get("version")?.as_str()?.to_string();
            let name = value.get("package").and_then(Value::as_str).unwrap_or(key).to_string();
            Some((name, req))
        }
        _ => None,
    }
}

pub fn parse_manifest(text: &str, manifest: &str) -> Vec<Declared> {
    let mut out = Vec::new();
    let push = |out: &mut Vec<Declared>, key: &str, name: String, req: String, section: String| {
        out.push(Declared {
            ecosystem: Ecosystem::Cargo,
            name,
            key: key.to_string(),
            manifest: manifest.to_string(),
            section,
            requirement: req,
            resolved: None,
            property: None,
        });
    };
    for table in minitoml::parse(text) {
        let h = &table.header;
        if h.last().is_some_and(|l| KINDS.contains(&l.as_str())) {
            let section = section_label(h);
            for entry in &table.entries {
                // `serde.workspace = true` is a dotted key, inherited — nothing to update here.
                if entry.key.len() != 1 {
                    continue;
                }
                if let Some((name, req)) = registry_dep(&entry.key[0], &entry.value) {
                    push(&mut out, &entry.key[0], name, req, section.clone());
                }
            }
        } else if h.len() >= 2 && KINDS.contains(&h[h.len() - 2].as_str()) {
            // `[dependencies.serde]` with `version = "1"` underneath.
            let key = &h[h.len() - 1];
            let as_table = Value::Table(
                table.entries.iter().filter(|e| e.key.len() == 1).map(|e| (e.key[0].clone(), e.value.clone())).collect(),
            );
            if let Some((name, req)) = registry_dep(key, &as_table) {
                push(&mut out, key, name, req, section_label(&h[..h.len() - 1]));
            }
        }
    }
    out
}

/// `[[package]]` entries of `Cargo.lock`, `poetry.lock` or `uv.lock`.
///
/// `registry_only` keeps what came from a registry: in `Cargo.lock` a crate with no `source` is one
/// of the workspace's own; in `uv.lock` the project itself is `source = { editable = "." }`.
pub fn parse_lock(text: &str, registry_only: bool) -> Vec<(String, String)> {
    minitoml::parse(text)
        .into_iter()
        .filter(|t| t.array && t.header == ["package"])
        .filter_map(|t| {
            let name = t.str("name")?.to_string();
            let version = t.str("version")?.to_string();
            if registry_only {
                match t.get("source") {
                    Some(Value::Str(s)) if s.starts_with("registry+") || s.starts_with("sparse+") => {}
                    Some(Value::Table(entries)) if entries.iter().any(|(k, _)| k == "registry") => {}
                    _ => return None,
                }
            }
            Some((name, version))
        })
        .collect()
}

/// The locked version a requirement means: the newest locked one it accepts. A lockfile can hold
/// `syn 1.x` and `syn 2.x` at once, and `syn = "2"` means the second.
pub fn resolve(locked: &[(String, String)], name: &str, requirement: &str) -> Option<String> {
    let req = semver::VersionReq::parse(requirement).ok();
    locked
        .iter()
        .filter(|(n, _)| n == name)
        .filter_map(|(_, v)| semver::Version::parse(v).ok().map(|parsed| (parsed, v)))
        .filter(|(parsed, _)| req.as_ref().is_none_or(|r| r.matches(parsed)))
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, v)| v.clone())
}

pub fn scan(root: &Path, files: &Files, out: &mut Scan) {
    let mut locks: HashMap<PathBuf, Vec<(String, String)>> = HashMap::new();
    for path in files.named("Cargo.toml") {
        let Some(text) = read(path) else { continue };
        let manifest = rel(root, path);
        let mut declared = parse_manifest(&text, &manifest);
        if let Some(lock_path) = nearest(root, path.parent().unwrap_or(root), &["Cargo.lock"]) {
            let locked = locks.entry(lock_path.clone()).or_insert_with(|| read(&lock_path).map(|t| parse_lock(&t, true)).unwrap_or_default());
            for d in &mut declared {
                d.resolved = resolve(locked, &d.name, &d.requirement);
            }
        }
        out.manifests.push(manifest);
        out.declared.extend(declared);
    }
    for (path, locked) in locks {
        let lockfile = rel(root, &path);
        out.lockfiles.push(Lockfile { path: lockfile.clone(), kind: LockKind::CargoLock });
        for (name, version) in locked {
            out.locked.push(Locked { ecosystem: Ecosystem::Cargo, name, version, lockfile: lockfile.clone() });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MANIFEST: &str = r#"
[package]
name = "app"
version = "0.1.0"

[dependencies]
serde = { version = "1.0.190", features = ["derive"] }
tokio.workspace = true
local = { path = "../local" }
fork = { git = "https://example.com/fork" }
json = { package = "serde_json", version = "1" }
syn = "2"

[dev-dependencies]
insta = "1.34"

[target.'cfg(windows)'.dependencies]
windows-sys = "0.52"

[build-dependencies.cc]
version = "1.0"

[workspace.dependencies]
anyhow = "1.0.75"
"#;

    const LOCK: &str = r#"
[[package]]
name = "app"
version = "0.1.0"

[[package]]
name = "syn"
version = "1.0.109"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "syn"
version = "2.0.39"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "serde"
version = "1.0.193"
source = "registry+https://github.com/rust-lang/crates.io-index"
"#;

    #[test]
    fn reads_every_dependency_table_and_skips_non_registry_entries() {
        let d = parse_manifest(MANIFEST, "Cargo.toml");
        let rows: Vec<_> = d.iter().map(|d| (d.key.as_str(), d.name.as_str(), d.section.as_str(), d.requirement.as_str())).collect();
        assert_eq!(
            rows,
            vec![
                ("serde", "serde", "dependencies", "1.0.190"),
                ("json", "serde_json", "dependencies", "1"),
                ("syn", "syn", "dependencies", "2"),
                ("insta", "insta", "dev-dependencies", "1.34"),
                ("windows-sys", "windows-sys", "dependencies", "0.52"),
                ("cc", "cc", "build-dependencies", "1.0"),
                ("anyhow", "anyhow", "workspace.dependencies", "1.0.75"),
            ]
        );
    }

    #[test]
    fn resolves_the_locked_version_a_requirement_accepts() {
        let locked = parse_lock(LOCK, true);
        assert_eq!(locked.len(), 3, "the workspace's own crate is not a registry package");
        assert_eq!(resolve(&locked, "syn", "2").as_deref(), Some("2.0.39"));
        assert_eq!(resolve(&locked, "syn", "1.0").as_deref(), Some("1.0.109"));
        assert_eq!(resolve(&locked, "serde", "1.0.190").as_deref(), Some("1.0.193"));
        assert_eq!(resolve(&locked, "missing", "1"), None);
    }
}
