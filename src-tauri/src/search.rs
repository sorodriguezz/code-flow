//! Repo-wide file listing and content search — what "go to file" and "find in project" run on.
//!
//! Both walk the working tree honouring `.gitignore`, and both prune ignored *directories*
//! rather than filtering their files afterwards: in a real project `node_modules` and `target`
//! hold more entries than the source does, and descending into them makes the difference between
//! an instant palette and a spinner.

use std::path::Path;

use git2::Repository;
use globset::{Glob, GlobSet, GlobSetBuilder};
use regex::Regex;
use serde::{Deserialize, Serialize};

/// Ceiling on how many paths "go to file" will hold. Well past any repo a person navigates by
/// name, and low enough that a pathological tree can't freeze the palette.
const MAX_FILES: usize = 20_000;

/// Files above this are skipped by content search: minified bundles and checked-in data dumps
/// are never what someone is looking for, and reading them is most of the cost.
const MAX_SEARCH_FILE_BYTES: u64 = 1024 * 1024;

/// Long lines (a minified bundle that slipped past the size check) are cut before crossing the
/// IPC boundary — the UI shows one line per hit and can't render a 200 KB one anyway.
const MAX_LINE_CHARS: usize = 400;

const MAX_HITS_PER_FILE: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    /// Repo-relative, `/`-separated.
    pub path: String,
    /// 1-based, so it can be handed straight to the editor.
    pub line_no: u32,
    pub line: String,
}

/// The toggles an editor's find box carries, in one place so search and replace can't drift
/// apart on what "a match" means.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    pub case_sensitive: bool,
    /// Match only whole words — `set` stops matching inside `offset`.
    pub whole_word: bool,
    /// Treat the query as a regular expression rather than literal text.
    pub regex: bool,
    /// Comma-separated globs limiting which files are searched (`src/**, *.ts`). Empty = all.
    pub include: String,
    /// Comma-separated globs to skip, applied after `include`.
    pub exclude: String,
}

/// Compiles the query into the one matcher both search and replace run on.
///
/// Everything funnels through `regex`, including plain-text search: escaping a literal is
/// cheaper than maintaining two matching paths that have to agree about case folding and word
/// boundaries.
fn build_matcher(query: &str, options: &SearchOptions) -> Result<Regex, String> {
    let body = if options.regex { query.to_string() } else { regex::escape(query) };
    let body = if options.whole_word { format!(r"\b(?:{body})\b") } else { body };
    let pattern = if options.case_sensitive { body } else { format!("(?i){body}") };
    Regex::new(&pattern).map_err(|e| {
        // A half-typed regex is the normal state of the box while someone types, so this reads
        // as feedback rather than as a crash.
        format!("invalid regular expression: {}", e.to_string().lines().last().unwrap_or("").trim())
    })
}

/// Builds a matcher from a comma-separated glob list. A pattern with no `/` matches by file name
/// anywhere in the tree (`*.ts`), which is what people mean and what editors do.
fn build_globs(patterns: &str) -> Result<Option<GlobSet>, String> {
    let patterns: Vec<&str> = patterns.split(',').map(str::trim).filter(|p| !p.is_empty()).collect();
    if patterns.is_empty() {
        return Ok(None);
    }
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        let normalized = if pattern.contains('/') { pattern.to_string() } else { format!("**/{pattern}") };
        builder.add(Glob::new(&normalized).map_err(|e| format!("invalid glob '{pattern}': {e}"))?);
    }
    builder.build().map(Some).map_err(|e| e.to_string())
}

