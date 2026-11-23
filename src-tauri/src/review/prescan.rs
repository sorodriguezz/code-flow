//! The deterministic pre-scan: a pass over the lines a pull request **adds** that marks what a
//! regex catches with near-certainty — committed secrets, debug leftovers, new dependencies and
//! `.env` files — before any model reads a line.
//!
//! Why it exists: these are findings a model re-derives at full price on every review, and
//! sometimes misses at the bottom of a long bundle. The scan is a **hint**, never a finding by
//! itself — a regex has no idea whether `password = "hunter22"` sits in a test fixture — so the
//! hits ride in the bundle header as *pre-marcados*: the reviewer confirms and reports them
//! (confidence ≥ 90) instead of spending its reading on detecting them, or dismisses them with a
//! reason. Ported from the reference reviewer's `tools/lib/prescan.py`.
//!
//! Three properties are the point, and the tests hold them:
//! - **Bounded.** At most [`MAX_HITS`] entries, ordered secret > env > dependency > debug, and one
//!   hit per manifest rather than one per package line (a template bump of 39 lines once pushed
//!   every debug leftover out of the cap).
//! - **Masked.** A secret's value never leaves this module: the snippet keeps its first characters
//!   and nothing else. A leaked key in a prompt, a transcript or a posted comment is still leaked.
//! - **Cheap.** Pure functions over the diff, no network and no model.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::git::diff::FileDiffInfo;

/// Ceiling on the hits handed to the reviewers. Past it the lowest-priority kinds go first.
pub const MAX_HITS: usize = 30;

/// Longest snippet shown per hit — enough to recognise the line, never a whole minified file.
const SNIPPET_CHARS: usize = 60;

/// Packages named per dependency hit before the rest is a count.
const DEP_SHOWN: usize = 6;

/// The categories the hits carry — the same slugs the reviewers are asked to report them under,
/// so a confirmed pre-mark and one the model found by itself land in the same bucket.
pub const CAT_SECRET: &str = "hardcoded-secret";
pub const CAT_DEBUG: &str = "debug-code-left";
pub const CAT_DEPENDENCY: &str = "unreviewed-dependency";

/// One changed file as the scan reads it.
#[derive(Debug, Clone, Default)]
pub struct ScanFile {
    /// Repository-relative, forward slashes.
    pub path: String,
    /// The pull request adds this file (as opposed to modifying it).
    pub added_file: bool,
    /// `(new-side line, text)` of every line the pull request added.
    pub added: Vec<(usize, String)>,
    /// The text of every line it removed — what tells a version bump from a new dependency.
    pub removed: Vec<String>,
    /// The file's whole new content, when known. Only manifests need it (to tell a line inside
    /// `dependencies` from one inside `scripts`); without it they fall back to stricter patterns.
    pub content: Option<String>,
}

/// One pre-marked line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub file: String,
    /// The line it anchors on (the first one, for a grouped dependency hit).
    pub line: usize,
    /// Every line a grouped hit covers; empty for a single-line hit.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub lines: Vec<usize>,
    /// `secret:<what>` · `env` · `dependency` · `debug:<what>`.
    pub kind: String,
    pub category: String,
    /// The line, trimmed and — for a secret — masked.
    pub snippet: String,
    /// Why it was marked, in a few words.
    pub reason: String,
}

impl Hit {
    fn family(&self) -> &str {
        self.kind.split(':').next().unwrap_or("")
    }
}

// ---------------------------------------------------------------------------
// Building the input from a diff
// ---------------------------------------------------------------------------

/// The scan's input from libgit2's diff — what the project-backed review already holds.
pub fn from_git(diff_files: &[FileDiffInfo]) -> Vec<ScanFile> {
    let mut out = Vec::new();
    for file in diff_files {
        if file.status.eq_ignore_ascii_case("deleted") || file.binary {
            continue;
        }
        let Some(path) = file.new_path.as_deref().or(file.old_path.as_deref()) else { continue };
        let mut scan = ScanFile {
            path: crate::review::outline::normalize_path(path),
            added_file: file.status.eq_ignore_ascii_case("added"),
            ..Default::default()
        };
        for hunk in &file.hunks {
            for line in &hunk.lines {
                match (line.origin.as_str(), line.new_lineno) {
                    ("+", Some(n)) => scan.added.push((n as usize, line.content.clone())),
                    ("-", _) => scan.removed.push(line.content.clone()),
                    _ => {}
                }
            }
        }
        out.push(scan);
    }
    out
}

fn hunk_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,\d+)? @@").unwrap())
}

