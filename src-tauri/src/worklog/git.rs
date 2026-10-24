//! The user's commits of a period in one repository, read with git2 — every local branch (worktrees
//! share them), then the remote-tracking ones, so work not merged yet and work pushed from another
//! machine both count (user, 2026-10-23: «también commits en worktrees/ramas no mergeadas»).
//!
//! **Which branch a commit is filed under** is the first that reaches it, walking the default branch
//! first: a commit already on `main` is merged work and says `main`; one reachable only from
//! `feature/x` is still in progress there — which is what «Hoy» reads.
//!
//! Merge commits are left out: they are the act of merging, not work, and on a busy repository they
//! would outnumber the commits they bring in.

use std::collections::HashSet;

use git2::{BranchType, Oid, Repository, Sort};

use super::{CommitItem, Period};

/// Who «the user» is in a repository: the emails (and, without any, the names) commits are matched on.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Identity {
    pub emails: Vec<String>,
    pub names: Vec<String>,
}

impl Identity {
    pub fn add_email(&mut self, email: &str) {
        let email = email.trim().to_lowercase();
        if !email.is_empty() && !self.emails.contains(&email) {
            self.emails.push(email);
        }
    }

    pub fn add_name(&mut self, name: &str) {
        let name = name.trim().to_lowercase();
        if !name.is_empty() && !self.names.contains(&name) {
            self.names.push(name);
        }
    }

    pub fn is_empty(&self) -> bool {
        self.emails.is_empty() && self.names.is_empty()
    }

    /// An email is the identity; a name only counts when no email is known (two people share a name
    /// far more often than an address).
    pub fn matches(&self, email: Option<&str>, name: Option<&str>) -> bool {
        if !self.emails.is_empty() {
            return email.is_some_and(|e| self.emails.iter().any(|mine| mine.eq_ignore_ascii_case(e.trim())));
        }
        name.is_some_and(|n| self.names.iter().any(|mine| mine.eq_ignore_ascii_case(n.trim())))
    }
}

/// The repository's own identity (its config, then the global one) plus `extra` — the emails the
/// user also commits with, from the workspace's identity or other repositories.
pub fn identity_of(repo: &Repository, extra: &Identity) -> Identity {
    let mut identity = extra.clone();
    if let Ok(config) = repo.config() {
        if let Ok(email) = config.get_string("user.email") {
            identity.add_email(&email);
        }
        if let Ok(name) = config.get_string("user.name") {
            identity.add_name(&name);
        }
    }
    identity
}

/// The branches walked, in the order that decides where a commit is filed: the default branch, the
/// one checked out, the other local ones, then the remote-tracking ones.
fn branch_tips(repo: &Repository) -> Vec<(String, Oid)> {
    let mut local: Vec<(String, Oid)> = Vec::new();
    if let Ok(branches) = repo.branches(Some(BranchType::Local)) {
        for (branch, _) in branches.flatten() {
            if let (Ok(Some(name)), Some(oid)) = (branch.name(), branch.get().target()) {
                local.push((name.to_string(), oid));
            }
        }
    }
    let head = repo.head().ok().and_then(|h| h.shorthand().map(str::to_string));
    let default = ["main", "master", "trunk", "develop"].iter().find(|d| local.iter().any(|(n, _)| n == *d)).map(|d| d.to_string());
    let rank = |name: &str| -> u8 {
        if Some(name) == default.as_deref() {
            0
        } else if Some(name) == head.as_deref() {
            1
        } else {
            2
        }
    };
    local.sort_by(|a, b| rank(&a.0).cmp(&rank(&b.0)).then_with(|| a.0.cmp(&b.0)));
    let mut remote: Vec<(String, Oid)> = Vec::new();
    if let Ok(branches) = repo.branches(Some(BranchType::Remote)) {
        for (branch, _) in branches.flatten() {
            if let (Ok(Some(name)), Some(oid)) = (branch.name(), branch.get().target()) {
                if !name.ends_with("/HEAD") {
                    remote.push((name.to_string(), oid));
                }
            }
        }
    }
    remote.sort();
    if local.is_empty() {
        // A repository with a detached HEAD and no branch still has work to show.
        if let Some(oid) = repo.head().ok().and_then(|h| h.target()) {
            local.push(("HEAD".into(), oid));
        }
    }
    local.into_iter().chain(remote).collect()
}

