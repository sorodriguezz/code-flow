//! Whether a task is small enough to skip the plan — decided before a single subscription token is
//! spent.
//!
//! A hybrid run costs the subscription two turns at least, the plan and the review, and each one
//! starts by loading the CLI's own context. For a change to one or two small files that overhead is
//! most of the bill, and more than asking the agent to do it outright. So when the objective itself
//! says where the change goes — it names the files, they exist, and they are small enough for the
//! local model to rewrite whole — the local model writes it straight from the objective, and the
//! review only runs if somebody asks for it.
//!
//! Deliberately conservative: anything it cannot read off the objective is a plan, because a wrong
//! "small" costs a bad edit while a wrong "large" only costs the tokens the user was already
//! prepared to spend.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::budget::Budget;
use super::plan::clean_path;
use super::prompts::padded_estimate;

/// The longest objective a direct run takes. A longer one is describing more than one change.
pub const MAX_DIRECT_GOAL_CHARS: usize = 600;
/// The most files a direct run touches. Each is written on its own from the same objective, which
/// stays coherent for two or three files and stops being so beyond that.
pub const MAX_DIRECT_FILES: usize = 3;
/// What a direct task costs besides its file and the objective: the executor's rules and framing.
const DIRECT_OVERHEAD_TOKENS: u64 = 900;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TriageFile {
    /// Relative to the repository.
    pub path: String,
    /// What the file costs the local model, padded the way the executor pads it.
    pub tokens: u64,
}

/// The verdict, and the files it rests on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Triage {
    /// The local model can write this straight from the objective.
    pub direct: bool,
    /// Why it cannot, when it cannot: `multi-repo` | `not-ready` | `no-files` | `not-found` |
    /// `ambiguous` | `too-many-files` | `too-long` | `file-too-big`. Empty when it can.
    pub reason: String,
    pub files: Vec<TriageFile>,
}

impl Triage {
    pub fn no(reason: &str) -> Self {
        Self { direct: false, reason: reason.to_string(), files: Vec::new() }
    }
}

/// What in the objective looks like a file: a path or a file name with an extension, wrapped or not
/// in backticks or quotes. URLs, version numbers ("1.2.3") and abbreviations ("e.g.") are not.
pub fn mentioned_files(goal: &str) -> Vec<String> {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    let pattern = PATTERN.get_or_init(|| {
        // Only the delimiter *before* is matched: one after would be consumed, and the next mention
        // ("a.ts b.ts") would lose the space it starts at.
        regex::Regex::new(r"(?:^|[\s`'\x22(\[{<,;])((?:[\w@.\-]+/)*[\w@\-][\w@.\-]*\.[A-Za-z0-9]{1,8})").expect("valid pattern")
    });
    let mut out: Vec<String> = Vec::new();
    for found in pattern.captures_iter(goal) {
        let candidate = found[1].trim_end_matches('.').to_string();
        let start = found.get(1).map(|m| m.start()).unwrap_or(0);
        // A host in a URL, not a file.
        if goal[..start].ends_with("://") || goal[..start].ends_with("//") {
            continue;
        }
        let extension = candidate.rsplit('.').next().unwrap_or("");
        if !extension.chars().any(|c| c.is_ascii_alphabetic()) {
            continue;
        }
        let stem = candidate.rsplit('/').next().unwrap_or(&candidate);
        let stem = stem.rsplit_once('.').map(|(stem, _)| stem).unwrap_or("");
        // "e.g", "i.e", "etc." — a stem of one letter is an abbreviation far more often than a file.
        if stem.chars().filter(|c| c.is_alphanumeric()).count() < 2 && !candidate.contains('/') {
            continue;
        }
        if !out.contains(&candidate) {
            out.push(candidate);
        }
    }
    out
}

/// The repository's tracked files, relative and `/`-separated — read from the index, and cached for
/// a minute because the dialog asks again as the objective is typed.
fn tracked_files(repo_root: &Path) -> Vec<String> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, Vec<String>)>>> = OnceLock::new();
    let key = repo_root.to_string_lossy().into_owned();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((at, files)) = cache.lock().ok().and_then(|map| map.get(&key).cloned()) {
        if at.elapsed() < Duration::from_secs(60) {
            return files;
        }
    }
    let files: Vec<String> = git2::Repository::open(repo_root)
        .and_then(|repo| repo.index())
        .map(|index| index.iter().filter_map(|entry| String::from_utf8(entry.path).ok()).collect())
        .unwrap_or_default();
    if let Ok(mut map) = cache.lock() {
        map.insert(key, (Instant::now(), files.clone()));
    }
    files
}

/// Where a mention points: the path itself when it exists, else the one tracked file it names.
enum Found {
    One(String),
    Many,
    None,
}

