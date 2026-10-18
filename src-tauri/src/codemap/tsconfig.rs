//! `compilerOptions.paths` and `baseUrl` from the repository's `tsconfig*.json` / `jsconfig*.json`.
//!
//! Without them an alias like `@app/foo` read as a package — external — and every edge through it
//! was missing from the map, which in a monorepo is most of them. Only what TypeScript itself uses
//! to resolve is read: `paths`, `baseUrl` and a *relative* `extends` chain. A config that extends a
//! package (`@tsconfig/node20`) keeps its own options; the package's are not looked up.
//!
//! A file is governed by the configs in the nearest folder above it that has any. Every config in
//! that folder counts (`tsconfig.json`, `tsconfig.app.json`, …): a Vite project keeps its `paths`
//! in `tsconfig.app.json`, referenced from a `tsconfig.json` that has none.

use serde_json::Value;

use super::resolve::{dir_of, join};

/// How deep an `extends` chain is followed.
const MAX_EXTENDS: usize = 8;

#[derive(Debug, Default, Clone)]
pub struct TsPaths {
    /// Longest folder first, so the first scope that contains a file is its nearest.
    scopes: Vec<Scope>,
}

#[derive(Debug, Default, Clone)]
struct Scope {
    /// Repository-relative folder the configs sit in; `""` for the root.
    dir: String,
    /// `baseUrl`, repository-relative, when one is set.
    base: Option<String>,
    /// Pattern → repository-relative targets (each may hold one `*`), in declaration order.
    paths: Vec<(String, Vec<String>)>,
}

/// Whether `path` is a config this reads: `tsconfig.json`, `tsconfig.app.json`, `jsconfig.json`, ….
pub fn is_config(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path);
    (name.starts_with("tsconfig") || name.starts_with("jsconfig")) && name.ends_with(".json")
}

impl TsPaths {
    /// Reads every config in `configs` (repository-relative paths) through `read`.
    pub fn load(configs: &[String], read: impl Fn(&str) -> Option<String>) -> Self {
        let mut by_dir: Vec<(String, Vec<&String>)> = Vec::new();
        let mut sorted: Vec<&String> = configs.iter().filter(|c| is_config(c)).collect();
        // `tsconfig.json` ahead of its siblings, so its patterns win a clash.
        sorted.sort_by_key(|c| (dir_of(c).to_string(), !c.ends_with("/tsconfig.json") && c.as_str() != "tsconfig.json", c.to_string()));
        for config in sorted {
            let dir = dir_of(config).to_string();
            match by_dir.last_mut() {
                Some((last, list)) if *last == dir => list.push(config),
                _ => by_dir.push((dir, vec![config])),
            }
        }
        let mut scopes = Vec::new();
        for (dir, list) in by_dir {
            let mut scope = Scope { dir, ..Default::default() };
            for config in list {
                let options = options_of(config, &read, 0);
                if scope.base.is_none() {
                    scope.base = options.base;
                }
                for (pattern, targets) in options.paths {
                    if !scope.paths.iter().any(|(p, _)| *p == pattern) {
                        scope.paths.push((pattern, targets));
                    }
                }
            }
            if scope.base.is_some() || !scope.paths.is_empty() {
                scopes.push(scope);
            }
        }
        scopes.sort_by(|a, b| b.dir.len().cmp(&a.dir.len()));
        TsPaths { scopes }
    }

    pub fn is_empty(&self) -> bool {
        self.scopes.is_empty()
    }

    /// Repository paths `spec`, imported from `from`, may name — and whether a `paths` pattern
    /// matched at all (then a miss is "unresolved", not "a package").
    pub fn candidates(&self, from: &str, spec: &str) -> (bool, Vec<String>) {
        let from_dir = dir_of(from);
        let Some(scope) = self
            .scopes
            .iter()
            .find(|s| s.dir.is_empty() || from_dir == s.dir || from_dir.starts_with(&format!("{}/", s.dir)))
        else {
            return (false, Vec::new());
        };
        let mut out = Vec::new();
        // TypeScript's rule: an exact pattern first, then the wildcard with the longest prefix.
        let mut best: Option<(&String, &Vec<String>, &str)> = None;
        for (pattern, targets) in &scope.paths {
            match pattern.split_once('*') {
                None if pattern == spec => {
                    best = Some((pattern, targets, ""));
                    break;
                }
                Some((prefix, suffix))
                    if spec.len() >= prefix.len() + suffix.len() && spec.starts_with(prefix) && spec.ends_with(suffix) =>
                {
                    let better = best.is_none_or(|(p, _, _)| p.contains('*') && p.split('*').next().unwrap_or("").len() < prefix.len());
                    if better {
                        best = Some((pattern, targets, &spec[prefix.len()..spec.len() - suffix.len()]));
                    }
                }
                _ => {}
            }
        }
        let matched = best.is_some();
        if let Some((_, targets, star)) = best {
            out.extend(targets.iter().map(|t| t.replacen('*', star, 1)));
        }
        if let Some(base) = &scope.base {
            if let Some(path) = join(base, spec) {
                out.push(path);
            }
        }
        (matched, out)
    }
}

#[derive(Default)]
struct Options {
    base: Option<String>,
    paths: Vec<(String, Vec<String>)>,
}

