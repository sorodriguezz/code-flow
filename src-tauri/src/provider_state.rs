//! The last thing that went wrong with a provider, kept after the toast is gone.
//!
//! A failed run says so once, in whatever surface started it. Ten minutes later the person opens the
//! provider's row in Settings to find out why it "stopped working", and there is nothing there: the
//! message lived in a toast. This keeps the most recent failure per provider — its kind, a code that
//! is safe to paste into a report, a short scrubbed message and when it happened — and clears it the
//! next time that provider answers.
//!
//! One row per provider in the settings table (`provider_last_error:<id>`), because it is a single
//! small value read when a row is drawn. Nothing here is sent anywhere.

use serde::{Deserialize, Serialize};

use crate::ai::{AiFailureKind, AiRun};

const KEY_PREFIX: &str = "provider_last_error:";
/// A message is a line or two; past this it is a log, and the row is not the place for one.
const MAX_MESSAGE: usize = 300;

/// One provider's most recent failure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LastError {
    /// Seconds since the epoch.
    pub at: i64,
    /// `quota`, `auth_required`, `cli_missing`, `cli_busy`, `overloaded` or `other` — the AI
    /// classifier's own words (see [`AiFailureKind`]).
    pub kind: String,
    /// The general classifier's kind (`network`, `timeout`, …) when the AI one said `other`.
    pub general: Option<String>,
    /// A code safe to paste into a report. See [`crate::user_errors::reference`].
    pub reference: Option<String>,
    /// The provider's own words, scrubbed and cut to a line or two.
    pub message: String,
}

fn key(provider: &str) -> String {
    format!("{KEY_PREFIX}{provider}")
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Whether a failed run says something about the provider. A run the user stopped, and one that
/// never started because its repository was busy, say nothing about it.
fn is_provider_failure(error: &str) -> bool {
    !(error.starts_with(crate::ai_runs::CANCELLED_MARKER) || error.starts_with(crate::ai_locks::BUSY_MARKER))
}

/// Builds the record for one failure. Pure, so it can be tested without a database.
pub fn describe(error: &str, at: i64) -> LastError {
    let failure = crate::ai::classify_failure(error);
    let general = crate::user_errors::classify(error);
    let kind = serde_json::to_value(failure.kind).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_else(|| "other".into());
    // The general kind is only worth keeping when the AI classifier had nothing better.
    let general_kind = (failure.kind == AiFailureKind::Other && general.kind != crate::user_errors::ErrorKind::Unknown)
        .then(|| serde_json::to_value(general.kind).ok().and_then(|v| v.as_str().map(str::to_string)))
        .flatten();
    let flat: String = failure.message.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut message = crate::applog::scrub(&flat);
    if message.chars().count() > MAX_MESSAGE {
        message = message.chars().take(MAX_MESSAGE).collect::<String>() + "…";
    }
    LastError { at, kind, general: general_kind, reference: general.reference, message }
}

/// Files the outcome of one run: a failure is recorded, a success clears what was there.
pub fn note_outcome(provider: &str, outcome: &Result<AiRun, String>) {
    if provider.trim().is_empty() {
        return;
    }
    match outcome {
        Ok(_) => clear(provider),
        Err(error) if is_provider_failure(error) => {
            let record = describe(error, now());
            if let Ok(json) = serde_json::to_string(&record) {
                crate::ai_usage::with_conn(|conn| crate::db::queries::set_setting(conn, &key(provider), &json));
            }
        }
        Err(_) => {}
    }
}

/// Forgets a provider's last error. A no-op when there is none.
pub fn clear(provider: &str) {
    crate::ai_usage::with_conn(|conn| {
        let _ = conn.execute("DELETE FROM app_settings WHERE key = ?1", rusqlite::params![key(provider)]);
    });
}

/// The provider's last failure, if it has not answered since.
pub fn last_error(provider: &str) -> Option<LastError> {
    serde_json::from_str(&crate::ai_usage::setting(&key(provider))?).ok()
}

/// Text to paste into an issue: the provider, its last failure and the app's own version, with no
/// account, path or conversation in it.
pub fn diagnostics(provider: &str, app_version: &str) -> String {
    let mut out = format!("provider: {provider}\napp: {app_version}\n");
    match last_error(provider) {
        Some(error) => {
            out.push_str(&format!("last error: {} ({})\n", error.kind, error.general.as_deref().unwrap_or("-")));
            if let Some(reference) = &error.reference {
                out.push_str(&format!("reference: {reference}\n"));
            }
            out.push_str(&format!("at: {}\nmessage: {}\n", error.at, error.message));
        }
        None => out.push_str("last error: none\n"),
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_quota_failure_keeps_the_ai_kind_and_its_words() {
        let record = describe("QUOTA_EXCEEDED::You've hit your weekly limit · resets Mon 9am", 100);
        assert_eq!(record.kind, "quota");
        assert!(record.message.contains("weekly limit"));
        assert_eq!(record.at, 100);
    }

    #[test]
    fn an_unclassified_ai_failure_borrows_the_general_kind_and_reference() {
        let record = describe("connect ECONNREFUSED 127.0.0.1:11434", 1);
        assert_eq!(record.kind, "other");
        assert_eq!(record.general.as_deref(), Some("network"));
        assert_eq!(record.reference.as_deref(), Some("errno/ECONNREFUSED"));
    }

    #[test]
    fn the_message_is_one_scrubbed_bounded_line() {
        let record = describe("failed\n  with Authorization: Bearer abcdefghijklmnopqrstuvwx\nand more", 1);
        assert!(!record.message.contains('\n'));
        assert!(!record.message.contains("abcdefghijklmnopqrstuvwx"));
        let long = describe(&"word ".repeat(200), 1);
        assert!(long.message.chars().count() <= MAX_MESSAGE + 1);
    }

    #[test]
    fn a_stopped_run_or_a_busy_repository_says_nothing_about_the_provider() {
        assert!(!is_provider_failure(crate::ai_runs::CANCELLED_MARKER));
        assert!(!is_provider_failure(&format!("{}x", crate::ai_locks::BUSY_MARKER)));
        assert!(is_provider_failure("exited with an error"));
    }

    #[test]
    fn diagnostics_carry_no_path_account_or_conversation() {
        // Nothing stored for this made-up provider: the report still reads, and says so.
        let text = diagnostics("no-such-provider", "9.9.9");
        assert!(text.contains("provider: no-such-provider"));
        assert!(text.contains("last error: none"));
    }
}
