//! Rebases, run by git itself: "rebase the current branch onto that one" and the interactive kind
//! the graph plans — reorder, squash, fixup, reword, drop.
//!
//! `history.rs` explains why this app long refused to rebase: an interactive rebase is a session
//! with a conflict at every step, and a UI that starts one and cannot finish it strands the
//! repository. What changed is that the conflicts banner now finishes sequenced operations through
//! `git rebase --continue` / `--abort` (see `merge::is_sequenced`), so a rebase that stops is left
//! exactly where `git rebase` leaves it, with the banner's two buttons in front of it.
//!
//! Nothing here walks the to-do list itself. The plan the user built is written as git's own to-do
//! file and handed over through `GIT_SEQUENCE_EDITOR`; every step after that is git's.

use std::path::{Path, PathBuf};

use git2::{Repository, Sort};
use serde::{Deserialize, Serialize};

use super::cli;
use super::graph::{build_commit_info, build_ref_map, CommitInfo};
use super::repo::open;

/// A plan whose range holds a merge: flattening it is not what anybody planning a reorder meant.
pub const REBASE_MERGES_PREFIX: &str = "REBASE_MERGES: ";

/// One line of the plan, oldest commit first.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RebaseStep {
    /// `pick`, `reword`, `squash`, `fixup` or `drop`.
    pub action: String,
    pub oid: String,
    /// The new message, for `reword` (and optionally for `squash`, replacing the combined one).
    #[serde(default)]
    pub message: Option<String>,
}

/// A commit of the plan, with its whole message — a reword starts from it, body included.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanCommit {
    #[serde(flatten)]
    pub commit: CommitInfo,
    pub message: String,
}

/// The commits an interactive rebase from `base` would replay — `base..HEAD`, oldest first. `base`
/// itself stays where it is. Refused when the range holds a merge, when `base` is not behind HEAD,
/// and on a dirty tree or a running operation, so the dialog never opens on a plan that cannot run.
pub fn rebase_plan(path: &str, base: &str) -> Result<Vec<PlanCommit>, String> {
    let repo = open(path)?;
    refuse_unready(&repo)?;
    let head = repo
        .head()
        .and_then(|h| h.peel_to_commit())
        .map_err(|_| "There is no commit yet".to_string())?;
    let base = repo
        .revparse_single(base)
        .and_then(|o| o.peel_to_commit())
        .map_err(|e| e.message().to_string())?;
    if base.id() == head.id() || !repo.graph_descendant_of(head.id(), base.id()).map_err(|e| e.message().to_string())? {
        return Err("That commit is not behind HEAD on the current branch".to_string());
    }
    let ref_map = build_ref_map(&repo);
    let mut walk = repo.revwalk().map_err(|e| e.message().to_string())?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::REVERSE).map_err(|e| e.message().to_string())?;
    walk.push(head.id()).map_err(|e| e.message().to_string())?;
    walk.hide(base.id()).map_err(|e| e.message().to_string())?;
    let mut out = Vec::new();
    for oid in walk {
        let oid = oid.map_err(|e| e.message().to_string())?;
        let commit = repo.find_commit(oid).map_err(|e| e.message().to_string())?;
        if commit.parent_count() > 1 {
            return Err(format!("{REBASE_MERGES_PREFIX}{}", &oid.to_string()[..7]));
        }
        out.push(PlanCommit {
            commit: build_commit_info(&repo, oid, &ref_map)?,
            message: commit.message().unwrap_or("").trim_end().to_string(),
        });
    }
    Ok(out)
}

/// Neither a dirty tree (git would refuse, after a confusing half-start) nor an operation already
/// stopped half way.
fn refuse_unready(repo: &Repository) -> Result<(), String> {
    super::merge::refuse_in_progress(repo)?;
    if super::history::is_dirty(repo)? {
        return Err("Commit or stash your changes before rebasing".to_string());
    }
    Ok(())
}

