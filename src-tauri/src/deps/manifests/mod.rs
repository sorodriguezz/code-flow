//! Finding a repository's manifests and lockfiles, and reading them.
//!
//! A monorepo has many manifests and usually one lockfile at its root, so each ecosystem reader is
//! handed every file of its kind at once and resolves a manifest against the nearest lockfile above
//! it. Readers are pure (`&str` in, rows out) and tested from fixtures; this module only walks.

pub mod cargo;
pub mod golang;
pub mod maven;
pub mod npm;
pub mod nuget;
pub mod python;

use std::path::{Path, PathBuf};

use super::Scan;

/// Directories that hold installed or generated copies, never the project's own manifests. Their
/// `package.json`s are thousands of third-party ones; reading them would report `node_modules`'
/// dependencies as the repository's.
const SKIP_DIRS: &[&str] = &[
    "node_modules", ".git", "target", "bin", "obj", "dist", "build", "out", "vendor", ".venv", "venv",
    "__pycache__", ".tox", ".next", ".nuxt", ".svelte-kit", ".turbo", ".gradle", ".idea", ".vs", "coverage",
    ".pnpm-store", ".yarn",
];

/// How deep a manifest may sit. Monorepos put packages at `packages/a` or `apps/web/packages/b`.
const MAX_DEPTH: usize = 7;
/// A cap on files visited, so a repository that is mostly data does not stall the scan.
const MAX_FILES: usize = 60_000;

/// Every file of interest, by kind, as absolute paths.
#[derive(Debug, Default)]
pub struct Files {
    pub by_name: Vec<PathBuf>,
}

impl Files {
    pub fn named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a PathBuf> + 'a {
        self.by_name.iter().filter(move |p| p.file_name().is_some_and(|n| n.eq_ignore_ascii_case(name)))
    }

    pub fn matching<'a>(&'a self, pred: impl Fn(&str) -> bool + 'a) -> impl Iterator<Item = &'a PathBuf> + 'a {
        self.by_name.iter().filter(move |p| p.file_name().and_then(|n| n.to_str()).is_some_and(&pred))
    }
}

fn interesting(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "package.json"
            | "package-lock.json"
            | "npm-shrinkwrap.json"
            | "pnpm-lock.yaml"
            | "yarn.lock"
            | "cargo.toml"
            | "cargo.lock"
            | "directory.packages.props"
            | "packages.lock.json"
            | "packages.config"
            | "pyproject.toml"
            | "poetry.lock"
            | "uv.lock"
            | "pipfile.lock"
            | "go.mod"
            | "go.sum"
            | "pom.xml"
    ) || lower.ends_with(".csproj")
        || lower.ends_with(".fsproj")
        || lower.ends_with(".vbproj")
        || (lower.starts_with("requirements") && lower.ends_with(".txt"))
}

pub fn walk(root: &Path) -> Files {
    let mut files = Files::default();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut visited = 0usize;
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            visited += 1;
            if visited > MAX_FILES {
                return files;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                // `requirements/` is a common home for `requirements/dev.txt`; other dot-dirs are tooling.
                if depth < MAX_DEPTH && !SKIP_DIRS.contains(&name.as_ref()) && !name.starts_with('.') {
                    stack.push((entry.path(), depth + 1));
                }
            } else if kind.is_file() && interesting(&name) {
                files.by_name.push(entry.path());
            }
        }
    }
    files.by_name.sort();
    files
}

/// `root`-relative with `/`, the way every row names its file.
pub fn rel(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/")
}

pub(crate) fn read(path: &Path) -> Option<String> {
    // A manifest is never megabytes; a lockfile can be tens of them. Past 64 MB it is not one.
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > 64 * 1024 * 1024 {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// The nearest lockfile named `name` in `dir` or above it, without leaving `root`.
pub(crate) fn nearest(root: &Path, dir: &Path, names: &[&str]) -> Option<PathBuf> {
    let mut current = Some(dir);
    while let Some(d) = current {
        for name in names {
            let candidate = d.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        if d == root {
            break;
        }
        current = d.parent().filter(|p| p.starts_with(root));
    }
    None
}

/// Reads every manifest and lockfile of a repository.
pub fn scan(root: &Path) -> Scan {
    let files = walk(root);
    let mut out = Scan::default();
    npm::scan(root, &files, &mut out);
    cargo::scan(root, &files, &mut out);
    nuget::scan(root, &files, &mut out);
    python::scan(root, &files, &mut out);
    golang::scan(root, &files, &mut out);
    maven::scan(root, &files, &mut out);
    out.manifests.sort();
    out.manifests.dedup();
    out.lockfiles.sort_by(|a, b| a.path.cmp(&b.path));
    out.lockfiles.dedup();
    let mut seen = std::collections::HashSet::new();
    out.locked.retain(|l| seen.insert((l.ecosystem, l.ecosystem.normalize(&l.name), l.version.clone())));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn walks_a_monorepo_and_skips_installed_copies() {
        let dir = std::env::temp_dir().join(format!("cf-deps-walk-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        for (path, body) in [
            ("package.json", r#"{"name":"root","dependencies":{"left-pad":"^1.3.0"}}"#),
            ("packages/web/package.json", r#"{"name":"web","devDependencies":{"vite":"^5.0.0"}}"#),
            ("node_modules/left-pad/package.json", r#"{"name":"left-pad","dependencies":{"evil":"1"}}"#),
            ("svc/Cargo.toml", "[dependencies]\nserde = \"1\"\n"),
        ] {
            let p = dir.join(path);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, body).unwrap();
        }
        let scan = scan(&dir);
        assert_eq!(scan.manifests, vec!["package.json", "packages/web/package.json", "svc/Cargo.toml"]);
        assert!(scan.declared.iter().all(|d| d.name != "evil"));
        assert_eq!(scan.declared.len(), 3);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