/// How far back of `start` a walk goes on before it stops: commit times are not monotonic along
/// history (a rebase keeps author dates), so a day of slack keeps an older-dated parent from ending
/// the walk before a newer one it leads to.
const SLACK_SECONDS: i64 = 3 * 86_400;
/// Most commits looked at per branch — a guard against a pathological history, far above a period.
const WALK_LIMIT: usize = 20_000;

/// The user's commits of `period` in the repository at `path`, newest first, at most `max`, and
/// the branches (other than the default one) they are still only on.
pub fn commits(path: &str, identity: &Identity, period: &Period, max: usize) -> Result<(Vec<CommitItem>, Vec<String>), String> {
    let repo = Repository::open(path).map_err(|e| e.message().to_string())?;
    let identity = identity_of(&repo, identity);
    if identity.is_empty() {
        return Err("git has no user.email for this repository".into());
    }
    let tips = branch_tips(&repo);
    let default = tips.first().map(|(name, _)| name.clone());
    let mut seen: HashSet<Oid> = HashSet::new();
    let mut found: Vec<CommitItem> = Vec::new();
    let mut open_branches: Vec<String> = Vec::new();
    for (branch, tip) in &tips {
        let mut walk = repo.revwalk().map_err(|e| e.message().to_string())?;
        walk.set_sorting(Sort::TIME).map_err(|e| e.message().to_string())?;
        if walk.push(*tip).is_err() {
            continue;
        }
        for (looked, oid) in walk.flatten().enumerate() {
            if looked >= WALK_LIMIT {
                break;
            }
            let Ok(commit) = repo.find_commit(oid) else { continue };
            let time = commit.author().when().seconds();
            if time < period.start - SLACK_SECONDS && commit.time().seconds() < period.start - SLACK_SECONDS {
                break;
            }
            // Already filed under an earlier branch. Not a reason to stop: a merge on this branch
            // can still lead to parents no branch walked so far reached.
            if !seen.insert(oid) {
                continue;
            }
            if commit.parent_count() > 1 || !period.contains(time) {
                continue;
            }
            let author = commit.author();
            if !identity.matches(author.email(), author.name()) {
                continue;
            }
            let (files_changed, insertions, deletions) = stats(&repo, &commit);
            found.push(CommitItem {
                sha: oid.to_string(),
                branch: branch.clone(),
                subject: commit.summary().unwrap_or_default().trim().to_string(),
                time,
                files_changed,
                insertions,
                deletions,
            });
            if Some(branch) != default.as_ref() && !open_branches.contains(branch) {
                open_branches.push(branch.clone());
            }
        }
    }
    found.sort_by_key(|c| std::cmp::Reverse(c.time));
    found.truncate(max);
    Ok((found, open_branches))
}

