//! Whether a change got its checks green by weakening them instead of by working.
//!
//! The commonest way an agent "fixes" a failing suite is to make it test less: delete the test,
//! mark it `.skip`, focus another with `.only` so the rest never run, silence the linter with
//! `@ts-ignore`, or rewrite the `test` script itself. Every one of those passes the check, and the
//! comparison with the base cannot see it either — fewer tests failing is exactly what it reads as
//! fixed. This reads the diff for those moves.
//!
//! It never decides alone: a task may well have been to delete a feature with its tests. What it
//! finds goes to the user as a gate (approve, or reject the task), never back to the member as a
//! failure — a member told to restore tests the task asked it to remove would spend every attempt
//! it has on an order it cannot follow.
//!
//! Plain text matching, no parser: it looks at the lines the diff adds and removes, in the file
//! types each rule belongs to, and only counts what a line *starts* with or a marker bounded on its
//! left — `profit(` is not `fit(`, `re.test(s)` is not a test, `iter.skip(2)` in Rust is not a skip.

use std::collections::BTreeMap;

/// What one rule found in one file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub file: String,
    pub text: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Lang {
    Js,
    Rust,
    Go,
    Python,
    Jvm,
    Ruby,
    CSharp,
    Other,
}

fn lang_of(path: &str) -> Lang {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" | "mts" | "cts" | "vue" | "svelte" => Lang::Js,
        "rs" => Lang::Rust,
        "go" => Lang::Go,
        "py" => Lang::Python,
        "java" | "kt" | "kts" | "scala" => Lang::Jvm,
        "rb" => Lang::Ruby,
        "cs" => Lang::CSharp,
        _ => Lang::Other,
    }
}

/// Whether `path` holds tests. Rust keeps its unit tests inside the source (`#[cfg(test)]`), so every
/// `.rs` counts — its markers (`#[test]`, `#[ignore]`) mean nothing else.
pub fn is_test_path(path: &str) -> bool {
    let lower = path.replace('\\', "/").to_ascii_lowercase();
    if lang_of(&lower) == Lang::Rust {
        return true;
    }
    let name = lower.rsplit('/').next().unwrap_or(&lower);
    let in_test_dir = lower.split('/').rev().skip(1).any(|segment| {
        matches!(segment, "test" | "tests" | "__tests__" | "spec" | "specs" | "e2e" | "cypress" | "playwright" | "integration-tests" | "testing")
    });
    in_test_dir
        || name.contains(".test.")
        || name.contains(".spec.")
        || name.contains("_test.")
        || name.contains(".e2e.")
        || name.starts_with("test_")
        || name.ends_with("_spec.rb")
        || name.ends_with("test.java")
        || name.ends_with("tests.java")
        || name.ends_with("test.kt")
        || name.ends_with("tests.cs")
        || name.ends_with("test.cs")
}

/// Config files that decide what a suite or the linter runs. Changing one may be the work; it may
/// also be excluding the failing test from the run, and only a person can tell which.
pub fn is_runner_config(path: &str) -> bool {
    let name = path.replace('\\', "/").rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
    let stem = name.split('.').next().unwrap_or("");
    matches!(stem, "vitest" | "jest" | "playwright" | "cypress" | "karma" | "eslint" | "vite")
        && (name.contains(".config.") || name.ends_with(".json"))
        || name.starts_with(".eslintrc")
        || name.starts_with(".mocharc")
        || name.starts_with(".golangci")
        || name == "pytest.ini"
        || name == "conftest.py"
        || name == "phpunit.xml"
}

fn is_comment(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with("//") || t.starts_with("/*") || t.starts_with('*') || (t.starts_with('#') && !t.starts_with("#[") && !t.starts_with("#!["))
}

/// `needle` in `line` with no identifier character (nor `.`) right before it — so `it(` is found in
/// ` it(` and `(it(` but not in `split(` or `re.test(`.
fn bounded(line: &str, needle: &str) -> usize {
    let bytes = line.as_bytes();
    line.match_indices(needle)
        .filter(|(at, _)| *at == 0 || !matches!(bytes[at - 1], b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'_' | b'$' | b'.'))
        .count()
}

/// How many test cases `line` declares.
fn declarations(lang: Lang, line: &str) -> usize {
    if is_comment(line) {
        return 0;
    }
    let t = line.trim_start();
    match lang {
        Lang::Js => ["it(", "test(", "it.only(", "test.only(", "it.each", "test.each", "it.concurrent(", "test.concurrent(", "it.skip(", "test.skip("]
            .iter()
            .map(|n| bounded(line, n))
            .sum(),
        Lang::Rust => usize::from(t.starts_with("#[test]") || t.starts_with("#[tokio::test") || t.starts_with("#[rstest") || t.starts_with("#[test_case")),
        Lang::Go => usize::from(t.starts_with("func Test") || t.starts_with("func Benchmark")),
        Lang::Python => usize::from(t.starts_with("def test") || t.starts_with("async def test")),
        Lang::Jvm => usize::from(t.starts_with("@Test") || t.starts_with("@ParameterizedTest")),
        Lang::Ruby => usize::from(t.starts_with("it \"") || t.starts_with("it '") || t.starts_with("it do") || t.starts_with("scenario ")),
        Lang::CSharp => usize::from(t.starts_with("[Fact") || t.starts_with("[Theory") || t.starts_with("[Test]") || t.starts_with("[TestMethod") || t.starts_with("[TestCase")),
        Lang::Other => 0,
    }
}

