//! Which symbols a changed file declares, and which of their lines the pull request touched.
//!
//! This is the input everything downstream is built on: the reading bundles open a symbol by its
//! **whole range** rather than by the diff's three lines of context (a one-line change can hide a
//! precedence or a semantics bug that is only visible with the method around it), the plan weighs a
//! file by the symbols it actually has to read, and the blast radius matches touched symbols against
//! the rest of the repository by name.
//!
//! **Regex over the declaration line, not a parse.** The goal is navigation, not a syntax tree: a
//! little over- and under-matching is the price of covering every language the app opens with one
//! mechanism and no per-language toolchain. A file whose extension has no patterns is not an error —
//! it simply has no symbols, and [`super::bundle`] falls back to "the whole file if it is short,
//! otherwise the changed zones with wide context", which is what a human does with a `.json` too.

use std::collections::BTreeSet;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::git::diff::FileDiffInfo;

/// One declaration and the range it owns, from its own line to the line before the next
/// declaration. Deliberately not the *syntactic* end of the block: finding that needs a parser,
/// while this over-approximates in the one direction that is safe — the model is shown the trailing
/// lines of a method rather than being cut off mid-way through it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Symbol {
    /// 1-based, inclusive.
    pub start: usize,
    /// 1-based, inclusive.
    pub end: usize,
    /// The declaration line, trimmed — `async function pagar(dto: PagoDto)`.
    pub label: String,
}

/// A file this pull request changed, with everything the pipeline needs to read it.
#[derive(Debug, Clone)]
pub struct ChangedFile {
    /// Repository-relative, forward slashes, no leading separator.
    pub path: String,
    /// `added` · `modified` · `renamed` · `deleted` … as git reports it.
    pub status: String,
    /// The file's full content on the pull request's side. Empty for a deletion, which is why
    /// nothing downstream may assume it is non-empty.
    pub content: String,
    /// Total lines in `content`.
    pub lines: usize,
    /// 1-based line numbers the pull request added or modified, on the new side. Its length is the
    /// file's additions, which is why there is no separate counter for them.
    pub changed: BTreeSet<usize>,
    /// Lines the pull request removed. Kept beside `changed` so a review's "scope analysed" line is
    /// counted from exactly the files that were reviewed, never from the branch.
    pub deletions: usize,
    /// The declarations that contain at least one changed line.
    pub symbols: Vec<Symbol>,
}

impl ChangedFile {
    /// The cost of reviewing this file, in lines the worker will actually read.
    ///
    /// With symbols that is the sum of their ranges; without them the file is read whole, so it
    /// weighs what it measures. Used only to balance the worker groups, so being approximate is
    /// the point — it beats splitting alphabetically when one file weighs ten times the rest.
    pub fn weight(&self) -> usize {
        if self.symbols.is_empty() {
            return self.lines.max(1);
        }
        self.symbols.iter().map(|s| s.end.saturating_sub(s.start) + 1).sum()
    }

    /// Whether there is any point handing this file to a worker: a deletion has no new side to
    /// read, and a file whose content could not be read has nothing to show.
    pub fn is_readable(&self) -> bool {
        !self.content.is_empty() && !self.status.eq_ignore_ascii_case("deleted")
    }
}

/// The longest a declaration label may be before it is elided — the label is a signpost in a
/// bundle header, not the declaration's documentation.
const MAX_LABEL_CHARS: usize = 70;

/// Words that open a block and look exactly like a call, which is what the "class method" patterns
/// match. Excluded in code rather than in the pattern because Rust's `regex` has no lookahead, and
/// because the list reads better here than escaped into an alternation.
///
/// Only genuine control flow belongs here. `function` conspicuously does not: `function real(a) {`
/// *is* a declaration, and listing it here silently deleted every top-level function in a
/// JavaScript file from its own outline.
const BLOCK_KEYWORDS: [&str; 14] = [
    "if", "for", "foreach", "while", "switch", "catch", "do", "else", "try", "using", "lock",
    "return", "when", "guard",
];

fn compile(patterns: &[&str]) -> Vec<Regex> {
    patterns.iter().filter_map(|p| Regex::new(p).ok()).collect()
}