/// The scan's input from a unified diff in text — what a review by link gets from the host.
///
/// A `+++ ` line is a file header only right after its `--- ` pair: an *added* content line that
/// itself starts with `++ ` reads as `+++ …` too, and taking it for a header dropped every hit in
/// the rest of that file (the reference tool learned this the hard way). An added file is told by
/// `/dev/null` on the old side, `new file mode`, or — Azure's diffs are rendered from two buffers
/// and carry neither — a lone hunk that starts at `-0,0`.
pub fn from_unified(diff: &str) -> Vec<ScanFile> {
    let mut out: Vec<ScanFile> = Vec::new();
    let mut current: Option<ScanFile> = None;
    let mut deleted = false;
    let mut old_null = false;
    let mut new_file_mode = false;
    let mut zero_hunk = false;
    let mut hunks = 0usize;
    let mut new_line = 0usize;
    let mut prev_minus_header = false;
    let mut in_hunk = false;

    let flush = |current: &mut Option<ScanFile>, deleted: bool, added: bool, out: &mut Vec<ScanFile>| {
        if let Some(mut file) = current.take() {
            if !deleted && !file.path.is_empty() {
                file.added_file = added;
                out.push(file);
            }
        }
    };

    for raw in diff.lines() {
        if raw.starts_with("diff --git ") {
            flush(&mut current, deleted, old_null || new_file_mode || (hunks == 1 && zero_hunk), &mut out);
            // The b/ side names the file until a `+++` says otherwise.
            let path = raw.rsplit_once(" b/").map(|(_, p)| p.to_string()).unwrap_or_default();
            current = Some(ScanFile { path, ..Default::default() });
            deleted = false;
            old_null = false;
            new_file_mode = false;
            zero_hunk = false;
            hunks = 0;
            in_hunk = false;
            prev_minus_header = false;
            continue;
        }
        if !in_hunk || prev_minus_header {
            if raw.starts_with("new file mode") {
                new_file_mode = true;
                continue;
            }
            if raw.starts_with("deleted file mode") {
                deleted = true;
                continue;
            }
        }
        if raw.starts_with("--- ") && (!in_hunk || current.is_none()) {
            if current.is_none() {
                current = Some(ScanFile::default());
            }
            old_null = raw[4..].trim() == "/dev/null";
            prev_minus_header = true;
            continue;
        }
        if prev_minus_header && raw.starts_with("+++ ") {
            prev_minus_header = false;
            let target = raw[4..].trim();
            if target == "/dev/null" {
                deleted = true;
            } else if let Some(file) = current.as_mut() {
                file.path = target.strip_prefix("b/").unwrap_or(target).to_string();
            }
            continue;
        }
        prev_minus_header = false;
        if let Some(caps) = hunk_re().captures(raw) {
            in_hunk = true;
            hunks += 1;
            let old_start: usize = caps[1].parse().unwrap_or(1);
            let old_len: usize = caps.get(2).and_then(|m| m.as_str().parse().ok()).unwrap_or(1);
            zero_hunk = old_start == 0 && old_len == 0;
            new_line = caps[3].parse::<usize>().unwrap_or(1).saturating_sub(1);
            continue;
        }
        if !in_hunk {
            continue;
        }
        let Some(file) = current.as_mut() else { continue };
        if let Some(text) = raw.strip_prefix('+') {
            new_line += 1;
            file.added.push((new_line, text.to_string()));
        } else if let Some(text) = raw.strip_prefix('-') {
            file.removed.push(text.to_string());
        } else if raw.starts_with('\\') {
            // "\ No newline at end of file" — not a line of either side.
        } else {
            new_line += 1;
        }
    }
    flush(&mut current, deleted, old_null || new_file_mode || (hunks == 1 && zero_hunk), &mut out);
    for file in out.iter_mut() {
        file.path = crate::review::outline::normalize_path(&file.path);
    }
    out
}

/// Whether the scan would read this file's whole content to judge its dependencies — so the caller
/// fetches it only for the handful of manifests a PR touches, never for every file.
pub fn wants_content(path: &str) -> bool {
    manifest_of(path).is_some()
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

struct SecretRule {
    kind: &'static str,
    reason: &'static str,
    re: Regex,
    /// The capture group holding the value, when the pattern names one — it is what is checked for
    /// placeholders and what gets masked. `0` = the whole match.
    group: usize,
    /// A value that must also look like a real secret (not a placeholder, not a word) to count.
    vetted: bool,
}

fn secret_rules() -> &'static [SecretRule] {
    static RULES: OnceLock<Vec<SecretRule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let r = |kind, reason, pattern: &str, group, vetted| SecretRule {
            kind,
            reason,
            re: Regex::new(pattern).expect("secret pattern"),
            group,
            vetted,
        };
        vec![
            r("private-key", "bloque de clave privada", r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----", 0, false),
            r("aws-access-key", "access key de AWS", r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b", 0, false),
            r("aws-secret-key", "secret key de AWS", r#"(?i)aws.{0,20}(?:secret|private).{0,20}[:=]\s*["']?([A-Za-z0-9/+=]{40})\b"#, 1, false),
            r("azure-storage-key", "clave de cuenta de Azure Storage", r"(?i)AccountKey=([A-Za-z0-9+/=]{20,})", 1, false),
            r("azure-sas", "firma SAS de Azure", r"(?i)(?:SharedAccessSignature=|SharedAccessKey=|[?&]sig=)([A-Za-z0-9%+/=]{20,})", 1, false),
            r("github-token", "token de GitHub", r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})", 0, false),
            r("gitlab-token", "token de GitLab", r"\bglpat-[A-Za-z0-9_\-]{20,}", 0, false),
            r("slack-token", "token de Slack", r"\bxox[abposr]-[A-Za-z0-9-]{10,}", 0, false),
            r("slack-webhook", "webhook de Slack", r"https://hooks\.slack\.com/services/[A-Za-z0-9_/]{20,}", 0, false),
            r("stripe-key", "clave de Stripe", r"\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}", 0, false),
            r("jwt", "token JWT", r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}", 0, false),
            r("url-credentials", "credenciales embebidas en una URL", r#"\b[a-zA-Z][a-zA-Z0-9+.\-]*://[^\s:@/'"]+:([^\s@/'"]{3,})@[^\s'"]+"#, 1, true),
            r("connection-string", "contraseña en una cadena de conexión", r#"(?i)(?:^|[;"'\s])(?:password|pwd)\s*=\s*([^;'"\s]{4,})"#, 1, true),
            r(
                "assignment",
                "asignación de secreto con valor literal",
                r#"(?i)\b[A-Za-z0-9_.\-]*(?:password|passwd|pwd|secret|token|api[_\-]?key|access[_\-]?key|private[_\-]?key|client[_\-]?secret|credential)[A-Za-z0-9_.\-]*["']?\s*(?::=|=>|[:=])\s*["'`]([^"'`]{8,})["'`]"#,
                1,
                true,
            ),
        ]
    })
}

/// Shannon entropy in bits per character — what tells `xK9#mQ2vLp` from `changeme1`.
fn entropy(value: &str) -> f64 {
    let mut counts: BTreeMap<char, usize> = BTreeMap::new();
    let mut total = 0usize;
    for c in value.chars() {
        *counts.entry(c).or_default() += 1;
        total += 1;
    }
    if total == 0 {
        return 0.0;
    }
    counts
        .values()
        .map(|&n| {
            let p = n as f64 / total as f64;
            -p * p.log2()
        })
        .sum()
}

/// A value that is obviously not a real secret: an env lookup, a template slot, a placeholder word.
fn is_placeholder(value: &str) -> bool {
    let v = value.trim();
    let lower = v.to_lowercase();
    const WORDS: &[&str] = &[
        "xxx", "***", "...", "…", "<", ">", "${", "{{", "}}", "$(", "%(", "#{", "process.env", "os.environ", "getenv",
        "your", "example", "placeholder", "changeme", "change_me", "change-me", "dummy", "fake", "sample", "redacted",
        "todo", "replace", "insert", "secret_here", "password_here", "<password>", "env(", "vault:", "keyvault",
    ];
    if v.is_empty() || v.starts_with('$') || v.starts_with('%') || v.starts_with('@') || v.starts_with(':') {
        return true;
    }
    if WORDS.iter().any(|w| lower.contains(w)) {
        return true;
    }
    // An environment variable's *name* (`DB_PASSWORD`), not its value.
    if v.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_') {
        return true;
    }
    // One character repeated (`aaaaaaaa`, `00000000`).
    let mut chars = v.chars();
    if let Some(first) = chars.next() {
        if chars.all(|c| c == first) {
            return true;
        }
    }
    // The key's own name as its value (`password: "password"`), or a well-known weak literal that is
    // a test default rather than a credential.
    matches!(lower.as_str(), "password" | "secret" | "token" | "apikey" | "api_key" | "passw0rd" | "password123" | "null" | "none" | "undefined")
}

/// A literal that looks like a credential rather than a word, a sentence, a path or an i18n key.
fn looks_secret(value: &str) -> bool {
    let v = value.trim();
    if v.chars().count() < 8 || v.contains(char::is_whitespace) || is_placeholder(v) {
        return false;
    }
    // `auth.password.label`, `/api/token/refresh`: a key or a route, not a value.
    if v.chars().all(|c| c.is_ascii_lowercase() || c == '.' || c == '_' || c == '-' || c == '/') {
        return false;
    }
    let classes = [
        v.chars().any(|c| c.is_ascii_lowercase()),
        v.chars().any(|c| c.is_ascii_uppercase()),
        v.chars().any(|c| c.is_ascii_digit()),
        v.chars().any(|c| !c.is_ascii_alphanumeric()),
    ]
    .iter()
    .filter(|b| **b)
    .count();
    classes >= 2 && entropy(v) >= 3.0
}

/// The first characters of a value and nothing else.
fn mask(value: &str) -> String {
    let n = value.chars().count();
    let keep = if n > 12 { 4 } else if n > 6 { 2 } else { 0 };
    format!("{}…", value.chars().take(keep).collect::<String>())
}

fn long_run_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[A-Za-z0-9+/=_\-]{20,}").unwrap())
}

