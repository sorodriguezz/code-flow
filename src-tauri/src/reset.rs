//! "Reset app data", performed at startup because it cannot be performed while the app is running.
//!
//! The marker is dropped by [`crate::commands::app_cmd::reset_app_data`], which then quits; this
//! runs on the next launch, before the database is opened and before [`crate::migrate`], when
//! nothing has a handle on anything.
//!
//! # What changed, and why it was a bug
//!
//! Until v1.19 this was one line — `remove_dir_all(paths::base_dir())` — and the single root it
//! deleted held, along with the database and the settings, two things it had no business touching:
//!
//! * `repos/`, the user's cloned repositories. Working copies, with whatever uncommitted work was
//!   in them.
//! * `Backups/`, every encrypted backup. So a reset destroyed the only artefacts that could have
//!   recovered from a reset.
//!
//! Neither was named in the confirmation text, in either language, or in the Windows uninstaller's
//! prompt. The user was told it would delete "the database, saved credentials, workspace MD files
//! and skills, review contexts, all settings" and it also deleted their source code.
//!
//! Now the roots are separate and the plan is enumerated rather than recursive: see
//! [`paths::wipe_plan`], which is where the two exclusions live and where the tests that pin them
//! are. This module is only the part that has to run at a particular moment.

use crate::applog;
use crate::paths;

/// Deletes what a pending reset asks for, if one is pending. Returns whether anything happened.
pub fn run_if_requested() -> bool {
    let marker = paths::reset_marker_path();

    // The old location too. A user who pressed "Reset app data" on a pre-v1.19 build and installed
    // the update before relaunching would otherwise get their reset silently ignored *and* all the
    // data they asked to be rid of copied into the new root by the migration — the exact opposite
    // of what they asked for, arrived at by two correct-looking steps.
    let legacy_marker = paths::legacy_base_dir().join(".reset-pending");

    let asked = marker.exists() || legacy_marker.exists();
    if !asked {
        return false;
    }
    applog::info("reset: a wipe was requested on the previous launch");

    let plan = paths::wipe_plan();
    for target in &plan.remove {
        remove(target);
    }
    for kept in &plan.kept {
        if kept.exists() {
            applog::info(&format!("reset: keeping {}", kept.to_string_lossy()));
        }
    }

    // The old root as well — but only when it is this user's own.
    //
    // The gate is the whole of it. On macOS and Linux the old root is `~/CodeFlow`, inside the
    // user's home, and sweeping it is right: someone who never migrated still has their database
    // there and asked for it to be gone. On Windows it is `C:\CodeFlow`, which is machine-wide with
    // no per-user component — the very fact this release exists to fix — so the other account's
    // database, workspaces and vault may be the only copy in it. Deleting those from a dialog that
    // named only `%LOCALAPPDATA%\CodeFlow` would be the same bug this module's header describes,
    // committed against a different directory. Windows users are offered that folder separately, by
    // the uninstaller, in its own prompt that names it.
    //
    // And when it does run: by name, never recursively. `repos` and `Backups` are conspicuously
    // absent from the list and must stay that way.
    let legacy = paths::legacy_base_dir();
    let mine = dirs::home_dir().map(|home| legacy.starts_with(home)).unwrap_or(false);
    if mine {
        for name in [
            "codeflow.db",
            "codeflow.db-wal",
            "codeflow.db-shm",
            "workspaces",
            "chain-memory",
            "pr-link-reviews",
            ".shell-path",
            ".write-test",
        ] {
            remove(&legacy.join(name));
        }
        remove_migrated_copies(&legacy);
    } else {
        applog::info(&format!(
            "reset: leaving {} alone — it is outside this user's profile and may be shared",
            legacy.to_string_lossy()
        ));
    }

    // The breadcrumb goes either way, and it has to.
    //
    // It is what tells the next launch "this user already migrated", and a reset means there is no
    // longer anything that was migrated. Left behind, `migrate` finds no manifest, sees the
    // breadcrumb, and reports a non-persistent profile — on a perfectly healthy machine, on every
    // launch from then on, while both recovery actions in Settings return errors. It is safe to
    // remove even from a shared `C:\CodeFlow`: it is this app's own note to itself, it names
    // nothing of the other account's, and a second account that has not migrated never reads it.
    remove(&legacy.join(crate::migrate::BREADCRUMB));

    remove(&marker);
    remove(&legacy_marker);
    applog::info("reset: done");
    true
}

/// The `codeflow.db.migrated-<date>` files [`crate::migrate`] leaves behind.
///
/// Matched by prefix rather than by reconstructing the date, because the date is whenever the
/// migration happened and a reset months later cannot know it.
fn remove_migrated_copies(legacy: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(legacy) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name.to_string_lossy().starts_with("codeflow.db.migrated-") {
            remove(&entry.path());
        }
    }
}

fn remove(path: &std::path::Path) {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return };
    let outcome =
        if meta.is_dir() { std::fs::remove_dir_all(path) } else { std::fs::remove_file(path) };
    match outcome {
        Ok(()) => applog::info(&format!("reset: removed {}", path.to_string_lossy())),
        // Logged and survived rather than propagated: a reset that stopped at the first locked file
        // would leave a half-wiped installation and no way to finish the job.
        Err(e) => applog::warn(&format!("reset: could not remove {}: {e}", path.to_string_lossy())),
    }
}
