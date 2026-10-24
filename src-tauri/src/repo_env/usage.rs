//! What the code reads — for «avisa si una variable que el código lee no está en `.env.example`».
//!
//! A regular-expression pass over the source files, capped, rather than the code map: the map
//! knows symbols and imports, and an environment read is a string literal inside a call. Each
//! language's usual spellings are covered; a read built at run time (`process.env[name]`) cannot be
//! seen by any static check and is not pretended to be.
//!
//! Three kinds of key, because the files spell them three ways: an environment variable
//! (`process.env.X`, `os.getenv("X")`…), a .NET configuration key (`configuration["A:B"]`), and a
//! Spring property (`@Value("${a.b}")`). The comparison against the files happens in the webview.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;
use serde::Serialize;

pub const MAX_FILES: usize = 8000;
pub const MAX_FILE_BYTES: u64 = 512 * 1024;
pub const MAX_DEPTH: usize = 14;
const MAX_PLACES: usize = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReadKind {
    Env,
    Dotnet,
    /// `GetSection("A")` — reads everything under `A`.
    DotnetSection,
    Spring,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub path: String,
    pub line: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Read {
    pub key: String,
    pub kind: ReadKind,
    /// The read names a fallback (`${a.b:default}`, `os.getenv("X", "d")`), so a missing key is
    /// not a failure.
    pub has_default: bool,
    pub places: Vec<Place>,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub reads: Vec<Read>,
    pub files_scanned: usize,
    pub truncated: bool,
}

struct Rule {
    re: Regex,
    kind: ReadKind,
    /// Capture 2 present means a fallback was given.
    default_group: bool,
}

fn rules_for(ext: &str) -> &'static [Rule] {
    static JS: OnceLock<Vec<Rule>> = OnceLock::new();
    static CS: OnceLock<Vec<Rule>> = OnceLock::new();
    static RS: OnceLock<Vec<Rule>> = OnceLock::new();
    static PY: OnceLock<Vec<Rule>> = OnceLock::new();
    static JVM: OnceLock<Vec<Rule>> = OnceLock::new();
    static GO: OnceLock<Vec<Rule>> = OnceLock::new();
    static RB: OnceLock<Vec<Rule>> = OnceLock::new();
    static PHP: OnceLock<Vec<Rule>> = OnceLock::new();
    static PRISMA: OnceLock<Vec<Rule>> = OnceLock::new();
    let rule = |pattern: &str, kind: ReadKind, default_group: bool| Rule { re: Regex::new(pattern).unwrap(), kind, default_group };
    let env = ReadKind::Env;
    match ext {
        "js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" | "mts" | "cts" | "vue" | "svelte" | "astro" => JS.get_or_init(|| {
            vec![
                rule(r"process\.env\.([A-Za-z_][A-Za-z0-9_]*)", env, false),
                rule(r#"process\.env\[\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\]"#, env, false),
                rule(r"import\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)", env, false),
                rule(r#"Deno\.env\.get\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']"#, env, false),
                rule(r#"Bun\.env\.([A-Za-z_][A-Za-z0-9_]*)"#, env, false),
            ]
        }),
        "cs" | "cshtml" | "razor" => CS.get_or_init(|| {
            vec![
                rule(r#"Environment\.GetEnvironmentVariable\(\s*"([^"]+)""#, env, false),
                rule(r#"[A-Za-z_]*[Cc]onfig[A-Za-z_]*\s*\[\s*"([^"]+)"\s*\]"#, ReadKind::Dotnet, false),
                rule(r#"GetValue<[^>]+>\(\s*"([^"]+)"\s*(,)?"#, ReadKind::Dotnet, true),
                rule(r#"GetConnectionString\(\s*"([^"]+)"\s*\)"#, ReadKind::Dotnet, false),
                rule(r#"GetSection\(\s*"([^"]+)"\s*\)"#, ReadKind::DotnetSection, false),
            ]
        }),
        "rs" => RS.get_or_init(|| {
            vec![
                rule(r#"env::var(?:_os)?\(\s*"([^"]+)"\s*\)"#, env, false),
                rule(r#"(?:option_)?env!\(\s*"([^"]+)"\s*(,)?"#, env, true),
                rule(r#"dotenvy?::var\(\s*"([^"]+)"\s*\)"#, env, false),
            ]
        }),
        "py" => PY.get_or_init(|| {
            vec![
                rule(r#"os\.environ\[\s*["']([^"']+)["']\s*\]"#, env, false),
                rule(r#"(?:os\.)?environ\.get\(\s*["']([^"']+)["']\s*(,)?"#, env, true),
                rule(r#"os\.getenv\(\s*["']([^"']+)["']\s*(,)?"#, env, true),
                rule(r#"\benv(?:\.str|\.int|\.bool)?\(\s*["']([A-Z][A-Z0-9_]*)["']\s*(,)?"#, env, true),
            ]
        }),
        "java" | "kt" | "kts" | "scala" | "groovy" => JVM.get_or_init(|| {
            vec![
                rule(r#"System\.getenv\(\s*"([^"]+)"\s*\)"#, env, false),
                rule(r#"@Value\(\s*"\$\{([^}:"]+)(:)?"#, ReadKind::Spring, true),
                rule(r#"(?:environment|env)\.getProperty\(\s*"([^"]+)"\s*(,)?"#, ReadKind::Spring, true),
            ]
        }),
        "go" => GO.get_or_init(|| vec![rule(r#"os\.(?:Getenv|LookupEnv)\(\s*"([^"]+)"\s*\)"#, env, false)]),
        "rb" | "erb" => RB.get_or_init(|| {
            vec![
                rule(r#"ENV\[\s*["']([^"']+)["']\s*\]"#, env, false),
                rule(r#"ENV\.fetch\(\s*["']([^"']+)["']\s*(,)?"#, env, true),
            ]
        }),
        "php" => PHP.get_or_init(|| {
            vec![
                rule(r#"getenv\(\s*['"]([^'"]+)['"]\s*\)"#, env, false),
                rule(r#"\$_(?:ENV|SERVER)\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]"#, env, false),
                rule(r#"\benv\(\s*['"]([A-Z][A-Z0-9_]*)['"]\s*(,)?"#, env, true),
            ]
        }),
        "prisma" => PRISMA.get_or_init(|| vec![rule(r#"env\(\s*"([^"]+)"\s*\)"#, env, false)]),
        _ => &[],
    }
}

/// Destructuring — `const { A, B: b } = process.env` — names several keys at once.
fn destructured(text: &str) -> Vec<(usize, String)> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"\{([^{}]{1,600})\}\s*=\s*(?:process\.env|import\.meta\.env)\b").unwrap());
    let mut out = Vec::new();
    for caps in re.captures_iter(text) {
        let whole = caps.get(1).unwrap();
        for part in whole.as_str().split(',') {
            let name = part.split([':', '=']).next().unwrap_or("").trim();
            if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && !name.starts_with("...") {
                out.push((whole.start(), name.to_string()));
            }
        }
    }
    out
}

/// Variables every runtime sets itself, or that a framework fills in — reading them is not a
/// configuration the repository owes anybody.
pub fn is_builtin(key: &str) -> bool {
    const EXACT: &[&str] = &[
        "NODE_ENV", "PATH", "HOME", "USER", "USERNAME", "USERPROFILE", "PWD", "SHELL", "TMPDIR", "TEMP", "TMP", "CI", "APPDATA",
        "LOCALAPPDATA", "HOSTNAME", "COMPUTERNAME", "LANG", "TERM", "MODE", "DEV", "PROD", "SSR", "BASE_URL", "OUT_DIR",
        "ASPNETCORE_ENVIRONMENT", "DOTNET_ENVIRONMENT", "PROGRAMFILES", "SYSTEMROOT", "WINDIR", "XDG_CONFIG_HOME",
        "XDG_DATA_HOME", "XDG_CACHE_HOME", "VERCEL", "VERCEL_ENV", "GITHUB_ACTIONS", "NEXT_RUNTIME",
    ];
    const PREFIXES: &[&str] = &["CARGO_", "npm_", "TAURI_ENV_", "RUNNER_", "GITHUB_", "DEP_", "RUSTC"];
    EXACT.contains(&key) || PREFIXES.iter().any(|p| key.starts_with(p))
}

/// Scans `text` (a file with extension `ext`) into `found`.
pub fn scan_text(rel: &str, ext: &str, text: &str, found: &mut BTreeMap<(ReadKind, String), Read>) {
    let rules = rules_for(ext);
    if rules.is_empty() {
        return;
    }
    let line_at = |offset: usize| text[..offset].matches('\n').count() + 1;
    let mut add = |key: String, kind: ReadKind, has_default: bool, offset: usize| {
        if key.is_empty() || key.len() > 200 || (kind == ReadKind::Env && is_builtin(&key)) {
            return;
        }
        let read = found.entry((kind, key.clone())).or_insert_with(|| Read { key, kind, has_default: true, places: Vec::new(), count: 0 });
        // One read without a fallback is enough to make the key required.
        read.has_default &= has_default;
        read.count += 1;
        if read.places.len() < MAX_PLACES {
            read.places.push(Place { path: rel.to_string(), line: line_at(offset) });
        }
    };
    for rule in rules {
        for caps in rule.re.captures_iter(text) {
            let m = caps.get(1).unwrap();
            let has_default = rule.default_group && caps.get(2).is_some();
            add(m.as_str().to_string(), rule.kind, has_default, m.start());
        }
    }
    if matches!(ext, "js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" | "mts" | "cts" | "vue" | "svelte" | "astro") {
        for (offset, name) in destructured(text) {
            add(name, ReadKind::Env, false, offset);
        }
    }
}

/// Walks `root`'s source files. `exclude` are folder names never entered (the same list the file
/// detection uses), and hidden folders are skipped too — source does not live in `.git` or `.idea`.
pub fn scan(root: &Path, exclude: &[String]) -> Usage {
    let exclude: Vec<String> = exclude.iter().map(|e| e.to_ascii_lowercase()).collect();
    let mut found: BTreeMap<(ReadKind, String), Read> = BTreeMap::new();
    let mut files_scanned = 0;
    let mut truncated = false;
    let mut stack: Vec<(std::path::PathBuf, String, usize)> = vec![(root.to_path_buf(), String::new(), 0)];
    'walk: while let Some((dir, rel, depth)) = stack.pop() {
        let Ok(read) = std::fs::read_dir(&dir) else { continue };
        for child in read.flatten() {
            let Ok(kind) = child.file_type() else { continue };
            if kind.is_symlink() {
                continue;
            }
            let name = child.file_name().to_string_lossy().into_owned();
            let child_rel = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
            if kind.is_dir() {
                if name.starts_with('.') || exclude.contains(&name.to_ascii_lowercase()) {
                    continue;
                }
                if depth + 1 < MAX_DEPTH {
                    stack.push((child.path(), child_rel, depth + 1));
                } else {
                    truncated = true;
                }
                continue;
            }
            let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
            if rules_for(&ext).is_empty() || name.ends_with(".min.js") || name.ends_with(".d.ts") {
                continue;
            }
            if files_scanned >= MAX_FILES {
                truncated = true;
                break 'walk;
            }
            if child.metadata().map(|m| m.len() > MAX_FILE_BYTES).unwrap_or(true) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(child.path()) else { continue };
            files_scanned += 1;
            scan_text(&child_rel, &ext, &text, &mut found);
        }
    }
    Usage { reads: found.into_values().collect(), files_scanned, truncated }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(rel: &str, ext: &str, text: &str) -> Vec<(ReadKind, String, bool)> {
        let mut found = BTreeMap::new();
        scan_text(rel, ext, text, &mut found);
        found.into_values().map(|r| (r.kind, r.key, r.has_default)).collect()
    }

    #[test]
    fn javascript_and_typescript() {
        let got = keys("a.ts", "ts", "const a = process.env.API_URL;\nconst b = process.env['TOKEN'];\nimport.meta.env.VITE_KEY;\nconst { DB_HOST, DB_PORT: port = 5432 } = process.env;\nprocess.env.NODE_ENV;\n");
        let names: Vec<&str> = got.iter().map(|(_, k, _)| k.as_str()).collect();
        assert_eq!(names, vec!["API_URL", "DB_HOST", "DB_PORT", "TOKEN", "VITE_KEY"], "NODE_ENV is the runtime's own");
    }

    #[test]
    fn dotnet_configuration_and_environment() {
        let got = keys(
            "P.cs",
            "cs",
            "Environment.GetEnvironmentVariable(\"API_KEY\");\nvar c = builder.Configuration[\"Jwt:Key\"];\n_config.GetValue<int>(\"Limits:Max\", 10);\nconfiguration.GetConnectionString(\"Default\");\nconfig.GetSection(\"Smtp\");",
        );
        assert!(got.contains(&(ReadKind::Env, "API_KEY".into(), false)));
        assert!(got.contains(&(ReadKind::Dotnet, "Jwt:Key".into(), false)));
        assert!(got.contains(&(ReadKind::Dotnet, "Limits:Max".into(), true)));
        assert!(got.contains(&(ReadKind::Dotnet, "Default".into(), false)));
        assert!(got.contains(&(ReadKind::DotnetSection, "Smtp".into(), false)));
    }

    #[test]
    fn rust_python_jvm_go_ruby_php() {
        assert_eq!(keys("m.rs", "rs", "std::env::var(\"DATABASE_URL\")\nenv!(\"CARGO_PKG_VERSION\")\noption_env!(\"BUILD_SHA\")"), vec![
            (ReadKind::Env, "BUILD_SHA".into(), false),
            (ReadKind::Env, "DATABASE_URL".into(), false),
        ]);
        let py = keys("a.py", "py", "os.environ['SECRET']\nos.getenv(\"PORT\", \"8000\")\nos.environ.get('REDIS')");
        assert!(py.contains(&(ReadKind::Env, "PORT".into(), true)));
        assert!(py.contains(&(ReadKind::Env, "REDIS".into(), false)));
        assert!(py.contains(&(ReadKind::Env, "SECRET".into(), false)));
        let java = keys("A.java", "java", "System.getenv(\"TOKEN\");\n@Value(\"${app.name}\") String n;\n@Value(\"${app.size:10}\") int s;");
        assert!(java.contains(&(ReadKind::Env, "TOKEN".into(), false)));
        assert!(java.contains(&(ReadKind::Spring, "app.name".into(), false)));
        assert!(java.contains(&(ReadKind::Spring, "app.size".into(), true)));
        assert_eq!(keys("m.go", "go", "os.Getenv(\"GO_KEY\")"), vec![(ReadKind::Env, "GO_KEY".into(), false)]);
        assert_eq!(keys("a.rb", "rb", "ENV['RB_KEY']"), vec![(ReadKind::Env, "RB_KEY".into(), false)]);
        assert_eq!(keys("a.php", "php", "getenv('PHP_KEY')"), vec![(ReadKind::Env, "PHP_KEY".into(), false)]);
        assert!(keys("a.txt", "txt", "process.env.X").is_empty());
    }

    #[test]
    fn one_read_without_a_fallback_makes_it_required_and_places_are_capped() {
        let mut found = BTreeMap::new();
        scan_text("a.py", "py", "os.getenv('K', 'x')", &mut found);
        scan_text("b.py", "py", &"os.getenv('K')\n".repeat(9), &mut found);
        let read = found.values().next().unwrap();
        assert!(!read.has_default);
        assert_eq!(read.count, 10);
        assert_eq!(read.places.len(), MAX_PLACES);
        assert_eq!(read.places[1], Place { path: "b.py".into(), line: 1 });
    }

    #[test]
    fn the_walk_skips_excluded_and_hidden_folders() {
        let root = super::super::temp_dir("usage");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/x")).unwrap();
        std::fs::create_dir_all(root.join(".hidden")).unwrap();
        std::fs::write(root.join("src/a.ts"), "process.env.ONE").unwrap();
        std::fs::write(root.join("node_modules/x/b.js"), "process.env.TWO").unwrap();
        std::fs::write(root.join(".hidden/c.js"), "process.env.THREE").unwrap();
        let usage = scan(&root, &["node_modules".to_string()]);
        assert_eq!(usage.files_scanned, 1);
        assert_eq!(usage.reads.iter().map(|r| r.key.as_str()).collect::<Vec<_>>(), vec!["ONE"]);
        std::fs::remove_dir_all(root).ok();
    }
}
