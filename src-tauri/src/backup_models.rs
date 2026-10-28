//! Where a plan's work goes when its provider says "not now".
//!
//! A chain that runs into a spent plan parks, and waits for the window to reopen. For a person who
//! pays for a second provider — or runs a local model — that is a long wait for a step that any of
//! them could have done. This is the ordered list they name once, in Settings: when a step parks on a
//! quota, the first entry that can take the work is given the step, and the plan goes on.
//!
//! **What may take a step is decided here, not asked of the user each time:**
//!
//! - It must be an engine that works with tools. Every step of a chain edits a working copy.
//! - A step that only *reads* (the analysis half of a story) must keep that limit: an engine whose
//!   "read only" is a request to the model rather than something its CLI enforces is never picked for
//!   it, because the fallback must not be the way a read-only step gains write access.
//! - A provider that just said "quota" is held out for [`HOLD_SECS`]. Plans are per account, so the
//!   next entry on the same provider would only fail again.
//! - The step it replaces is the one that failed. Nothing already done is touched.

use serde::{Deserialize, Serialize};

/// The setting holding the list, as JSON: `[{"provider":"codex","model":"gpt-6"}, …]`.
pub const KEY: &str = "ai_backup_models";
/// How many entries are kept. More is a list nobody could reason about.
pub const MAX: usize = 8;
/// How long a provider that refused for quota is passed over, in seconds.
pub const HOLD_SECS: i64 = 600;

/// One place work can go.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Backup {
    pub provider: String,
    /// Empty means "the provider's own default model".
    #[serde(default)]
    pub model: String,
}

/// Reads the stored list leniently: unknown providers, blanks and repeats are dropped, and it is cut
/// to [`MAX`]. A list that does not parse is an empty one — the feature is then simply off.
pub fn parse(raw: &str) -> Vec<Backup> {
    let Ok(list) = serde_json::from_str::<Vec<Backup>>(raw) else { return Vec::new() };
    let mut seen: Vec<Backup> = Vec::new();
    for entry in list {
        let entry = Backup { provider: entry.provider.trim().to_string(), model: entry.model.trim().to_string() };
        let known = crate::provider_caps::PROVIDER_IDS.contains(&entry.provider.as_str());
        if known && !seen.contains(&entry) {
            seen.push(entry);
        }
        if seen.len() == MAX {
            break;
        }
    }
    seen
}

/// Whether `provider` refused for quota recently enough to be passed over.
pub fn held(provider: &str, now: i64) -> bool {
    crate::provider_state::last_error(provider)
        .is_some_and(|error| error.kind == "quota" && now - error.at < HOLD_SECS)
}

/// The first entry that can take a step that just failed on `(provider, model)`.
///
/// `held` says whether a provider is being passed over; `needs_read_only` is true for a step that
/// must not be able to write.
pub fn pick(list: &[Backup], current: (&str, &str), needs_read_only: bool, held: &dyn Fn(&str) -> bool) -> Option<Backup> {
    list.iter()
        .find(|candidate| {
            let same = candidate.provider == current.0 && (candidate.model.is_empty() || candidate.model == current.1);
            if same || held(&candidate.provider) {
                return false;
            }
            let Some(caps) = crate::provider_caps::caps_of(&candidate.provider) else { return false };
            caps.agentic && (!needs_read_only || caps.enforces_read_only)
        })
        .cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list() -> Vec<Backup> {
        vec![
            Backup { provider: "claude".into(), model: "sonnet".into() },
            Backup { provider: "codex".into(), model: "gpt-6".into() },
            Backup { provider: "opencode".into(), model: "x/y".into() },
        ]
    }

    #[test]
    fn parse_drops_unknown_providers_blanks_and_repeats() {
        let raw = r#"[{"provider":"codex","model":" gpt-6 "},{"provider":"codex","model":"gpt-6"},
                      {"provider":"nope","model":"m"},{"provider":"","model":"m"},{"provider":"grok"}]"#;
        let parsed = parse(raw);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0], Backup { provider: "codex".into(), model: "gpt-6".into() });
        assert_eq!(parsed[1].provider, "grok");
        assert!(parsed[1].model.is_empty());
    }

    #[test]
    fn parse_of_garbage_is_an_empty_list_and_the_list_is_capped() {
        assert!(parse("not json").is_empty());
        assert!(parse("").is_empty());
        let many: Vec<Backup> = (0..20).map(|n| Backup { provider: "claude".into(), model: format!("m{n}") }).collect();
        assert_eq!(parse(&serde_json::to_string(&many).unwrap()).len(), MAX);
    }

    #[test]
    fn the_first_usable_entry_wins_and_never_the_one_that_just_failed() {
        let none_held = |_: &str| false;
        let next = pick(&list(), ("claude", "sonnet"), false, &none_held).unwrap();
        assert_eq!(next.provider, "codex");
        // An entry with no model stands for the whole provider.
        let whole = vec![Backup { provider: "claude".into(), model: String::new() }, Backup { provider: "grok".into(), model: String::new() }];
        assert_eq!(pick(&whole, ("claude", "opus"), false, &none_held).unwrap().provider, "grok");
    }

    #[test]
    fn a_provider_held_for_quota_is_passed_over() {
        let held_codex = |provider: &str| provider == "codex";
        assert_eq!(pick(&list(), ("claude", "sonnet"), false, &held_codex).unwrap().provider, "opencode");
        let all = |_: &str| true;
        assert!(pick(&list(), ("claude", "sonnet"), false, &all).is_none());
    }

    #[test]
    fn a_read_only_step_is_never_given_an_engine_that_cannot_enforce_it() {
        let none_held = |_: &str| false;
        let list = vec![
            // opencode's read-only is a request, not a limit (see `AiEngine::enforces_read_only`).
            Backup { provider: "opencode".into(), model: "x/y".into() },
            Backup { provider: "codex".into(), model: "gpt-6".into() },
        ];
        assert!(!crate::provider_caps::caps_of("opencode").unwrap().enforces_read_only);
        assert_eq!(pick(&list, ("claude", "sonnet"), true, &none_held).unwrap().provider, "codex");
        assert_eq!(pick(&list, ("claude", "sonnet"), false, &none_held).unwrap().provider, "opencode");
    }

    #[test]
    fn nothing_is_held_for_a_provider_with_no_recorded_failure() {
        assert!(!held("no-such-provider", 1_000_000));
    }
}
