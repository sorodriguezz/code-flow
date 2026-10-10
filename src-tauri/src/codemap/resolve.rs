//! Which file an import names — the difference between "this file mentions `guardar`" and "this
//! file uses *that* `guardar`".
//!
//! Each language family has its own idea of a module: a relative path (`./cart`), a dotted package
//! (`com.acme.Pago`, `..models`), a namespace (`Acme.Pagos`), a crate path (`crate::db::queries`).
//! All of them come down to the same few lookups over the repository's file list: an exact path
//! without its extension, a path *ending* in the import (an alias like `@/lib/x`, a source root
//! nobody declared), a folder, or a declared namespace.
//!
//! **Three answers, not two.** An import is resolved to files, recognised as external (`react`,
//! `java.util`, `System.Linq`) or left *unresolved* — it looks like the project's own and nothing
//! matched, the signature of a path alias or a build setup this does not read. A file with an
//! unresolved import is never used to rule anything out: whatever it imports could be the very
//! file in question.

use std::collections::{HashMap, HashSet};

use super::extract::Facts;

/// A wildcard or namespace import can name a whole folder; past this many files it says nothing
/// useful about which one a name came from.
const MAX_FILES_PER_IMPORT: usize = 400;

/// Extensions an import may carry that name a file which is not code — an asset, never a module.
const ASSET_EXT: &[&str] = &[
    "css", "scss", "sass", "less", "svg", "png", "jpg", "jpeg", "gif", "webp", "ico", "json", "md", "txt", "html", "wasm",
    "woff", "woff2", "ttf", "otf", "mp3", "wav", "glsl", "yaml", "yml",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution {
    Files(Vec<u32>),
    External,
    Unresolved,
}

pub struct Resolver<'a> {
    paths: Vec<&'a str>,
    /// Path without extension → files. A folder's `index.ts`, `__init__.py` or `mod.rs` is also
    /// listed under the folder itself.
    stems: HashMap<String, Vec<u32>>,
    /// Last segment of every key in `stems` → the keys ending in it, for suffix lookups.
    by_last: HashMap<String, Vec<String>>,
    namespaces: HashMap<String, Vec<u32>>,
    dirs: HashMap<String, Vec<u32>>,
    /// First path segments, and the ones under a `src/`, `lib/` or `app/` root: what makes an
    /// import that matched nothing look like the project's own rather than a package.
    top: HashSet<String>,
}

pub fn dir_of(path: &str) -> &str {
    path.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("")
}

fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// `src/a/b.ts` → `src/a/b`.
pub fn stem(path: &str) -> &str {
    let name = file_name(path);
    match name.rfind('.') {
        Some(dot) if dot > 0 => &path[..path.len() - (name.len() - dot)],
        _ => path,
    }
}

fn last_segment(key: &str) -> &str {
    key.rsplit('/').next().unwrap_or(key)
}

/// Joins `rel` onto `dir` and folds `.` and `..` — `None` when it climbs out of the repository.
fn join(dir: &str, rel: &str) -> Option<String> {
    let mut parts: Vec<&str> = if dir.is_empty() { Vec::new() } else { dir.split('/').collect() };
    for segment in rel.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            other => parts.push(other),
        }
    }
    Some(parts.join("/"))
}

fn extension_of(spec: &str) -> Option<String> {
    let name = file_name(spec);
    name.rfind('.').filter(|dot| *dot > 0).map(|dot| name[dot + 1..].to_ascii_lowercase())
}