/// Markers that turn tests off or leave the rest unrun, by language: `(marker, what it does)`.
fn skip_markers(lang: Lang) -> &'static [(&'static str, &'static str)] {
    match lang {
        Lang::Js => &[
            ("describe.skip(", "salta"),
            ("it.skip(", "salta"),
            ("test.skip(", "salta"),
            ("context.skip(", "salta"),
            ("suite.skip(", "salta"),
            ("xit(", "salta"),
            ("xtest(", "salta"),
            ("xdescribe(", "salta"),
            ("this.skip(", "salta"),
            ("describe.only(", "enfoca (las demás no corren)"),
            ("it.only(", "enfoca (las demás no corren)"),
            ("test.only(", "enfoca (las demás no corren)"),
            ("fit(", "enfoca (las demás no corren)"),
            ("fdescribe(", "enfoca (las demás no corren)"),
        ],
        Lang::Rust => &[("#[ignore", "ignora")],
        Lang::Go => &[("t.Skip(", "salta"), ("t.Skipf(", "salta"), ("t.SkipNow(", "salta")],
        Lang::Python => &[("pytest.mark.skip", "salta"), ("pytest.mark.xfail", "da por esperado el fallo de"), ("unittest.skip", "salta"), ("pytest.skip(", "salta"), (".skipTest(", "salta")],
        Lang::Jvm => &[("@Disabled", "desactiva"), ("@Ignore", "ignora")],
        Lang::Ruby => &[("xit ", "salta"), ("skip ", "salta"), ("pending ", "marca pendiente")],
        Lang::CSharp => &[("Skip =", "salta"), ("[Ignore", "ignora")],
        Lang::Other => &[],
    }
}

/// Markers that silence the linter or the type checker for a line or a file.
fn lint_markers(lang: Lang) -> &'static [&'static str] {
    match lang {
        Lang::Js => &["eslint-disable", "@ts-ignore", "@ts-nocheck", "@ts-expect-error", "biome-ignore"],
        Lang::Rust => &["#[allow(", "#![allow("],
        Lang::Python => &["# noqa", "# type: ignore", "# pylint: disable"],
        Lang::Go => &["//nolint"],
        Lang::Jvm => &["@SuppressWarnings"],
        Lang::CSharp => &["#pragma warning disable"],
        _ => &[],
    }
}

fn count_marker(lang: Lang, line: &str, marker: &str) -> usize {
    // Markers with their own punctuation up front (`#[`, `@`, `//`, `# `) or a receiver (`t.`) are
    // matched as they are; bare identifiers (`xit(`, `fit(`) need a boundary.
    let starts_bare = marker.chars().next().is_some_and(|c| c.is_ascii_alphabetic());
    let n = if starts_bare && !marker.contains('.') { bounded(line, marker) } else { line.matches(marker).count() };
    // A commented-out marker turns nothing off; the lint markers *are* comments.
    if starts_bare && is_comment(line) && lang != Lang::Ruby {
        return 0;
    }
    n
}

#[derive(Default)]
struct Tally {
    removed_decls: usize,
    added_decls: usize,
    markers: BTreeMap<&'static str, (i64, &'static str)>,
    lint: BTreeMap<&'static str, i64>,
    deleted: bool,
}

