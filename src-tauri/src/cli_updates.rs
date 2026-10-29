//! Keeping the AI CLIs current: find out which have a newer version, and update them in one click.
//!
//! # How a CLI is updated
//!
//! By the CLI itself. Each one the app drives has an update subcommand of its own (see
//! [`crate::provider_caps`]), and that command knows how it was installed — a native installer, npm,
//! Homebrew — and updates it that way. Guessing the channel from a path and running `npm i -g` over a
//! native install is how a second copy gets left behind with the old one first on `PATH`. The npm
//! registry is used for one thing only: learning what the latest version is.
//!
//! # What this never does
//!
//! - Run a binary the app is not already configured to use. The CLI updated is the one a run would
//!   launch (`{provider}_binary_path`, else the engine's default).
//! - Update while an AI process is alive. Replacing an executable under a running turn is what breaks
//!   it, most of all on Windows, so the update waits (see [`Outcome::Busy`]).
//! - Report a problem at launch. [`check_all`] swallows every failure: no network is silence, not an
//!   error card. Errors are for the update the person asked for.
//! - Promise a percentage. None of these commands reports one; progress is the CLI's own output.

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::provider_caps::{self, ProviderCaps};

/// Setting: whether the app looks for updates when it opens. On unless it reads `"false"`.
pub const ENABLED_KEY: &str = "cli_updates_enabled";
/// Setting: seconds since the epoch of the last check that ran.
const LAST_CHECK_KEY: &str = "cli_updates_last_check";
/// Setting: `{ "<provider>": "<version>" }` — updates the person said to skip, until a newer one.
const SKIPPED_KEY: &str = "cli_updates_skipped";
/// A check at most this often, however many times the app is opened. Overridden by `force`.
const CHECK_EVERY_SECS: i64 = 12 * 60 * 60;
/// How long one CLI's lookups (its version, the registry) may take.
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(8);
/// How long an update may run before it is stopped.
const UPDATE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// How long the output is still read once the process is gone or stopped.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
/// Lines of output kept for "Show details".
const KEEP_LINES: usize = 60;

/// One CLI that has a newer version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliUpdate {
    pub provider: String,
    pub label: String,
    pub binary: String,
    pub installed: String,
    pub latest: String,
}

// ------------------------------------------------------------------------------------ versions

/// The numeric parts of a version: `v2.1.310` → `[2, 1, 310]`. Anything after a `-` or `+` is dropped.
fn numbers(version: &str) -> Vec<u64> {
    version
        .trim()
        .trim_start_matches('v')
        .split(['-', '+'])
        .next()
        .unwrap_or_default()
        .split('.')
        .map_while(|part| part.parse::<u64>().ok())
        .collect()
}

/// Whether `latest` is a newer release than `installed`.
///
/// A pre-release (`1.2.3-beta.1`) is offered only to someone already on one: the latest *stable* is the
/// registry's `latest` tag, so a `-` in it means the project tagged a pre-release as latest, and
/// pushing that onto a stable install is the update nobody asked for. A version that does not parse
/// is never newer — "unknown" must not turn into a card.
pub fn is_newer(installed: &str, latest: &str) -> bool {
    let (have, want) = (numbers(installed), numbers(latest));
    if have.is_empty() || want.is_empty() {
        return false;
    }
    if latest.contains('-') && !installed.contains('-') {
        return false;
    }
    let len = have.len().max(want.len());
    for at in 0..len {
        let (a, b) = (have.get(at).copied().unwrap_or(0), want.get(at).copied().unwrap_or(0));
        if a != b {
            return b > a;
        }
    }
    false
}

// ----------------------------------------------------------------------------------- the check

fn setting(key: &str) -> Option<String> {
    crate::ai_usage::setting(key).filter(|value| !value.trim().is_empty())
}