/// TypeScript / JavaScript and the frameworks that embed them.
fn ts_js() -> &'static Vec<Regex> {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        compile(&[
            r"^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+\w+",
            r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+\w+",
            r"^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|\w+\s*=>)",
            r"^\s*(?:export\s+)?(?:type|interface|enum)\s+\w+",
            // A class method: `name(args) {`. The keyword exclusion happens in `is_declaration`.
            r"^\s+(?:(?:public|private|protected|static|async|readonly|get|set|override)\s+|\*\s*)*\w+\s*\([^;]*\)\s*(?::[^{]+)?\{",
        ])
    })
}

fn c_sharp() -> &'static Vec<Regex> {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        compile(&[
            r"^\s*(?:(?:public|private|protected|internal|static|abstract|sealed|partial)\s+)*(?:class|interface|struct|enum|record)\s+\w+",
            r"^\s+(?:(?:public|private|protected|internal|static|virtual|override|abstract|async|sealed|extern|unsafe|new)\s+)+[\w<>\[\],\.\s]+\s+\w+\s*\([^;]*\)\s*(?:\{|=>)?\s*$",
        ])
    })
}

fn java_like() -> &'static Vec<Regex> {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        compile(&[
            r"^\s*(?:(?:public|private|protected|static|abstract|final|open|data|sealed)\s+)*(?:class|interface|enum|record|object)\s+\w+",
            r"^\s+(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|override|suspend)\s+)+[\w<>\[\],\.\s\?]+\s+\w+\s*\([^;]*\)\s*(?:throws\s+[\w.,\s]+)?\s*(?:\{|=>)?\s*$",
            // Kotlin/Swift-style `fun name(` / `func name(`.
            r"^\s*(?:(?:public|private|internal|open|override|suspend|static|final|class)\s+)*(?:fun|func)\s+\w+",
        ])
    })
}

fn go_lang() -> &'static Vec<Regex> {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        compile(&[r"^\s*func\s+(?:\([^)]*\)\s*)?\w+", r"^\s*type\s+\w+\s+(?:struct|interface)\b"])
    })
}

fn rust_lang() -> &'static Vec<Regex> {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        compile(&[
            r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+\x22[^\x22]*\x22\s+)?fn\s+\w+",
            r"^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union|type)\s+\w+",
            r"^\s*(?:unsafe\s+)?impl(?:<[^>]*>)?\s+",
            r"^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+",
            r"^\s*macro_rules!\s+\w+",
        ])
    })
}

fn python_lang() -> &'static Vec<Regex> {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| compile(&[r"^\s*(?:async\s+)?def\s+\w+", r"^\s*class\s+\w+"]))
}

fn ruby_lang() -> &'static Vec<Regex> {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| compile(&[r"^\s*(?:def|class|module)\s+[\w.:]+"]))
}

fn php_lang() -> &'static Vec<Regex> {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        compile(&[
            r"^\s*(?:(?:abstract|final)\s+)*(?:class|interface|trait|enum)\s+\w+",
            r"^\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+\w+",
        ])
    })
}

fn sql_lang() -> &'static Vec<Regex> {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        compile(&[
            r"(?i)^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:PROCEDURE|FUNCTION|TABLE|VIEW|TRIGGER|INDEX)\s+[\w.\[\]\x22`]+",
            r"(?i)^\s*ALTER\s+TABLE\s+[\w.\[\]\x22`]+",
        ])
    })
}

fn shell_lang() -> &'static Vec<Regex> {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| compile(&[r"^\s*function\s+[\w-]+", r"^\s*[\w-]+\s*\(\s*\)\s*\{?"]))
}

fn powershell_lang() -> &'static Vec<Regex> {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| compile(&[r"(?i)^\s*function\s+[\w-]+", r"(?i)^\s*(?:class|enum)\s+\w+"]))
}

/// InterSystems ObjectScript — the app already ships an IRIS client, so its `.cls` files are code
/// somebody here reviews.
fn objectscript() -> &'static Vec<Regex> {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        compile(&[
            r"(?i)^\s*(?:Class|ClassMethod|Method|Property|Parameter|Index|XData|Query|Trigger|ForeignKey|Relationship)\s+",
        ])
    })
}