impl<'a> Resolver<'a> {
    pub fn new(files: &[(&'a str, &'a Facts)]) -> Self {
        let mut resolver = Resolver {
            paths: files.iter().map(|(path, _)| *path).collect(),
            stems: HashMap::new(),
            by_last: HashMap::new(),
            namespaces: HashMap::new(),
            dirs: HashMap::new(),
            top: HashSet::new(),
        };
        for (index, (path, facts)) in files.iter().enumerate() {
            let index = index as u32;
            let mut keys = vec![stem(path).to_string()];
            let base = last_segment(stem(path));
            if matches!(base, "index" | "__init__" | "mod") {
                keys.push(dir_of(path).to_string());
            }
            for key in keys {
                let entry = resolver.stems.entry(key.clone()).or_default();
                if entry.is_empty() {
                    resolver.by_last.entry(last_segment(&key).to_string()).or_default().push(key.clone());
                }
                entry.push(index);
            }
            resolver.dirs.entry(dir_of(path).to_string()).or_default().push(index);
            if let Some(namespace) = &facts.namespace {
                resolver.namespaces.entry(namespace.clone()).or_default().push(index);
            }
            let mut segments = path.split('/');
            if let Some(first) = segments.next() {
                resolver.top.insert(first.to_string());
                if matches!(first, "src" | "lib" | "app" | "source" | "packages") {
                    if let Some(second) = segments.next() {
                        resolver.top.insert(second.to_string());
                    }
                }
            }
        }
        resolver
    }

    fn exact(&self, key: &str) -> Vec<u32> {
        self.stems.get(key).cloned().unwrap_or_default()
    }

    /// Files whose path (without extension) is `target` or ends in `/target`.
    fn suffix(&self, target: &str) -> Vec<u32> {
        let target = target.trim_matches('/');
        if target.is_empty() {
            return Vec::new();
        }
        let Some(keys) = self.by_last.get(last_segment(target)) else { return Vec::new() };
        let needle = format!("/{target}");
        let mut out = Vec::new();
        for key in keys {
            if key == target || key.ends_with(&needle) {
                out.extend(self.exact(key));
            }
        }
        out
    }

    fn dir_suffix(&self, target: &str) -> Vec<u32> {
        let target = target.trim_matches('/');
        let needle = format!("/{target}");
        let mut out = Vec::new();
        for (dir, files) in &self.dirs {
            if dir == target || dir.ends_with(&needle) {
                out.extend(files.iter().copied());
            }
        }
        out
    }

    fn looks_local(&self, first: &str) -> bool {
        self.top.contains(first)
    }

    fn found(files: Vec<u32>) -> Option<Resolution> {
        if files.is_empty() {
            return None;
        }
        let mut files = files;
        files.sort_unstable();
        files.dedup();
        files.truncate(MAX_FILES_PER_IMPORT);
        Some(Resolution::Files(files))
    }

    /// What `spec`, imported by the file at `from_index`, names.
    pub fn resolve(&self, from_index: u32, facts: &Facts, spec: &str) -> Resolution {
        let from = self.paths[from_index as usize];
        let spec = spec.split(['?', '#']).next().unwrap_or(spec).trim();
        if spec.is_empty() {
            return Resolution::External;
        }
        match facts.lang.as_str() {
            "ts" => self.typescript(from, spec),
            "py" => self.python(from, spec),
            "java" => self.jvm(facts, spec),
            "cs" => self.csharp(facts, spec),
            "go" => self.go(spec),
            "rs" => self.rust(from, spec),
            "php" => self.php(facts, spec),
            "rb" => self.relative_or_suffix(from, spec, Some("lib")),
            "c" => self.relative_or_suffix(from, spec, None),
            "dart" => self.dart(from, spec),
            _ => Resolution::External,
        }
    }

    fn typescript(&self, from: &str, spec: &str) -> Resolution {
        // A stylesheet or an image is never a module — and `./cart.css` stripped of its extension
        // would otherwise name `./cart.ts`.
        if extension_of(spec).is_some_and(|ext| ASSET_EXT.contains(&ext.as_str())) {
            return Resolution::External;
        }
        if spec.starts_with('.') {
            let Some(joined) = join(dir_of(from), spec) else { return Resolution::External };
            if let Some(found) = Self::found(self.exact(stem(&joined))).or_else(|| Self::found(self.exact(&joined))) {
                return found;
            }
            return Resolution::Unresolved;
        }
        let stripped = spec.trim_start_matches("@/").trim_start_matches("~/").trim_start_matches('#').trim_start_matches('/');
        let aliased = stripped.len() != spec.len();
        let first = stripped.split('/').next().unwrap_or_default();
        // A scoped package (`@tauri-apps/api`) or a bare one (`react`) is never the project's own,
        // unless its first segment is a folder of the project (a `baseUrl` import).
        if !aliased && !self.looks_local(first) {
            return Resolution::External;
        }
        Self::found(self.suffix(stem(stripped))).unwrap_or(Resolution::Unresolved)
    }