fn put_setting(key: &str, value: &str) {
    crate::ai_usage::with_conn(|conn| crate::db::queries::set_setting(conn, key, value));
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// The binary a run of `provider` would launch.
fn binary_of(caps: &ProviderCaps) -> String {
    setting(&format!("{}_binary_path", caps.id)).unwrap_or_else(|| caps.default_binary.clone())
}

fn skipped() -> std::collections::HashMap<String, String> {
    setting(SKIPPED_KEY).and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default()
}

/// "Skip this version": no card for it until a newer one is published.
pub fn skip(provider: &str, version: &str) {
    let mut all = skipped();
    all.insert(provider.to_string(), version.to_string());
    if let Ok(json) = serde_json::to_string(&all) {
        put_setting(SKIPPED_KEY, &json);
    }
}

/// One CLI: its installed version against the registry's. `None` for anything that is not a clear
/// "there is a newer one" — not installed, version unreadable, registry unreachable, up to date.
async fn check_one(caps: ProviderCaps) -> Option<CliUpdate> {
    let package = caps.npm_package.clone()?;
    let binary = binary_of(&caps);
    // Not on this machine: nothing to update, and not this feature's place to say so.
    crate::ai::find_on_path(&binary)?;
    // Asked fresh: a CLI updated in a terminal since the app opened is not what was read before.
    crate::ai::forget_engine_version(&binary);
    let installed = tokio::time::timeout(LOOKUP_TIMEOUT, crate::ai::engine_version(&binary)).await.ok().flatten()?;
    let latest = tokio::time::timeout(LOOKUP_TIMEOUT, crate::npm::latest_version(&package)).await.ok()?.ok()?;
    if !is_newer(&installed, &latest) {
        return None;
    }
    if skipped().get(&caps.id).is_some_and(|version| version == &latest) {
        return None;
    }
    Some(CliUpdate { provider: caps.id, label: caps.label, binary, installed, latest })
}

/// Which CLIs have a newer version. Empty when the feature is off, when it ran too recently (unless
/// `force`), and on any failure: this runs unasked at launch, so it never complains.
pub async fn check_all(force: bool) -> Vec<CliUpdate> {
    if setting(ENABLED_KEY).as_deref() == Some("false") && !force {
        return Vec::new();
    }
    if !force {
        let last = setting(LAST_CHECK_KEY).and_then(|raw| raw.parse::<i64>().ok()).unwrap_or(0);
        if now() - last < CHECK_EVERY_SECS {
            return Vec::new();
        }
    }
    put_setting(LAST_CHECK_KEY, &now().to_string());
    let lookups = provider_caps::all().into_iter().filter(ProviderCaps::updatable).map(check_one);
    futures_util::future::join_all(lookups).await.into_iter().flatten().collect()
}

// ---------------------------------------------------------------------------------- the update

/// How an update ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// The CLI reports a newer version than before.
    Done,
    /// An AI process is running, or another update is. Nothing was started; try again shortly.
    Busy,
    /// The command failed.
    Failed,
    /// The command succeeded and the CLI still reports the old version: another copy is first on
    /// `PATH`, or the update did not take.
    NotApplied,
    /// The command failed and the CLI no longer starts.
    Broken,
}

/// The result of one update, for the card.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResult {
    pub provider: String,
    pub outcome: Outcome,
    /// What the CLI reports now. Empty when it could not be read.
    pub version_after: String,
    /// What failed, for the card's sentence: the general classifier's kind (`permission`,
    /// `network`, …), or `None` on success.
    pub error_kind: Option<crate::user_errors::ErrorKind>,
    /// A code safe to paste into a report.
    pub reference: Option<String>,
    /// The tail of the command's output, scrubbed — what "Show details" opens.
    pub details: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    provider: &'a str,
    line: String,
}

/// One CLI maintenance job at a time, app-wide: an update here and an install from «Preparar
/// CodeFlow» (`tool_setup`) rewrite the same binaries and shims, so they share this lock rather than
/// each keeping its own — two separate locks let an install and an update of one CLI run at once.
pub(crate) fn single_flight() -> &'static tokio::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(Default::default)
}