fn truncate(text: &str) -> String {
    if text.chars().count() <= SNIPPET_CHARS {
        return text.to_string();
    }
    format!("{}…", text.chars().take(SNIPPET_CHARS - 1).collect::<String>())
}

/// The line with the secret span masked — and, as a second net, every other long token-like run.
fn masked_snippet(line: &str, start: usize, end: usize) -> String {
    let masked = format!("{}{}{}", &line[..start], mask(&line[start..end]), &line[end..]);
    let masked = long_run_re().replace_all(&masked, |c: &regex::Captures| mask(&c[0])).to_string();
    truncate(masked.trim())
}

fn scan_secret(text: &str) -> Option<(&'static str, &'static str, String)> {
    for rule in secret_rules() {
        for caps in rule.re.captures_iter(text) {
            let Some(span) = caps.get(rule.group).or_else(|| caps.get(0)) else { continue };
            if rule.vetted && !looks_secret(span.as_str()) {
                continue;
            }
            if !rule.vetted && is_placeholder(span.as_str()) && rule.group != 0 {
                continue;
            }
            // A key block's header holds no secret (the key is on the lines after it): shown as is.
            let snippet = if rule.kind == "private-key" { truncate(text.trim()) } else { masked_snippet(text, span.start(), span.end()) };
            return Some((rule.kind, rule.reason, snippet));
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Committed .env files
// ---------------------------------------------------------------------------

/// `.env`, `.env.local`, `config/.env.production` — but not the templates that exist to be committed.
fn is_env_file(path: &str) -> bool {
    let name = path.rsplit('/').next().unwrap_or(path).to_lowercase();
    if name != ".env" && !name.starts_with(".env.") {
        return false;
    }
    const TEMPLATES: &[&str] = &["example", "sample", "template", "dist", "defaults", "schema", "tpl"];
    !name.split('.').skip(2).any(|part| TEMPLATES.contains(&part))
}

// ---------------------------------------------------------------------------
// Debug leftovers
// ---------------------------------------------------------------------------

fn test_path_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)(?:\.spec\.|\.test\.|(?:^|/)tests?/|__tests__/|__mocks__/|(?:^|/)test_[^/]*\.py$|_test\.(?:go|py|rs)$|(?:^|/)spec/|(?:^|/)e2e/|(?:^|/)cypress/)").unwrap()
    })
}

fn is_test_path(path: &str) -> bool {
    test_path_re().is_match(path)
}

fn extension(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.rsplit_once('.').map(|(_, e)| e.to_lowercase()).unwrap_or_default()
}

struct DebugRule {
    kind: &'static str,
    reason: &'static str,
    exts: &'static [&'static str],
    re: Regex,
}

const JS: &[&str] = &["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts", "vue", "svelte", "astro"];

fn debug_rules() -> &'static [DebugRule] {
    static RULES: OnceLock<Vec<DebugRule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let r = |kind, reason, exts, pattern: &str| DebugRule { kind, reason, exts, re: Regex::new(pattern).expect("debug pattern") };
        vec![
            r("console-log", "console.* olvidado", JS, r"\bconsole\.(?:log|debug|trace|dir)\s*\("),
            r("debugger", "sentencia debugger", JS, r"(?:^|[^\w.])debugger\s*;?\s*$"),
            r("print", "print() de depuración", &["py"], r"^\s*print\s*\("),
            r("breakpoint", "breakpoint de depuración", &["py"], r"\b(?:breakpoint\s*\(\s*\)|i?pdb\.set_trace\s*\()"),
            r("dbg", "dbg!() olvidado", &["rs"], r"\bdbg!\s*\("),
            r("println", "println!() de depuración", &["rs"], r"^\s*println!\s*\("),
            r("system-out", "System.out/err.println", &["java"], r"\bSystem\.(?:out|err)\.print(?:ln|f)?\s*\("),
            r("var-dump", "volcado de depuración (var_dump/dd/print_r)", &["php"], r"(?:^|[^\w>$:])(?:var_dump|dd|print_r)\s*\("),
        ]
    })
}

fn focused_test_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?:\b(?:describe|it|test|context|suite)\.only\s*\(|(?:^|[^\w.])f(?:it|describe)\s*\()").unwrap())
}

fn is_comment(text: &str) -> bool {
    let t = text.trim_start();
    t.starts_with("//") || t.starts_with('#') || t.starts_with("/*") || t.starts_with('*') || t.starts_with("<!--")
}

