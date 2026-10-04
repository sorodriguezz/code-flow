//! The reports a project's tests leave behind — coverage and JUnit XML — found and read.
//!
//! A pipeline knows where its reports are because somebody wrote the paths into its YAML. Here
//! nobody has, so they are looked for: in `CODEFLOW_REPORTS_DIR` (where the suggested test commands
//! write), and in the places each ecosystem's tools write by default. Only files written **during
//! this review's test stage** count — a `coverage/lcov.info` from last week would put last week's
//! number on today's report, which is worse than no number at all.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

/// Folders never searched: dependencies, VCS internals, caches. Build output is *not* here —
/// `target/` and `build/` are exactly where Maven and Gradle put their reports.
const SKIP: &[&str] = &[
    "node_modules", ".git", ".hg", ".svn", ".venv", "venv", "__pycache__", ".gradle", ".idea", ".vscode",
    ".next", ".nuxt", ".turbo", ".cache", "Pods", "DerivedData", "bower_components", "vendor", ".tox", ".mypy_cache",
];

/// How deep the search goes, and how many folders it may read, so a monorepo can't stall a review.
const MAX_DEPTH: usize = 10;
const MAX_DIRS: usize = 20_000;

/// Every file under `root` that `wanted` accepts, modified at or after `since`.
pub fn find(root: &Path, since: Option<SystemTime>, wanted: &dyn Fn(&Path) -> bool) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut seen = 0usize;
    while let Some((dir, depth)) = stack.pop() {
        seen += 1;
        if seen > MAX_DIRS {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            let path = entry.path();
            if kind.is_dir() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if depth < MAX_DEPTH && !SKIP.contains(&name.as_ref()) {
                    stack.push((path, depth + 1));
                }
            } else if kind.is_file() && wanted(&path) {
                let fresh = match since {
                    None => true,
                    Some(since) => entry
                        .metadata()
                        .and_then(|m| m.modified())
                        // A couple of seconds of slack: file systems store mtimes coarser than the clock.
                        .map(|modified| modified + std::time::Duration::from_secs(2) >= since)
                        .unwrap_or(false),
                };
                if fresh {
                    found.push(path);
                }
            }
        }
    }
    found.sort();
    found
}

fn name_of(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default()
}

fn head(path: &Path) -> String {
    use std::io::Read;
    let mut buffer = [0u8; 1024];
    let read = std::fs::File::open(path).and_then(|mut f| f.read(&mut buffer)).unwrap_or(0);
    String::from_utf8_lossy(&buffer[..read]).into_owned()
}

/// The coverage reports a review found, by the analyzer property that reads each kind.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Coverage {
    pub lcov: Vec<PathBuf>,
    pub jacoco: Vec<PathBuf>,
    /// Cobertura XML — what coverage.py writes as `coverage.xml`.
    pub cobertura: Vec<PathBuf>,
    pub go: Vec<PathBuf>,
}

impl Coverage {
    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.lcov.is_empty() && self.jacoco.is_empty() && self.cobertura.is_empty() && self.go.is_empty()
    }

    /// `-Dkey=value` pairs for the scanner.
    pub fn properties(&self) -> Vec<(String, String)> {
        let join = |paths: &[PathBuf]| paths.iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>().join(",");
        let mut out = Vec::new();
        if !self.lcov.is_empty() {
            // The JavaScript analyzer reads LCOV for TypeScript too.
            out.push(("sonar.javascript.lcov.reportPaths".to_string(), join(&self.lcov)));
        }
        if !self.jacoco.is_empty() {
            out.push(("sonar.coverage.jacoco.xmlReportPaths".to_string(), join(&self.jacoco)));
        }
        if !self.cobertura.is_empty() {
            out.push(("sonar.python.coverage.reportPaths".to_string(), join(&self.cobertura)));
        }
        if !self.go.is_empty() {
            out.push(("sonar.go.coverage.reportPaths".to_string(), join(&self.go)));
        }
        out
    }
}

pub fn find_coverage(roots: &[&Path], since: Option<SystemTime>) -> Coverage {
    let mut coverage = Coverage::default();
    for root in roots {
        for path in find(root, since, &|p| {
            let name = name_of(p);
            name == "lcov.info"
                || name.ends_with(".lcov")
                || (name.ends_with(".xml") && (name.contains("jacoco") || name.contains("cobertura") || name == "coverage.xml"))
                || name == "coverage.out"
                || name == "cover.out"
                || name.ends_with(".coverprofile")
        }) {
            let name = name_of(&path);
            if name == "lcov.info" || name.ends_with(".lcov") {
                coverage.lcov.push(path);
            } else if name.ends_with(".xml") {
                let text = head(&path);
                if text.contains("JACOCO") || text.contains("<report") {
                    coverage.jacoco.push(path);
                } else if text.contains("<coverage") {
                    coverage.cobertura.push(path);
                }
            } else {
                coverage.go.push(path);
            }
        }
    }
    coverage
}