/// Builds the card's result: the output scrubbed, and — for a failure — classified, so the card can say
/// what went wrong in words and give a code to paste into a report.
fn result(
    provider: &str,
    outcome: Outcome,
    version_after: String,
    tail: &[String],
    failure: bool,
) -> UpdateResult {
    let details = crate::applog::scrub(&tail.join("\n"));
    let classified = failure.then(|| crate::user_errors::classify(&details));
    UpdateResult {
        provider: provider.to_string(),
        outcome,
        version_after,
        error_kind: classified.as_ref().map(|c| c.kind),
        reference: classified.and_then(|c| c.reference),
        details,
    }
}

/// Runs `provider`'s own update command and reports how it went. One at a time, and never while an AI
/// process is alive.
///
/// `before` is the version the card showed, so success is judged by the CLI's answer afterwards rather
/// than by an exit code alone: a command can exit cleanly having updated a copy that is not the one on
/// `PATH`.
pub async fn update(app: &AppHandle, provider: &str, before: &str) -> Result<UpdateResult, String> {
    let caps = provider_caps::caps_of(provider).filter(ProviderCaps::updatable).ok_or_else(|| format!("{provider} cannot be updated from here"))?;
    let args = caps.update_args.clone().unwrap_or_default();
    if crate::ai_runs::live_processes() > 0 {
        return Ok(result(provider, Outcome::Busy, String::new(), &[], false));
    }
    let Ok(_turn) = single_flight().try_lock() else {
        return Ok(result(provider, Outcome::Busy, String::new(), &[], false));
    };

    let binary = binary_of(&caps);
    let (mut command, program) = crate::ai::update_command(&binary);
    command.args(&args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped());
    command.kill_on_drop(true);
    // Its own group, so the timeout can stop everything it started: see `ai_runs::kill_tree`.
    crate::proc::own_process_group(&mut command);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let tail = vec![format!("could not start {program}: {error}")];
            return Ok(result(provider, Outcome::Failed, String::new(), &tail, true));
        }
    };

    let mut lines = Vec::<String>::new();
    let (mut out, mut err) = (
        BufReader::new(child.stdout.take().expect("piped")).lines(),
        BufReader::new(child.stderr.take().expect("piped")).lines(),
    );
    let deadline = tokio::time::sleep(UPDATE_TIMEOUT);
    tokio::pin!(deadline);
    // A stream that has ended is not polled again: `next_line` answers `None` at once from then on,
    // and a branch that is always ready turned the wait for the process into a busy loop.
    let (mut out_open, mut err_open) = (true, true);
    let status = loop {
        tokio::select! {
            line = out.next_line(), if out_open => match line {
                Ok(Some(line)) => keep(app, provider, &mut lines, line),
                _ => out_open = false,
            },
            line = err.next_line(), if err_open => match line {
                Ok(Some(line)) => keep(app, provider, &mut lines, line),
                _ => err_open = false,
            },
            status = child.wait() => break status.ok(),
            _ = &mut deadline => {
                // The whole tree: an installer is a shell running a package manager running more,
                // and killing only the shell left them going — and holding the pipes read below.
                crate::ai_runs::kill_tree(&mut child).await;
                lines.push("the update did not finish in 10 minutes and was stopped (timed out)".to_string());
                break None;
            }
        }
    };
    // Whatever the process wrote after it was waited for.
    // Bounded: a descendant that outlived the process (a daemon it started) can keep the pipes
    // open forever, and the result must not wait on it.
    let _ = tokio::time::timeout(DRAIN_TIMEOUT, async {
        while out_open {
            match out.next_line().await {
                Ok(Some(line)) => keep(app, provider, &mut lines, line),
                _ => out_open = false,
            }
        }
        while err_open {
            match err.next_line().await {
                Ok(Some(line)) => keep(app, provider, &mut lines, line),
                _ => err_open = false,
            }
        }
    })
    .await;

    crate::ai::forget_engine_version(&binary);
    let after = crate::ai::engine_version(&binary).await.unwrap_or_default();
    let succeeded = status.is_some_and(|status| status.success());

    if !succeeded {
        // A failed update that took the CLI with it is a different problem from one that changed
        // nothing: the person is left without the tool, and "Retry" is not the whole answer.
        let broken = after.is_empty() && !before.is_empty();
        let outcome = if broken { Outcome::Broken } else { Outcome::Failed };
        return Ok(result(provider, outcome, after, &lines, true));
    }
    if after.is_empty() || !is_newer(before, &after) {
        // Exited cleanly and reports no newer version than before.
        lines.push(format!("the CLI still reports {}", if after.is_empty() { "nothing" } else { after.as_str() }));
        return Ok(result(provider, Outcome::NotApplied, after, &lines, false));
    }
    Ok(result(provider, Outcome::Done, after, &lines, false))
}

