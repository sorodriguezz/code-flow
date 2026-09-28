//! Bisect: find the commit that broke something by halving the range between one known good and one
//! known bad commit.
//!
//! The search is git's own (`git bisect start / good / bad / skip / reset`), run through the CLI: it is
//! a state machine with its log in the git directory, and a terminal and this app can then take turns
//! at the same bisect without either confusing the other. What this module adds is the reading of that
//! state — which commit is being tested, how much of the range is left, and when the search has
//! narrowed to one commit — straight from the refs git keeps (`refs/bisect/bad`, `refs/bisect/good-*`,
//! `refs/bisect/skip-*`), so the graph can draw it without parsing git's prose.

use git2::{Oid, Repository};
use serde::{Deserialize, Serialize};

use super::cli;
use super::repo::open;

/// Marks a refusal because a bisect is running — undo and restore move HEAD, and doing that under a
/// bisect would test a commit git did not pick.
pub const BISECT_ACTIVE_PREFIX: &str = "BISECT_ACTIVE: ";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct BisectState {
    pub active: bool,
    pub bad: Option<String>,
    pub good: Vec<String>,
    pub skipped: Vec<String>,
    /// The commit under test — HEAD, while both ends are known and the search is not over.
    pub candidate: Option<String>,
    /// Commits still in the range, the bad one included.
    pub remaining: usize,
    /// git's own estimate of the tests left (see [`estimate_steps`]).
    pub steps: usize,
    /// The first bad commit, once the range is down to it.
    pub first_bad: Option<String>,
}

/// `estimate_bisect_steps` from git's `bisect.c`, so the number shown is the one `git bisect` prints.
pub fn estimate_steps(all: usize) -> usize {
    if all < 3 {
        return 0;
    }
    let n = usize::BITS as usize - 1 - all.leading_zeros() as usize;
    let e = 1usize << n;
    let x = all - e;
    if e < 3 * x {
        n
    } else {
        n - 1
    }
}

fn ids(repo: &Repository, glob: &str) -> Vec<Oid> {
    let Ok(refs) = repo.references_glob(glob) else { return vec![] };
    refs.flatten().filter_map(|r| r.target()).collect()
}

pub fn state_of(repo: &Repository) -> Result<BisectState, String> {
    // `BISECT_START` lives in the worktree's own git directory, as does the bisect's log — a bisect is
    // per worktree.
    if !repo.path().join("BISECT_START").exists() {
        return Ok(BisectState::default());
    }
    let bad = repo.find_reference("refs/bisect/bad").ok().and_then(|r| r.target());
    let good = ids(repo, "refs/bisect/good-*");
    let skipped = ids(repo, "refs/bisect/skip-*");

    let mut remaining = 0;
    if let Some(bad) = bad {
        if !good.is_empty() {
            let mut walk = repo.revwalk().map_err(|e| e.message().to_string())?;
            walk.push(bad).map_err(|e| e.message().to_string())?;
            for id in &good {
                walk.hide(*id).map_err(|e| e.message().to_string())?;
            }
            remaining = walk.count();
        }
    }
    let both_known = bad.is_some() && !good.is_empty();
    let done = both_known && remaining <= 1;
    let head = repo.head().ok().and_then(|h| h.target());
    Ok(BisectState {
        active: true,
        bad: bad.map(|id| id.to_string()),
        good: good.iter().map(|id| id.to_string()).collect(),
        skipped: skipped.iter().map(|id| id.to_string()).collect(),
        candidate: if both_known && !done { head.map(|id| id.to_string()) } else { None },
        steps: estimate_steps(remaining),
        remaining,
        first_bad: if done { bad.map(|id| id.to_string()) } else { None },
    })
}

pub fn state(path: &str) -> Result<BisectState, String> {
    state_of(&open(path)?)
}

fn run(path: &str, args: &[&str]) -> Result<(), String> {
    let out = cli::run_in(path, args, &[])?;
    if out.success {
        Ok(())
    } else {
        Err(out.detail())
    }
}

/// Starts a bisect with the first verdict already given: `rev` is `bad` or `good` per `verdict`.
/// Starting from a commit in the graph is how the search is begun here — the other end is marked the
/// same way, and git checks the first candidate out as soon as it knows both.
pub fn start(path: &str, verdict: &str, rev: &str) -> Result<BisectState, String> {
    if state(path)?.active {
        return mark(path, verdict, Some(rev));
    }
    run(path, &["bisect", "start"])?;
    if let Err(e) = mark(path, verdict, Some(rev)) {
        // A start that could not take its first verdict is a bisect with nothing in it; leaving it
        // running would put the banner up over a search that never began.
        let _ = run(path, &["bisect", "reset"]);
        return Err(e);
    }
    state(path)
}