/// Files changed, lines added and removed against the first parent (the root commit against nothing).
fn stats(repo: &Repository, commit: &git2::Commit) -> (usize, usize, usize) {
    let Ok(tree) = commit.tree() else { return (0, 0, 0) };
    let parent = commit.parent(0).ok().and_then(|p| p.tree().ok());
    let Ok(diff) = repo.diff_tree_to_tree(parent.as_ref(), Some(&tree), None) else { return (0, 0, 0) };
    match diff.stats() {
        Ok(s) => (s.files_changed(), s.insertions(), s.deletions()),
        Err(_) => (diff.deltas().len(), 0, 0),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::worklog::{period, PeriodKind};
    use chrono::{Local, NaiveDate, TimeZone};
    use git2::{Signature, Time};
    use std::path::Path;

    pub fn at(day: &str, hour: u32) -> i64 {
        let date = NaiveDate::parse_from_str(day, "%Y-%m-%d").unwrap();
        Local.from_local_datetime(&date.and_hms_opt(hour, 0, 0).unwrap()).unwrap().timestamp()
    }

    /// A commit of `file` on whatever HEAD is, by `who`, at `when`.
    pub fn commit(repo: &Repository, who: (&str, &str), when: i64, file: &str, message: &str) -> Oid {
        let sig = Signature::new(who.0, who.1, &Time::new(when, 0)).unwrap();
        let root = repo.workdir().unwrap();
        std::fs::write(root.join(file), format!("{message}\n")).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(file)).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let parents: Vec<git2::Commit> = repo.head().ok().and_then(|h| h.target()).map(|o| vec![repo.find_commit(o).unwrap()]).unwrap_or_default();
        let refs: Vec<&git2::Commit> = parents.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &refs).unwrap()
    }

    pub fn temp_repo() -> (std::path::PathBuf, Repository) {
        let dir = std::env::temp_dir().join(format!("cf-worklog-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let repo = Repository::init(&dir).unwrap();
        repo.set_head("refs/heads/main").unwrap();
        {
            let mut config = repo.config().unwrap().open_level(git2::ConfigLevel::Local).unwrap();
            config.set_str("user.email", "me@example.com").unwrap();
            config.set_str("user.name", "Me").unwrap();
        }
        (dir, repo)
    }

    const ME: (&str, &str) = ("Me", "me@example.com");
    const OTHER: (&str, &str) = ("Other", "other@example.com");

    #[test]
    fn only_my_commits_of_the_period_count_merges_left_out() {
        let (dir, repo) = temp_repo();
        // Monday 2026-10-26: the period is Friday 2026-10-23.
        commit(&repo, ME, at("2026-10-22", 18), "a.txt", "thursday work");
        let base = commit(&repo, ME, at("2026-10-23", 9), "b.txt", "friday on main");
        commit(&repo, OTHER, at("2026-10-23", 10), "c.txt", "someone else's");
        // A feature branch with a commit of mine, merged back with a merge commit of mine.
        let main_tip = repo.find_commit(repo.head().unwrap().target().unwrap()).unwrap();
        repo.branch("feature/login", &repo.find_commit(base).unwrap(), false).unwrap();
        repo.set_head("refs/heads/feature/login").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force())).unwrap();
        let feature = commit(&repo, ME, at("2026-10-23", 11), "d.txt", "login form");
        repo.set_head("refs/heads/main").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force())).unwrap();
        let sig = Signature::new(ME.0, ME.1, &Time::new(at("2026-10-23", 12), 0)).unwrap();
        let feature_commit = repo.find_commit(feature).unwrap();
        let mut merged = repo.merge_commits(&main_tip, &feature_commit, None).unwrap();
        let tree = repo.find_tree(merged.write_tree_to(&repo).unwrap()).unwrap();
        repo.commit(Some("HEAD"), &sig, &sig, "Merge feature/login", &tree, &[&main_tip, &feature_commit]).unwrap();
        // Still in progress on another branch.
        let merge_tip = repo.find_commit(repo.head().unwrap().target().unwrap()).unwrap();
        repo.branch("feature/pay", &merge_tip, false).unwrap();
        repo.set_head("refs/heads/feature/pay").unwrap();
        repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force())).unwrap();
        commit(&repo, ME, at("2026-10-23", 16), "e.txt", "pay draft");
        commit(&repo, ME, at("2026-10-24", 10), "f.txt", "saturday");

        let p = period(PeriodKind::PreviousWorkday, NaiveDate::from_ymd_opt(2026, 10, 26).unwrap(), None, None).unwrap();
        let (found, open) = commits(dir.to_str().unwrap(), &Identity::default(), &p, 50).unwrap();
        let subjects: Vec<&str> = found.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(subjects, vec!["pay draft", "login form", "friday on main"]);
        assert_eq!(found[1].branch, "main", "merged work is filed under the default branch");
        assert_eq!(found[0].branch, "feature/pay");
        assert_eq!(open, vec!["feature/pay".to_string()]);
        assert_eq!(found[2].files_changed, 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn another_email_of_mine_counts_and_names_only_without_emails() {
        let (dir, repo) = temp_repo();
        commit(&repo, ("Me at work", "me@work.example"), at("2026-10-23", 9), "a.txt", "from the other address");
        let p = period(PeriodKind::Today, NaiveDate::from_ymd_opt(2026, 10, 23).unwrap(), None, None).unwrap();
        let (none, _) = commits(dir.to_str().unwrap(), &Identity::default(), &p, 50).unwrap();
        assert!(none.is_empty());
        let mut extra = Identity::default();
        extra.add_email("ME@work.example");
        let (found, _) = commits(dir.to_str().unwrap(), &extra, &p, 50).unwrap();
        assert_eq!(found.len(), 1);
        let by_name = Identity { emails: vec![], names: vec!["me at work".into()] };
        assert!(by_name.matches(Some("x@y"), Some("Me at Work")));
        let _ = std::fs::remove_dir_all(dir);
    }
}