/// One failed or errored test, as the Tests tab lists it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TestFailure {
    pub suite: String,
    pub name: String,
    pub message: String,
    /// The first lines of the failure's body — usually the assertion and the top of the stack.
    pub detail: String,
    pub file: Option<String>,
    pub line: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct TestReport {
    pub total: u32,
    pub passed: u32,
    pub failed: u32,
    pub skipped: u32,
    pub duration_ms: u64,
    pub failures: Vec<TestFailure>,
    /// How many report files were read — 0 means the numbers came from nowhere and the tab says so.
    pub files: u32,
}

/// JUnit XML files written by this review's tests: Surefire/Failsafe and Gradle's folders, and any
/// file whose name says it is a JUnit report.
pub fn find_junit(roots: &[&Path], since: Option<SystemTime>) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for root in roots {
        files.extend(find(root, since, &|p| {
            let name = name_of(p);
            if !name.ends_with(".xml") {
                return false;
            }
            let in_report_dir = p.components().any(|c| {
                let part = c.as_os_str().to_string_lossy();
                part == "surefire-reports" || part == "failsafe-reports" || part == "test-results"
            });
            in_report_dir || name.contains("junit") || name.starts_with("test-") || name.starts_with("test_results")
        }));
    }
    files.retain(|p| {
        let text = head(p);
        text.contains("<testsuite") || text.contains("<testcase")
    });
    files.sort();
    files.dedup();
    files
}

/// The value of `attr="…"` inside one tag's text.
fn attribute(tag: &str, attr: &str) -> Option<String> {
    let needle = format!("{attr}=");
    let mut rest = tag;
    while let Some(at) = rest.find(&needle) {
        // A whole attribute name, not the end of a longer one (`classname` vs `name`).
        let boundary = at == 0 || rest[..at].ends_with(|c: char| c.is_whitespace());
        let after = &rest[at + needle.len()..];
        let quote = after.chars().next()?;
        if boundary && (quote == '"' || quote == '\'') {
            let value = &after[1..];
            let end = value.find(quote)?;
            return Some(unescape(&value[..end]));
        }
        rest = &rest[at + needle.len()..];
    }
    None
}

fn unescape(text: &str) -> String {
    text.replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&#10;", "\n")
        .replace("&#13;", "")
        .replace("&amp;", "&")
}

fn strip_cdata(text: &str) -> String {
    text.replace("<![CDATA[", "").replace("]]>", "")
}

/// Reads every `<testcase>` of the files. Counted from the cases rather than the suites' attributes,
/// which reporters fill in inconsistently (some count a skipped test as a failure, some leave
/// `tests` out).
pub fn read_junit(files: &[PathBuf]) -> TestReport {
    let mut report = TestReport { files: files.len() as u32, ..Default::default() };
    for file in files {
        let Ok(text) = std::fs::read_to_string(file) else { continue };
        let mut rest = text.as_str();
        while let Some(start) = rest.find("<testcase") {
            let after = &rest[start..];
            let Some(open_end) = after.find('>') else { break };
            let open = &after[..open_end];
            let self_closing = open.ends_with('/');
            let (body, consumed) = if self_closing {
                ("", open_end + 1)
            } else {
                match after.find("</testcase>") {
                    Some(close) => (&after[open_end + 1..close], close + "</testcase>".len()),
                    None => ("", open_end + 1),
                }
            };
            rest = &after[consumed..];

            report.total += 1;
            if let Some(seconds) = attribute(open, "time").and_then(|t| t.replace(',', "").parse::<f64>().ok()) {
                report.duration_ms += (seconds * 1000.0).round() as u64;
            }
            let failure_at = body.find("<failure").or_else(|| body.find("<error"));
            if let Some(at) = failure_at {
                report.failed += 1;
                let tag_end = body[at..].find('>').map(|e| at + e).unwrap_or(body.len());
                let tag = &body[at..tag_end];
                let inner = if tag.ends_with('/') {
                    String::new()
                } else {
                    let content_start = (tag_end + 1).min(body.len());
                    let close = body[content_start..]
                        .find("</failure>")
                        .or_else(|| body[content_start..].find("</error>"))
                        .map(|c| content_start + c)
                        .unwrap_or(body.len());
                    strip_cdata(&unescape(&body[content_start..close]))
                };
                let detail: String = inner.lines().map(str::trim_end).filter(|l| !l.trim().is_empty()).take(12).collect::<Vec<_>>().join("\n");
                let message = attribute(tag, "message").unwrap_or_else(|| detail.lines().next().unwrap_or_default().to_string());
                report.failures.push(TestFailure {
                    suite: attribute(open, "classname").unwrap_or_default(),
                    name: attribute(open, "name").unwrap_or_default(),
                    message: message.chars().take(400).collect(),
                    detail,
                    file: attribute(open, "file"),
                    line: attribute(open, "line").and_then(|l| l.parse().ok()),
                });
            } else if body.contains("<skipped") {
                report.skipped += 1;
            }
        }
    }
    report.passed = report.total.saturating_sub(report.failed + report.skipped);
    report
}

