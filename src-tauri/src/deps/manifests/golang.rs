//! Go: `go.mod` `require` lines (an `// indirect` one is transitive) and `go.sum` for the rest of
//! the module graph.
//!
//! Go's minimal version selection makes the `require` line the resolved version, so there is no
//! "declared vs locked" gap to close. A major version is a different module path (`…/v2`), which is
//! why the registry is never asked about a different major for the same path.

use std::path::Path;

use super::{read, rel, Files};
use crate::deps::{version, Declared, Ecosystem, LockKind, Locked, Lockfile, Scan};

/// `require` entries → (module, version, indirect).
pub fn parse_go_mod(text: &str) -> Vec<(String, String, bool)> {
    let mut out = Vec::new();
    let mut in_block = false;
    for raw in text.lines() {
        let indirect = raw.contains("// indirect");
        let line = raw.split("//").next().unwrap_or("").trim();
        if in_block {
            if line.starts_with(')') {
                in_block = false;
                continue;
            }
        } else if let Some(rest) = line.strip_prefix("require") {
            let rest = rest.trim();
            if rest.starts_with('(') {
                in_block = true;
                continue;
            }
            push(rest, indirect, &mut out);
            continue;
        } else {
            continue;
        }
        push(line, indirect, &mut out);
    }
    out
}

fn push(spec: &str, indirect: bool, out: &mut Vec<(String, String, bool)>) {
    let mut parts = spec.split_whitespace();
    if let (Some(module), Some(v)) = (parts.next(), parts.next()) {
        if version::parse(v).is_some() {
            out.push((module.trim_matches('"').to_string(), v.to_string(), indirect));
        }
    }
}

/// `go.sum` → (module, version), the `/go.mod`-only lines left out: those are modules whose
/// `go.mod` was read during resolution, not code that is built.
pub fn parse_go_sum(text: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = text
        .lines()
        .filter_map(|l| {
            let mut parts = l.split_whitespace();
            let module = parts.next()?;
            let v = parts.next()?;
            if v.ends_with("/go.mod") {
                return None;
            }
            Some((module.to_string(), v.to_string()))
        })
        .collect();
    out.dedup();
    out
}

pub fn scan(root: &Path, files: &Files, out: &mut Scan) {
    for path in files.named("go.mod") {
        let Some(text) = read(path) else { continue };
        let manifest = rel(root, path);
        for (module, v, indirect) in parse_go_mod(&text) {
            out.declared.push(Declared {
                ecosystem: Ecosystem::Go,
                key: module.clone(),
                name: module,
                manifest: manifest.clone(),
                section: if indirect { "require (indirect)".into() } else { "require".into() },
                requirement: v.clone(),
                resolved: Some(v),
                property: None,
            });
        }
        out.manifests.push(manifest);
        let sum = path.with_file_name("go.sum");
        if let Some(text) = read(&sum).filter(|_| sum.is_file()) {
            let lockfile = rel(root, &sum);
            out.lockfiles.push(Lockfile { path: lockfile.clone(), kind: LockKind::GoSum });
            for (name, v) in parse_go_sum(&text) {
                out.locked.push(Locked { ecosystem: Ecosystem::Go, name, version: v, lockfile: lockfile.clone() });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_single_and_block_requires() {
        let text = "module example.com/app\n\ngo 1.22\n\nrequire github.com/pkg/errors v0.9.1\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n\tgolang.org/x/net v0.17.0 // indirect\n)\n\nreplace example.com/old => ../old\n";
        assert_eq!(
            parse_go_mod(text),
            vec![
                ("github.com/pkg/errors".into(), "v0.9.1".into(), false),
                ("github.com/gin-gonic/gin".into(), "v1.9.1".into(), false),
                ("golang.org/x/net".into(), "v0.17.0".into(), true),
            ]
        );
    }

    #[test]
    fn reads_go_sum_without_go_mod_lines() {
        let text = "github.com/gin-gonic/gin v1.9.1 h1:abc=\ngithub.com/gin-gonic/gin v1.9.1/go.mod h1:def=\ngolang.org/x/net v0.17.0/go.mod h1:x=\n";
        assert_eq!(parse_go_sum(text), vec![("github.com/gin-gonic/gin".into(), "v1.9.1".into())]);
    }
}