    fn python(&self, from: &str, spec: &str) -> Resolution {
        let dots = spec.chars().take_while(|c| *c == '.').count();
        let rest = spec[dots..].replace('.', "/");
        if dots > 0 {
            let mut base = dir_of(from).to_string();
            for _ in 1..dots {
                base = dir_of(&base).to_string();
            }
            let target = if rest.is_empty() { base.clone() } else if base.is_empty() { rest.clone() } else { format!("{base}/{rest}") };
            // `from .models import Pago` arrives as both `.models` and `.models.Pago`: the second is a
            // name inside the first, so it resolves to the module it is in.
            if let Some(found) = Self::found(self.exact(&target)).or_else(|| Self::found(self.exact(dir_of(&target)))) {
                return found;
            }
            return Resolution::Unresolved;
        }
        let first = rest.split('/').next().unwrap_or_default().to_string();
        let mut target = rest.as_str();
        loop {
            if let Some(found) = Self::found(self.suffix(target)) {
                return found;
            }
            match target.rsplit_once('/') {
                Some((shorter, _)) => target = shorter,
                None => break,
            }
        }
        if self.looks_local(&first) {
            Resolution::Unresolved
        } else {
            Resolution::External
        }
    }

    fn jvm(&self, facts: &Facts, spec: &str) -> Resolution {
        let own_prefix = facts.namespace.as_deref().map(|ns| ns.split('.').take(2).collect::<Vec<_>>().join("."));
        let local = |spec: &str| own_prefix.as_deref().is_some_and(|prefix| !prefix.is_empty() && spec.starts_with(prefix));
        if let Some(package) = spec.strip_suffix(".*") {
            if let Some(found) = Self::found(self.namespaces.get(package).cloned().unwrap_or_default())
                .or_else(|| Self::found(self.dir_suffix(&package.replace('.', "/"))))
            {
                return found;
            }
            return if local(package) { Resolution::Unresolved } else { Resolution::External };
        }
        let path = spec.replace('.', "/");
        // A static import names a member: `com.acme.Util.format` lives in `com/acme/Util`.
        if let Some(found) = Self::found(self.suffix(&path)).or_else(|| Self::found(self.suffix(dir_of(&path)))) {
            return found;
        }
        if local(spec) {
            Resolution::Unresolved
        } else {
            Resolution::External
        }
    }

    fn csharp(&self, facts: &Facts, spec: &str) -> Resolution {
        if let Some(found) = Self::found(self.namespaces.get(spec).cloned().unwrap_or_default()) {
            return found;
        }
        let own_root = facts.namespace.as_deref().and_then(|ns| ns.split('.').next()).unwrap_or_default();
        if !own_root.is_empty() && spec.split('.').next() == Some(own_root) {
            Resolution::Unresolved
        } else {
            Resolution::External
        }
    }

    fn go(&self, spec: &str) -> Resolution {
        let segments: Vec<&str> = spec.split('/').collect();
        if segments.len() >= 2 {
            let tail = segments[segments.len() - 2..].join("/");
            if let Some(found) = Self::found(self.dir_suffix(&tail)) {
                return found;
            }
        }
        let last = segments.last().copied().unwrap_or_default();
        let dirs: Vec<&String> = self.dirs.keys().filter(|dir| last_segment(dir) == last).collect();
        match dirs.as_slice() {
            [one] if segments.len() >= 2 => Self::found(self.dirs.get(*one).cloned().unwrap_or_default()).unwrap_or(Resolution::Unresolved),
            [] => Resolution::External,
            _ if segments.len() >= 2 => Resolution::Unresolved,
            _ => Resolution::External,
        }
    }

    /// The folder a Rust file's child modules live in: `src/db/mod.rs` → `src/db`, `src/db.rs` →
    /// `src/db`, `src/lib.rs` → `src`.
    fn rust_module_dir(from: &str) -> String {
        let name = file_name(from);
        if matches!(name, "mod.rs" | "lib.rs" | "main.rs") {
            dir_of(from).to_string()
        } else {
            stem(from).to_string()
        }
    }

