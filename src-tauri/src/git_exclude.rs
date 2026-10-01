//! Keeping what the app writes into a repository out of that repository's history.
//!
//! Two things drop files into a user's working copy on the app's behalf: a chain's shared memory
//! (`.codeflow/`, see `chain_memory`) and the workspace's skills (`.claude/skills/<name>/`, see
//! `skills_cmd::sync_skills_into_project`). Neither is the user's work, and both used to show up in
//! the Changes panel as untracked files one "stage all" away from being committed — the skills
//! always, and the memory in every *worktree*, where `.git` is not the directory the old code
//! assumed it was.
//!
//! The answer is git's own per-clone ignore list, `info/exclude`: it never touches a tracked file,
//! it is never shared by a push, and it only hides *untracked* paths — a skill the team did commit
//! stays exactly as visible as it was.

use std::path::{Path, PathBuf};

/// Where a working copy's shared git state lives — the directory whose `info/exclude` git reads.
///
/// Three shapes of checkout, and only the first is the one a naive `repo/.git/info` handles:
///
/// - **A normal clone** — `.git` is a directory, and it is the answer.
/// - **A linked worktree** (`git worktree add`, which is how this app's own sessions run) — `.git`
///   is a *file* saying `gitdir: <main>/.git/worktrees/<name>`, and that per-worktree directory has
///   a `commondir` file pointing back at the main `.git`. Exclusions are read from the common one:
///   `info/` is in git's list of shared paths, so writing into the worktree's own directory would
///   be a file git never opens.
/// - **A submodule** — `.git` is a file pointing into the superproject's `.git/modules/<name>`,
///   with no `commondir`, so that directory is its own common dir.
///
/// `None` for anything that is not a working copy at all — no `.git`, or one that does not lead to
/// a directory holding a `HEAD`. A bare repository has no working tree to hide files in.
pub fn common_git_dir(repo: &Path) -> Option<PathBuf> {
    let dot_git = repo.join(".git");
    let git_dir = if dot_git.is_dir() {
        dot_git
    } else if dot_git.is_file() {
        let text = std::fs::read_to_string(&dot_git).ok()?;
        let target = text.lines().find_map(|line| line.trim().strip_prefix("gitdir:"))?.trim();
        if target.is_empty() {
            return None;
        }
        let target = Path::new(target);
        // Relative paths are relative to the working copy — that is how `git worktree add` and
        // submodules with `core.worktree` both write them when asked for portable paths.
        if target.is_absolute() {
            target.to_path_buf()
        } else {
            repo.join(target)
        }
    } else {
        return None;
    };

    let common = match std::fs::read_to_string(git_dir.join("commondir")) {
        Ok(text) if !text.trim().is_empty() => {
            let common = Path::new(text.trim());
            // `commondir` is relative to the per-worktree directory it sits in ("../.." as git
            // writes it), absolute only when someone set it that way by hand.
            if common.is_absolute() {
                common.to_path_buf()
            } else {
                git_dir.join(common)
            }
        }
        _ => git_dir,
    };
    // Normalised so `../..` does not leak into what callers log or compare, and so a path that does
    // not exist falls out here rather than as an I/O error later.
    let common = common.canonicalize().ok()?;
    common.join("HEAD").exists().then_some(common)
}

