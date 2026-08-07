//! A chain's shared memory: one folder of Markdown notes, written by the app as its steps answer.
//!
//! # Why a folder and not a session
//!
//! Steps of a chain are separate engine sessions on purpose, and between two *different* engines
//! they could not be anything else — a resume token belongs to the CLI that minted it and does not
//! cross (see `claude_cmd::session_for_provider`). So the only context that reaches step 4 is text
//! somebody put in its opening message, and until now that was one thing: the immediately previous
//! answer. Step 4 never saw step 1.
//!
//! These notes are that missing memory, and they are files rather than columns for three reasons
//! that all matter more than tidiness:
//!
//! - **Every engine can read them.** No flags, no allow-list, no tool names — a copy of the folder
//!   is inside the repository, which is the working directory every step already runs in. Claude,
//!   Codex, agy and opencode reach it the same way, and CodeFlow does not have to know how any of
//!   them do it.
//! - **The app writes them, so they exist whether or not the model cooperates.** A step that
//!   ignores every instruction in its prompt still has its answer filed. The *reading* is the
//!   model's to do; the *keeping* is not.
//! - **You can read them too.** A chain's reasoning stops being something only its own panes can
//!   show, and a plan that went wrong can be diagnosed by opening a file.
//!
//! # One home, and a copy in every repository
//!
//! The notes live in `~/CodeFlow/chain-memory/<chain id>/` and are **mirrored** into
//! `.codeflow/memory/<chain id>/` inside every repository the chain touches. Both halves earn their
//! keep and neither is redundant:
//!
//! - The home copy is the one that lasts. A repository can be deleted, moved or re-cloned, and a
//!   chain's record of what it did should not go with it. It is also one folder for a plan that
//!   spans six, which is what makes a *browsable* history possible at all.
//! - The mirrors are the ones the agents read. Reaching outside the working directory is not
//!   portable across the engines this app dispatches to — `--add-dir` on one of them, a different
//!   name on another, nothing at all on the hosted ones, a fact this codebase had already
//!   established twice before this feature existed (see `commands::stories_cmd`). A folder inside
//!   cwd needs no flag from anybody.
//!
//! Mirroring into **every** repository, not just the first, is also what makes the memory whole on a
//! multi-repository plan: a step running in the third repository can read what the step in the first
//! one wrote, which is exactly the context that was missing when the notes lived in one place.
//!
//! This is the same shape `commands::skills_cmd` already uses — canonical copy under `~/CodeFlow`,
//! synced into whichever repository is about to be worked on — and for the same reason.
//!
//! Writing inside somebody's repository earns an obligation, which [`exclude_from_git`] discharges:
//! the folder is registered in `.git/info/exclude` the first time it is created. That file rather
//! than `.gitignore` because `.gitignore` is the user's, is tracked, and would turn "CodeFlow ran a
//! chain" into a diff on their branch.

use std::path::{Path, PathBuf};

/// Everything the app puts inside a repository lives under this one name, so a user who wants it
/// gone has one thing to delete.
const ROOT: &str = ".codeflow";

/// What is appended to `.git/info/exclude`. Matched verbatim before appending, so this is
/// idempotent across every chain in a repository.
const EXCLUDE_LINE: &str = "/.codeflow/";

/// The folder that actually holds one chain's notes.
pub fn dir(chain_id: &str) -> PathBuf {
    crate::paths::chain_memory_dir(chain_id)
}

/// The copy of it inside one repository — what an agent working there opens.
pub fn mirror_dir(repo_path: &str, chain_id: &str) -> PathBuf {
    Path::new(repo_path).join(ROOT).join("memory").join(chain_id)
}

/// The same path as the agent will be told it: relative to the repository, forward slashes on every
/// platform, because it is going into a prompt and not into a filesystem call.
pub fn relative_dir(chain_id: &str) -> String {
    format!("{ROOT}/memory/{chain_id}")
}

/// One step's note, named so the folder sorts into plan order and reads as a table of contents.
///
/// Derived rather than stored: `queries` needs to name a file it will not write, and the command
/// layer needs to write a file it did not name. A single function both call is what keeps those two
/// agreeing without a column to fall out of step.
pub fn note_name(step_index: i64, agent_name: &str) -> String {
    let slug: String = agent_name
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let slug = slug.trim_matches('-').replace("--", "-");
    let slug = if slug.is_empty() { "agent".to_string() } else { slug.chars().take(32).collect() };
    format!("{:02}-{}.md", step_index + 1, slug)
}

