//! What the app cannot do without, checked once on the first launch after installing.
//!
//! **Only the two things that are not optional.** Nearly everything CodeFlow shells out to is
//! feature-scoped and already reports itself where it is used: the AI engines have a
//! "found / not found" badge in Settings with an install command beside it, `ssh` explains itself
//! when a Remote host or a tunnelled connection fails, `npx` when a skill install does. A launch
//! screen listing all of them would be a wall of things nobody has tried to use yet.
//!
//! These two are different because failing them is not a feature not working — it is the app
//! looking fine and being wrong:
//!
//! * **`git`.** Every clone, fetch, pull and push runs the system binary (see `remote.rs`, and the
//!   note there about why: it is the only way to reuse the user's own SSH keys, credential manager
//!   and `.gitconfig`). Everything *local* goes through libgit2, which is linked in — so without
//!   `git` the window opens, the graph draws, the history scrolls, and then every operation that
//!   touches a remote dies with `No such file or directory (os error 2)`, an error that does not
//!   contain the word "git". That is the worst shape a missing dependency can have: it looks
//!   installed.
//!
//! * **The data directories.** The state root holds the database, and `lib.rs` opens it with an
//!   `expect` — so if it cannot be created or written, the process panics before there is any
//!   window to say so. That is an application that does nothing at all when you double-click it,
//!   with no message anywhere. Checked here so that at least the *next* launch explains it.
//!
//!   All three roots are probed, not just the one holding the database, and the failure names which
//!   one it was. Before the roots split there was one directory and "the data directory" was
//!   unambiguous; now a machine can perfectly well allow `%LOCALAPPDATA%` and refuse
//!   `%USERPROFILE%`, and a message that said only "the data directory" would send the user to look
//!   at the wrong one.
//!
//! Adding a third is one entry in [`check`]; the frontend renders whatever comes back.

use serde::Serialize;

/// One thing that was checked, and what was found.
#[derive(Debug, Clone, Serialize)]
pub struct Requirement {
    /// Stable, and doubles as the translation-key fragment (`requirements.<id>` / `.hint`). Never
    /// shown raw.
    pub id: String,
    pub ok: bool,
    /// What was actually found: a version string when it was, the underlying error when it was not.
    /// Shown verbatim and deliberately untranslated — it is a quotation, not a sentence of ours.
    pub detail: String,
}

/// Runs every check. Cheap enough to be unconditional (one short-lived subprocess and one file
/// write), but it is called at most once per installation all the same — see `requirementsStore`.
pub fn check() -> Vec<Requirement> {
    vec![git(), data_dir()]
}

/// `git --version` rather than a `PATH` walk.
///
/// Looking for the file would answer a narrower question than the one that matters: a `git` that is
/// present but cannot execute — the wrong architecture, a broken Xcode command-line-tools stub on
/// macOS that exits asking to be installed, a shim pointing at a version manager that is gone — is
/// found by any search and still fails every fetch. Running it is the only way to learn that it
/// runs.
fn git() -> Requirement {
    match crate::proc::std_command("git").arg("--version").output() {
        Ok(output) if output.status.success() => Requirement {
            id: "git".into(),
            ok: true,
            detail: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        },
        // Spawned but unhappy: the stub case above, which prints its complaint on stderr and exits
        // non-zero. Its own words are far more useful than anything we could say about it.
        Ok(output) => Requirement {
            id: "git".into(),
            ok: false,
            detail: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        },
        Err(e) => Requirement { id: "git".into(), ok: false, detail: e.to_string() },
    }
}

/// Probes all three roots and reports the first one that cannot hold data.
///
/// All three rather than only the database's, because they no longer share a parent: a machine can
/// allow `%LOCALAPPDATA%` and refuse `%USERPROFILE%`, and the user needs to be told which. The
/// `detail` carries the offending path so the message names something they can act on.
fn data_dir() -> Requirement {
    let state = crate::paths::state_dir();

    // Reported before any probe, because every probe below would *pass*: the fallback roots live
    // under the temp directory, which is writable on every machine ever made. The app would come up
    // looking healthy and lose the user's work at the next reboot, which is the one failure this
    // check exists to make impossible.
    if !crate::paths::roots_resolved() {
        return Requirement {
            id: "dataDir".into(),
            ok: false,
            detail: format!("{}: home directory could not be resolved", state.to_string_lossy()),
        };
    }

    for dir in [state.clone(), crate::paths::cache_dir(), crate::paths::user_dir()] {
        if let Err(e) = probe(&dir) {
            return Requirement {
                id: "dataDir".into(),
                ok: false,
                detail: format!("{}: {e}", dir.to_string_lossy()),
            };
        }
    }

    // The state root on success: it is the one the user is sent to by "Show in folder", and the one
    // a support conversation is about.
    Requirement { id: "dataDir".into(), ok: true, detail: state.to_string_lossy().to_string() }
}

/// Create-then-write, against one directory.
///
/// Both halves are needed and neither is redundant. `create_dir_all` succeeding says the path can
/// exist; it says nothing about whether this user may write there, which is exactly the failure on
/// a machine where the directory was created once by an administrator. The probe file is removed
/// again — and its removal is not checked, because a directory that accepted the write and refuses
/// the delete is still a directory the database can live in.
fn probe(dir: &std::path::Path) -> Result<(), std::io::Error> {
    std::fs::create_dir_all(dir)?;
    let probe = dir.join(".write-test");
    std::fs::write(&probe, b"")?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every check has to answer, whatever it finds. A probe that panicked or returned nothing
    /// would leave the first-run screen unable to say anything at all — which is the one moment it
    /// exists for.
    #[test]
    fn every_check_reports_something() {
        let found = check();
        assert_eq!(found.len(), 2);
        for requirement in &found {
            assert!(!requirement.id.is_empty());
            assert!(!requirement.detail.is_empty(), "{} said nothing", requirement.id);
        }
    }

    /// The suite runs where `git` is on `PATH` and the home directory is writable, so both have to
    /// come back clean. A failure here is the check itself being broken, not the machine.
    #[test]
    fn a_working_machine_passes() {
        for requirement in check() {
            assert!(requirement.ok, "{} failed: {}", requirement.id, requirement.detail);
        }
    }

    /// `git --version` is what it claims to be running — the detail carried back is the real
    /// output, not a label we made up, because the point of showing it is that it can be trusted.
    #[test]
    fn the_git_check_reports_the_version_it_found() {
        let found = git();
        assert!(found.ok);
        assert!(found.detail.starts_with("git version"), "got: {}", found.detail);
    }
}