/// Surefire and Gradle report folders, for `sonar.junit.reportPaths` — the Java analyzer reads test
/// counts from them.
pub fn junit_dirs(files: &[PathBuf]) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = files
        .iter()
        .filter(|f| name_of(f).starts_with("test-"))
        .filter_map(|f| f.parent().map(Path::to_path_buf))
        .collect();
    dirs.sort();
    dirs.dedup();
    dirs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cf-reviewer-reports-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn junit_cases_are_counted_and_failures_kept() {
        let dir = temp();
        let file = dir.join("junit.xml");
        std::fs::write(
            &file,
            r#"<?xml version="1.0"?>
<testsuites><testsuite name="orders" tests="4">
  <testcase classname="orders" name="totals" time="0.012"/>
  <testcase classname="orders" name="rejects an empty basket" time="0.018" file="tests/orders.test.ts" line="42">
    <failure message="expected EmptyBasketError, got undefined" type="AssertionError"><![CDATA[AssertionError: expected EmptyBasketError
    at tests/orders.test.ts:42:5]]></failure>
  </testcase>
  <testcase classname="payments" name="refund is idempotent" time="5.000"><error message="Timeout of 5000ms">Error: Timeout</error></testcase>
  <testcase classname="payments" name="later"><skipped/></testcase>
</testsuite></testsuites>"#,
        )
        .unwrap();
        let report = read_junit(&[file]);
        assert_eq!(report.total, 4);
        assert_eq!(report.failed, 2);
        assert_eq!(report.skipped, 1);
        assert_eq!(report.passed, 1);
        assert_eq!(report.duration_ms, 5030);
        assert_eq!(report.failures[0].name, "rejects an empty basket");
        assert_eq!(report.failures[0].message, "expected EmptyBasketError, got undefined");
        assert_eq!(report.failures[0].file.as_deref(), Some("tests/orders.test.ts"));
        assert_eq!(report.failures[0].line, Some(42));
        assert!(report.failures[0].detail.contains("at tests/orders.test.ts:42:5"));
        assert_eq!(report.failures[1].suite, "payments");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn attribute_matches_whole_names_only() {
        let tag = r#"<testcase classname="a.B" name="does &quot;x&quot;""#;
        assert_eq!(attribute(tag, "name").as_deref(), Some("does \"x\""));
        assert_eq!(attribute(tag, "classname").as_deref(), Some("a.B"));
        assert_eq!(attribute(tag, "time"), None);
    }

    #[test]
    fn coverage_reports_are_sorted_by_kind_and_stale_ones_ignored() {
        let dir = temp();
        std::fs::create_dir_all(dir.join("coverage")).unwrap();
        std::fs::create_dir_all(dir.join("target/site/jacoco")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules/x/coverage")).unwrap();
        std::fs::write(dir.join("coverage/lcov.info"), "TN:\n").unwrap();
        std::fs::write(dir.join("node_modules/x/coverage/lcov.info"), "TN:\n").unwrap();
        std::fs::write(dir.join("target/site/jacoco/jacoco.xml"), r#"<?xml version="1.0"?><!DOCTYPE report PUBLIC "-//JACOCO//DTD Report 1.1//EN" "report.dtd"><report name="x">"#).unwrap();
        std::fs::write(dir.join("coverage.xml"), r#"<?xml version="1.0" ?><coverage version="7.4">"#).unwrap();
        std::fs::write(dir.join("coverage.out"), "mode: set\n").unwrap();
        let coverage = find_coverage(&[&dir], None);
        assert_eq!(coverage.lcov, vec![dir.join("coverage/lcov.info")]);
        assert_eq!(coverage.jacoco.len(), 1);
        assert_eq!(coverage.cobertura.len(), 1);
        assert_eq!(coverage.go.len(), 1);
        let keys: Vec<String> = coverage.properties().into_iter().map(|(k, _)| k).collect();
        assert!(keys.contains(&"sonar.javascript.lcov.reportPaths".to_string()));
        // Written before the stage began: not this review's.
        let future = SystemTime::now() + std::time::Duration::from_secs(3600);
        assert!(find_coverage(&[&dir], Some(future)).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