/// Records one step's answer.
///
/// Never fails a turn. A repository that has gone read-only, a disk that is full, a path that no
/// longer exists — none of those are worth losing a completed engine run over, and the answer is
/// already safe in `agent_chain_steps.output_text` either way. The notes are a convenience for the
/// steps that come after, not the system of record.
pub fn write_note(
    chain_id: &str,
    step_index: i64,
    agent_name: &str,
    repo_name: &str,
    body: &str,
    repos: &[String],
) {
    let folder = dir(chain_id);
    if std::fs::create_dir_all(&folder).is_err() {
        return;
    }
    let header = format!(
        "# Step {} — {}\n\n_Repository: {}_\n\n---\n\n",
        step_index + 1,
        if agent_name.trim().is_empty() { "agent" } else { agent_name.trim() },
        if repo_name.trim().is_empty() { "unknown" } else { repo_name.trim() },
    );
    let _ = std::fs::write(folder.join(note_name(step_index, agent_name)), header + body.trim());
    mirror(chain_id, repos);
}

/// Copies the whole folder into every repository of the chain.
///
/// The whole folder rather than the one file just written, because that makes it self-healing: a
/// repository that was unplugged, read-only or simply not there when an earlier note was filed
/// catches up on the next one, instead of being permanently short a note nobody would notice was
/// missing.
pub fn mirror(chain_id: &str, repos: &[String]) {
    let source = dir(chain_id);
    let Ok(entries) = std::fs::read_dir(&source) else { return };
    let files: Vec<_> = entries.flatten().filter(|e| e.path().is_file()).collect();
    for repo in repos {
        let target = mirror_dir(repo, chain_id);
        if std::fs::create_dir_all(&target).is_err() {
            continue;
        }
        exclude_from_git(repo);
        for file in &files {
            let _ = std::fs::copy(file.path(), target.join(file.file_name()));
        }
    }
}

/// What the whole chain did, one section per step, written when it finishes.
///
/// Assembled from what is already on disk rather than by asking an engine to summarise: a summary
/// that cost another turn would be a summary that can be wrong, and the one question it answers —
/// *which agent did what* — is one the app can answer exactly.
pub fn write_summary(
    chain_id: &str,
    title: &str,
    sections: &[(i64, String, String, String)],
    repos: &[String],
) {
    let folder = dir(chain_id);
    if std::fs::create_dir_all(&folder).is_err() {
        return;
    }
    let mut out = format!("# {}\n\n", if title.trim().is_empty() { "Chain" } else { title.trim() });
    for (index, agent, status, body) in sections {
        out.push_str(&format!("## Step {} — {} ({})\n\n", index + 1, agent, status));
        if body.trim().is_empty() {
            out.push_str("_No output._\n\n");
        } else {
            out.push_str(body.trim());
            out.push_str("\n\n");
        }
    }
    let _ = std::fs::write(folder.join("SUMMARY.md"), out);
    mirror(chain_id, repos);
}

/// Deletes one chain's notes. Called when the chain is deleted and at no other time — the folder is
/// the chain's memory for as long as the chain exists, including across restarts.
pub fn forget(chain_id: &str, repos: &[String]) {
    let _ = std::fs::remove_dir_all(dir(chain_id));
    // Every mirror as well, or the copies would outlive the thing they are copies of — and a folder
    // left inside a repository after its chain is gone is one nobody has a way to explain.
    for repo in repos {
        let _ = std::fs::remove_dir_all(mirror_dir(repo, chain_id));
    }
}