/// Reads a `git diff` (any context; `-U0` is enough) plus the files git does not track yet (the
/// member's new files, read whole) and says what weakened the tests. `lint` adds the silencing
/// markers, for a repository whose checks include a linter or a type check.
pub fn inspect(diff: &str, untracked: &[(String, String)], lint: bool) -> Vec<Finding> {
    let mut files: BTreeMap<String, Tally> = BTreeMap::new();
    let mut current: Option<String> = None;
    let mut minus_path: Option<String> = None;
    let record = |files: &mut BTreeMap<String, Tally>, path: &str, line: &str, added: bool| {
        let lang = lang_of(path);
        let tally = files.entry(path.to_string()).or_default();
        if is_test_path(path) {
            let decls = declarations(lang, line);
            if added { tally.added_decls += decls } else { tally.removed_decls += decls }
            for (marker, what) in skip_markers(lang) {
                let n = count_marker(lang, line, marker) as i64;
                if n > 0 {
                    let entry = tally.markers.entry(marker).or_insert((0, what));
                    entry.0 += if added { n } else { -n };
                }
            }
        }
        if lint {
            for marker in lint_markers(lang) {
                let n = line.matches(marker).count() as i64;
                if n > 0 {
                    *tally.lint.entry(marker).or_insert(0) += if added { n } else { -n };
                }
            }
        }
    };
    for line in diff.lines() {
        if line.starts_with("diff --git ") {
            current = None;
            minus_path = None;
        } else if let Some(path) = line.strip_prefix("--- ") {
            minus_path = path.strip_prefix("a/").map(str::to_string);
        } else if let Some(path) = line.strip_prefix("+++ ") {
            current = match path.strip_prefix("b/") {
                Some(path) => Some(path.to_string()),
                // `+++ /dev/null`: the file was deleted; its lines are all `-`.
                None => {
                    if let Some(gone) = &minus_path {
                        files.entry(gone.clone()).or_default().deleted = true;
                    }
                    minus_path.clone()
                }
            };
        } else if let Some(path) = &current {
            if let Some(text) = line.strip_prefix('+') {
                record(&mut files, path, text, true);
            } else if let Some(text) = line.strip_prefix('-') {
                record(&mut files, path, text, false);
            }
        }
    }
    for (path, text) in untracked {
        for line in text.lines() {
            record(&mut files, path, line, true);
        }
    }

    let mut out = Vec::new();
    let removed: usize = files.values().map(|t| t.removed_decls).sum();
    let added: usize = files.values().map(|t| t.added_decls).sum();
    // Tests moved from one file to another cancel out; only a net loss is reported, on the files
    // that lost them.
    if removed > added {
        let losers: Vec<String> = files
            .iter()
            .filter(|(_, t)| t.removed_decls > t.added_decls)
            .map(|(path, t)| if t.deleted { format!("{path} (borrado)") } else { path.clone() })
            .collect();
        out.push(Finding { file: losers.first().cloned().unwrap_or_default(), text: format!("hay {} prueba(s) menos que antes del cambio: {}", removed - added, losers.join(", ")) });
    }
    for (path, tally) in &files {
        for (marker, (net, what)) in &tally.markers {
            if *net > 0 {
                out.push(Finding { file: path.clone(), text: format!("agrega `{}` en {path}: {what} prueba(s)", marker.trim_end_matches('(').trim()) });
            }
        }
        for (marker, net) in &tally.lint {
            if *net > 0 {
                out.push(Finding { file: path.clone(), text: format!("agrega `{}` en {path}: silencia el lint o los tipos", marker.trim_end_matches('(')) });
            }
        }
    }
    out
}

/// The `package.json` script a check runs, from its command: `pnpm test` → `test`,
/// `npm run lint` → `lint`, `yarn typecheck` → `typecheck`.
pub fn script_of(command: &str) -> Option<String> {
    let words: Vec<&str> = command.split_whitespace().collect();
    let script = match words.as_slice() {
        ["npm" | "pnpm" | "yarn" | "bun", "run", script, ..] => *script,
        ["npm" | "pnpm" | "yarn" | "bun", "test", ..] => "test",
        ["yarn" | "pnpm", script, ..] if !script.starts_with('-') && !matches!(*script, "install" | "add" | "exec" | "dlx") => *script,
        _ => return None,
    };
    Some(script.to_string())
}