/// A path as one `sh` word — git runs the editors and `exec` lines through `sh`, Git for Windows'
/// own included, where a forward-slashed `C:/…` path is understood.
fn sh_quote(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    format!("'{}'", text.replace('\'', r"'\''"))
}

/// The to-do file for `steps`, and the message files its `exec` lines read. A reword is a `pick`
/// followed by an amend with the new message — git's own `reword` would open an editor nobody is
/// sitting at.
fn todo_text(steps: &[RebaseStep], dir: &Path) -> Result<(String, Vec<(PathBuf, String)>), String> {
    let mut lines = Vec::new();
    let mut messages = Vec::new();
    let mut first_kept = true;
    for (index, step) in steps.iter().enumerate() {
        if step.oid.len() < 7 || !step.oid.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(format!("not a commit id: {}", step.oid));
        }
        let action = step.action.as_str();
        if !matches!(action, "pick" | "reword" | "squash" | "fixup" | "drop") {
            return Err(format!("unknown rebase action: {action}"));
        }
        if action != "drop" {
            if first_kept && matches!(action, "squash" | "fixup") {
                return Err("The first commit kept cannot be squashed into one before it".to_string());
            }
            first_kept = false;
        }
        let verb = if action == "reword" { "pick" } else { action };
        lines.push(format!("{verb} {}", step.oid));
        let message = step.message.as_deref().map(str::trim).filter(|m| !m.is_empty());
        if let (Some(message), true) = (message, matches!(action, "reword" | "squash")) {
            let file = dir.join(format!("message-{index}.txt"));
            lines.push(format!("exec git commit --amend --allow-empty --quiet -F {}", sh_quote(&file)));
            messages.push((file, format!("{message}\n")));
        }
    }
    if first_kept {
        return Err("The plan drops every commit".to_string());
    }
    Ok((lines.join("\n") + "\n", messages))
}