fn c_family() -> &'static Vec<Regex> {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        compile(&[
            r"^\s*(?:(?:static|inline|extern|const|virtual|explicit)\s+)*(?:struct|class|enum|union|namespace)\s+\w+",
            r"^[\w][\w\s\*&:<>,]*\s+[\*&]?\w+\s*\([^;]*\)\s*(?:const)?\s*\{?\s*$",
        ])
    })
}

/// The declaration patterns for a path's extension, or `None` when the extension has no symbols
/// worth naming (`.json`, `.md`, `.yaml`, an image…).
fn patterns_for(path: &str) -> Option<&'static Vec<Regex>> {
    let ext = path.rsplit_once('.').map(|(_, e)| e.to_lowercase())?;
    Some(match ext.as_str() {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "mts" | "cts" | "vue" | "svelte" => ts_js(),
        "cs" => c_sharp(),
        "java" | "kt" | "kts" | "scala" | "swift" | "dart" | "groovy" => java_like(),
        "go" => go_lang(),
        "rs" => rust_lang(),
        "py" | "pyi" => python_lang(),
        "rb" => ruby_lang(),
        "php" => php_lang(),
        "sql" | "pks" | "pkb" => sql_lang(),
        "sh" | "bash" | "zsh" => shell_lang(),
        "ps1" | "psm1" => powershell_lang(),
        "cls" | "mac" | "int" | "inc" => objectscript(),
        "c" | "h" | "cpp" | "hpp" | "cc" | "hh" | "cxx" | "m" | "mm" => c_family(),
        _ => return None,
    })
}

/// Whether a line opens a declaration rather than a control-flow block that merely looks like one.
///
/// `if (x) {` matches the "class method" shape in every C-like language, and a file full of them
/// would be carved into one "symbol" per branch. The keyword check is what the equivalent pattern
/// does with a negative lookahead in languages whose regex engine has one; Rust's does not.
fn is_declaration(line: &str, patterns: &[Regex]) -> bool {
    if !patterns.iter().any(|p| p.is_match(line)) {
        return false;
    }
    let first = line
        .trim_start()
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .find(|w| !w.is_empty())
        .unwrap_or("");
    !BLOCK_KEYWORDS.contains(&first)
}

/// Trims a declaration line down to the label a bundle header carries.
fn label_of(line: &str) -> String {
    let trimmed = line.trim().trim_end_matches(['{', ':']).trim();
    if trimmed.chars().count() <= MAX_LABEL_CHARS {
        return trimmed.to_string();
    }
    let cut: String = trimmed.chars().take(MAX_LABEL_CHARS - 1).collect();
    format!("{cut}…")
}

/// Every declaration in a file, with the range each one owns.
///
/// Kept apart from [`symbols_for`] because the blast radius needs the *whole* picture of a file it
/// is only scanning for callers — it has no diff for it, so it has no changed set to narrow by.
pub fn declarations(path: &str, content: &str) -> Vec<Symbol> {
    let Some(patterns) = patterns_for(path) else { return Vec::new() };
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len();

    let decls: Vec<(usize, &str)> = lines
        .iter()
        .enumerate()
        .filter(|(_, line)| is_declaration(line, patterns))
        .map(|(i, line)| (i + 1, *line))
        .collect();

    decls
        .iter()
        .enumerate()
        .filter_map(|(k, (start, text))| {
            let end = decls.get(k + 1).map(|(next, _)| next.saturating_sub(1)).unwrap_or(total);
            (end >= *start).then(|| Symbol { start: *start, end, label: label_of(text) })
        })
        .collect()
}

/// The declarations of `content` that contain at least one of `changed`.
///
/// Filtering by the changed set here rather than downstream is what keeps a 3000-line file with two
/// touched methods from putting all forty of its symbols into a bundle.
pub fn symbols_for(path: &str, content: &str, changed: &BTreeSet<usize>) -> Vec<Symbol> {
    if changed.is_empty() {
        return Vec::new();
    }
    declarations(path, content)
        .into_iter()
        .filter(|s| changed.iter().any(|ln| (s.start..=s.end).contains(ln)))
        .collect()
}