/// Keeps `.codeflow/` out of `git status` without touching a tracked file.
///
/// Appends once and only once. Read-then-append rather than "always append" because this runs on
/// every note: without the check, a ten-step chain would leave ten identical lines in a file the
/// user might one day open.
fn exclude_from_git(repo_path: &str) {
    let info = Path::new(repo_path).join(".git").join("info");
    // No `.git/info` means this is not a normal working clone (a bare repo, a path that stopped
    // being a repository). Nothing to exclude from, and creating the directory would be inventing
    // git plumbing in someone else's folder.
    if !info.is_dir() {
        return;
    }
    let exclude = info.join("exclude");
    let current = std::fs::read_to_string(&exclude).unwrap_or_default();
    if current.lines().any(|line| line.trim() == EXCLUDE_LINE) {
        return;
    }
    let separator = if current.is_empty() || current.ends_with('\n') { "" } else { "\n" };
    let _ = std::fs::write(&exclude, format!("{current}{separator}{EXCLUDE_LINE}\n"));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn note_names_sort_into_plan_order_and_survive_any_agent_name() {
        assert_eq!(note_name(0, "Analista"), "01-analista.md");
        assert_eq!(note_name(9, "Implementador"), "10-implementador.md");
        // Sorting is the whole point of the ordinal: a folder listed alphabetically must read as
        // the plan, which decimal step numbers alone would not give past step 9.
        assert!(note_name(0, "a") < note_name(9, "a"));
        assert!(note_name(9, "a") < note_name(10, "a"));
    }

    /// Agent names are free text — emoji, slashes, accents, nothing at all. Every one of them has
    /// to come out as a filename that exists on all three platforms.
    #[test]
    fn an_agent_name_can_never_produce_a_path() {
        assert_eq!(note_name(0, "../../etc/passwd"), "01-etc-passwd.md");
        assert_eq!(note_name(1, ""), "02-agent.md");
        assert_eq!(note_name(2, "  "), "03-agent.md");
        assert_eq!(note_name(3, "🤖"), "04-agent.md");
        let long = note_name(4, &"x".repeat(200));
        assert!(long.len() < 45, "clamped, so a long name cannot hit a path limit: {long}");
        for name in ["../../etc/passwd", "a/b", "a\\b", "a:b", ""] {
            let produced = note_name(0, name);
            assert!(!produced.contains('/') && !produced.contains('\\') && !produced.contains(':'));
        }
    }

    #[test]
    fn the_git_exclude_line_is_written_once_however_many_notes_are_filed() {
        let repo = std::env::temp_dir().join(format!("cf-mem-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(repo.join(".git").join("info")).unwrap();
        let path = repo.to_string_lossy().to_string();
        let chain = format!("chain-{}", uuid::Uuid::new_v4());
        let repos = vec![path.clone()];

        for step in 0..3 {
            write_note(&chain, step, "Analista", "repo", "algo", &repos);
        }
        let exclude = std::fs::read_to_string(repo.join(".git").join("info").join("exclude")).unwrap();
        assert_eq!(exclude.matches(EXCLUDE_LINE).count(), 1, "appended once: {exclude:?}");

        forget(&chain, &repos);
        std::fs::remove_dir_all(&repo).ok();
    }

    /// The point of the mirrors: a plan across three repositories leaves the **whole** set of notes
    /// in each one, so a step running in the third can read what the step in the first wrote. That
    /// is the context that was missing while the notes lived in a single repository.
    #[test]
    fn every_repository_of_a_chain_gets_the_whole_folder() {
        let make = || {
            let dir = std::env::temp_dir().join(format!("cf-mem-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(dir.join(".git").join("info")).unwrap();
            dir
        };
        let (a, b) = (make(), make());
        let chain = format!("chain-{}", uuid::Uuid::new_v4());
        let repos = vec![a.to_string_lossy().to_string(), b.to_string_lossy().to_string()];

        write_note(&chain, 0, "Analista", "a", "lo que vi en A", &repos);
        write_note(&chain, 1, "Implementador", "b", "lo que hice en B", &repos);

        for repo in &repos {
            let mirror = mirror_dir(repo, &chain);
            assert!(mirror.join("01-analista.md").exists(), "{} is short a note", repo);
            assert!(mirror.join("02-implementador.md").exists(), "{} is short a note", repo);
        }
        // And the home copy is the one that would survive either repository being deleted.
        assert!(dir(&chain).join("01-analista.md").exists());

        forget(&chain, &repos);
        assert!(!dir(&chain).exists(), "the home copy goes");
        for repo in &repos {
            assert!(!mirror_dir(repo, &chain).exists(), "and so does every mirror");
        }
        std::fs::remove_dir_all(&a).ok();
        std::fs::remove_dir_all(&b).ok();
    }

    /// A repository the app cannot write into must not take a turn down with it — nor stop the
    /// other repositories of the same chain from getting their copy.
    #[test]
    fn a_repository_that_cannot_be_written_is_skipped_not_fatal() {
        let good = std::env::temp_dir().join(format!("cf-mem-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&good).unwrap();
        let chain = format!("chain-{}", uuid::Uuid::new_v4());
        let repos = vec!["/nonexistent/cf-test-path".to_string(), good.to_string_lossy().to_string()];

        write_note(&chain, 0, "Bot", "repo", "algo", &repos);
        assert!(mirror_dir(&repos[1], &chain).join("01-bot.md").exists(), "the reachable one still got it");

        forget(&chain, &repos);
        std::fs::remove_dir_all(&good).ok();
    }
}
