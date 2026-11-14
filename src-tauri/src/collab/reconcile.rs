//! The three-way decision, per file, that keeps every copy of a session agreeing.
//!
//! For each path there are three states:
//!
//! - **agreed**: what this machine and the session last agreed the file was (the base when the path
//!   never synced).
//! - **local**: what this machine's worktree has now (its manifest).
//! - **remote**: what the session's record in Supabase says now.
//!
//! The rule is ordinary three-way merging at the granularity of whole files:
//!
//! | local vs remote | local vs agreed | remote vs agreed | action |
//! |---|---|---|---|
//! | same | - | - | [`Action::Settle`] when agreed lags, nothing otherwise |
//! | differ | same | - | [`Action::Pull`]: only the session moved |
//! | differ | - | same | [`Action::Push`]: only this machine moved |
//! | differ | differ | differ | [`Action::Conflict`]: both moved |
//!
//! A conflict is never resolved here. A text file open in the editor never reaches one in stage E
//! (its keystrokes travel as Yjs updates, not as whole files). For everything else the UI shows the
//! editor's compare strip and the person picks.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use super::manifest::{state_of, FileState};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    /// Send the local state to the session.
    Push,
    /// Write the session's state into the worktree.
    Pull,
    /// Both already agree. Only the agreed record is behind, so update it.
    Settle,
    /// Both sides changed the file since they last agreed.
    Conflict,
}

/// The action for one path, or `None` when everything already agrees.
pub fn decide(agreed: &FileState, local: &FileState, remote: &FileState) -> Option<Action> {
    if local.same_as(remote) {
        return (!agreed.same_as(local)).then_some(Action::Settle);
    }
    if local.same_as(agreed) {
        return Some(Action::Pull);
    }
    if remote.same_as(agreed) {
        return Some(Action::Push);
    }
    Some(Action::Conflict)
}

/// Every path any of the three maps names, with its action. A path missing from a map is at the base
/// there. The result is sorted by path, so a sync round is deterministic and its log readable.
pub fn plan(
    agreed: &BTreeMap<String, FileState>,
    local: &BTreeMap<String, FileState>,
    remote: &BTreeMap<String, FileState>,
) -> Vec<(String, Action)> {
    let paths: BTreeSet<&String> = agreed.keys().chain(local.keys()).chain(remote.keys()).collect();
    paths
        .into_iter()
        .filter_map(|path| {
            decide(state_of(agreed, path), state_of(local, path), state_of(remote, path)).map(|a| (path.clone(), a))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(sha: &str) -> FileState {
        FileState::Present { sha: sha.into(), size: 1, binary: false }
    }
    use FileState::{Base, Deleted};

    #[test]
    fn one_sided_changes_flow_the_right_way() {
        assert_eq!(decide(&Base, &p("x"), &Base), Some(Action::Push));
        assert_eq!(decide(&Base, &Base, &p("x")), Some(Action::Pull));
        assert_eq!(decide(&p("x"), &Deleted, &p("x")), Some(Action::Push));
        assert_eq!(decide(&p("x"), &p("x"), &Deleted), Some(Action::Pull));
    }

    #[test]
    fn a_revert_to_the_base_is_a_change_like_any_other() {
        assert_eq!(decide(&p("x"), &Base, &p("x")), Some(Action::Push));
        assert_eq!(decide(&p("x"), &p("x"), &Base), Some(Action::Pull));
    }

    #[test]
    fn agreement_needs_no_transfer() {
        assert_eq!(decide(&Base, &Base, &Base), None);
        assert_eq!(decide(&p("x"), &p("x"), &p("x")), None);
        // Both arrived at the same bytes on their own: only the record moves.
        assert_eq!(decide(&Base, &p("y"), &p("y")), Some(Action::Settle));
    }

    #[test]
    fn only_the_hash_decides_sameness() {
        let big = FileState::Present { sha: "x".into(), size: 999, binary: true };
        assert_eq!(decide(&p("x"), &big, &p("x")), None);
    }

    #[test]
    fn both_sides_moving_is_a_conflict() {
        assert_eq!(decide(&Base, &p("a"), &p("b")), Some(Action::Conflict));
        assert_eq!(decide(&p("x"), &Deleted, &p("y")), Some(Action::Conflict));
    }

    #[test]
    fn a_plan_covers_the_union_of_paths_in_order() {
        let agreed = BTreeMap::from([("shared.txt".to_string(), p("1"))]);
        let local = BTreeMap::from([("mine.txt".to_string(), p("m")), ("shared.txt".to_string(), p("1"))]);
        let remote = BTreeMap::from([("theirs.png".to_string(), p("t")), ("shared.txt".to_string(), p("2"))]);
        assert_eq!(
            plan(&agreed, &local, &remote),
            vec![
                ("mine.txt".to_string(), Action::Push),
                ("shared.txt".to_string(), Action::Pull),
                ("theirs.png".to_string(), Action::Pull),
            ]
        );
    }
}