/// The bare identifier a declaration declares — `async function pagar(dto)` → `pagar`,
/// `class PagoRepository` → `PagoRepository`.
///
/// Best-effort: a label nothing matches is skipped rather than guessed at, because the only
/// consumer is the blast radius, where a wrong name would report callers of something else.
pub fn symbol_name(label: &str) -> Option<String> {
    static KEYWORD: OnceLock<Regex> = OnceLock::new();
    static CALL: OnceLock<Regex> = OnceLock::new();
    let keyword = KEYWORD.get_or_init(|| {
        Regex::new(r"\b(?:class|interface|struct|enum|trait|record|type|module|namespace|ClassMethod|Method|Property)\s+([A-Za-z_][A-Za-z0-9_]*)")
            .expect("valid keyword regex")
    });
    let call = CALL
        .get_or_init(|| Regex::new(r"([A-Za-z_][A-Za-z0-9_]*)\s*\(").expect("valid call regex"));

    if let Some(caps) = keyword.captures(label) {
        return caps.get(1).map(|m| m.as_str().to_string());
    }
    if let Some(caps) = call.captures(label) {
        return caps.get(1).map(|m| m.as_str().to_string());
    }
    // A declaration with neither — `pub fn` without parens on the line, `const x =` — falls back to
    // the last identifier before any punctuation.
    label
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .filter(|w| !w.is_empty())
        .next_back()
        .map(str::to_string)
}

/// The 1-based line numbers a diff adds or modifies on the **new** side.
///
/// Straight out of git's own line origins, which is why there is no textual re-diffing anywhere in
/// this module: `libgit2` already decided what changed, and asking a second algorithm the same
/// question is how the marked lines and the reviewed lines drift apart.
pub fn changed_lines(file: &FileDiffInfo) -> BTreeSet<usize> {
    file.hunks
        .iter()
        .flat_map(|h| h.lines.iter())
        .filter(|l| l.origin == "+")
        .filter_map(|l| l.new_lineno.map(|n| n as usize))
        .collect()
}

/// Normalises a path to the one spelling the whole pipeline compares on: forward slashes, no
/// leading separator. Windows reports `src\app\foo.ts`, the model writes `src/app/foo.ts`, and the
/// hosts hand out `/src/app/foo.ts`.
pub fn normalize_path(path: &str) -> String {
    path.replace('\\', "/").trim_start_matches('/').to_string()
}

/// Whether two paths name the same file, tolerating the prefix differences above.
pub fn same_path(a: &str, b: &str) -> bool {
    let (a, b) = (normalize_path(a).to_lowercase(), normalize_path(b).to_lowercase());
    a == b || a.ends_with(&b) || b.ends_with(&a)
}