    fn rust_lookup(&self, base: &str, segments: &[&str]) -> Option<Resolution> {
        for take in (1..=segments.len()).rev() {
            let rel = segments[..take].join("/");
            let target = if base.is_empty() { rel } else { format!("{base}/{rel}") };
            if let Some(found) = Self::found(self.exact(&target)) {
                return Some(found);
            }
        }
        None
    }

    fn rust(&self, from: &str, spec: &str) -> Resolution {
        let module_dir = Self::rust_module_dir(from);
        if let Some(name) = spec.strip_prefix("mod:") {
            return Self::found(self.exact(&format!("{module_dir}/{name}"))).unwrap_or(Resolution::Unresolved);
        }
        let segments: Vec<&str> = spec.split("::").filter(|s| !s.is_empty()).collect();
        let Some((first, rest)) = segments.split_first() else { return Resolution::External };
        match *first {
            "crate" => {
                for take in (1..=rest.len()).rev() {
                    if let Some(found) = Self::found(self.suffix(&rest[..take].join("/"))) {
                        return found;
                    }
                }
                Resolution::Unresolved
            }
            "self" => self.rust_lookup(&module_dir, rest).unwrap_or(Resolution::Unresolved),
            "super" => {
                let mut base = dir_of(&module_dir).to_string();
                let mut rest = rest;
                while rest.first() == Some(&"super") {
                    base = dir_of(&base).to_string();
                    rest = &rest[1..];
                }
                self.rust_lookup(&base, rest).unwrap_or(Resolution::Unresolved)
            }
            // A path relative to the current module (2018 edition) when its first segment is a child
            // module; otherwise another crate.
            _ => self.rust_lookup(&module_dir, &segments).unwrap_or(Resolution::External),
        }
    }

    fn php(&self, facts: &Facts, spec: &str) -> Resolution {
        let path = spec.replace('\\', "/");
        let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        for skip in 0..segments.len().saturating_sub(1) {
            if let Some(found) = Self::found(self.suffix(&segments[skip..].join("/"))) {
                return found;
            }
        }
        let own_root = facts.namespace.as_deref().and_then(|ns| ns.split('\\').next()).unwrap_or_default();
        if !own_root.is_empty() && segments.first() == Some(&own_root) {
            Resolution::Unresolved
        } else {
            Resolution::External
        }
    }

    fn relative_or_suffix(&self, from: &str, spec: &str, root: Option<&str>) -> Resolution {
        if spec.starts_with('.') {
            let Some(joined) = join(dir_of(from), spec) else { return Resolution::External };
            return Self::found(self.exact(stem(&joined))).unwrap_or(Resolution::Unresolved);
        }
        if let Some(found) = Self::found(self.suffix(stem(spec))) {
            return found;
        }
        if let Some(root) = root {
            if let Some(found) = Self::found(self.suffix(&format!("{root}/{}", stem(spec)))) {
                return found;
            }
        }
        Resolution::External
    }

    fn dart(&self, from: &str, spec: &str) -> Resolution {
        if let Some(rest) = spec.strip_prefix("package:") {
            let path = rest.split_once('/').map(|(_, path)| path).unwrap_or(rest);
            return Self::found(self.suffix(&format!("lib/{}", stem(path)))).unwrap_or(Resolution::External);
        }
        if spec.starts_with("dart:") {
            return Resolution::External;
        }
        self.relative_or_suffix(from, &format!("./{}", spec.trim_start_matches("./")), None)
    }
}

/// Whether a file of family `user` sees what a file of family `owner` declares without importing
/// it: Java and Go share a package folder, C# and PHP a namespace.
pub fn same_scope(user_path: &str, user: &Facts, owner_path: &str, owner: &Facts) -> bool {
    if user.lang != owner.lang {
        return false;
    }
    match user.lang.as_str() {
        "java" | "go" => {
            dir_of(user_path) == dir_of(owner_path)
                || (user.namespace.is_some() && user.namespace == owner.namespace && user.lang == "java")
        }
        "cs" => match (&user.namespace, &owner.namespace) {
            (Some(user_ns), Some(owner_ns)) => user_ns == owner_ns || user_ns.starts_with(&format!("{owner_ns}.")),
            // The global namespace is visible to everything.
            (_, None) => true,
            _ => false,
        },
        "php" => user.namespace.is_some() && user.namespace == owner.namespace,
        _ => false,
    }
}