fn scan_debug(path: &str, text: &str) -> Option<(&'static str, &'static str)> {
    if is_comment(text) {
        return None;
    }
    let ext = extension(path);
    if is_test_path(path) {
        // In a test file a console.log is noise, but a focused test silently skips the whole suite.
        if JS.contains(&ext.as_str()) && focused_test_re().is_match(text) {
            return Some(("focused-test", "test enfocado (.only/fit): el resto de la suite no corre"));
        }
        return None;
    }
    if ext == "rs" && text.contains("\"cargo:") {
        return None; // a build script's instructions to cargo, printed on purpose
    }
    debug_rules()
        .iter()
        .find(|rule| rule.exts.contains(&ext.as_str()) && rule.re.is_match(text))
        .map(|rule| (rule.kind, rule.reason))
}

// ---------------------------------------------------------------------------
// New dependencies
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Manifest {
    PackageJson,
    Requirements,
    Pyproject,
    Pom,
    Csproj,
    Cargo,
    GoMod,
}

fn manifest_of(path: &str) -> Option<Manifest> {
    let name = path.rsplit('/').next().unwrap_or(path).to_lowercase();
    match name.as_str() {
        "package.json" => Some(Manifest::PackageJson),
        "pyproject.toml" => Some(Manifest::Pyproject),
        "pom.xml" => Some(Manifest::Pom),
        "cargo.toml" => Some(Manifest::Cargo),
        "go.mod" => Some(Manifest::GoMod),
        "directory.packages.props" => Some(Manifest::Csproj),
        _ if name.starts_with("requirements") && name.ends_with(".txt") => Some(Manifest::Requirements),
        _ if name.ends_with(".csproj") || name.ends_with(".fsproj") || name.ends_with(".vbproj") => Some(Manifest::Csproj),
        _ => None,
    }
}

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("manifest pattern"))
}