fn locate(repo_root: &Path, mention: &str, tracked: &mut Option<Vec<String>>) -> Found {
    if let Some(path) = clean_path(mention) {
        if repo_root.join(&path).is_file() {
            return Found::One(path);
        }
    }
    let files = tracked.get_or_insert_with(|| tracked_files(repo_root));
    let wanted = mention.trim_start_matches("./").to_string();
    let suffix = format!("/{wanted}");
    let mut matches = files.iter().filter(|file| **file == wanted || file.ends_with(&suffix));
    match (matches.next(), matches.next()) {
        (Some(only), None) => Found::One(only.clone()),
        (Some(_), Some(_)) => Found::Many,
        _ => Found::None,
    }
}

/// Decides whether `goal` can go straight to the local model in `repo_root`, under `budget`.
pub fn triage(repo_root: &Path, goal: &str, budget: &Budget) -> Triage {
    let goal = goal.trim();
    if goal.chars().count() > MAX_DIRECT_GOAL_CHARS {
        return Triage::no("too-long");
    }
    let mentions = mentioned_files(goal);
    if mentions.is_empty() {
        return Triage::no("no-files");
    }
    let mut tracked = None;
    let mut paths: Vec<String> = Vec::new();
    for mention in &mentions {
        match locate(repo_root, mention, &mut tracked) {
            Found::One(path) => {
                if !paths.contains(&path) {
                    paths.push(path);
                }
            }
            Found::Many => return Triage::no("ambiguous"),
            Found::None => return Triage::no("not-found"),
        }
    }
    if paths.len() > MAX_DIRECT_FILES {
        return Triage::no("too-many-files");
    }
    let goal_tokens = padded_estimate(goal);
    let mut files = Vec::new();
    for path in paths {
        let Ok(text) = std::fs::read_to_string(repo_root.join(&path)) else {
            return Triage::no("not-found");
        };
        let tokens = padded_estimate(&text);
        // The local model writes the whole file back, so it has to fit the answer as well as the
        // question — the same two limits the executor holds a whole-file task to.
        if tokens > budget.output as u64 * 9 / 10 || tokens + goal_tokens + DIRECT_OVERHEAD_TOKENS > budget.input as u64 {
            return Triage { direct: false, reason: "file-too-big".to_string(), files: vec![TriageFile { path, tokens }] };
        }
        files.push(TriageFile { path, tokens });
    }
    Triage { direct: true, reason: String::new(), files }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cf-hybrid-triage-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("src/orders")).unwrap();
        std::fs::create_dir_all(dir.join("src/admin/orders")).unwrap();
        std::fs::write(dir.join("src/orders/total.ts"), "export const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);\n").unwrap();
        std::fs::write(dir.join("src/orders/OrdersPage.tsx"), "export function OrdersPage() { return null; }\n").unwrap();
        std::fs::write(dir.join("src/admin/orders/OrdersPage.tsx"), "export function OrdersPage() { return null; }\n").unwrap();
        std::fs::write(dir.join("src/big.ts"), "export const x = 1;\n".repeat(4_000)).unwrap();
        let repo = git2::Repository::init(&dir).unwrap();
        let mut index = repo.index().unwrap();
        index.add_all(["*"], git2::IndexAddOption::DEFAULT, None).unwrap();
        index.write().unwrap();
        dir
    }

    fn budget() -> Budget {
        Budget { ctx: 16_384, output: 4_096, input: 11_776 }
    }

    #[test]
    fn files_are_read_off_the_objective() {
        assert_eq!(
            mentioned_files("En `src/orders/total.ts` cambia el redondeo, y en OrdersPage.tsx el título."),
            vec!["src/orders/total.ts", "OrdersPage.tsx"]
        );
        assert_eq!(mentioned_files("Rename it (see utils/date-format.js)."), vec!["utils/date-format.js"]);
        assert!(mentioned_files("Upgrade to 1.2.3, e.g. like https://example.com/docs.html says").is_empty());
        assert!(mentioned_files("Make the login button blue").is_empty());
    }

    #[test]
    fn a_change_to_a_small_named_file_goes_straight_to_the_local_model() {
        let root = repo();
        let triage = triage(&root, "In total.ts, round the sum to two decimals.", &budget());
        assert!(triage.direct, "{triage:?}");
        assert_eq!(triage.files[0].path, "src/orders/total.ts", "a bare file name is found by the one tracked file it names");
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn anything_it_cannot_read_off_the_objective_is_a_plan() {
        let root = repo();
        let b = budget();
        assert_eq!(triage(&root, "Make the login button blue", &b).reason, "no-files");
        assert_eq!(triage(&root, "Fix OrdersPage.tsx", &b).reason, "ambiguous", "two files share the name");
        assert_eq!(triage(&root, "Fix src/missing.ts", &b).reason, "not-found");
        assert_eq!(triage(&root, "Speed up src/big.ts", &b).reason, "file-too-big");
        assert_eq!(triage(&root, &format!("Fix src/orders/total.ts. {}", "More detail. ".repeat(60)), &b).reason, "too-long");
        assert!(triage(&root, "Fix src/orders/OrdersPage.tsx", &b).direct, "a full path is never ambiguous");
        std::fs::remove_dir_all(root).ok();
    }
}