/// Families whose imports this module resolves. A file of any other family (SQL, shell,
/// ObjectScript, Swift) cannot be told apart by its imports, so its uses are reported by name.
pub fn knows_imports(lang: &str) -> bool {
    matches!(lang, "ts" | "py" | "java" | "cs" | "go" | "rs" | "php" | "rb" | "c" | "dart")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(lang: &str, namespace: Option<&str>) -> Facts {
        Facts { lang: lang.to_string(), namespace: namespace.map(str::to_string), ..Default::default() }
    }

    fn resolve(paths: &[(&str, Facts)], from: &str, spec: &str) -> Resolution {
        let rows: Vec<(&str, &Facts)> = paths.iter().map(|(p, f)| (*p, f)).collect();
        let resolver = Resolver::new(&rows);
        let index = paths.iter().position(|(p, _)| *p == from).unwrap() as u32;
        resolver.resolve(index, &paths[index as usize].1, spec)
    }

    fn files(paths: &[(&str, Facts)], names: &[&str]) -> Resolution {
        Resolution::Files(names.iter().map(|n| paths.iter().position(|(p, _)| p == n).unwrap() as u32).collect())
    }

    #[test]
    fn typescript_relative_alias_index_and_packages() {
        let ts = || facts("ts", None);
        let paths = vec![
            ("src/app/cart.ts", ts()),
            ("src/lib/pricing.ts", ts()),
            ("src/lib/db/index.ts", ts()),
            ("src/components/Button.tsx", ts()),
        ];
        assert_eq!(resolve(&paths, "src/app/cart.ts", "../lib/pricing"), files(&paths, &["src/lib/pricing.ts"]));
        assert_eq!(resolve(&paths, "src/app/cart.ts", "../lib/pricing.js"), files(&paths, &["src/lib/pricing.ts"]), "ESM writes .js for .ts");
        assert_eq!(resolve(&paths, "src/app/cart.ts", "../lib/db"), files(&paths, &["src/lib/db/index.ts"]));
        assert_eq!(resolve(&paths, "src/app/cart.ts", "@/components/Button"), files(&paths, &["src/components/Button.tsx"]));
        assert_eq!(resolve(&paths, "src/app/cart.ts", "react"), Resolution::External);
        assert_eq!(resolve(&paths, "src/app/cart.ts", "@tauri-apps/api/core"), Resolution::External);
        assert_eq!(resolve(&paths, "src/app/cart.ts", "./cart.css"), Resolution::External);
        assert_eq!(resolve(&paths, "src/app/cart.ts", "@/nowhere/thing"), Resolution::Unresolved);
        assert_eq!(resolve(&paths, "src/app/cart.ts", "./missing"), Resolution::Unresolved);
    }

    #[test]
    fn python_relative_names_and_absolute_modules() {
        let py = || facts("py", None);
        let paths = vec![("app/servicio.py", py()), ("app/models.py", py()), ("app/repo/__init__.py", py())];
        assert_eq!(resolve(&paths, "app/servicio.py", ".models"), files(&paths, &["app/models.py"]));
        assert_eq!(resolve(&paths, "app/servicio.py", ".models.Pago"), files(&paths, &["app/models.py"]));
        assert_eq!(resolve(&paths, "app/servicio.py", ".repo"), files(&paths, &["app/repo/__init__.py"]));
        assert_eq!(resolve(&paths, "app/servicio.py", "app.models"), files(&paths, &["app/models.py"]));
        assert_eq!(resolve(&paths, "app/servicio.py", "os.path"), Resolution::External);
        assert_eq!(resolve(&paths, "app/servicio.py", "app.nothing"), Resolution::Unresolved);
    }

    #[test]
    fn java_classes_wildcards_and_static_members() {
        let paths = vec![
            ("src/main/java/com/acme/pagos/PagoService.java", facts("java", Some("com.acme.pagos"))),
            ("src/main/java/com/acme/repo/PagoRepository.java", facts("java", Some("com.acme.repo"))),
            ("src/main/java/com/acme/util/Fmt.java", facts("java", Some("com.acme.util"))),
        ];
        let from = "src/main/java/com/acme/pagos/PagoService.java";
        assert_eq!(resolve(&paths, from, "com.acme.repo.PagoRepository"), files(&paths, &["src/main/java/com/acme/repo/PagoRepository.java"]));
        assert_eq!(resolve(&paths, from, "com.acme.util.*"), files(&paths, &["src/main/java/com/acme/util/Fmt.java"]));
        assert_eq!(resolve(&paths, from, "com.acme.util.Fmt.money"), files(&paths, &["src/main/java/com/acme/util/Fmt.java"]));
        assert_eq!(resolve(&paths, from, "java.util.List"), Resolution::External);
        assert_eq!(resolve(&paths, from, "com.acme.gone.Thing"), Resolution::Unresolved);
    }

    #[test]
    fn csharp_namespaces() {
        let paths = vec![("Pagos/PagoService.cs", facts("cs", Some("Acme.Pagos"))), ("Data/Repo.cs", facts("cs", Some("Acme.Data")))];
        assert_eq!(resolve(&paths, "Pagos/PagoService.cs", "Acme.Data"), files(&paths, &["Data/Repo.cs"]));
        assert_eq!(resolve(&paths, "Pagos/PagoService.cs", "System.Linq"), Resolution::External);
        assert_eq!(resolve(&paths, "Pagos/PagoService.cs", "Acme.Missing"), Resolution::Unresolved);
    }

    #[test]
    fn rust_crate_self_super_and_mod() {
        let rs = || facts("rs", None);
        let paths = vec![
            ("src-tauri/src/lib.rs", rs()),
            ("src-tauri/src/db/mod.rs", rs()),
            ("src-tauri/src/db/queries.rs", rs()),
            ("src-tauri/src/review/graph.rs", rs()),
            ("src-tauri/src/review/outline.rs", rs()),
        ];
        assert_eq!(resolve(&paths, "src-tauri/src/review/graph.rs", "crate::db::queries"), files(&paths, &["src-tauri/src/db/queries.rs"]));
        assert_eq!(resolve(&paths, "src-tauri/src/review/graph.rs", "super::outline"), files(&paths, &["src-tauri/src/review/outline.rs"]));
        assert_eq!(resolve(&paths, "src-tauri/src/db/mod.rs", "mod:queries"), files(&paths, &["src-tauri/src/db/queries.rs"]));
        assert_eq!(resolve(&paths, "src-tauri/src/db/mod.rs", "self::queries"), files(&paths, &["src-tauri/src/db/queries.rs"]));
        assert_eq!(resolve(&paths, "src-tauri/src/lib.rs", "db::queries"), files(&paths, &["src-tauri/src/db/queries.rs"]));
        assert_eq!(resolve(&paths, "src-tauri/src/lib.rs", "serde_json::Value"), Resolution::External);
    }

    #[test]
    fn go_packages_by_folder() {
        let go = || facts("go", Some("x"));
        let paths = vec![("internal/pagos/pagar.go", go()), ("internal/repo/repo.go", go())];
        assert_eq!(resolve(&paths, "internal/pagos/pagar.go", "github.com/acme/app/internal/repo"), files(&paths, &["internal/repo/repo.go"]));
        assert_eq!(resolve(&paths, "internal/pagos/pagar.go", "fmt"), Resolution::External);
    }

    #[test]
    fn scope_without_imports() {
        let a = facts("java", Some("com.acme"));
        let b = facts("java", Some("com.acme"));
        assert!(same_scope("x/A.java", &a, "y/B.java", &b), "same package");
        let c = facts("cs", Some("Acme.Pagos.Sub"));
        let d = facts("cs", Some("Acme.Pagos"));
        assert!(same_scope("a.cs", &c, "b.cs", &d), "a child namespace sees its parent");
        assert!(!same_scope("a.cs", &d, "b.cs", &c));
        let ts = facts("ts", None);
        assert!(!same_scope("a.ts", &ts, "b.ts", &ts), "TypeScript always imports");
    }
}
