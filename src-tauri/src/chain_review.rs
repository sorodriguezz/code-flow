//! A reviewer in a chain: a step whose answer decides whether the plan goes on or goes back.
//!
//! A chain already loops — a step's `on_fail` may point at an earlier one — but only an exit code could
//! send it back. This lets an **agent** do it: a step marked as a review reads the work, answers with
//! findings, and the plan returns to the step before it when there is something that must change. The
//! point of "until it is polished" is the stop, so most of this module is about *when to stop*.
//!
//! # What makes a loop end
//!
//! A reviewer model always finds something. Left alone, "until polished" is "until the budget runs
//! out", so four things bound it, all decided here from facts and none from the model's mood:
//!
//! 1. **Severity.** Findings are `must` (wrong), `should` (works, could be better) or `nit` (taste). A
//!    plan configured for *correct* goes back only for `must`; one configured for *polished* also for
//!    `should`. A `nit` never sends work back.
//! 2. **Anchoring.** A finding names a file, and the file must exist in one of the chain's repositories.
//!    One that does not is dropped: a finding nobody can go and look at is the commonest way a loop
//!    starts chasing nothing.
//! 3. **No progress.** The same working-tree state twice in a row means the worker changed nothing; the
//!    same findings twice means it was asked the same thing and did not answer it; a count of blocking
//!    findings that does not fall over two laps means it is not converging.
//! 4. **A cap on laps**, three by default, never more than [`MAX_LAPS_CAP`].
//!
//! Hitting 2, 3 or 4 does not fail the chain. It **parks** it, so the person decides: accept it as it
//! is, give it one more lap, or stop. Failing silently would throw away work that is probably mostly
//! right.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Laps a reviewer allows unless told otherwise.
pub const DEFAULT_MAX_LAPS: i64 = 3;
/// The most laps a reviewer can be configured for.
pub const MAX_LAPS_CAP: i64 = 8;
/// A finding's text is cut to this: it is written into the next lap's brief, where length is cost.
const MAX_FIELD: usize = 400;
/// How many blocking findings travel back to the worker. More is a wall of text nobody acts on.
const MAX_SENT_BACK: usize = 12;

/// How strict the review is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Exigence {
    /// Goes back only for what is wrong (`must`). The default.
    Correct,
    /// Also goes back for what could be better (`should`).
    Polished,
}

