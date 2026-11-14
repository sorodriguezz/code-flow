//! Shared workspace chats: two or more people on one workspace chat and the repositories it works
//! on, each on their own machine, with their own copy and their own engine quota.
//!
//! The plan, the decisions behind it and the stages are in `.claude/plans/multiplayer-chat.md`.
//! This is stage A, the core every later stage stands on, and nothing calls it yet:
//!
//! - [`exclude`]: what never leaves a machine. Dependency folders such as `node_modules` always;
//!   build output when it is not tracked; secrets files; symlinks; anything past the size cap.
//! - [`manifest`]: what a session worktree changed over its base, file by file, as content hashes.
//! - [`reconcile`]: the three-way decision per file (last agreed, local, remote) that turns two
//!   manifests into pushes, pulls and conflicts.
//! - [`worktree`]: the session worktree every participant works in, the host included. It is created
//!   on the base, seeded with the host's uncommitted work, takes in files from others and is closed
//!   onto its own branch.
//! - `collab_schema.sql`: the Supabase side (sessions, people with a nick and a key hash, invitations,
//!   per-file versions, blobs, the shared thread and per-repository turn locks).
//!
//! **Why every participant gets a worktree.** Nobody's own checkout is written to by a session, so
//! joining one never risks local work. Leaving one is choosing whether its branch stays, and there is
//! no stash to restore.
//!
//! **Why files and not diffs.** A file's state over the base is one of three things, `present(sha)`,
//! `deleted` or `base`. Agreeing on that per file is what lets binaries travel like text, a
//! reconnecting peer catch up without replaying history, and a revert to the base propagate.

#![allow(dead_code)] // Stage A: wired into commands, the chat and the UI in stages B–D.

pub mod chat;
pub mod exclude;
pub mod link;
pub mod manifest;
pub mod reconcile;
pub mod remote;
pub mod store;
pub mod sync;
pub mod worktree;

/// The Supabase script for sessions. CodeFlow has no Supabase of its own: every host runs this, once,
/// in a project of their choosing (the share dialog copies it), and their guests connect to that
/// project through the invitation. It stands alone, apart from the API client's `supabase_schema.sql`.
pub const SCHEMA_SQL: &str = include_str!("collab_schema.sql");

/// What `cf_collab_version()` returns for this build's script. Sharing checks the host's project
/// against it first, so a project without the script, or with an older one, is told so in words.
pub const SCHEMA_VERSION: i64 = 2;

#[cfg(test)]
mod tests {
    use super::SCHEMA_SQL;

    fn statements() -> impl Iterator<Item = &'static str> {
        SCHEMA_SQL.lines().map(str::trim).filter(|l| !l.starts_with("--"))
    }

    #[test]
    fn every_table_has_rls_and_none_is_forced() {
        let tables = statements().filter(|l| l.starts_with("create table if not exists cf_collab_")).count();
        let enabled = statements().filter(|l| l.starts_with("alter table cf_collab_") && l.ends_with("enable row level security;")).count();
        assert_eq!(tables, 8);
        assert_eq!(enabled, tables, "a table without row-level security would be world-readable");
        // Forcing it would hold the security-definer functions to the policies and make
        // cf_collab_me recurse through cf_collab_people's own policy.
        assert!(!statements().any(|l| l.contains("force row level security")));
    }

    #[test]
    fn every_policy_is_scoped_to_members() {
        let policies: Vec<&str> = statements().filter(|l| l.starts_with("create policy")).collect();
        assert!(!policies.is_empty());
        for policy in policies {
            assert!(policy.contains("cf_collab_me("), "{policy}");
        }
    }

    #[test]
    fn invitations_are_reachable_only_through_functions() {
        assert!(!statements().any(|l| l.starts_with("create policy") && l.contains("on cf_collab_invites")));
    }

    #[test]
    fn the_script_states_its_version() {
        let body = SCHEMA_SQL
            .split("create or replace function cf_collab_version()")
            .nth(1)
            .expect("the script defines cf_collab_version");
        assert!(body.contains(&format!("select {}", super::SCHEMA_VERSION)), "bump SCHEMA_VERSION with the script");
    }
}