fn passes_filters(path: &str, include: &Option<GlobSet>, exclude: &Option<GlobSet>) -> bool {
    if let Some(include) = include {
        if !include.is_match(path) {
            return false;
        }
    }
    match exclude {
        Some(exclude) => !exclude.is_match(path),
        None => true,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplaceOutcome {
    /// How many occurrences were rewritten.
    pub replacements: usize,
    /// How many files were touched.
    pub files: usize,
    /// The snapshot taken before anything was written, so a repo-wide replace is undoable from
    /// the same place an AI run is. `None` only if the snapshot itself failed.
    pub checkpoint_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchOutcome {
    pub hits: Vec<SearchHit>,
    /// True when the result set hit `max_results` — the UI says so instead of implying the list
    /// is everything there is.
    pub truncated: bool,
}

/// Depth-first walk of the working tree, yielding repo-relative file paths.
fn walk(repo: &Repository, root: &Path, rel: &str, out: &mut Vec<String>, limit: usize) {
    if out.len() >= limit {
        return;
    }
    let dir = if rel.is_empty() { root.to_path_buf() } else { root.join(rel) };
    let Ok(entries) = std::fs::read_dir(&dir) else { return };

    // Sorted so the palette's order is stable between calls rather than filesystem-dependent.
    let mut names: Vec<_> = entries.flatten().collect();
    names.sort_by_key(|e| e.file_name());

    for entry in names {
        if out.len() >= limit {
            return;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        let child_rel = if rel.is_empty() { name } else { format!("{rel}/{name}") };
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        // git wants a trailing slash to answer "is this *directory* ignored" for rules like
        // `build/`; without it a directory-only rule doesn't match and we'd descend anyway.
        let probe = if is_dir { format!("{child_rel}/") } else { child_rel.clone() };
        if repo.is_path_ignored(Path::new(&probe)).unwrap_or(false) {
            continue;
        }
        if is_dir {
            walk(repo, root, &child_rel, out, limit);
        } else {
            out.push(child_rel);
        }
    }
}

/// Every non-ignored file in the repo, repo-relative, sorted.
pub fn list_files(repo_path: &str) -> Result<Vec<String>, String> {
    let repo = Repository::open(repo_path).map_err(|e| e.message().to_string())?;
    let root = repo
        .workdir()
        .ok_or_else(|| "bare repository".to_string())?
        .to_path_buf();
    let mut out = Vec::new();
    walk(&repo, &root, "", &mut out, MAX_FILES);
    Ok(out)
}

/// Whether a byte slice looks like binary content. A NUL byte is the same heuristic `grep` uses,
/// and it's enough to keep images and compiled artifacts out of text search results.
fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|b| *b == 0)
}

fn truncate_line(line: &str) -> String {
    let trimmed = line.trim_end_matches(['\r', '\n']);
    if trimmed.chars().count() > MAX_LINE_CHARS {
        format!("{}…", trimmed.chars().take(MAX_LINE_CHARS).collect::<String>())
    } else {
        trimmed.to_string()
    }
}

/// Searches the repo's text files, honouring every toggle in [`SearchOptions`].
pub fn search(
    repo_path: &str,
    query: &str,
    options: &SearchOptions,
    max_results: usize,
) -> Result<SearchOutcome, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(SearchOutcome { hits: Vec::new(), truncated: false });
    }
    let matcher = build_matcher(query, options)?;
    let include = build_globs(&options.include)?;
    let exclude = build_globs(&options.exclude)?;

    let repo = Repository::open(repo_path).map_err(|e| e.message().to_string())?;
    let root = repo
        .workdir()
        .ok_or_else(|| "bare repository".to_string())?
        .to_path_buf();

    let mut files = Vec::new();
    walk(&repo, &root, "", &mut files, MAX_FILES);

    let mut hits: Vec<SearchHit> = Vec::new();
    for rel in files {
        if hits.len() >= max_results {
            return Ok(SearchOutcome { hits, truncated: true });
        }
        if !passes_filters(&rel, &include, &exclude) {
            continue;
        }
        let Some(text) = read_text_file(&root.join(&rel)) else { continue };

        let mut in_file = 0;
        for (index, line) in text.lines().enumerate() {
            if in_file >= MAX_HITS_PER_FILE || hits.len() >= max_results {
                break;
            }
            if matcher.is_match(line) {
                in_file += 1;
                hits.push(SearchHit { path: rel.clone(), line_no: index as u32 + 1, line: truncate_line(line) });
            }
        }
    }

    let truncated = hits.len() >= max_results;
    Ok(SearchOutcome { hits, truncated })
}