impl Exigence {
    pub fn parse(text: &str) -> Self {
        if text.trim().eq_ignore_ascii_case("polished") {
            Self::Polished
        } else {
            Self::Correct
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Correct => "correct",
            Self::Polished => "polished",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Nit,
    Should,
    Must,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Finding {
    pub severity: Severity,
    /// Relative to a repository, as the reviewer wrote it. Empty when it named none.
    pub file: String,
    pub line: Option<u32>,
    pub problem: String,
    /// How to check that it is fixed. Optional.
    pub check: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Review {
    pub ok: bool,
    pub findings: Vec<Finding>,
}

/// What the reviewer is asked to answer with. Appended to its own instruction by the caller.
pub fn instruction(exigence: Exigence) -> String {
    let goes_back = match exigence {
        Exigence::Correct => "only `must` findings send the work back",
        Exigence::Polished => "`must` and `should` findings send the work back",
    };
    format!(
        "You are the reviewer of this plan. Read the work in the repositories and judge it against what was asked. \
         Do not edit anything.\n\n\
         Answer in exactly this shape:\n\
         VERDICT: OK | FIX\n\
         FINDINGS:\n\
         - [must|should|nit] path/to/file:LINE — what is wrong — how to check it is fixed\n\n\
         Rules: `must` is something wrong or missing, `should` works but could be better, `nit` is taste. \
         Here {goes_back}. Every finding names a real file that exists in a repository; one that names no file, or a file \
         that is not there, is ignored. Do not repeat a finding you already raised and was fixed. \
         If there is nothing to send back, answer `VERDICT: OK` and no findings."
    )
}

/// Reads a reviewer's answer. `None` when there is no `VERDICT:` line at all: an answer that cannot be
/// read is not an approval, and the caller parks the plan rather than letting it through.
pub fn parse(answer: &str) -> Option<Review> {
    let mut ok = None;
    let mut findings = Vec::new();
    for raw in answer.lines() {
        let line = raw.trim().trim_start_matches(['*', '#', '>']).trim();
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("verdict:") {
            // The last VERDICT line wins: a model that corrects itself writes the correction last.
            let word = rest.trim().trim_matches(['*', '`', '.', ' ']);
            ok = Some(match word.split_whitespace().next().unwrap_or_default() {
                "ok" | "approved" | "pass" | "lgtm" => true,
                _ => false,
            });
            continue;
        }
        if let Some(found) = finding(line) {
            findings.push(found);
        }
    }
    ok.map(|ok| Review { ok, findings })
}

/// `- [must] src/a.rs:42 — it divides by zero — call it with 0` and its cousins.
fn finding(line: &str) -> Option<Finding> {
    let line = line.trim_start_matches(['-', '*', '•']).trim_start();
    let open = line.strip_prefix('[')?;
    let (tag, rest) = open.split_once(']')?;
    let severity = match tag.trim().to_ascii_lowercase().as_str() {
        "must" | "blocker" | "critical" | "high" => Severity::Must,
        "should" | "major" | "medium" => Severity::Should,
        "nit" | "minor" | "low" | "style" => Severity::Nit,
        _ => return None,
    };
    let rest = rest.trim();
    // The three parts are separated by an em dash, a spaced hyphen or a pipe, whichever the model used.
    let mut parts = rest.splitn(3, |c| c == '—' || c == '–' || c == '|').map(str::trim);
    let mut head = parts.next().unwrap_or_default().to_string();
    let mut problem = parts.next().unwrap_or_default().to_string();
    let check = parts.next().unwrap_or_default().to_string();
    if problem.is_empty() {
        // "path/to/file:42 - problem": a spaced hyphen as the only separator.
        if let Some((location, text)) = head.clone().split_once(" - ") {
            head = location.trim().to_string();
            problem = text.trim().to_string();
        }
    }
    let (file, line_no) = split_location(&head);
    Some(Finding { severity, file, line: line_no, problem: cut(&problem), check: cut(&check) })
}

fn cut(text: &str) -> String {
    text.chars().take(MAX_FIELD).collect()
}

/// `src/a.rs:42` → (`src/a.rs`, 42). Anything that is not a plausible path comes back empty, so it is
/// dropped by [`ground`] instead of being looked up on disk.
fn split_location(head: &str) -> (String, Option<u32>) {
    let head = head.trim().trim_matches('`');
    let (path, line) = match head.rsplit_once(':') {
        Some((path, line)) if line.chars().all(|c| c.is_ascii_digit()) && !line.is_empty() => (path, line.parse().ok()),
        _ => (head, None),
    };
    let plausible = !path.is_empty()
        && path.len() <= 300
        && !path.contains(char::is_whitespace)
        && !path.chars().any(|c| c.is_control());
    (if plausible { path.to_string() } else { String::new() }, line)
}

/// Keeps the findings whose file exists under one of `roots` (`exists` answers for a path). Absolute
/// paths, `..` and anything that escapes a root are refused before the question is asked: a model's
/// text must never choose which file the app looks at.
pub fn ground(findings: Vec<Finding>, roots: &[String], exists: &dyn Fn(&std::path::Path) -> bool) -> Vec<Finding> {
    findings
        .into_iter()
        .filter(|found| {
            if found.file.is_empty() {
                return false;
            }
            let relative = std::path::Path::new(&found.file);
            let safe = !relative.is_absolute()
                && relative.components().all(|part| matches!(part, std::path::Component::Normal(_) | std::path::Component::CurDir));
            safe && roots.iter().any(|root| exists(&std::path::Path::new(root).join(relative)))
        })
        .collect()
}

/// The findings that send work back under `exigence`.
pub fn blocking(findings: &[Finding], exigence: Exigence) -> Vec<Finding> {
    let floor = match exigence {
        Exigence::Correct => Severity::Must,
        Exigence::Polished => Severity::Should,
    };
    findings.iter().filter(|found| found.severity >= floor).cloned().collect()
}

/// A hash of what the findings *say*, not where: a line number moves when the worker edits above it,
/// and the same complaint at a new line is still the same complaint.
pub fn findings_hash(findings: &[Finding]) -> String {
    let mut keys: Vec<String> = findings
        .iter()
        .map(|found| format!("{}|{}", found.file.to_ascii_lowercase(), found.problem.to_ascii_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")))
        .collect();
    keys.sort();
    keys.dedup();
    hex::encode(Sha256::digest(keys.join("\n").as_bytes()))
}

/// One finished lap, as the ledger keeps it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lap {
    pub lap: i64,
    pub blocking: i64,
    pub findings_hash: String,
    pub state_hash: String,
}

/// Why a loop is stopped for the person to decide.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Stop {
    /// The worker changed nothing since the last review.
    NoProgress,
    /// The reviewer raised the same things as last time.
    SameFindings,
    /// The number of blocking findings did not fall over two laps.
    Stalled,
    /// The configured number of laps is spent.
    LapsSpent,
}

impl Stop {
    /// The translation key the chain parks under.
    pub fn reason(self) -> &'static str {
        match self {
            Self::NoProgress | Self::SameFindings => "chain.noProgress",
            Self::Stalled => "chain.stalled",
            Self::LapsSpent => "chain.lapsExhausted",
        }
    }
}

/// Whether the loop must stop **instead of** sending the work back once more. `done` are the laps
/// already sent back, oldest first; `now` is the review that has just found something to send back.
pub fn stop_reason(done: &[Lap], now: &Lap, max_laps: i64) -> Option<Stop> {
    if let Some(last) = done.last() {
        if !now.state_hash.is_empty() && last.state_hash == now.state_hash {
            return Some(Stop::NoProgress);
        }
        if last.findings_hash == now.findings_hash {
            return Some(Stop::SameFindings);
        }
    }
    if done.len() >= 2 {
        let (a, b) = (&done[done.len() - 2], &done[done.len() - 1]);
        if now.blocking >= b.blocking && b.blocking >= a.blocking {
            return Some(Stop::Stalled);
        }
    }
    if done.len() as i64 >= max_laps.clamp(1, MAX_LAPS_CAP) {
        return Some(Stop::LapsSpent);
    }
    None
}

/// The note the worker reads at the top of the next lap: what to fix, with where and how to check, and
/// a short history so it does not undo what an earlier lap fixed.
pub fn note_for_worker(blocking: &[Finding], history: &[Lap], lap: i64) -> String {
    let mut out = format!("The reviewer sent this back (lap {lap}). Fix exactly these, and nothing else:\n");
    for found in blocking.iter().take(MAX_SENT_BACK) {
        let at = match found.line {
            Some(line) => format!("{}:{line}", found.file),
            None => found.file.clone(),
        };
        out.push_str(&format!("- [{}] {at} — {}", severity_word(found.severity), found.problem));
        if !found.check.is_empty() {
            out.push_str(&format!(" (check: {})", found.check));
        }
        out.push('\n');
    }
    if blocking.len() > MAX_SENT_BACK {
        out.push_str(&format!("…and {} more of the same kind.\n", blocking.len() - MAX_SENT_BACK));
    }
    if !history.is_empty() {
        let trail: Vec<String> = history.iter().map(|lap| format!("lap {}: {}", lap.lap, lap.blocking)).collect();
        out.push_str(&format!("\nBlocking findings in earlier laps — {}. Do not undo what those laps fixed.\n", trail.join(", ")));
    }
    out
}

fn severity_word(severity: Severity) -> &'static str {
    match severity {
        Severity::Must => "must",
        Severity::Should => "should",
        Severity::Nit => "nit",
    }
}

// ------------------------------------------------------------------------------ protected files

/// Files matching `globs` that differ from `HEAD` in any of `roots` (changed, added or untracked), each as
/// `root-relative path` → a hash of its content (`"-"` for one that was deleted). Blocking: it runs `git`.
///
/// The key carries the repository (`<index>:<path>`) so two repositories with a `tests/` folder do not
/// shadow one another.
pub fn protected_state(roots: &[String], globs: &[String]) -> std::collections::BTreeMap<String, String> {
    let mut out = std::collections::BTreeMap::new();
    let mut builder = globset::GlobSetBuilder::new();
    let mut any = false;
    for glob in globs.iter().map(|g| g.trim()).filter(|g| !g.is_empty()) {
        if let Ok(parsed) = globset::Glob::new(glob) {
            builder.add(parsed);
            any = true;
        }
    }
    let Ok(set) = builder.build() else { return out };
    if !any {
        return out;
    }
    for (index, root) in roots.iter().enumerate() {
        let git = |args: &[&str]| -> String {
            crate::proc::std_command("git").arg("-C").arg(root).args(args).output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default()
        };
        let mut names: std::collections::BTreeSet<String> = git(&["diff", "HEAD", "--name-only"]).lines().map(str::to_string).collect();
        names.extend(git(&["ls-files", "--others", "--exclude-standard"]).lines().map(str::to_string));
        for name in names.into_iter().filter(|name| !name.is_empty() && set.is_match(name)) {
            let path = std::path::Path::new(root).join(&name);
            let hash = match std::fs::read(&path) {
                Ok(bytes) => hex::encode(Sha256::digest(&bytes)),
                Err(_) => "-".to_string(),
            };
            out.insert(format!("{index}:{name}"), hash);
        }
    }
    out
}

/// The protected files the worker changed: every one in `now` whose content differs from what the chain
/// started with (`baseline`). A file the person had already changed before the chain began is in the
/// baseline with the same hash, so it is not the worker's doing; one that was clean and now is not, or one
/// edited further, is.
pub fn protected_violations(now: &std::collections::BTreeMap<String, String>, baseline: &std::collections::BTreeMap<String, String>) -> Vec<String> {
    let mut out: Vec<String> = now.iter().filter(|(key, hash)| baseline.get(*key) != Some(*hash)).map(|(key, _)| key.split_once(':').map_or(key.as_str(), |(_, name)| name).to_string()).collect();
    // A protected file that was changed at the start and has since been put back is gone from `now`:
    // that is the worker restoring it, not a violation.
    out.sort();
    out.dedup();
    out
}

/// The synthetic `must` findings for the protected files the worker changed. They name real files by
/// construction, so they are never dropped by [`ground`].
pub fn protected_findings(violations: &[String]) -> Vec<Finding> {
    violations
        .iter()
        .map(|file| Finding {
            severity: Severity::Must,
            file: file.clone(),
            line: None,
            problem: "this file is protected — the plan is judged by it, so the worker must not change it. Restore it to what it was and fix the code instead".to_string(),
            check: format!("`git diff HEAD -- {file}` shows nothing the worker added"),
        })
        .collect()
}

/// What the caller read **outside** the database lock, because it touches disk and runs `git`: the
/// reviewer's answer parsed, its findings anchored in the chain's repositories, and a fingerprint of
/// the working copies at the moment it answered.
#[derive(Debug, Clone, Default)]
pub struct ReviewEnv {
    /// `None` when the answer had no `VERDICT:` line.
    pub review: Option<Review>,
    /// The findings whose file exists in a repository.
    pub grounded: Vec<Finding>,
    pub state_hash: String,
    /// Protected files the worker changed since the chain began (see [`protected_violations`]).
    pub protected_changed: Vec<String>,
}

/// Reads the answer and the working copies. Blocking: it runs `git`, so call it from a blocking task.
pub fn prepare(answer: &str, roots: &[String], globs: &[String], baseline: &std::collections::BTreeMap<String, String>) -> ReviewEnv {
    let review = parse(answer);
    let grounded = review.as_ref().map(|review| ground(review.findings.clone(), roots, &|path| path.is_file())).unwrap_or_default();
    let protected_changed = protected_violations(&protected_state(roots, globs), baseline);
    ReviewEnv { review, grounded, state_hash: working_state(roots), protected_changed }
}

/// Files read from an untracked listing: how many, and how much of each.
const MAX_UNTRACKED_FILES: usize = 200;
const MAX_FILE_BYTES: u64 = 512 * 1024;
const MAX_DIFF_BYTES: usize = 4 * 1024 * 1024;

/// A fingerprint of every working copy: what differs from `HEAD`, and what is not tracked yet. Two
/// reviews with the same fingerprint looked at the same code, whatever the worker said in between.
fn working_state(roots: &[String]) -> String {
    let mut parts = Vec::new();
    for root in roots {
        let git = |args: &[&str]| -> Vec<u8> {
            crate::proc::std_command("git")
                .arg("-C")
                .arg(root)
                .args(args)
                .output()
                .map(|output| output.stdout)
                .unwrap_or_default()
        };
        let mut diff = git(&["diff", "HEAD", "--no-color", "--no-ext-diff"]);
        diff.truncate(MAX_DIFF_BYTES);
        parts.push(String::from_utf8_lossy(&diff).into_owned());
        let listing = git(&["ls-files", "--others", "--exclude-standard"]);
        for name in String::from_utf8_lossy(&listing).lines().take(MAX_UNTRACKED_FILES) {
            let path = std::path::Path::new(root).join(name);
            let small = std::fs::metadata(&path).map(|meta| meta.is_file() && meta.len() <= MAX_FILE_BYTES).unwrap_or(false);
            let body = if small { std::fs::read(&path).unwrap_or_default() } else { Vec::new() };
            parts.push(format!("{name}\0{}", String::from_utf8_lossy(&body)));
        }
    }
    state_hash(&parts)
}

/// A fingerprint of what a set of working copies currently holds. `parts` is whatever the caller read —
/// the output of `git diff HEAD` and the contents of untracked files, repository by repository.
pub fn state_hash(parts: &[String]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update((part.len() as u64).to_le_bytes());
        hasher.update(part.as_bytes());
    }
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn must(file: &str, problem: &str) -> Finding {
        Finding { severity: Severity::Must, file: file.into(), line: Some(1), problem: problem.into(), check: String::new() }
    }

    const ANSWER: &str = "I read the code.\nVERDICT: FIX\nFINDINGS:\n\
        - [must] src/a.rs:42 — divides by zero when the list is empty — call it with []\n\
        - [should] src/b.rs — the name is misleading\n\
        - [nit] src/c.rs:3 | spacing\n\
        - [must] no file given here\n";

    #[test]
    fn a_review_is_read_into_severities_locations_and_checks() {
        let review = parse(ANSWER).unwrap();
        assert!(!review.ok);
        assert_eq!(review.findings.len(), 4);
        let first = &review.findings[0];
        assert_eq!((first.severity, first.file.as_str(), first.line), (Severity::Must, "src/a.rs", Some(42)));
        assert!(first.problem.contains("divides by zero") && first.check.contains("call it with"));
        assert_eq!(review.findings[1].line, None);
        assert_eq!(review.findings[2].severity, Severity::Nit);
        // A finding with no path reads as having none, so it is dropped when grounded.
        assert_eq!(review.findings[3].file, "");
    }

    #[test]
    fn the_verdict_decides_ok_and_the_last_one_wins() {
        assert!(parse("VERDICT: OK").unwrap().ok);
        assert!(parse("**VERDICT: OK**").unwrap().ok);
        assert!(!parse("VERDICT: FIX").unwrap().ok);
        assert!(parse("VERDICT: FIX\nOn reflection:\nVERDICT: OK").unwrap().ok);
    }

    #[test]
    fn an_answer_with_no_verdict_is_not_an_approval() {
        assert!(parse("Looks fine to me, ship it.").is_none());
        assert!(parse("").is_none());
    }

    #[test]
    fn a_hyphen_separated_finding_is_read_too() {
        let review = parse("VERDICT: FIX\n- [must] src/x.rs:7 - off by one in the loop").unwrap();
        assert_eq!(review.findings[0].file, "src/x.rs");
        assert_eq!(review.findings[0].problem, "off by one in the loop");
    }

    #[test]
    fn only_files_that_exist_inside_a_repository_anchor_a_finding() {
        let roots = vec!["/work/app".to_string()];
        let exists = |path: &std::path::Path| path.to_string_lossy() == "/work/app/src/a.rs";
        let kept = ground(
            vec![must("src/a.rs", "real"), must("src/ghost.rs", "invented"), must("", "no file"), must("../../etc/passwd", "escape"), must("/etc/passwd", "absolute")],
            &roots,
            &exists,
        );
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].problem, "real");
    }

    #[test]
    fn what_goes_back_depends_on_the_exigence_and_a_nit_never_does() {
        let findings = vec![
            must("a", "wrong"),
            Finding { severity: Severity::Should, ..must("b", "could be better") },
            Finding { severity: Severity::Nit, ..must("c", "taste") },
        ];
        assert_eq!(blocking(&findings, Exigence::Correct).len(), 1);
        assert_eq!(blocking(&findings, Exigence::Polished).len(), 2);
    }

    #[test]
    fn the_same_complaint_at_another_line_hashes_the_same() {
        let a = vec![Finding { line: Some(10), ..must("src/a.rs", "Divides  by ZERO") }];
        let b = vec![Finding { line: Some(99), ..must("SRC/a.rs", "divides by zero") }];
        assert_eq!(findings_hash(&a), findings_hash(&b));
        assert_ne!(findings_hash(&a), findings_hash(&[must("src/a.rs", "something else")]));
    }

    fn lap(n: i64, blocking: i64, findings: &str, state: &str) -> Lap {
        Lap { lap: n, blocking, findings_hash: findings.into(), state_hash: state.into() }
    }

    #[test]
    fn a_worker_that_changed_nothing_stops_the_loop() {
        let done = [lap(1, 3, "f1", "s1")];
        assert_eq!(stop_reason(&done, &lap(2, 3, "f2", "s1"), 3), Some(Stop::NoProgress));
    }

    #[test]
    fn the_same_findings_twice_stop_the_loop() {
        let done = [lap(1, 3, "f1", "s1")];
        assert_eq!(stop_reason(&done, &lap(2, 3, "f1", "s2"), 3), Some(Stop::SameFindings));
    }

    #[test]
    fn a_count_that_does_not_fall_over_two_laps_is_a_stall() {
        let done = [lap(1, 3, "f1", "s1"), lap(2, 3, "f2", "s2")];
        assert_eq!(stop_reason(&done, &lap(3, 3, "f3", "s3"), 8), Some(Stop::Stalled));
        // Falling at any step is progress.
        let falling = [lap(1, 5, "f1", "s1"), lap(2, 3, "f2", "s2")];
        assert_eq!(stop_reason(&falling, &lap(3, 2, "f3", "s3"), 8), None);
    }

    #[test]
    fn the_configured_laps_are_a_hard_cap() {
        let done = [lap(1, 5, "f1", "s1"), lap(2, 4, "f2", "s2"), lap(3, 3, "f3", "s3")];
        assert_eq!(stop_reason(&done, &lap(4, 2, "f4", "s4"), 3), Some(Stop::LapsSpent));
        assert_eq!(stop_reason(&done, &lap(4, 2, "f4", "s4"), 4), None);
        // Whatever is configured, never past the cap.
        let many: Vec<Lap> = (1..=8).map(|n| lap(n, 10 - n, &format!("f{n}"), &format!("s{n}"))).collect();
        assert_eq!(stop_reason(&many, &lap(9, 1, "f9", "s9"), 100), Some(Stop::LapsSpent));
    }

    #[test]
    fn the_first_lap_has_nothing_to_compare_with() {
        assert_eq!(stop_reason(&[], &lap(1, 4, "f1", "s1"), 3), None);
    }

    #[test]
    fn the_note_names_each_finding_with_where_and_how_to_check_and_carries_the_history() {
        let blocking = vec![Finding { check: "run the test".into(), ..must("src/a.rs", "off by one") }];
        let note = note_for_worker(&blocking, &[lap(1, 4, "f", "s")], 2);
        assert!(note.contains("lap 2") && note.contains("src/a.rs:1") && note.contains("off by one"));
        assert!(note.contains("check: run the test"));
        assert!(note.contains("lap 1: 4") && note.contains("Do not undo"));
    }

    #[test]
    fn the_state_hash_changes_with_content_and_cannot_be_forged_by_moving_a_boundary() {
        assert_eq!(state_hash(&["a".into(), "b".into()]), state_hash(&["a".into(), "b".into()]));
        assert_ne!(state_hash(&["a".into(), "b".into()]), state_hash(&["ab".into()]));
        assert_ne!(state_hash(&["a".into()]), state_hash(&["b".into()]));
    }

    fn map(pairs: &[(&str, &str)]) -> std::collections::BTreeMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn a_protected_file_the_worker_changed_is_a_violation() {
        let baseline = map(&[]);
        let now = map(&[("0:src/a.test.ts", "h1")]);
        assert_eq!(protected_violations(&now, &baseline), vec!["src/a.test.ts".to_string()]);
    }

    #[test]
    fn a_file_the_person_had_already_changed_is_not_blamed_on_the_worker() {
        let baseline = map(&[("0:src/a.test.ts", "mine")]);
        assert!(protected_violations(&map(&[("0:src/a.test.ts", "mine")]), &baseline).is_empty());
        // Edited further by the worker: that part is theirs.
        assert_eq!(protected_violations(&map(&[("0:src/a.test.ts", "worker")]), &baseline).len(), 1);
    }

    #[test]
    fn a_file_put_back_is_no_longer_a_violation() {
        assert!(protected_violations(&map(&[]), &map(&[("0:src/a.test.ts", "mine")])).is_empty());
    }

    #[test]
    fn protected_findings_are_must_and_name_the_file() {
        let found = protected_findings(&["tests/a.rs".to_string()]);
        assert_eq!((found[0].severity, found[0].file.as_str()), (Severity::Must, "tests/a.rs"));
        assert!(found[0].problem.contains("Restore"));
    }

    #[test]
    fn the_protected_state_of_a_real_repository_sees_a_changed_test_and_ignores_the_rest() {
        let dir = std::env::temp_dir().join(format!("cf-prot-{}-{}", std::process::id(), uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        let git = |args: &[&str]| {
            let out = crate::proc::std_command("git").arg("-C").arg(&dir).args(args).output().unwrap();
            assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
        };
        git(&["init", "-q"]);
        git(&["config", "user.email", "t@example.test"]);
        git(&["config", "user.name", "t"]);
        std::fs::write(dir.join("src/a.test.ts"), "expect(1).toBe(1)").unwrap();
        std::fs::write(dir.join("src/a.ts"), "export const a = 1").unwrap();
        git(&["add", "."]);
        git(&["commit", "-qm", "init"]);
        let roots = vec![dir.display().to_string()];
        let globs = vec!["**/*.test.ts".to_string()];
        assert!(protected_state(&roots, &globs).is_empty(), "a clean tree has nothing changed");
        // The worker edits the code and the test.
        std::fs::write(dir.join("src/a.ts"), "export const a = 2").unwrap();
        std::fs::write(dir.join("src/a.test.ts"), "expect(1).toBe(2)").unwrap();
        let now = protected_state(&roots, &globs);
        assert_eq!(now.keys().collect::<Vec<_>>(), vec!["0:src/a.test.ts"], "only the protected file is tracked");
        assert_eq!(protected_violations(&now, &map(&[])), vec!["src/a.test.ts".to_string()]);
        // Restored: gone.
        git(&["checkout", "--", "src/a.test.ts"]);
        assert!(protected_violations(&protected_state(&roots, &globs), &map(&[])).is_empty());
        assert!(protected_state(&roots, &[]).is_empty(), "no globs, nothing protected");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_instruction_states_the_threshold_it_was_given() {
        assert!(instruction(Exigence::Correct).contains("only `must`"));
        assert!(instruction(Exigence::Polished).contains("`must` and `should`"));
        assert_eq!(Exigence::parse("polished"), Exigence::Polished);
        assert_eq!(Exigence::parse("anything else"), Exigence::Correct);
    }
}
