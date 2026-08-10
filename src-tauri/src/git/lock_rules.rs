//! The one list of branch-name patterns that come locked without anyone having clicked a padlock.
//!
//! The per-branch lock in [`super::branch`] is a decision taken once, in one repository, on one
//! branch. That is the right shape for "leave this spike alone", and the wrong shape for "nothing
//! ever merges into main" — a rule that is true of every repository the user will ever open, and
//! that a per-branch switch makes them re-assert on each one, from memory, before the first
//! mistake rather than after it. So the rules live here, above every workspace and repository, and
//! the per-branch switch stays exactly what it was: the exception to them.
//!
//! ## Where the list lives, and why it is also a static
//!
//! The list is stored in `app_settings` (key [`SETTING_KEY`]) as a JSON array, next to every other
//! app-wide preference. But the guards that consume it — `guard_head_unlocked` and friends — run
//! deep inside the git layer, which is handed a repository path and nothing else: no `AppHandle`,
//! no database connection, and deliberately no Tauri types. Threading a connection down to them
//! would put the database on the signature of every git operation in the app.
//!
//! So the stored list is mirrored into a process-wide static, seeded once at startup (see
//! `lib.rs`) and rewritten whenever the settings screen saves. Reads are lock-free-ish and cheap,
//! which matters because `list_branches` asks about every branch on every refresh.

use std::sync::{OnceLock, RwLock};

/// Where the JSON array is kept in `app_settings`.
pub const SETTING_KEY: &str = "locked_branch_rules";

/// What a fresh install locks. The three integration branches nearly every team has, plus the
/// release line — the branches where an accidental merge or push is expensive and a deliberate one
/// is rare enough to be worth two clicks (unlock, do it, lock again).
///
/// These are only a *default*: the list is fully editable, and emptying it is a supported answer
/// that survives a restart (see [`resolve_stored`]).
pub const DEFAULT_RULES: &[&str] = &["main", "master", "develop", "release/*"];

fn cell() -> &'static RwLock<Vec<String>> {
    static RULES: OnceLock<RwLock<Vec<String>>> = OnceLock::new();
    RULES.get_or_init(|| RwLock::new(DEFAULT_RULES.iter().map(|s| s.to_string()).collect()))
}

/// The list as it stands. Cloned rather than borrowed so no caller holds the read lock while it
/// walks branches — `matches` takes the same lock per branch.
///
/// A poisoned lock is recovered from rather than treated as "no rules": the data behind it is a
/// `Vec<String>` that a panic elsewhere cannot have left half-written, and answering "nothing is
/// locked" would take every padlock down at once — the one direction this feature must never fail
/// in.
pub fn rules() -> Vec<String> {
    cell().read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Replaces the list. Entries are trimmed, blanks dropped and duplicates collapsed here rather
/// than at the UI, so the same normalisation applies to a restored backup and to a hand-edited
/// settings row as to the screen.
pub fn set_rules(list: Vec<String>) -> Vec<String> {
    let cleaned = normalize(list);
    *cell().write().unwrap_or_else(|e| e.into_inner()) = cleaned.clone();
    cleaned
}

pub fn normalize(list: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(list.len());
    for raw in list {
        let trimmed = raw.trim().to_string();
        if trimmed.is_empty() {
            continue;
        }
        if !out.iter().any(|existing| existing.eq_ignore_ascii_case(&trimmed)) {
            out.push(trimmed);
        }
    }
    out
}

/// Turns the stored settings value into a list. `None` — never configured — means the defaults;
/// `Some("[]")` means the user emptied the list on purpose and must stay empty. Without that
/// distinction, clearing every rule would silently restore all four on the next launch.
pub fn resolve_stored(stored: Option<&str>) -> Vec<String> {
    match stored {
        None => DEFAULT_RULES.iter().map(|s| s.to_string()).collect(),
        Some(raw) => match serde_json::from_str::<Vec<String>>(raw) {
            Ok(list) => normalize(list),
            // A row we can't parse is a corrupted setting, not a request for no protection.
            Err(_) => DEFAULT_RULES.iter().map(|s| s.to_string()).collect(),
        },
    }
}

/// Whether a branch name is covered by the list.
///
/// Remote-tracking names are never asked about: the lock is a local guard rail, and `list_branches`
/// only resolves it for local branches.
pub fn matches(branch: &str) -> bool {
    rules().iter().any(|pattern| matches_pattern(pattern, branch))
}

/// Glob matching over the branch name, with `*` for any run of characters (slashes included, so
/// `release/*` covers `release/2024/q1`) and `?` for exactly one. A pattern with no wildcard is an
/// exact name — which is what makes `main` mean the branch `main` and not everything containing it.
///
/// Case-insensitive over ASCII. Git refs are case-sensitive, but these patterns are typed by hand
/// into a settings box, and a `Develop` that slipped past the rule the user believed they had
/// written is the failure mode worth avoiding — the cost of being wrong the other way is a lock
/// they can lift with one click.
pub fn matches_pattern(pattern: &str, name: &str) -> bool {
    let p: Vec<char> = pattern.trim().to_ascii_lowercase().chars().collect();
    let n: Vec<char> = name.to_ascii_lowercase().chars().collect();
    if p.is_empty() {
        return false;
    }

    // Iterative backtracking rather than recursion: a pathological pattern (`*a*a*a*…`) would
    // otherwise cost a stack frame per star, and this runs once per branch per refresh.
    let (mut pi, mut ni) = (0usize, 0usize);
    let (mut star, mut resume) = (None::<usize>, 0usize);

    while ni < n.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == n[ni]) {
            pi += 1;
            ni += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            resume = ni;
            pi += 1;
        } else if let Some(s) = star {
            // Give the last star one more character and try again.
            pi = s + 1;
            resume += 1;
            ni = resume;
        } else {
            return false;
        }
    }

    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