/// Reads a file if it's text and small enough to be worth searching.
fn read_text_file(path: &Path) -> Option<String> {
    match std::fs::metadata(path) {
        Ok(meta) if meta.len() <= MAX_SEARCH_FILE_BYTES => {}
        _ => return None,
    }
    let bytes = std::fs::read(path).ok()?;
    if looks_binary(&bytes) {
        return None;
    }
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// Rewrites every match with `replacement` across the repo, or within `only_path` when given.
///
/// A checkpoint is taken first: this writes to files the user may not even have open, and a
/// project-wide replace with no undo is a trap. `$1`-style group references work when the query
/// is a regex, the same as in the editors people are used to.
pub fn replace_all(
    repo_path: &str,
    query: &str,
    replacement: &str,
    options: &SearchOptions,
    only_path: Option<&str>,
) -> Result<ReplaceOutcome, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(ReplaceOutcome { replacements: 0, files: 0, checkpoint_id: None });
    }
    let matcher = build_matcher(query, options)?;
    let include = build_globs(&options.include)?;
    let exclude = build_globs(&options.exclude)?;

    let repo = Repository::open(repo_path).map_err(|e| e.message().to_string())?;
    let root = repo
        .workdir()
        .ok_or_else(|| "bare repository".to_string())?
        .to_path_buf();

    let mut files = Vec::new();
    walk(&repo, &root, "", &mut files, MAX_FILES);

    // Every edit is computed before a single byte is written, so a file that fails to read
    // halfway through can't leave the tree half-replaced.
    let mut planned: Vec<(String, String, usize)> = Vec::new();
    for rel in files {
        if let Some(only) = only_path {
            if rel != only {
                continue;
            }
        }
        if !passes_filters(&rel, &include, &exclude) {
            continue;
        }
        let Some(text) = read_text_file(&root.join(&rel)) else { continue };
        let count = matcher.find_iter(&text).count();
        if count == 0 {
            continue;
        }
        let replaced = matcher.replace_all(&text, replacement).into_owned();
        if replaced != text {
            planned.push((rel, replaced, count));
        }
    }

    if planned.is_empty() {
        return Ok(ReplaceOutcome { replacements: 0, files: 0, checkpoint_id: None });
    }

    let checkpoint_id = crate::git::checkpoint::create(repo_path, "replace-all").ok();
    let mut replacements = 0;
    let mut written = 0;
    for (rel, content, count) in planned {
        std::fs::write(root.join(&rel), content).map_err(|e| format!("{rel}: {e}"))?;
        replacements += count;
        written += 1;
    }
    Ok(ReplaceOutcome { replacements, files: written, checkpoint_id })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fixture() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cf-search-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        Repository::init(&dir).unwrap();
        fs::write(dir.join(".gitignore"), "node_modules/\n*.log\n").unwrap();
        fs::write(dir.join("src/app.ts"), "const answer = 42;\nexport { answer };\n").unwrap();
        fs::write(dir.join("src/util.ts"), "// the ANSWER helper\n").unwrap();
        fs::write(dir.join("node_modules/pkg/index.js"), "const answer = 1;\n").unwrap();
        fs::write(dir.join("debug.log"), "answer\n").unwrap();
        dir
    }

    #[test]
    fn lists_source_files_and_skips_ignored_ones() {
        let dir = fixture();
        let files = list_files(dir.to_str().unwrap()).unwrap();
        assert!(files.contains(&"src/app.ts".to_string()));
        assert!(files.contains(&".gitignore".to_string()));
        // The whole ignored directory is pruned, not just filtered afterwards.
        assert!(!files.iter().any(|f| f.starts_with("node_modules")), "got {files:?}");
        assert!(!files.contains(&"debug.log".to_string()));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn finds_matches_case_insensitively_by_default() {
        let dir = fixture();
        let found = search(dir.to_str().unwrap(), "answer", &SearchOptions::default(), 100).unwrap();
        let paths: Vec<&str> = found.hits.iter().map(|h| h.path.as_str()).collect();
        assert!(paths.contains(&"src/app.ts"));
        assert!(paths.contains(&"src/util.ts"));
        // Ignored files stay out of search too.
        assert!(!paths.contains(&"debug.log"));
        assert_eq!(found.hits.iter().find(|h| h.path == "src/app.ts").unwrap().line_no, 1);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn case_sensitive_search_respects_case() {
        let dir = fixture();
        let options = SearchOptions { case_sensitive: true, ..Default::default() };
        let found = search(dir.to_str().unwrap(), "ANSWER", &options, 100).unwrap();
        let paths: Vec<&str> = found.hits.iter().map(|h| h.path.as_str()).collect();
        assert_eq!(paths, vec!["src/util.ts"]);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reports_truncation_instead_of_pretending_it_found_everything() {
        let dir = fixture();
        let found = search(dir.to_str().unwrap(), "answer", &SearchOptions::default(), 1).unwrap();
        assert_eq!(found.hits.len(), 1);
        assert!(found.truncated);
        fs::remove_dir_all(&dir).ok();
    }
}

#[cfg(test)]
mod option_tests {
    use super::*;
    use std::fs;

    fn repo(files: &[(&str, &str)]) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cf-find-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        Repository::init(&dir).unwrap();
        for (path, body) in files {
            let full = dir.join(path);
            fs::create_dir_all(full.parent().unwrap()).unwrap();
            fs::write(full, body).unwrap();
        }
        dir
    }

    fn paths(outcome: &SearchOutcome) -> Vec<String> {
        outcome.hits.iter().map(|h| format!("{}:{}", h.path, h.line_no)).collect()
    }

    #[test]
    fn whole_word_stops_matching_inside_longer_words() {
        let dir = repo(&[("a.ts", "const set = 1;\nconst offset = 2;\n")]);
        let path = dir.to_str().unwrap();

        let loose = search(path, "set", &SearchOptions::default(), 50).unwrap();
        assert_eq!(paths(&loose), vec!["a.ts:1", "a.ts:2"]);

        let strict = SearchOptions { whole_word: true, ..Default::default() };
        assert_eq!(paths(&search(path, "set", &strict, 50).unwrap()), vec!["a.ts:1"]);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn regex_mode_treats_the_query_as_a_pattern() {
        let dir = repo(&[("a.ts", "fn one() {}\nfn two() {}\nconst three = 3;\n")]);
        let path = dir.to_str().unwrap();

        let options = SearchOptions { regex: true, ..Default::default() };
        assert_eq!(paths(&search(path, r"fn \w+\(", &options, 50).unwrap()), vec!["a.ts:1", "a.ts:2"]);

        // The same text without the flag is a literal, and matches nothing.
        assert!(search(path, r"fn \w+\(", &SearchOptions::default(), 50).unwrap().hits.is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_unfinished_regex_reports_itself_instead_of_panicking() {
        let dir = repo(&[("a.ts", "x\n")]);
        let options = SearchOptions { regex: true, ..Default::default() };
        let error = search(dir.to_str().unwrap(), "foo(", &options, 50).unwrap_err();
        assert!(error.starts_with("invalid regular expression"), "got {error}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn include_and_exclude_globs_narrow_the_scan() {
        let dir = repo(&[
            ("src/a.ts", "needle\n"),
            ("src/a.test.ts", "needle\n"),
            ("docs/a.md", "needle\n"),
        ]);
        let path = dir.to_str().unwrap();

        // A bare pattern matches by file name at any depth.
        let only_ts = SearchOptions { include: "*.ts".into(), ..Default::default() };
        assert_eq!(paths(&search(path, "needle", &only_ts, 50).unwrap()), vec!["src/a.test.ts:1", "src/a.ts:1"]);

        // Exclude runs after include.
        let no_tests = SearchOptions { include: "*.ts".into(), exclude: "*.test.ts".into(), ..Default::default() };
        assert_eq!(paths(&search(path, "needle", &no_tests, 50).unwrap()), vec!["src/a.ts:1"]);

        // A pattern with a slash is matched against the path.
        let docs_only = SearchOptions { include: "docs/**".into(), ..Default::default() };
        assert_eq!(paths(&search(path, "needle", &docs_only, 50).unwrap()), vec!["docs/a.md:1"]);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn replace_rewrites_matches_and_leaves_an_undo_behind() {
        let dir = repo(&[("src/a.ts", "const oldName = 1;\nuse(oldName);\n"), ("src/b.ts", "nothing here\n")]);
        let path = dir.to_str().unwrap();

        let outcome = replace_all(path, "oldName", "newName", &SearchOptions::default(), None).unwrap();
        assert_eq!(outcome.replacements, 2);
        // Only the file that actually matched is touched.
        assert_eq!(outcome.files, 1);
        assert_eq!(
            fs::read_to_string(dir.join("src/a.ts")).unwrap(),
            "const newName = 1;\nuse(newName);\n"
        );

        // And the checkpoint restores it, which is what makes a project-wide replace safe.
        let checkpoint = outcome.checkpoint_id.expect("a checkpoint was taken");
        crate::git::checkpoint::restore(path, &checkpoint).unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("src/a.ts")).unwrap(),
            "const oldName = 1;\nuse(oldName);\n"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn replace_can_be_scoped_to_one_file_and_can_use_capture_groups() {
        let dir = repo(&[("a.ts", "call(1, 2);\n"), ("b.ts", "call(3, 4);\n")]);
        let path = dir.to_str().unwrap();

        let options = SearchOptions { regex: true, ..Default::default() };
        let outcome = replace_all(path, r"call\((\d+), (\d+)\)", "call($2, $1)", &options, Some("a.ts")).unwrap();
        assert_eq!(outcome.files, 1);
        assert_eq!(fs::read_to_string(dir.join("a.ts")).unwrap(), "call(2, 1);\n");
        // The file outside the scope is untouched.
        assert_eq!(fs::read_to_string(dir.join("b.ts")).unwrap(), "call(3, 4);\n");
        fs::remove_dir_all(&dir).ok();
    }
}