/// Runs the plan: `git rebase -i <base>` with the to-do file swapped in. A step that conflicts
/// leaves the rebase in progress and answers with the conflicts prefix, which the UI turns into the
/// banner — and the message files stay behind for the `exec` lines still to come.
pub fn rebase_interactive(path: &str, base: &str, steps: &[RebaseStep]) -> Result<(), String> {
    let repo = open(path)?;
    refuse_unready(&repo)?;
    super::branch::guard_head_unlocked(&repo)?;
    let dir = std::env::temp_dir().join(format!("cf-rebase-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let (todo, messages) = todo_text(steps, &dir)?;
    let todo_path = dir.join("git-rebase-todo");
    std::fs::write(&todo_path, todo).map_err(|e| e.to_string())?;
    for (file, text) in &messages {
        std::fs::write(file, text).map_err(|e| e.to_string())?;
    }
    let editor = format!("cp {}", sh_quote(&todo_path));
    let output = cli::run_in(
        path,
        &["-c", "rebase.autoSquash=false", "-c", "rebase.autoStash=false", "rebase", "-i", base],
        // `:` is git's own "no editor": a squash keeps the combined message it prepared.
        &[("GIT_SEQUENCE_EDITOR", editor.as_str()), ("GIT_EDITOR", ":")],
    )?;
    finish(output, &dir)
}

/// `git rebase <upstream>`: the current branch's own commits replayed on top of `upstream`.
pub fn rebase_onto(path: &str, upstream: &str) -> Result<(), String> {
    let repo = open(path)?;
    refuse_unready(&repo)?;
    super::branch::guard_head_unlocked(&repo)?;
    let output = cli::run_in(path, &["-c", "rebase.autoStash=false", "rebase", upstream], &[("GIT_EDITOR", ":")])?;
    finish(output, Path::new(""))
}

fn finish(output: cli::Output, scratch: &Path) -> Result<(), String> {
    if output.success {
        if !scratch.as_os_str().is_empty() {
            let _ = std::fs::remove_dir_all(scratch);
        }
        return Ok(());
    }
    let all = format!("{}\n{}", output.stderr, output.stdout);
    let detail = if output.stderr.trim().is_empty() { output.stdout.trim() } else { output.stderr.trim() };
    Err(crate::remote::failure_message("rebase", &all, detail))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn git(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git").args(args).current_dir(dir).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn log(dir: &Path) -> Vec<String> {
        let out = std::process::Command::new("git").args(["log", "--format=%s"]).current_dir(dir).output().unwrap();
        String::from_utf8_lossy(&out.stdout).lines().map(str::to_string).collect()
    }

    fn fixture() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cf-rebase-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q"]);
        git(&dir, &["config", "user.name", "Test"]);
        git(&dir, &["config", "user.email", "test@example.com"]);
        git(&dir, &["config", "commit.gpgsign", "false"]);
        // Off the default branch, which the shipped lock rules guard against rewriting.
        git(&dir, &["checkout", "-q", "-b", "work"]);
        for name in ["base", "one", "two", "three"] {
            fs::write(dir.join(format!("{name}.txt")), name).unwrap();
            git(&dir, &["add", "."]);
            git(&dir, &["commit", "-q", "-m", name]);
        }
        dir
    }

    #[test]
    fn a_plan_reorders_rewords_squashes_and_drops() {
        let dir = fixture();
        let path = dir.to_str().unwrap();
        let plan = rebase_plan(path, "HEAD~3").unwrap();
        let ids: Vec<String> = plan.iter().map(|c| c.commit.id.clone()).collect();
        assert_eq!(plan.iter().map(|c| c.commit.summary.as_str()).collect::<Vec<_>>(), ["one", "two", "three"]);
        assert_eq!(plan[0].message, "one");

        let step = |action: &str, oid: &str, message: Option<&str>| RebaseStep {
            action: action.into(),
            oid: oid.into(),
            message: message.map(str::to_string),
        };
        rebase_interactive(
            path,
            "HEAD~3",
            &[step("reword", &ids[2], Some("three, renamed")), step("fixup", &ids[0], None), step("drop", &ids[1], None)],
        )
        .unwrap();
        assert_eq!(log(&dir), ["three, renamed", "base"]);
        assert!(dir.join("one.txt").exists() && !dir.join("two.txt").exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn plans_that_cannot_run_are_refused_before_git_starts() {
        let dir = fixture();
        let path = dir.to_str().unwrap();
        assert!(rebase_plan(path, "HEAD").is_err());
        let ids: Vec<String> = rebase_plan(path, "HEAD~2").unwrap().into_iter().map(|c| c.commit.id).collect();
        let squash_first = [RebaseStep { action: "squash".into(), oid: ids[0].clone(), message: None }];
        assert!(rebase_interactive(path, "HEAD~2", &squash_first).is_err());
        fs::write(dir.join("one.txt"), "dirty").unwrap();
        assert!(rebase_plan(path, "HEAD~2").unwrap_err().contains("stash"));
        assert_eq!(log(&dir).len(), 4);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_conflicting_step_stops_with_the_rebase_in_progress() {
        let dir = fixture();
        let path = dir.to_str().unwrap();
        fs::write(dir.join("one.txt"), "changed again").unwrap();
        git(&dir, &["commit", "-q", "-am", "four"]);
        let ids: Vec<String> = rebase_plan(path, "HEAD~4").unwrap().into_iter().map(|c| c.commit.id).collect();
        // `four` edits `one.txt`; putting it before `one` (which creates it) cannot apply.
        let order = [3, 0, 1, 2].map(|i| RebaseStep { action: "pick".into(), oid: ids[i].clone(), message: None });
        let err = rebase_interactive(path, "HEAD~4", &order).unwrap_err();
        assert!(err.starts_with(super::super::merge::OPERATION_CONFLICTS_PREFIX), "{err}");
        let repo = Repository::open(&dir).unwrap();
        assert!(super::super::merge::is_sequenced(repo.state()));
        git(&dir, &["rebase", "--abort"]);
        fs::remove_dir_all(&dir).ok();
    }
}