/// Pins the process-wide list for the duration of one test, and puts the defaults back when the
/// returned guard drops.
///
/// The list is a static, and `cargo test` runs a module's tests on parallel threads in a single
/// process — so a test that quietly rewrote it would decide what an unrelated test in
/// [`super::branch`] sees. Every test that depends on the rules takes this, which both sets the
/// list and serialises them against each other, in the same shape `secrets.rs` uses for its own
/// process-wide store.
#[cfg(test)]
pub fn pin_for_test(list: &[&str]) -> RulesGuard {
    static ORDER: OnceLock<std::sync::Mutex<()>> = OnceLock::new();
    // A test that panicked while holding this poisoned the mutex; the data behind it is `()`, so
    // taking it anyway is right — the alternative is every later test failing for someone else's
    // reason.
    let order = ORDER
        .get_or_init(|| std::sync::Mutex::new(()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    set_rules(list.iter().map(|s| s.to_string()).collect());
    RulesGuard { _order: order }
}

#[cfg(test)]
pub struct RulesGuard {
    /// Held and never read: dropping it is the whole job, and it is what lets the next test in.
    _order: std::sync::MutexGuard<'static, ()>,
}

#[cfg(test)]
impl Drop for RulesGuard {
    fn drop(&mut self) {
        set_rules(DEFAULT_RULES.iter().map(|s| s.to_string()).collect());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_names_match_only_themselves() {
        assert!(matches_pattern("main", "main"));
        assert!(!matches_pattern("main", "maintenance"));
        assert!(!matches_pattern("main", "feature/main"));
        // Case-insensitive, as documented.
        assert!(matches_pattern("main", "Main"));
        assert!(matches_pattern("Develop", "develop"));
    }

    #[test]
    fn stars_span_slashes_so_release_covers_nested_lines() {
        assert!(matches_pattern("release/*", "release/1.2"));
        assert!(matches_pattern("release/*", "release/2024/q1"));
        // The prefix still has to be there, and `release/` alone isn't a release branch.
        assert!(!matches_pattern("release/*", "hotfix/1.2"));
        assert!(!matches_pattern("release/*", "release"));
        // A trailing star matches the empty rest, so `release/` itself is covered by `release*`.
        assert!(matches_pattern("release*", "release"));
    }

    #[test]
    fn question_mark_is_exactly_one_character() {
        assert!(matches_pattern("v?", "v1"));
        assert!(!matches_pattern("v?", "v10"));
        assert!(!matches_pattern("v?", "v"));
    }

    #[test]
    fn backtracking_pattern_terminates() {
        assert!(matches_pattern("*a*b*c", "xxaxxbxxc"));
        assert!(!matches_pattern("*a*b*c", "xxaxxbxx"));
        assert!(matches_pattern("*", "anything/at/all"));
    }

    #[test]
    fn an_empty_pattern_matches_nothing() {
        assert!(!matches_pattern("", "main"));
        assert!(!matches_pattern("   ", "main"));
    }

    #[test]
    fn normalising_trims_drops_blanks_and_collapses_duplicates() {
        let out = normalize(vec![
            "  main  ".into(),
            "".into(),
            "   ".into(),
            "MAIN".into(),
            "release/*".into(),
        ]);
        assert_eq!(out, vec!["main".to_string(), "release/*".to_string()]);
    }

    #[test]
    fn an_absent_row_means_defaults_and_an_empty_array_means_empty() {
        assert_eq!(resolve_stored(None), DEFAULT_RULES.to_vec());
        assert!(resolve_stored(Some("[]")).is_empty());
        assert_eq!(resolve_stored(Some(r#"["qa"]"#)), vec!["qa".to_string()]);
        // Garbage is a broken setting, not a request to protect nothing.
        assert_eq!(resolve_stored(Some("not json")), DEFAULT_RULES.to_vec());
    }

    #[test]
    fn the_static_reflects_the_last_write() {
        let _pinned = pin_for_test(&["qa", "  ", "release/*"]);
        assert_eq!(rules(), vec!["qa".to_string(), "release/*".to_string()]);
        assert!(matches("QA"));
        assert!(matches("release/9"));
        assert!(!matches("feature/x"));

        set_rules(Vec::new());
        assert!(!matches("qa"));
    }

    #[test]
    fn the_defaults_cover_the_branches_they_name_and_nothing_else() {
        let _pinned = pin_for_test(DEFAULT_RULES);
        for name in ["main", "master", "develop", "release/1.2", "release/2025/q1"] {
            assert!(matches(name), "{name} should be covered by the defaults");
        }
        for name in ["feature/main", "developer", "mainline", "hotfix/1.2", "release"] {
            assert!(!matches(name), "{name} should not be covered by the defaults");
        }
    }
}