/// The options `config` ends up with: its own over those of what it extends.
fn options_of(config: &str, read: &impl Fn(&str) -> Option<String>, depth: usize) -> Options {
    let Some(text) = read(config) else { return Options::default() };
    let Ok(json) = serde_json::from_str::<Value>(&strip_jsonc(&text)) else { return Options::default() };
    let dir = dir_of(config);
    let mut inherited = Options::default();
    if depth < MAX_EXTENDS {
        let parents: Vec<&str> = match json.get("extends") {
            Some(Value::String(one)) => vec![one.as_str()],
            Some(Value::Array(many)) => many.iter().filter_map(Value::as_str).collect(),
            _ => Vec::new(),
        };
        for parent in parents {
            if !parent.starts_with('.') {
                continue;
            }
            let Some(mut path) = join(dir, parent) else { continue };
            if !path.ends_with(".json") {
                path.push_str(".json");
            }
            let options = options_of(&path, read, depth + 1);
            if options.base.is_some() {
                inherited.base = options.base;
            }
            if !options.paths.is_empty() {
                inherited.paths = options.paths;
            }
        }
    }
    let compiler = json.get("compilerOptions");
    let base = compiler
        .and_then(|c| c.get("baseUrl"))
        .and_then(Value::as_str)
        .and_then(|b| join(dir, b));
    // `paths` resolve against `baseUrl` when there is one, else against the config that declares them.
    let paths_root = base.clone().or_else(|| inherited.base.clone()).unwrap_or_else(|| dir.to_string());
    let paths: Vec<(String, Vec<String>)> = compiler
        .and_then(|c| c.get("paths"))
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .map(|(pattern, targets)| {
                    let targets = targets
                        .as_array()
                        .map(|list| list.iter().filter_map(Value::as_str).filter_map(|t| join(&paths_root, t)).collect())
                        .unwrap_or_default();
                    (pattern.clone(), targets)
                })
                .collect()
        })
        .unwrap_or_default();
    Options {
        base: base.or(inherited.base),
        paths: if paths.is_empty() { inherited.paths } else { paths },
    }
}

/// tsconfig is JSON with comments and trailing commas; this makes it plain JSON. Strings are
/// copied untouched, so a `"//"` inside one stays.
fn strip_jsonc(text: &str) -> String {
    let bytes: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if c == '"' {
            out.push(c);
            i += 1;
            while i < bytes.len() {
                out.push(bytes[i]);
                if bytes[i] == '\\' && i + 1 < bytes.len() {
                    out.push(bytes[i + 1]);
                    i += 2;
                    continue;
                }
                if bytes[i] == '"' {
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        if c == '/' && bytes.get(i + 1) == Some(&'/') {
            while i < bytes.len() && bytes[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && bytes.get(i + 1) == Some(&'*') {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == '*' && bytes[i + 1] == '/') {
                i += 1;
            }
            i += 2;
            continue;
        }
        if c == ',' {
            let next = bytes[i + 1..].iter().find(|ch| !ch.is_whitespace());
            if matches!(next, Some('}') | Some(']')) {
                i += 1;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn load(files: &[(&str, &str)]) -> TsPaths {
        let map: HashMap<String, String> = files.iter().map(|(p, t)| (p.to_string(), t.to_string())).collect();
        let configs: Vec<String> = files.iter().map(|(p, _)| p.to_string()).collect();
        TsPaths::load(&configs, |p| map.get(p).cloned())
    }

    #[test]
    fn comments_and_trailing_commas_are_dropped_but_strings_kept() {
        let json = strip_jsonc("{\n // note\n \"a\": \"x//y\", /* b */ \"c\": [1, 2,],\n}");
        let value: Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["a"], "x//y");
        assert_eq!(value["c"], serde_json::json!([1, 2]));
    }

    #[test]
    fn wildcard_and_exact_patterns_resolve_against_base_url() {
        let paths = load(&[(
            "apps/web/tsconfig.json",
            r#"{ "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/*"], "@shared": ["../../libs/shared/index"] } } }"#,
        )]);
        let (matched, found) = paths.candidates("apps/web/src/pages/a.ts", "@app/lib/x");
        assert!(matched);
        assert_eq!(found[0], "apps/web/src/lib/x");
        assert_eq!(paths.candidates("apps/web/src/a.ts", "@shared").1[0], "libs/shared/index");
        // Outside the config's folder nothing applies.
        assert_eq!(paths.candidates("apps/api/src/a.ts", "@app/lib/x"), (false, Vec::new()));
    }

    #[test]
    fn paths_come_from_a_sibling_config_and_through_a_relative_extends() {
        let paths = load(&[
            ("tsconfig.json", r#"{ "files": [], "references": [{ "path": "./tsconfig.app.json" }] }"#),
            ("tsconfig.app.json", r#"{ "extends": "./tsconfig.base", "compilerOptions": {} }"#),
            ("tsconfig.base.json", r#"{ "compilerOptions": { "paths": { "~lib/*": ["./src/lib/*"] } } }"#),
        ]);
        assert_eq!(paths.candidates("src/a.ts", "~lib/db").1, vec!["src/lib/db".to_string()]);
    }

    #[test]
    fn the_longest_wildcard_prefix_wins() {
        let paths = load(&[(
            "tsconfig.json",
            r#"{ "compilerOptions": { "paths": { "@/*": ["src/*"], "@/ui/*": ["packages/ui/src/*"] } } }"#,
        )]);
        assert_eq!(paths.candidates("src/a.ts", "@/ui/Button").1[0], "packages/ui/src/Button");
        assert_eq!(paths.candidates("src/a.ts", "@/lib/x").1[0], "src/lib/x");
    }
}
