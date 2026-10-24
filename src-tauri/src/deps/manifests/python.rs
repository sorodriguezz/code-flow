//! Python: `requirements*.txt`, `pyproject.toml` (PEP 621, PEP 735 groups and Poetry), and the
//! lockfiles that pin them — `poetry.lock`, `uv.lock`, `Pipfile.lock`.

use std::collections::HashMap;
use std::path::Path;

use serde_json::Value as Json;

use super::{cargo, nearest, read, rel, Files};
use crate::deps::minitoml::{self, Value};
use crate::deps::{version, Declared, Ecosystem, LockKind, Locked, Lockfile, Scan};

/// A PEP 508 line → (name, specifier). `None` for URLs, paths and options (`-r`, `-e`, `--hash`).
pub fn pep508(line: &str) -> Option<(String, String)> {
    let line = line.split(" #").next().unwrap_or(line).trim();
    if line.is_empty() || line.starts_with(['#', '-', '.', '/']) || line.contains("://") {
        return None;
    }
    let spec_part = line.split(';').next().unwrap_or("").trim();
    if spec_part.contains(" @ ") || spec_part.contains("@ ") {
        return None;
    }
    let name: String = spec_part.chars().take_while(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')).collect();
    if name.is_empty() {
        return None;
    }
    let mut rest = spec_part[name.len()..].trim_start();
    if rest.starts_with('[') {
        rest = rest.find(']').map(|i| rest[i + 1..].trim_start()).unwrap_or("");
    }
    let rest = rest.trim_start_matches('(').trim_end_matches(')').trim();
    Some((name, rest.to_string()))
}

fn declared(name: String, req: String, manifest: &str, section: &str) -> Option<Declared> {
    // A bare name pins nothing: still listed (its vulnerabilities count) once a lock resolves it.
    if !req.is_empty() && version::requirement(Ecosystem::Pypi, &req).is_none() {
        return None;
    }
    Some(Declared {
        ecosystem: Ecosystem::Pypi,
        key: name.clone(),
        name,
        manifest: manifest.to_string(),
        section: section.to_string(),
        requirement: req,
        resolved: None,
        property: None,
    })
}

pub fn parse_requirements(text: &str, manifest: &str) -> Vec<Declared> {
    text.lines().filter_map(pep508).filter_map(|(n, r)| declared(n, r, manifest, "requirements")).collect()
}

pub fn parse_pyproject(text: &str, manifest: &str) -> Vec<Declared> {
    let mut out = Vec::new();
    let array_of = |value: &Value| -> Vec<(String, String)> {
        match value {
            Value::Array(items) => items.iter().filter_map(Value::as_str).filter_map(pep508).collect(),
            _ => vec![],
        }
    };
    for table in minitoml::parse(text) {
        let h: Vec<&str> = table.header.iter().map(String::as_str).collect();
        match h.as_slice() {
            ["project"] => {
                if let Some(v) = table.get("dependencies") {
                    out.extend(array_of(v).into_iter().filter_map(|(n, r)| declared(n, r, manifest, "dependencies")));
                }
            }
            ["project", "optional-dependencies"] | ["dependency-groups"] => {
                for entry in &table.entries {
                    let section = format!("{}.{}", h.join("."), entry.key.join("."));
                    out.extend(array_of(&entry.value).into_iter().filter_map(|(n, r)| declared(n, r, manifest, &section)));
                }
            }
            ["tool", "poetry", "dependencies"] | ["tool", "poetry", "dev-dependencies"] | ["tool", "poetry", "group", _, "dependencies"] => {
                let section = h.join(".");
                for entry in &table.entries {
                    if entry.key.len() != 1 || entry.key[0].eq_ignore_ascii_case("python") {
                        continue;
                    }
                    let req = match &entry.value {
                        Value::Str(s) => Some(s.clone()),
                        t @ Value::Table(_) if t.get("path").is_none() && t.get("git").is_none() && t.get("url").is_none() => {
                            t.get("version").and_then(Value::as_str).map(str::to_string)
                        }
                        _ => None,
                    };
                    if let Some(req) = req {
                        let req = if req.trim() == "*" { String::new() } else { req };
                        out.extend(declared(entry.key[0].clone(), req, manifest, &section));
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// `Pipfile.lock`: `default` and `develop`, each `name → { version: "==1.2.3" }`.
pub fn parse_pipfile_lock(text: &str) -> Vec<(String, String)> {
    let Ok(json) = serde_json::from_str::<Json>(text) else { return vec![] };
    let mut out = Vec::new();
    for group in ["default", "develop"] {
        let Some(map) = json.get(group).and_then(Json::as_object) else { continue };
        for (name, entry) in map {
            if let Some(v) = entry.get("version").and_then(Json::as_str) {
                out.push((name.clone(), v.trim_start_matches('=').to_string()));
            }
        }
    }
    out
}

fn load_lock(path: &Path) -> Vec<(String, String)> {
    let Some(text) = read(path) else { return vec![] };
    match path.file_name().and_then(|n| n.to_str()).unwrap_or("") {
        "Pipfile.lock" => parse_pipfile_lock(&text),
        "uv.lock" => cargo::parse_lock(&text, true),
        _ => cargo::parse_lock(&text, false),
    }
}

fn lock_kind(path: &Path) -> LockKind {
    match path.file_name().and_then(|n| n.to_str()).unwrap_or("") {
        "Pipfile.lock" => LockKind::PipfileLock,
        "uv.lock" => LockKind::UvLock,
        _ => LockKind::PoetryLock,
    }
}

pub fn scan(root: &Path, files: &Files, out: &mut Scan) {
    let mut locks: HashMap<std::path::PathBuf, HashMap<String, String>> = HashMap::new();
    let manifests = files.matching(|n| {
        let l = n.to_ascii_lowercase();
        l == "pyproject.toml" || (l.starts_with("requirements") && l.ends_with(".txt"))
    });
    for path in manifests {
        let Some(text) = read(path) else { continue };
        let manifest = rel(root, path);
        let is_pyproject = path.file_name().is_some_and(|n| n.eq_ignore_ascii_case("pyproject.toml"));
        let mut declared = if is_pyproject { parse_pyproject(&text, &manifest) } else { parse_requirements(&text, &manifest) };
        if declared.is_empty() {
            continue;
        }
        if let Some(lock_path) = nearest(root, path.parent().unwrap_or(root), &["poetry.lock", "uv.lock", "Pipfile.lock"]) {
            let lock = locks.entry(lock_path.clone()).or_insert_with(|| {
                load_lock(&lock_path).into_iter().map(|(n, v)| (Ecosystem::Pypi.normalize(&n), v)).collect()
            });
            for d in &mut declared {
                d.resolved = lock.get(&Ecosystem::Pypi.normalize(&d.name)).cloned();
            }
        }
        for d in &mut declared {
            // `==1.2.3` is its own resolution when nothing else says.
            if d.resolved.is_none() && d.requirement.starts_with("==") && !d.requirement.contains(['*', ',']) {
                d.resolved = Some(d.requirement.trim_start_matches('=').trim().to_string());
            }
        }
        declared.retain(|d| !d.requirement.is_empty() || d.resolved.is_some());
        out.manifests.push(manifest);
        out.declared.extend(declared);
    }
    for (path, lock) in locks {
        let lockfile = rel(root, &path);
        out.lockfiles.push(Lockfile { path: lockfile.clone(), kind: lock_kind(&path) });
        for (name, v) in lock {
            out.locked.push(Locked { ecosystem: Ecosystem::Pypi, name, version: v, lockfile: lockfile.clone() });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_requirement_lines() {
        let text = "# pinned\nrequests==2.31.0  # http\nDjango>=4.2,<5\nrich[jupyter]~=13.7 ; python_version >= '3.8'\n-r base.txt\n-e .\ngit+https://x/y.git#egg=z\nflask\n";
        let rows: Vec<_> = parse_requirements(text, "requirements.txt").into_iter().map(|d| (d.name, d.requirement)).collect();
        assert_eq!(
            rows,
            vec![
                ("requests".into(), "==2.31.0".into()),
                ("Django".into(), ">=4.2,<5".into()),
                ("rich".into(), "~=13.7".into()),
                ("flask".into(), String::new()),
            ]
        );
    }

    #[test]
    fn reads_pep621_groups_and_poetry() {
        let text = r#"
[project]
name = "svc"
dependencies = [
  "httpx>=0.27",
  "pydantic (>=2.5,<3)",
]

[project.optional-dependencies]
dev = ["pytest>=8"]

[dependency-groups]
lint = ["ruff==0.6.9"]

[tool.poetry.dependencies]
python = "^3.11"
fastapi = "^0.110.0"
local = { path = "../local" }
uvicorn = { version = "^0.29", extras = ["standard"] }

[tool.poetry.group.test.dependencies]
coverage = "*"
"#;
        let rows: Vec<_> = parse_pyproject(text, "pyproject.toml").into_iter().map(|d| (d.name, d.section, d.requirement)).collect();
        assert_eq!(rows[0], ("httpx".into(), "dependencies".into(), ">=0.27".into()));
        assert_eq!(rows[1].2, ">=2.5,<3");
        assert_eq!(rows[2], ("pytest".into(), "project.optional-dependencies.dev".into(), ">=8".into()));
        assert_eq!(rows[3], ("ruff".into(), "dependency-groups.lint".into(), "==0.6.9".into()));
        assert_eq!(rows[4], ("fastapi".into(), "tool.poetry.dependencies".into(), "^0.110.0".into()));
        assert_eq!(rows[5].2, "^0.29");
        assert_eq!(rows[6], ("coverage".into(), "tool.poetry.group.test.dependencies".into(), String::new()));
        assert_eq!(rows.len(), 7);
    }

    #[test]
    fn reads_the_three_lockfiles() {
        let poetry = "[[package]]\nname = \"httpx\"\nversion = \"0.27.0\"\n\n[package.dependencies]\nanyio = \"*\"\n";
        assert_eq!(cargo::parse_lock(poetry, false), vec![("httpx".into(), "0.27.0".into())]);
        let uv = "[[package]]\nname = \"svc\"\nversion = \"0.1.0\"\nsource = { editable = \".\" }\n\n[[package]]\nname = \"anyio\"\nversion = \"4.4.0\"\nsource = { registry = \"https://pypi.org/simple\" }\n";
        assert_eq!(cargo::parse_lock(uv, true), vec![("anyio".into(), "4.4.0".into())]);
        let pipfile = r#"{"default":{"requests":{"version":"==2.31.0"}},"develop":{"pytest":{"version":"==8.0.0"}}}"#;
        assert_eq!(parse_pipfile_lock(pipfile).len(), 2);
    }
}