/// `git bisect good|bad|skip [<rev>]` — HEAD (the candidate) when `rev` is `None`.
pub fn mark(path: &str, verdict: &str, rev: Option<&str>) -> Result<BisectState, String> {
    let verdict = match verdict {
        "good" | "bad" | "skip" => verdict,
        other => return Err(format!("unknown bisect verdict '{other}'")),
    };
    let mut args = vec!["bisect", verdict];
    if let Some(rev) = rev {
        args.push(rev);
    }
    run(path, &args)?;
    state(path)
}

/// `git bisect reset` — back to the branch the bisect started from.
pub fn reset(path: &str) -> Result<(), String> {
    run(path, &["bisect", "reset"])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = cli::run_in(dir.to_str().unwrap(), args, &[]).unwrap();
        assert!(out.success, "git {args:?}: {}", out.combined());
        out.stdout.trim().to_string()
    }

    /// Ten commits on `main`; the sixth writes `broken` into `state.txt`.
    fn fixture() -> (PathBuf, Vec<String>) {
        let dir = std::env::temp_dir().join(format!("cf-bisect-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "main"]);
        for (key, value) in [
            ("user.name", "Test"),
            ("user.email", "test@example.com"),
            ("commit.gpgsign", "false"),
            ("core.hooksPath", "/dev/null"),
        ] {
            git(&dir, &["config", key, value]);
        }
        let mut commits = Vec::new();
        for i in 1..=10 {
            let state = if i >= 6 { "broken" } else { "fine" };
            fs::write(dir.join("state.txt"), format!("{state}\n")).unwrap();
            fs::write(dir.join("counter.txt"), format!("{i}\n")).unwrap();
            git(&dir, &["add", "-A"]);
            git(&dir, &["commit", "-q", "-m", &format!("commit {i}")]);
            commits.push(git(&dir, &["rev-parse", "HEAD"]));
        }
        (dir, commits)
    }

    #[test]
    fn a_bisect_finds_the_first_bad_commit() {
        let (dir, commits) = fixture();
        let path = dir.to_str().unwrap();
        assert!(!state(path).unwrap().active);

        let s = start(path, "bad", &commits[9]).unwrap();
        assert!(s.active && s.candidate.is_none(), "one end is not enough to test anything");
        let mut s = mark(path, "good", Some(&commits[0])).unwrap();
        assert_eq!(s.remaining, 9);
        assert_eq!(s.steps, estimate_steps(9));

        let mut rounds = 0;
        while s.first_bad.is_none() {
            let candidate = s.candidate.clone().expect("a candidate while the search runs");
            assert_eq!(git(&dir, &["rev-parse", "HEAD"]), candidate, "the candidate is what is checked out");
            let broken = fs::read_to_string(dir.join("state.txt")).unwrap().trim() == "broken";
            s = mark(path, if broken { "bad" } else { "good" }, None).unwrap();
            rounds += 1;
            assert!(rounds < 10, "the search did not converge");
        }
        assert_eq!(s.first_bad.as_deref(), Some(commits[5].as_str()));

        reset(path).unwrap();
        assert!(!state(path).unwrap().active);
        assert_eq!(git(&dir, &["branch", "--show-current"]), "main");
        assert_eq!(git(&dir, &["rev-parse", "HEAD"]), commits[9]);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn skipping_moves_to_another_candidate() {
        let (dir, commits) = fixture();
        let path = dir.to_str().unwrap();
        start(path, "good", &commits[0]).unwrap();
        let s = mark(path, "bad", Some(&commits[9])).unwrap();
        let first = s.candidate.clone().unwrap();
        let s = mark(path, "skip", None).unwrap();
        assert_eq!(s.skipped, vec![first.clone()]);
        assert_ne!(s.candidate.as_deref(), Some(first.as_str()));
        reset(path).unwrap();
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_unknown_revision_leaves_no_bisect_behind() {
        let (dir, _) = fixture();
        let path = dir.to_str().unwrap();
        assert!(start(path, "bad", "not-a-revision").is_err());
        assert!(!state(path).unwrap().active);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_step_estimate_matches_git() {
        // Values `git bisect` prints for these range sizes.
        assert_eq!(estimate_steps(1), 0);
        assert_eq!(estimate_steps(2), 0);
        assert_eq!(estimate_steps(3), 1);
        assert_eq!(estimate_steps(9), 2);
        assert_eq!(estimate_steps(16), 3);
        assert_eq!(estimate_steps(24), 4);
        assert_eq!(estimate_steps(1000), 9);
    }
}