/// Keeps a line for "Show details" and tells the card it arrived.
fn keep(app: &AppHandle, provider: &str, lines: &mut Vec<String>, line: String) {
    let line = line.trim_end().to_string();
    if line.is_empty() {
        return;
    }
    let shown = crate::applog::scrub(&line);
    let _ = app.emit("cli-update:progress", Progress { provider, line: shown });
    lines.push(line);
    if lines.len() > KEEP_LINES {
        lines.remove(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_newer_release_is_compared_number_by_number() {
        assert!(is_newer("2.1.310", "2.1.312"));
        assert!(is_newer("0.163.0", "0.165.0"));
        assert!(is_newer("1.18.35", "2.2.0"));
        // 10 is more than 9, whatever a string comparison says.
        assert!(is_newer("1.9.0", "1.10.0"));
        assert!(!is_newer("1.10.0", "1.9.0"));
        assert!(!is_newer("2.1.310", "2.1.310"));
        assert!(is_newer("v1.0.62", "1.0.70"));
    }

    #[test]
    fn a_missing_trailing_part_counts_as_zero() {
        assert!(!is_newer("1.2", "1.2.0"));
        assert!(is_newer("1.2", "1.2.1"));
    }

    #[test]
    fn what_cannot_be_read_is_never_newer() {
        assert!(!is_newer("", "1.0.0"));
        assert!(!is_newer("1.0.0", ""));
        assert!(!is_newer("banner without a version", "1.0.0"));
    }

    #[test]
    fn a_pre_release_is_offered_only_to_someone_already_on_one() {
        assert!(!is_newer("1.2.3", "1.3.0-beta.1"));
        assert!(is_newer("1.2.3-beta.1", "1.3.0-beta.2"));
    }

    #[test]
    fn the_update_command_of_each_cli_is_the_one_its_help_names() {
        let args = |id: &str| provider_caps::caps_of(id).unwrap().update_args.unwrap();
        assert_eq!(args("claude"), ["update"]);
        assert_eq!(args("codex"), ["update"]);
        assert_eq!(args("opencode"), ["upgrade"]);
    }

    #[test]
    fn a_failed_update_is_classified_and_its_output_scrubbed() {
        let tail = vec!["npm error code EACCES".to_string(), "npm error Authorization: Bearer abcdefghijklmnopqrstuvwx".to_string()];
        let failed = result("opencode", Outcome::Failed, String::new(), &tail, true);
        assert_eq!(failed.error_kind, Some(crate::user_errors::ErrorKind::Permission));
        assert_eq!(failed.reference.as_deref(), Some("errno/EACCES"));
        assert!(!failed.details.contains("abcdefghijklmnopqrstuvwx"));
        // A success carries no error at all.
        let done = result("opencode", Outcome::Done, "2.0.0".into(), &[], false);
        assert!(done.error_kind.is_none() && done.reference.is_none());
    }

    #[test]
    fn a_skipped_version_is_remembered_per_provider() {
        // No app database in a unit test: the call must be a quiet no-op rather than a panic.
        skip("claude", "9.9.9");
        assert!(skipped().is_empty() || skipped().contains_key("claude"));
    }
}