/// The lines of a `package.json` that sit inside one of its dependency objects.
fn package_json_dep_lines(content: &str) -> HashSet<usize> {
    static OPEN: OnceLock<Regex> = OnceLock::new();
    let open = re(&OPEN, r#"^\s*"(?:dependencies|devDependencies|peerDependencies|optionalDependencies)"\s*:\s*\{"#);
    let mut out = HashSet::new();
    let mut depth: Option<i32> = None;
    for (i, line) in content.lines().enumerate() {
        match depth {
            None => {
                if open.is_match(line) {
                    let d = line.matches('{').count() as i32 - line.matches('}').count() as i32;
                    if d > 0 {
                        depth = Some(d);
                    }
                }
            }
            Some(d) => {
                let next = d + line.matches('{').count() as i32 - line.matches('}').count() as i32;
                if next > 0 {
                    out.insert(i + 1);
                    depth = Some(next);
                } else {
                    // The closing line may still hold an entry (`"a": "1" }`).
                    out.insert(i + 1);
                    depth = None;
                }
            }
        }
    }
    out
}

/// The lines of a TOML manifest that declare a dependency: inside a `*dependencies` table, or in a
/// `dependencies = [ … ]` array (PEP 621's `[project]`, `optional-dependencies`, `dependency-groups`).
fn toml_dep_lines(content: &str) -> (HashSet<usize>, HashSet<usize>) {
    static HEADER: OnceLock<Regex> = OnceLock::new();
    static ARRAY: OnceLock<Regex> = OnceLock::new();
    let header = re(&HEADER, r"^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$");
    let array = re(&ARRAY, r"^\s*[A-Za-z0-9_.\-]+\s*=\s*\[");
    let mut table_lines = HashSet::new();
    let mut array_lines = HashSet::new();
    let mut table = String::new();
    let mut in_array = false;
    for (i, line) in content.lines().enumerate() {
        let n = i + 1;
        if let Some(caps) = header.captures(line) {
            table = caps[1].trim().to_string();
            in_array = false;
            // `[dependencies.serde]` declares a dependency with its header.
            if table.contains("dependencies.") {
                table_lines.insert(n);
            }
            continue;
        }
        let arrays_here = table == "project" && line.trim_start().starts_with("dependencies")
            || table == "project.optional-dependencies"
            || table == "dependency-groups";
        if in_array {
            array_lines.insert(n);
            if line.contains(']') {
                in_array = false;
            }
            continue;
        }
        if arrays_here && array.is_match(line) {
            array_lines.insert(n);
            in_array = !line.contains(']');
            continue;
        }
        if table.ends_with("dependencies") && !table.starts_with("project") && table != "dependency-groups" {
            table_lines.insert(n);
        }
    }
    (table_lines, array_lines)
}

/// The `(name, version)` a manifest line declares, if it declares one.
///
/// `context` is what the whole file says about where this line sits; `None` when the content is
/// unknown, and then only the unambiguous shapes count.
fn dependency_of(kind: Manifest, line_no: usize, text: &str, context: Option<&ManifestContext>) -> Option<(String, String)> {
    static PKG: OnceLock<Regex> = OnceLock::new();
    static REQ: OnceLock<Regex> = OnceLock::new();
    static PY_STR: OnceLock<Regex> = OnceLock::new();
    static TOML_KV: OnceLock<Regex> = OnceLock::new();
    static TOML_VER: OnceLock<Regex> = OnceLock::new();
    static TOML_HEADER_DEP: OnceLock<Regex> = OnceLock::new();
    static POM: OnceLock<Regex> = OnceLock::new();
    static CSPROJ: OnceLock<Regex> = OnceLock::new();
    static GOMOD: OnceLock<Regex> = OnceLock::new();
    match kind {
        Manifest::PackageJson => {
            let caps = re(&PKG, r#"^\s*"(@?[A-Za-z0-9_.\-]+(?:/[A-Za-z0-9_.\-]+)?)"\s*:\s*"([^"]*)""#).captures(text)?;
            let (name, spec) = (caps[1].to_string(), caps[2].to_string());
            match context.and_then(|c| c.package_json.as_ref()) {
                Some(lines) if !lines.contains(&line_no) => None,
                Some(_) => Some((name, spec)),
                None => {
                    const NOT_DEPS: &[&str] = &["version", "node", "npm", "pnpm", "yarn", "name", "main", "types", "module"];
                    let versionish = spec.trim_start_matches(['^', '~', '>', '<', '=', ' ']).starts_with(|c: char| c.is_ascii_digit());
                    (versionish && !NOT_DEPS.contains(&name.as_str())).then_some((name, spec))
                }
            }
        }
        Manifest::Requirements => {
            let t = text.trim();
            if t.is_empty() || t.starts_with('#') || t.starts_with('-') {
                return None;
            }
            let caps = re(&REQ, r"^([A-Za-z0-9][A-Za-z0-9_.\-]*(?:\[[^\]]*\])?)\s*(?:(?:===|==|>=|<=|~=|!=|<|>|@)\s*([^\s;#,]+))?").captures(t)?;
            Some((caps[1].to_string(), caps.get(2).map(|m| m.as_str().to_string()).unwrap_or_default()))
        }
        Manifest::Pyproject | Manifest::Cargo => {
            let string_entry = re(&PY_STR, r#"^\s*["']([A-Za-z0-9][A-Za-z0-9_.\-]*(?:\[[^\]]*\])?)\s*([<>=~!^][^"';]*)?[^"']*["']\s*,?\s*(?:#.*)?$"#);
            let kv = re(&TOML_KV, r#"^\s*([A-Za-z0-9_\-]+)\s*=\s*(.+?)\s*(?:#.*)?$"#);
            let header_dep = re(&TOML_HEADER_DEP, r"^\s*\[[^\]]*dependencies\.([A-Za-z0-9_\-]+)\s*\]");
            let version_of = |value: &str| -> String {
                let quoted = re(&TOML_VER, r#"(?:version\s*=\s*)?["']([^"']+)["']"#);
                quoted.captures(value).map(|c| c[1].to_string()).unwrap_or_default()
            };
            match context.and_then(|c| c.toml.as_ref()) {
                Some((tables, arrays)) => {
                    if arrays.contains(&line_no) {
                        let caps = string_entry.captures(text)?;
                        return Some((caps[1].to_string(), caps.get(2).map(|m| m.as_str().trim().to_string()).unwrap_or_default()));
                    }
                    if tables.contains(&line_no) {
                        if let Some(caps) = header_dep.captures(text) {
                            return Some((caps[1].to_string(), String::new()));
                        }
                        let caps = kv.captures(text)?;
                        let name = caps[1].to_string();
                        if name == "python" {
                            return None;
                        }
                        return Some((name, version_of(&caps[2])));
                    }
                    None
                }
                // Without the file, only a quoted requirement with a version operator is unambiguous.
                None if kind == Manifest::Pyproject => {
                    let caps = string_entry.captures(text)?;
                    caps.get(2).map(|v| (caps[1].to_string(), v.as_str().trim().to_string()))
                }
                None => None,
            }
        }
        Manifest::Pom => {
            let caps = re(&POM, r"<artifactId>\s*([^<\s]+)\s*</artifactId>").captures(text)?;
            let inside = context.and_then(|c| c.pom_dependency_lines.as_ref()).map(|lines| lines.contains(&line_no)).unwrap_or(false);
            inside.then(|| (caps[1].to_string(), String::new()))
        }
        Manifest::Csproj => {
            let caps = re(&CSPROJ, r#"<Package(?:Reference|Version)\s+(?:Include|Update)="([^"]+)"(?:\s+Version="([^"]+)")?"#).captures(text)?;
            Some((caps[1].to_string(), caps.get(2).map(|m| m.as_str().to_string()).unwrap_or_default()))
        }
        Manifest::GoMod => {
            let caps = re(&GOMOD, r"^\s*(?:require\s+)?([A-Za-z0-9][A-Za-z0-9.\-_~]*\.[A-Za-z]{2,}(?:/\S+)*)\s+(v\d\S*)(?:\s*//\s*indirect)?\s*$").captures(text)?;
            Some((caps[1].to_string(), caps[2].to_string()))
        }
    }
}

/// What a manifest's whole content says about where each of its lines sits.
#[derive(Default)]
struct ManifestContext {
    package_json: Option<HashSet<usize>>,
    toml: Option<(HashSet<usize>, HashSet<usize>)>,
    pom_dependency_lines: Option<HashSet<usize>>,
}

/// The lines of a `pom.xml` (or of its added lines, when that is all there is) that sit inside a
/// `<dependency>` element — not a plugin's, a parent's or an exclusion's `artifactId`.
fn pom_dependency_lines(lines: &[(usize, &str)]) -> HashSet<usize> {
    let mut out = HashSet::new();
    let mut inside = false;
    for (n, line) in lines {
        let t = line.trim();
        if t.contains("<dependency>") {
            inside = true;
        }
        if t.contains("<exclusion>") || t.contains("<plugin>") || t.contains("<parent>") || t.contains("<extension>") {
            inside = false;
        }
        if inside {
            out.insert(*n);
        }
        if t.contains("</dependency>") || t.contains("</exclusions>") {
            inside = t.contains("</exclusions>");
        }
    }
    out
}

fn manifest_context(kind: Manifest, file: &ScanFile) -> ManifestContext {
    let mut ctx = ManifestContext::default();
    match (kind, file.content.as_deref()) {
        (Manifest::PackageJson, Some(content)) => ctx.package_json = Some(package_json_dep_lines(content)),
        (Manifest::Pyproject | Manifest::Cargo, Some(content)) => ctx.toml = Some(toml_dep_lines(content)),
        (Manifest::Pom, Some(content)) => {
            let lines: Vec<(usize, &str)> = content.lines().enumerate().map(|(i, l)| (i + 1, l)).collect();
            ctx.pom_dependency_lines = Some(pom_dependency_lines(&lines));
        }
        (Manifest::Pom, None) => {
            let lines: Vec<(usize, &str)> = file.added.iter().map(|(n, l)| (*n, l.as_str())).collect();
            ctx.pom_dependency_lines = Some(pom_dependency_lines(&lines));
        }
        _ => {}
    }
    ctx
}

/// One hit per manifest: which packages it adds and which it only re-versions.
fn scan_manifest(kind: Manifest, file: &ScanFile) -> Option<Hit> {
    let ctx = manifest_context(kind, file);
    let has_ctx = file.content.is_some();
    let ctx_ref = (has_ctx || kind == Manifest::Pom).then_some(&ctx);
    // A removed line is read without context on purpose: it no longer has a place in the new file,
    // and all it has to answer is "was this package here before".
    let before: HashSet<String> = file
        .removed
        .iter()
        .filter_map(|line| dependency_of(kind, 0, line, None).or_else(|| loose_name(kind, line)))
        .map(|(name, _)| name.to_lowercase())
        .collect();
    let mut lines = Vec::new();
    let mut new_ones = Vec::new();
    let mut bumped = Vec::new();
    let mut seen = BTreeSet::new();
    for (n, text) in &file.added {
        let Some((name, version)) = dependency_of(kind, *n, text, ctx_ref) else { continue };
        if !seen.insert(name.to_lowercase()) {
            continue;
        }
        lines.push(*n);
        let label = if version.is_empty() { name.clone() } else { format!("{name} {version}") };
        if before.contains(&name.to_lowercase()) {
            bumped.push(label);
        } else {
            new_ones.push(label);
        }
    }
    if lines.is_empty() {
        return None;
    }
    let list = |items: &[String]| -> String {
        let shown = items.iter().take(DEP_SHOWN).cloned().collect::<Vec<_>>().join(", ");
        if items.len() > DEP_SHOWN {
            format!("{shown} (+{})", items.len() - DEP_SHOWN)
        } else {
            shown
        }
    };
    let mut parts = Vec::new();
    if !new_ones.is_empty() {
        parts.push(format!("nuevas: {}", list(&new_ones)));
    }
    if !bumped.is_empty() {
        parts.push(format!("cambian de versión: {}", list(&bumped)));
    }
    Some(Hit {
        file: file.path.clone(),
        line: lines[0],
        lines: if lines.len() > 1 { lines } else { Vec::new() },
        kind: "dependency".into(),
        category: CAT_DEPENDENCY.into(),
        snippet: truncate(&parts.join(" · ")),
        reason: format!("{} dependencia(s) nueva(s), {} con versión cambiada", new_ones.len(), bumped.len()),
    })
}

/// A dependency name read off a removed line whose context is gone (`"lodash": "^4"` was inside
/// `dependencies`, or a TOML `name = "1.0"`), so a bump is not mistaken for an addition.
fn loose_name(kind: Manifest, line: &str) -> Option<(String, String)> {
    static KV: OnceLock<Regex> = OnceLock::new();
    static PKG: OnceLock<Regex> = OnceLock::new();
    match kind {
        Manifest::Cargo | Manifest::Pyproject => {
            let caps = re(&KV, r#"^\s*([A-Za-z0-9_\-]+)\s*=\s*["'{]"#).captures(line)?;
            Some((caps[1].to_string(), String::new()))
        }
        Manifest::PackageJson => {
            let caps = re(&PKG, r#"^\s*"(@?[A-Za-z0-9_.\-]+(?:/[A-Za-z0-9_.\-]+)?)"\s*:\s*""#).captures(line)?;
            Some((caps[1].to_string(), String::new()))
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

fn family_rank(hit: &Hit) -> u8 {
    match hit.family() {
        "secret" => 0,
        "env" => 1,
        "dependency" => 2,
        _ => 3,
    }
}

/// Every pre-mark over the added lines, plus one per committed `.env` file — capped and ordered.
pub fn scan(files: &[ScanFile]) -> Vec<Hit> {
    let mut hits: Vec<Hit> = Vec::new();
    for file in files {
        if file.added_file && is_env_file(&file.path) {
            hits.push(Hit {
                file: file.path.clone(),
                line: 1,
                lines: Vec::new(),
                kind: "env".into(),
                category: CAT_SECRET.into(),
                snippet: "archivo .env agregado al repositorio".into(),
                reason: "un .env suele llevar credenciales reales y no debería versionarse".into(),
            });
        }
        let manifest = manifest_of(&file.path);
        for (n, text) in &file.added {
            if let Some((kind, reason, snippet)) = scan_secret(text) {
                hits.push(Hit {
                    file: file.path.clone(),
                    line: *n,
                    lines: Vec::new(),
                    kind: format!("secret:{kind}"),
                    category: CAT_SECRET.into(),
                    snippet,
                    reason: reason.into(),
                });
                continue;
            }
            if manifest.is_some() {
                continue;
            }
            if let Some((kind, reason)) = scan_debug(&file.path, text) {
                hits.push(Hit {
                    file: file.path.clone(),
                    line: *n,
                    lines: Vec::new(),
                    kind: format!("debug:{kind}"),
                    category: CAT_DEBUG.into(),
                    snippet: truncate(text.trim()),
                    reason: reason.into(),
                });
            }
        }
        if let Some(kind) = manifest {
            hits.extend(scan_manifest(kind, file));
        }
    }
    hits.sort_by(|a, b| family_rank(a).cmp(&family_rank(b)).then(a.file.cmp(&b.file)).then(a.line.cmp(&b.line)));
    hits.truncate(MAX_HITS);
    hits
}

/// What a confirmed hit should be reported as — guidance, not a rule: the reviewer has the code.
fn suggested(hit: &Hit) -> &'static str {
    match hit.family() {
        "secret" => "Blocker · Vulnerabilidad",
        "env" => "Crítico · Vulnerabilidad",
        "dependency" => "Menor · Security Hotspot",
        _ if hit.kind == "debug:focused-test" => "Mayor · Bug",
        _ => "Menor · Code Smell",
    }
}

/// The `#`-commented block for a bundle header, limited to the files that bundle reads (`None` =
/// every file); `None` when nothing applies, so a clean PR pays nothing for the feature.
pub fn block(hits: &[Hit], files: Option<&[String]>) -> Option<String> {
    let rows: Vec<&Hit> = hits
        .iter()
        .filter(|h| files.is_none_or(|fs| fs.iter().any(|f| crate::review::outline::same_path(f, &h.file))))
        .collect();
    if rows.is_empty() {
        return None;
    }
    let mut out = String::from(
        "#\n# --- PRE-SCAN determinista (pre-marcados: confírmalos y repórtalos; no gastes la lectura en volver a detectarlos) ---\n",
    );
    for h in &rows {
        let at = if h.lines.len() > 1 {
            let shown: Vec<String> = h.lines.iter().take(DEP_SHOWN).map(|n| n.to_string()).collect();
            let more = h.lines.len().saturating_sub(DEP_SHOWN);
            format!("{}{}", shown.join(","), if more > 0 { format!(" (+{more})") } else { String::new() })
        } else {
            h.line.to_string()
        };
        out.push_str(&format!(
            "#   {}:{}  {} → {}  \"{}\"  ({}; sugerido {})\n",
            h.file,
            at,
            h.kind,
            h.category,
            h.snippet,
            h.reason,
            suggested(h)
        ));
    }
    out.push_str(
        "#   Un pre-marcado que confirmas se reporta con confianza >= 90 y la categoría indicada. Si es una falsa\n\
         #   alarma (fixture de test, placeholder, ejemplo de documentación), no lo reportes y di en una línea por qué.\n",
    );
    if rows.iter().any(|h| h.family() == "secret" || h.family() == "env") {
        out.push_str(
            "#   Secretos: NUNCA copies el valor en el hallazgo (ni en la evidencia ni en el código sugerido). Como\n\
             #   evidencia cita solo el tramo de la línea anterior al valor (p. ej. `const apiKey =`); sugiere moverlo a un\n\
             #   secreto o variable de entorno y rotarlo: lo que llegó a un commit ya está expuesto.\n",
        );
    }
    if rows.iter().any(|h| h.family() == "dependency") {
        out.push_str(
            "#   Dependencias: UN hallazgo unreviewed-dependency por manifiesto; en el porqué nombra solo las riesgosas\n\
             #   (saltos de major, paquetes de runtime poco conocidos), no la lista entera.\n",
        );
    }
    Some(out)
}

/// The same hits as prose for the single-pass prompt of a review by link, which has no bundle header.
pub fn context_text(hits: &[Hit]) -> Option<String> {
    block(hits, None).map(|b| b.lines().map(|l| l.trim_start_matches('#').trim_start()).collect::<Vec<_>>().join("\n").trim().to_string())
}

/// `3 marca(s): 1 secreto, 2 debug` — the run log's and the report's line.
pub fn summary(hits: &[Hit]) -> String {
    let count = |family: &str| hits.iter().filter(|h| h.family() == family).count();
    let parts: Vec<String> = [("secret", "secreto(s)"), ("env", ".env"), ("dependency", "manifiesto(s) con dependencias"), ("debug", "resto(s) de debug")]
        .iter()
        .filter_map(|(family, label)| {
            let n = count(family);
            (n > 0).then(|| format!("{n} {label}"))
        })
        .collect();
    if parts.is_empty() {
        "sin marcas".to_string()
    } else {
        format!("{} marca(s): {}", hits.len(), parts.join(", "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, added: &[(usize, &str)]) -> ScanFile {
        ScanFile {
            path: path.into(),
            added: added.iter().map(|(n, t)| (*n, t.to_string())).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn secrets_are_found_and_never_leak_their_value() {
        let aws = "AKIAIOSFODNN7EXAMPL3";
        let files = vec![file(
            "src/config.ts",
            &[
                (3, &format!("const key = \"{aws}\";")),
                (4, "-----BEGIN RSA PRIVATE KEY-----"),
                (5, "const token = \"ghp_abcdefghijklmnopqrstuvwxyz0123456789\";"),
                (6, "const db = \"Server=x;Database=y;User Id=sa;Password=Sup3r$ecretPw;\";"),
                (7, "const url = \"postgres://admin:Xk9pLm2Qz@db.internal:5432/app\";"),
                (8, "const apiKey = \"q8Zr2LkP0vXa7MnB\";"),
            ],
        )];
        let hits = scan(&files);
        let kinds: Vec<&str> = hits.iter().map(|h| h.kind.as_str()).collect();
        assert_eq!(
            kinds,
            ["secret:aws-access-key", "secret:private-key", "secret:github-token", "secret:connection-string", "secret:url-credentials", "secret:assignment"]
        );
        for hit in &hits {
            assert_eq!(hit.category, CAT_SECRET);
            for value in [aws, "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "Sup3r$ecretPw", "Xk9pLm2Qz", "q8Zr2LkP0vXa7MnB"] {
                assert!(!hit.snippet.contains(value), "{} leaked {value}", hit.snippet);
            }
        }
        let block = block(&hits, None).unwrap();
        assert!(!block.contains(aws) && !block.contains("q8Zr2LkP0vXa7MnB"));
        assert!(block.contains("NUNCA copies el valor"));
    }

    #[test]
    fn placeholders_and_env_lookups_are_not_secrets() {
        let files = vec![file(
            "src/config.py",
            &[
                (1, "password = os.environ[\"DB_PASSWORD\"]"),
                (2, "api_key = \"${API_KEY}\""),
                (3, "secret = \"your-secret-here\""),
                (4, "token: \"changeme\""),
                (5, "PASSWORD_LABEL = \"auth.password.label\""),
                (6, "url = \"postgres://user:${PASSWORD}@host/db\""),
                (7, "error = \"Invalid password for this user\""),
                (8, "conn = \"Server=x;Password={0};\""),
            ],
        )];
        assert!(scan(&files).is_empty(), "{:?}", scan(&files));
    }

    #[test]
    fn debug_leftovers_respect_language_and_tests() {
        let files = vec![
            file("src/app.ts", &[(1, "console.log('here', user);"), (2, "  debugger;"), (3, "// console.log('commented')")]),
            file("src/app.test.ts", &[(1, "console.log('fine in a test')"), (2, "it.only('runs alone', () => {")]),
            file("tool/main.py", &[(4, "print(result)"), (5, "breakpoint()")]),
            file("src/lib.rs", &[(9, "    dbg!(&value);")]),
            file("build.rs", &[(2, "    println!(\"cargo:rerun-if-changed=x\");")]),
            file("App.java", &[(7, "System.out.println(\"x\");")]),
            file("index.php", &[(3, "dd($request);")]),
            file("README.md", &[(1, "console.log('docs')")]),
        ];
        let hits = scan(&files);
        let got: Vec<(String, usize, String)> = hits.iter().map(|h| (h.file.clone(), h.line, h.kind.clone())).collect();
        assert_eq!(
            got,
            vec![
                ("App.java".to_string(), 7, "debug:system-out".to_string()),
                ("index.php".into(), 3, "debug:var-dump".into()),
                ("src/app.test.ts".into(), 2, "debug:focused-test".into()),
                ("src/app.ts".into(), 1, "debug:console-log".into()),
                ("src/app.ts".into(), 2, "debug:debugger".into()),
                ("src/lib.rs".into(), 9, "debug:dbg".into()),
                ("tool/main.py".into(), 4, "debug:print".into()),
                ("tool/main.py".into(), 5, "debug:breakpoint".into()),
            ]
        );
        assert!(hits.iter().all(|h| h.category == CAT_DEBUG));
    }

    #[test]
    fn env_files_are_flagged_but_templates_are_not() {
        let mut env = file(".env", &[(1, "DEBUG=1")]);
        env.added_file = true;
        let mut local = file("app/.env.production", &[]);
        local.added_file = true;
        let mut example = file(".env.example", &[(1, "API_KEY=")]);
        example.added_file = true;
        let modified = file(".env.local", &[(1, "X=1")]);
        let hits = scan(&[env, local, example, modified]);
        let files: Vec<&str> = hits.iter().map(|h| h.file.as_str()).collect();
        assert_eq!(files, [".env", "app/.env.production"]);
        assert!(hits.iter().all(|h| h.kind == "env" && h.category == CAT_SECRET));
    }

    #[test]
    fn package_json_groups_into_one_hit_and_tells_new_from_bumped() {
        let content = "{\n  \"name\": \"app\",\n  \"version\": \"1.0.0\",\n  \"scripts\": {\n    \"build\": \"tsc\"\n  },\n  \"engines\": {\n    \"node\": \">=20\"\n  },\n  \"dependencies\": {\n    \"lodash\": \"^4.17.21\",\n    \"left-pad\": \"1.3.0\"\n  }\n}\n";
        let mut pkg = file(
            "package.json",
            &[(3, "  \"version\": \"1.0.0\","), (8, "    \"node\": \">=20\""), (11, "    \"lodash\": \"^4.17.21\","), (12, "    \"left-pad\": \"1.3.0\"")],
        );
        pkg.removed = vec!["    \"lodash\": \"^4.17.20\",".into()];
        pkg.content = Some(content.into());
        let hits = scan(&[pkg]);
        assert_eq!(hits.len(), 1);
        let hit = &hits[0];
        assert_eq!((hit.kind.as_str(), hit.category.as_str(), hit.line), ("dependency", CAT_DEPENDENCY, 11));
        assert_eq!(hit.lines, vec![11, 12]);
        assert_eq!(hit.snippet, "nuevas: left-pad 1.3.0 · cambian de versión: lodash ^4.17.21");
    }

    #[test]
    fn manifests_of_every_ecosystem() {
        let cargo = ScanFile {
            path: "Cargo.toml".into(),
            added: vec![(2, "name = \"x\"".into()), (5, "serde = { version = \"1\", features = [\"derive\"] }".into())],
            content: Some("[package]\nname = \"x\"\n\n[dependencies]\nserde = { version = \"1\", features = [\"derive\"] }\n".into()),
            ..Default::default()
        };
        let req = file("requirements-dev.txt", &[(1, "requests==2.31.0"), (2, "# comment"), (3, "-r base.txt")]);
        let gomod = file("go.mod", &[(1, "module example.com/app"), (5, "\tgithub.com/pkg/errors v0.9.1")]);
        let csproj = file("src/Api.csproj", &[(9, "<PackageReference Include=\"Newtonsoft.Json\" Version=\"13.0.3\" />")]);
        let pom = file("pom.xml", &[(20, "<dependency>"), (21, "  <groupId>org.x</groupId>"), (22, "  <artifactId>lib</artifactId>"), (23, "</dependency>")]);
        let py = file("pyproject.toml", &[(8, "  \"httpx>=0.27\",")]);
        let hits = scan(&[cargo, req, gomod, csproj, pom, py]);
        let got: Vec<(String, String)> = hits.iter().map(|h| (h.file.clone(), h.snippet.clone())).collect();
        assert_eq!(
            got,
            vec![
                ("Cargo.toml".to_string(), "nuevas: serde 1".to_string()),
                ("go.mod".into(), "nuevas: github.com/pkg/errors v0.9.1".into()),
                ("pom.xml".into(), "nuevas: lib".into()),
                ("pyproject.toml".into(), "nuevas: httpx >=0.27".into()),
                ("requirements-dev.txt".into(), "nuevas: requests 2.31.0".into()),
                ("src/Api.csproj".into(), "nuevas: Newtonsoft.Json 13.0.3".into()),
            ]
        );
    }

    #[test]
    fn capped_and_ordered_by_priority() {
        let mut lines: Vec<(usize, String)> = (1..=40).map(|n| (n, format!("console.log({n});"))).collect();
        lines.push((41, "const k = \"AKIAIOSFODNN7EXAMPL3\";".into()));
        let f = ScanFile { path: "a.js".into(), added: lines, ..Default::default() };
        let hits = scan(&[f]);
        assert_eq!(hits.len(), MAX_HITS);
        assert_eq!(hits[0].kind, "secret:aws-access-key");
    }

    #[test]
    fn unified_diffs_from_every_host_shape() {
        let diff = "diff --git a/src/a.ts b/src/a.ts\n\
index 1..2 100644\n\
--- a/src/a.ts\n\
+++ b/src/a.ts\n\
@@ -1,3 +1,4 @@\n\
 const a = 1;\n\
-const b = 2;\n\
+const b = 3;\n\
+++ counter;\n\
 export {};\n\
diff --git a/.env b/.env\n\
new file mode 100644\n\
--- /dev/null\n\
+++ b/.env\n\
@@ -0,0 +1 @@\n\
+X=1\n\
diff --git a/gone.ts b/gone.ts\n\
deleted file mode 100644\n\
--- a/gone.ts\n\
+++ /dev/null\n\
@@ -1 +0,0 @@\n\
-x\n\
diff --git a/new.ts b/new.ts\n\
--- a/new.ts\n\
+++ b/new.ts\n\
@@ -0,0 +1,2 @@\n\
+one\n\
+two\n";
        let files = from_unified(diff);
        let summary: Vec<(String, bool, Vec<usize>)> =
            files.iter().map(|f| (f.path.clone(), f.added_file, f.added.iter().map(|(n, _)| *n).collect())).collect();
        assert_eq!(
            summary,
            vec![
                ("src/a.ts".to_string(), false, vec![2, 3]),
                (".env".into(), true, vec![1]),
                ("new.ts".into(), true, vec![1, 2]),
            ]
        );
        assert_eq!(files[0].added[1].1, "++ counter;");
        assert_eq!(files[0].removed, vec!["const b = 2;".to_string()]);
    }

    #[test]
    fn the_block_is_scoped_to_its_group() {
        let hits = scan(&[file("a.js", &[(1, "console.log(1)")]), file("b.js", &[(1, "debugger;")])]);
        let only_b = block(&hits, Some(&["b.js".to_string()])).unwrap();
        assert!(only_b.contains("b.js:1") && !only_b.contains("a.js"));
        assert!(block(&hits, Some(&["c.js".to_string()])).is_none());
        assert_eq!(summary(&hits), "2 marca(s): 2 resto(s) de debug");
    }
}