/// A path segment made safe to put in an exclude pattern verbatim: git reads `*`, `?`, `[` and `\`
/// as pattern syntax, and a folder name that happens to contain one must match only itself.
pub fn literal(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for c in segment.chars() {
        if matches!(c, '*' | '?' | '[' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Adds `pattern` to the working copy's `info/exclude`, once — however many times it is asked.
///
/// Read-then-append rather than "always append" because callers run this on every note a chain
/// files and every skills sync; without the check a long-lived repository would collect the same
/// line hundreds of times in a file the user may one day open.
///
/// `info/` is created when the git directory lacks one (a clone made without templates has none),
/// which is only ever done once [`common_git_dir`] has confirmed this *is* a repository — the one
/// thing this must never do is invent git plumbing in a folder that is not one.
///
/// Returns whether the line was written. Failures are the caller's to ignore: a read-only checkout
/// costs the user an untracked entry in Changes, never a failed turn.
pub fn exclude(repo: &Path, pattern: &str) -> std::io::Result<bool> {
    // A read, a check and a rewrite: two agent turns syncing skills into one repository at once —
    // they run side by side now — would each read the file without the other's line and the second
    // write would drop the first's. One process-wide lock; the file is tiny and the section short.
    static WRITE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _serialised = WRITE.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let pattern = pattern.trim();
    let Some(common) = common_git_dir(repo) else { return Ok(false) };
    if pattern.is_empty() {
        return Ok(false);
    }
    let info = common.join("info");
    std::fs::create_dir_all(&info)?;
    let file = info.join("exclude");
    let current = match std::fs::read_to_string(&file) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e),
    };
    if current.lines().any(|line| line.trim() == pattern) {
        return Ok(false);
    }
    let separator = if current.is_empty() || current.ends_with('\n') { "" } else { "\n" };
    std::fs::write(&file, format!("{current}{separator}{pattern}\n"))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(dir: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.invalid")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.invalid")
            .output()
            .unwrap();
        assert!(status.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&status.stderr));
    }

    fn untracked(dir: &Path) -> String {
        let out = std::process::Command::new("git")
            .args(["status", "--porcelain", "--untracked-files=all"])
            .current_dir(dir)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cf-exclude-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    fn repo_with_a_commit() -> PathBuf {
        let repo = scratch();
        git(&repo, &["init", "-q"]);
        std::fs::write(repo.join("README.md"), "hola\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "init"]);
        repo
    }

    #[test]
    fn a_normal_clone_is_excluded_once_and_git_stops_listing_the_folder() {
        let repo = repo_with_a_commit();
        std::fs::create_dir_all(repo.join(".codeflow").join("memory")).unwrap();
        std::fs::write(repo.join(".codeflow").join("memory").join("01-bot.md"), "nota").unwrap();
        assert!(untracked(&repo).contains(".codeflow"), "listed before");

        assert!(exclude(&repo, "/.codeflow/").unwrap());
        assert!(!exclude(&repo, "/.codeflow/").unwrap(), "the second call writes nothing");
        let file = std::fs::read_to_string(repo.join(".git").join("info").join("exclude")).unwrap();
        assert_eq!(file.matches("/.codeflow/").count(), 1);
        assert!(!untracked(&repo).contains(".codeflow"), "and git no longer lists it");
        std::fs::remove_dir_all(&repo).ok();
    }

    /// The case the old helper got wrong: in a linked worktree `.git` is a file, so it found no
    /// `.git/info`, did nothing, and the folder showed up in Changes.
    #[test]
    fn a_linked_worktree_writes_to_the_common_exclude_that_git_reads() {
        let main = repo_with_a_commit();
        let worktree = scratch().join("wt");
        git(&main, &["worktree", "add", "-q", "-b", "side", &worktree.to_string_lossy()]);
        assert!(worktree.join(".git").is_file(), "a worktree's .git is a file");

        assert_eq!(common_git_dir(&worktree).unwrap(), main.join(".git").canonicalize().unwrap());
        std::fs::create_dir_all(worktree.join(".claude").join("skills").join("revisor")).unwrap();
        std::fs::write(worktree.join(".claude").join("skills").join("revisor").join("SKILL.md"), "x").unwrap();
        assert!(untracked(&worktree).contains(".claude/skills/revisor"));

        assert!(exclude(&worktree, "/.claude/skills/revisor/").unwrap());
        assert!(!untracked(&worktree).contains(".claude"), "hidden in the worktree: {}", untracked(&worktree));
        let file = std::fs::read_to_string(main.join(".git").join("info").join("exclude")).unwrap();
        assert!(file.contains("/.claude/skills/revisor/"));

        git(&main, &["worktree", "remove", "--force", &worktree.to_string_lossy()]);
        std::fs::remove_dir_all(&main).ok();
    }

    /// A skill the team committed stays tracked: an exclusion only ever hides untracked paths, and
    /// the per-skill pattern leaves the user's own unmanaged skills listed.
    #[test]
    fn only_the_named_path_is_hidden() {
        let repo = repo_with_a_commit();
        let skills = repo.join(".claude").join("skills");
        std::fs::create_dir_all(skills.join("gestionada")).unwrap();
        std::fs::create_dir_all(skills.join("propia")).unwrap();
        std::fs::write(skills.join("gestionada").join("SKILL.md"), "x").unwrap();
        std::fs::write(skills.join("propia").join("SKILL.md"), "y").unwrap();

        exclude(&repo, "/.claude/skills/gestionada/").unwrap();
        let listed = untracked(&repo);
        assert!(!listed.contains("gestionada"), "{listed}");
        assert!(listed.contains("propia"), "the user's own skill is still listed: {listed}");
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn a_name_with_pattern_characters_matches_only_itself() {
        assert_eq!(literal("revisor"), "revisor");
        assert_eq!(literal("a*b?[c]\\d"), "a\\*b\\?\\[c]\\\\d");

        let repo = repo_with_a_commit();
        let skills = repo.join(".claude").join("skills");
        std::fs::create_dir_all(skills.join("q*")).unwrap();
        std::fs::create_dir_all(skills.join("qa")).unwrap();
        std::fs::write(skills.join("q*").join("SKILL.md"), "x").unwrap();
        std::fs::write(skills.join("qa").join("SKILL.md"), "y").unwrap();
        exclude(&repo, &format!("/.claude/skills/{}/", literal("q*"))).unwrap();
        let listed = untracked(&repo);
        assert!(listed.contains("skills/qa/"), "a glob would have hidden this too: {listed}");
        std::fs::remove_dir_all(&repo).ok();
    }

    #[test]
    fn a_folder_that_is_not_a_repository_is_left_alone() {
        let dir = scratch();
        assert!(common_git_dir(&dir).is_none());
        assert!(!exclude(&dir, "/.codeflow/").unwrap());
        assert!(!dir.join(".git").exists(), "no git plumbing invented");
        // A `.git` file pointing nowhere is not a repository either.
        std::fs::write(dir.join(".git"), "gitdir: ./nowhere\n").unwrap();
        assert!(common_git_dir(&dir).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A clone made without templates has no `info/` at all; once the directory is confirmed to be
    /// a repository, creating it is fine.
    #[test]
    fn a_repository_without_an_info_folder_gets_one() {
        let repo = repo_with_a_commit();
        std::fs::remove_dir_all(repo.join(".git").join("info")).ok();
        assert!(exclude(&repo, "/.codeflow/").unwrap());
        assert!(repo.join(".git").join("info").join("exclude").exists());
        std::fs::remove_dir_all(&repo).ok();
    }
}