/// The check scripts whose command changed between the base `package.json` and the current one.
pub fn changed_scripts(base: &str, now: &str, commands: &[String]) -> Vec<Finding> {
    let parse = |text: &str| serde_json::from_str::<serde_json::Value>(text).ok();
    let (Some(base), Some(now)) = (parse(base), parse(now)) else { return Vec::new() };
    let mut out = Vec::new();
    for script in commands.iter().filter_map(|c| script_of(c)) {
        let before = base["scripts"][&script].as_str().unwrap_or("");
        let after = now["scripts"][&script].as_str().unwrap_or("");
        if before != after && !before.is_empty() && !out.iter().any(|f: &Finding| f.text.contains(&format!("«{script}»"))) {
            out.push(Finding {
                file: "package.json".into(),
                text: format!("cambia el script «{script}» que corre la verificación: `{before}` → `{}`", if after.is_empty() { "(borrado)" } else { after }),
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diff(path: &str, removed: &[&str], added: &[&str]) -> String {
        let mut out = format!("diff --git a/{path} b/{path}\n--- a/{path}\n+++ b/{path}\n@@ -1 +1 @@\n");
        for line in removed {
            out.push_str(&format!("-{line}\n"));
        }
        for line in added {
            out.push_str(&format!("+{line}\n"));
        }
        out
    }

    #[test]
    fn classifies_test_files() {
        for path in ["src/a.test.ts", "src/__tests__/a.ts", "tests/api.py", "pkg/x_test.go", "src/lib.rs", "spec/user_spec.rb", "src/test/java/FooTest.java", "e2e/login.spec.ts", "test_api.py"] {
            assert!(is_test_path(path), "{path}");
        }
        for path in ["src/app.ts", "src/testing-utils.md", "README.md", "src/contest.ts"] {
            assert!(!is_test_path(path), "{path}");
        }
        assert!(is_runner_config("vitest.config.ts") && is_runner_config("apps/web/.eslintrc.cjs") && is_runner_config("jest.config.json"));
        assert!(!is_runner_config("vite-env.d.ts") && !is_runner_config("src/config.ts"));
    }

    #[test]
    fn a_skipped_or_focused_test_is_found() {
        let d = diff("src/a.test.ts", &["  it(\"works\", () => {"], &["  it.skip(\"works\", () => {"]);
        let found = inspect(&d, &[], false);
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(found[0].text.contains("it.skip"), "{found:?}");
        let d = diff("src/a.test.ts", &["describe(\"x\", () => {"], &["describe.only(\"x\", () => {"]);
        assert!(inspect(&d, &[], false)[0].text.contains("enfoca"));
        let d = diff("src/lib.rs", &["    #[test]"], &["    #[test]", "    #[ignore]"]);
        assert!(inspect(&d, &[], false)[0].text.contains("#[ignore"));
        let d = diff("pkg/a_test.go", &[], &["\tt.Skip(\"flaky\")"]);
        assert_eq!(inspect(&d, &[], false).len(), 1);
    }

    #[test]
    fn deleted_tests_count_but_moved_tests_do_not() {
        let gone = "diff --git a/src/a.test.ts b/src/a.test.ts\ndeleted file mode 100644\n--- a/src/a.test.ts\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-it(\"one\", () => {})\n-it(\"two\", () => {})\n";
        let found = inspect(gone, &[], false);
        assert_eq!(found.len(), 1);
        assert!(found[0].text.contains("2 prueba(s) menos") && found[0].text.contains("(borrado)"), "{found:?}");
        // The same two, now in a file git does not track yet: moved, not lost.
        let moved = [("src/b.test.ts".to_string(), "it(\"one\", () => {})\nit(\"two\", () => {})\n".to_string())];
        assert!(inspect(gone, &moved, false).is_empty());
        // Renamed in place: one out, one in.
        let d = diff("src/a.test.ts", &["it(\"old name\", () => {})"], &["it(\"new name\", () => {})"]);
        assert!(inspect(&d, &[], false).is_empty());
    }

    #[test]
    fn ordinary_code_is_not_mistaken_for_tests() {
        let d = diff("src/a.test.ts", &[], &["const ok = /x/.test(s);", "const p = profit(1);", "// it.skip(\"later\")", "split(\",\")"]);
        assert!(inspect(&d, &[], false).is_empty(), "{:?}", inspect(&d, &[], false));
        let d = diff("src/iter.rs", &[], &["let rest = it.skip(2);"]);
        assert!(inspect(&d, &[], false).is_empty());
        // Outside a test file, a `.skip(` is somebody's API.
        let d = diff("src/list.ts", &[], &["items.skip(2)", "it(\"x\")"]);
        assert!(inspect(&d, &[], false).is_empty());
    }

    #[test]
    fn lint_silencers_only_count_when_the_team_lints() {
        let d = diff("src/app.ts", &[], &["// @ts-ignore", "const x: number = y;"]);
        assert!(inspect(&d, &[], false).is_empty());
        let found = inspect(&d, &[], true);
        assert_eq!(found.len(), 1);
        assert!(found[0].text.contains("@ts-ignore"));
        // One that was there and stays (moved a line down) is not new.
        let d = diff("src/app.ts", &["// eslint-disable-next-line no-console"], &["// eslint-disable-next-line no-console"]);
        assert!(inspect(&d, &[], true).is_empty());
    }

    #[test]
    fn a_rewritten_check_script_is_found() {
        assert_eq!(script_of("pnpm test").as_deref(), Some("test"));
        assert_eq!(script_of("npm run lint").as_deref(), Some("lint"));
        assert_eq!(script_of("yarn typecheck").as_deref(), Some("typecheck"));
        assert_eq!(script_of("cargo test"), None);
        let base = r#"{"scripts":{"test":"vitest run","lint":"eslint ."}}"#;
        let now = r#"{"scripts":{"test":"vitest run --passWithNoTests","lint":"eslint ."}}"#;
        let found = changed_scripts(base, now, &["pnpm test".into(), "pnpm run lint".into()]);
        assert_eq!(found.len(), 1);
        assert!(found[0].text.contains("«test»"));
        assert!(changed_scripts(base, base, &["pnpm test".into()]).is_empty());
    }
}