/// Builds the outline of a whole pull request: one [`ChangedFile`] per file in the diff, with its
/// new-side content read from `head_ref` and its touched symbols resolved.
///
/// A file whose content cannot be read (a deletion, a binary blob, a ref that no longer resolves)
/// still comes back — with empty content and no symbols — so the caller can count it in the scope
/// and say so, rather than quietly reviewing fewer files than it reports.
pub fn build(repo_path: &str, head_ref: &str, files: &[FileDiffInfo]) -> Vec<ChangedFile> {
    let mut out = Vec::with_capacity(files.len());
    for file in files {
        let Some(path) = file.new_path.as_deref().or(file.old_path.as_deref()) else { continue };
        let path = normalize_path(path);
        let changed = changed_lines(file);
        let content = if file.status.eq_ignore_ascii_case("deleted") {
            String::new()
        } else {
            crate::git::diff::file_at_ref(repo_path, head_ref, &path).unwrap_or_default()
        };
        let symbols = symbols_for(&path, &content, &changed);
        let deletions = file
            .hunks
            .iter()
            .flat_map(|h| h.lines.iter())
            .filter(|l| l.origin == "-")
            .count();
        out.push(ChangedFile {
            path,
            status: file.status.clone(),
            lines: content.lines().count(),
            content,
            changed,
            deletions,
            symbols,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn changed(lines: &[usize]) -> BTreeSet<usize> {
        lines.iter().copied().collect()
    }

    const TS: &str = "\
import { a } from './a';

export function pagar(dto: PagoDto) {
  const cuenta = buscar(dto.id);
  return cuenta.saldo;
}

export class PagoRepository {
  guardar(pago: Pago) {
    return this.db.save(pago);
  }
}
";

    #[test]
    fn a_touched_function_yields_its_whole_range() {
        let syms = symbols_for("src/pago.ts", TS, &changed(&[5]));
        assert_eq!(syms.len(), 1, "only the symbol containing line 5");
        assert_eq!(syms[0].start, 3);
        assert!(syms[0].label.starts_with("export function pagar"));
        // The range runs to the line before the next declaration, so the method arrives whole.
        assert!(syms[0].end >= 5);
    }

    #[test]
    fn an_untouched_file_has_no_symbols() {
        assert!(symbols_for("src/pago.ts", TS, &BTreeSet::new()).is_empty());
    }

    #[test]
    fn a_class_and_its_method_are_both_declarations() {
        let syms = symbols_for("src/pago.ts", TS, &changed(&[10]));
        assert!(!syms.is_empty());
        assert!(syms.iter().any(|s| s.label.contains("guardar")), "the method is its own symbol");
    }

    /// The reason `is_declaration` exists: without the keyword check, every `if (…) {` in a C-like
    /// file becomes a symbol boundary and the ranges stop meaning anything.
    #[test]
    fn control_flow_blocks_are_not_declarations() {
        let src = "\
function real(a) {
  if (a > 1) {
    return 2;
  }
  for (const x of a) {
    doThing(x);
  }
}
";
        let syms = symbols_for("a.js", src, &changed(&[3, 6]));
        assert_eq!(syms.len(), 1, "only `real` is a declaration");
        assert!(syms[0].label.starts_with("function real"));
    }

    #[test]
    fn a_file_type_with_no_symbols_is_not_an_error() {
        assert!(symbols_for("package.json", "{\n  \"a\": 1\n}", &changed(&[2])).is_empty());
        assert!(symbols_for("README", "hello", &changed(&[1])).is_empty());
    }

    #[test]
    fn several_languages_resolve_their_own_declarations() {
        let rs = "pub fn alpha() {\n    let x = 1;\n}\n";
        assert_eq!(symbols_for("a.rs", rs, &changed(&[2])).len(), 1);

        let py = "class Foo:\n    def bar(self):\n        return 1\n";
        assert!(!symbols_for("a.py", py, &changed(&[3])).is_empty());

        let go = "func Alpha() int {\n\treturn 1\n}\n";
        assert_eq!(symbols_for("a.go", go, &changed(&[2])).len(), 1);

        let cls = "Class Pkg.Name Extends %Persistent\n{\nClassMethod Do() As %Status\n{\n quit 1\n}\n}\n";
        assert!(!symbols_for("a.cls", cls, &changed(&[5])).is_empty());
    }

    #[test]
    fn a_long_declaration_is_elided_rather_than_carried_whole() {
        let long = format!("export function {}(a) {{", "x".repeat(120));
        let syms = symbols_for("a.ts", &format!("{long}\n  return a;\n}}\n"), &changed(&[2]));
        assert_eq!(syms.len(), 1);
        assert!(syms[0].label.chars().count() <= MAX_LABEL_CHARS);
        assert!(syms[0].label.ends_with('…'));
    }

    #[test]
    fn weight_is_the_lines_a_worker_actually_reads() {
        let file = ChangedFile {
            path: "a.ts".into(),
            status: "modified".into(),
            content: TS.into(),
            lines: TS.lines().count(),
            changed: changed(&[5]),
            deletions: 0,
            symbols: vec![Symbol { start: 3, end: 6, label: "f".into() }],
        };
        assert_eq!(file.weight(), 4, "the symbol's range, not the file's size");

        // With no symbols the file is read whole, so it weighs what it measures.
        let plain = ChangedFile { symbols: vec![], ..file };
        assert_eq!(plain.weight(), plain.lines);
    }

    #[test]
    fn paths_compare_across_the_spellings_the_hosts_and_the_model_use() {
        assert_eq!(normalize_path("\\src\\app\\foo.ts"), "src/app/foo.ts");
        assert!(same_path("/src/app/foo.ts", "src/app/foo.ts"));
        assert!(same_path("app/foo.ts", "src/app/foo.ts"));
        assert!(!same_path("src/app/foo.ts", "src/app/bar.ts"));
    }
}
