//! CI/CD pipelines — the runs a repository has executed, the jobs inside them, and their logs.
//!
//! Named `ci` rather than `pipelines` on purpose: in this crate "pipeline" already means the
//! *AI review* pipeline (`commands::review_pipeline`, `review::*`), and a second meaning for the
//! same word in the same codebase is a bug waiting to be read into existence.
//!
//! The shape is the one `crate::ado`'s [`PullRequestSummary`] established for pull requests: the
//! wire types are declared **once**, here, with a `provider` field, and each of the three clients
//! produces exactly them. The frontend never branches on the host, and neither does anything
//! between here and it.
//!
//! What each provider actually gives us differs enough to be worth stating up front, because the
//! whole shape of this module follows from it:
//!
//! | | run | jobs | log | grouping |
//! |---|---|---|---|---|
//! | GitHub | workflow run | `/runs/{id}/jobs` | per job, behind a 302 | **none** — see [`PipelineRun::definition_path`] |
//! | GitLab | pipeline | `/pipelines/{id}/jobs` | per job (`trace`), text/plain | `job.stage`, first-class |
//! | Azure | build | `timeline` records | per *record*, not per job | the record's `Stage` parent |
//!
//! [`PullRequestSummary`]: crate::ado::PullRequestSummary

pub mod azure;
pub mod github;
pub mod gitlab;
pub mod http;

use serde::Serialize;

/// The provider ids as they travel to the frontend. Same three strings the PR types use, so a
/// component that already knows how to label "github" doesn't learn a second vocabulary.
pub const PROVIDER_GITHUB: &str = "github";
pub const PROVIDER_GITLAB: &str = "gitlab";
pub const PROVIDER_AZURE: &str = "azure";

/// The seven buckets every provider's taxonomy is collapsed into before it crosses to TypeScript.
///
/// Normalising in Rust rather than in the UI is the rule the PR clients already follow
/// (`github::bucket_status`, `gitlab::bucket_status`, `ado::bucket_status`). The UI gets a closed
/// set it can exhaustively map to an icon and a colour; the provider's own word survives in
/// [`PipelineRun::raw_status`] for the tooltip, so nothing is actually lost.
pub mod status {
    /// Accepted by the host, no runner yet.
    pub const QUEUED: &str = "queued";
    /// A runner has it. The only bucket the UI draws with an orb instead of a glyph.
    pub const RUNNING: &str = "running";
    pub const SUCCESS: &str = "success";
    /// Finished, but not cleanly. Only Azure says this outright (`partiallySucceeded`); for the
    /// other two it is derived — see each client's `bucket_status`.
    pub const WARNING: &str = "warning";
    pub const FAILED: &str = "failed";
    pub const CANCELLED: &str = "cancelled";
    /// Never ran: a branch condition, a manual job nobody launched, or a stage skipped because
    /// the one before it failed.
    pub const SKIPPED: &str = "skipped";
}

/// True for the two buckets that are still moving, which is what decides the polling cadence and
/// whether a run may be handed to the failure analysis yet.
pub fn is_live(bucket: &str) -> bool {
    bucket == status::RUNNING || bucket == status::QUEUED
}

/// One execution of a pipeline: a GitHub workflow run, a GitLab pipeline, an Azure build.
#[derive(Debug, Clone, Serialize)]
pub struct PipelineRun {
    /// "github" | "gitlab" | "azure".
    pub provider: String,
    /// The host's own id, as a string. Deliberately not an `i64`: the three providers don't share
    /// an id space, the value is only ever echoed back to the host or used as a map key, and a
    /// string keeps Azure's build ids and GitHub's 64-bit run ids in the same field without
    /// anyone having to remember which is which.
    pub id: String,
    /// The number a human sees — `run_number`, the pipeline `iid`, the build number. Absent when
    /// the host doesn't publish one.
    pub number: Option<i64>,
    /// The workflow / pipeline / build-definition name.
    pub name: String,
    /// One of [`status`].
    pub status: String,
    /// What the provider actually said, for the tooltip. Keeping it is what makes the bucketing
    /// above safe to be lossy.
    pub raw_status: String,
    pub branch: String,
    pub commit_sha: String,
    pub commit_title: Option<String>,
    pub actor: Option<String>,
    /// What triggered it — `push`, `pull_request`, `schedule`, `individualCI`… Free-form: it is
    /// shown, never matched on.
    pub event: Option<String>,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    /// Where "open in GitHub / GitLab / Azure DevOps" goes. Always a browser URL, never an API
    /// one, and always built with the *web* encoder — a `/` percent-encoded into `%2F` is correct
    /// for GitLab's API and broken in a browser.
    pub web_url: String,
    /// Repo-relative path of the file that defines this run, when the host names one.
    ///
    /// Only GitHub populates it, and it exists for exactly one reason: `/runs/{id}/jobs` does not
    /// return `needs`, so GitHub is the one provider whose API cannot tell us which jobs ran in
    /// parallel. The frontend reads this file out of the working copy and parses the `needs:` to
    /// build the graph's columns — no extra request, no new dependency. When it can't (renamed
    /// workflow, working copy on another commit), the graph falls back to grouping jobs by
    /// overlapping time, and says so.
    pub definition_path: Option<String>,
}

/// One unit inside a run. The unit that has a log — which is why there is no `step` level: GitLab
/// has no steps at all, and in Azure the log hangs off a timeline *record*, not off the job.
#[derive(Debug, Clone, Serialize)]
pub struct PipelineJob {
    pub provider: String,
    pub run_id: String,
    pub id: String,
    pub name: String,
    /// The column this job belongs to in the graph, when the provider says. `None` for GitHub,
    /// where nothing in the API knows — see [`PipelineRun::definition_path`].
    pub stage: Option<String>,
    pub status: String,
    pub raw_status: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub web_url: String,
    /// A second identifier the log needs, when the job's own id isn't enough. Azure addresses
    /// logs by the timeline record's `log.id`, which is a different number from the record id.
    pub log_ref: Option<String>,
}

/// A run plus its jobs, fetched together because the UI never wants one without the other.
#[derive(Debug, Clone, Serialize)]
pub struct PipelineRunDetail {
    pub run: PipelineRun,
    pub jobs: Vec<PipelineJob>,
}

/// A job's log, already capped.
#[derive(Debug, Clone, Serialize)]
pub struct JobLog {
    /// The text as the host served it: ANSI intact, markers intact, nothing rewritten. The log
    /// pane renders it, and a pane that quietly edits what the host said is a pane you stop
    /// trusting. The cleaning happens on the *analysis* path only — see [`clean_ci_markers`].
    pub text: String,
    /// Whether [`MAX_LOG_BYTES`] cut it short. Announced in the UI rather than left implicit.
    pub truncated: bool,
    /// How much was read before the cap. Not the log's full size when `truncated` is true —
    /// nothing asked the host how big it was.
    pub total_bytes: u64,
}

/// Whether the repository is wired up for this screen at all, and to what.
///
/// One command answers both halves of the gate so the frontend doesn't have to re-implement
/// `linked_repo`'s provider precedence — which, if it drifted, would show the tab for one host and
/// fetch from another.
#[derive(Debug, Clone, Serialize)]
pub struct PipelineAvailability {
    /// The provider this project is linked to, or `None` if it is linked to nothing.
    pub provider: Option<String>,
    /// Whether that provider has a saved connection. Read from the `*_connections` app-settings,
    /// never from the keychain: on macOS with an ad-hoc signature every keychain read pops a
    /// password dialog, and this runs whenever a repository is selected.
    pub connected: bool,
    /// The host or organization the tab would talk to, for the "not connected" message.
    pub host: Option<String>,
}

// ---------------------------------------------------------------------------
// Log handling
// ---------------------------------------------------------------------------

/// How much of a log is read before giving up on it.
///
/// A GitLab `trace` has no guaranteed ceiling — the administrator of a self-managed instance sets
/// it — and a job that loops printing can produce hundreds of megabytes. The cap is on the read
/// itself (see [`http::read_capped`]), not on a buffer we have already filled.
pub const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

/// How much of a log the failure analysis is given.
///
/// Roughly the size of [`crate::ai::MAX_REVIEW_DIFF_CHARS`] halved: a log is far more repetitive
/// than a diff, so the same budget buys less signal, and what matters is nearly always at the end.
pub const MAX_AI_LOG_CHARS: usize = 60_000;

/// The marker written where the middle of a log was dropped.
fn elision(chars: usize) -> String {
    format!("\n… [{chars} caracteres omitidos por CodeFlow] …\n")
}

/// Trims a log to `max_chars`, **keeping the end**.
///
/// This is the one piece of this feature that could not reuse anything: every truncation in this
/// codebase is `text.chars().take(N)` (`ai.rs:1936`, `:2724`, `:2816`, `:3914`, `:3942`), which
/// keeps the *head*. On a diff that is right — a diff's first hunks are as informative as its
/// last. On a CI log it is exactly wrong: the head is `actions/checkout` and `npm install`, and
/// the thing that has to survive is the stack trace on the final screen.
///
/// A fifth of the budget is still spent on the head, because the head carries the command that
/// was run and the versions it ran with, and an analysis that can't see the command is guessing.
/// Both cuts land on a line boundary — a log is read as lines, and half a line at each seam is
/// half a line the model has to decide whether to trust.
///
/// Returns the text and whether anything was dropped.
pub fn head_and_tail(text: &str, max_chars: usize) -> (String, bool) {
    let total = text.chars().count();
    if total <= max_chars {
        return (text.to_string(), false);
    }

    let head_budget = max_chars / 5;
    let tail_budget = max_chars - head_budget;

    // Byte offset of the character at `index`, so the slices below are on char boundaries.
    let at = |index: usize| -> usize {
        text.char_indices().nth(index).map(|(byte, _)| byte).unwrap_or(text.len())
    };

    // The head ends at the last newline inside its budget, so it never stops mid-line.
    let head_end_raw = at(head_budget);
    let head_end = text[..head_end_raw].rfind('\n').map(|at| at + 1).unwrap_or(0);

    // The tail starts at the first newline *after* its budget opens, for the same reason.
    let tail_start_raw = at(total - tail_budget);
    let tail_start = text[tail_start_raw..]
        .find('\n')
        .map(|offset| tail_start_raw + offset + 1)
        .unwrap_or(tail_start_raw);

    // A pathological log — one line of ten megabytes, which a progress bar without newlines is —
    // leaves the two boundaries crossed. Keeping the tail alone is the honest answer there.
    if head_end >= tail_start {
        let kept: String = text.chars().skip(total.saturating_sub(max_chars)).collect();
        return (kept, true);
    }

    let dropped = text[head_end..tail_start].chars().count();
    let mut out = String::with_capacity(max_chars + 64);
    out.push_str(&text[..head_end]);
    out.push_str(&elision(dropped));
    out.push_str(&text[tail_start..]);
    (out, true)
}

/// Strips the scaffolding CI systems wrap their logs in, for the *analysis* payload only.
///
/// Every one of these is noise to a model and costs budget that the actual error should be
/// spending: GitHub's `##[group]` / `##[endgroup]` fold markers, GitLab's `section_start:` /
/// `section_end:` sequences, and the ISO timestamp Azure and GitHub Actions prepend to every
/// single line (28 characters × the whole log).
///
/// What it deliberately does **not** touch: `##[error]` and `##[warning]`, which are the host
/// telling us where it thinks the problem is, and are worth more to the analysis than they cost.
pub fn clean_ci_markers(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        let line = strip_timestamp(line);
        let trimmed = line.trim_start();
        if trimmed.starts_with("##[group]")
            || trimmed.starts_with("##[endgroup]")
            || trimmed.starts_with("##[debug]")
        {
            continue;
        }
        if trimmed.starts_with("section_start:") || trimmed.starts_with("section_end:") {
            continue;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// Drops a leading `2026-08-21T17:04:11.1234567Z ` if there is one.
///
/// Matched structurally rather than with a regex (this crate has no regex dependency and does not
/// need one for this): 4 digits, `-`, and a `Z` or `+` before the first space.
fn strip_timestamp(line: &str) -> &str {
    let Some(space) = line.find(' ') else { return line };
    let (stamp, rest) = line.split_at(space);
    let bytes = stamp.as_bytes();
    if stamp.len() < 20 || bytes.len() < 11 {
        return line;
    }
    let looks_iso = bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && stamp.contains('T')
        && (stamp.ends_with('Z') || stamp.contains('+'));
    if looks_iso { rest.trim_start_matches(' ') } else { line }
}

/// The seconds between two RFC3339 stamps, when both are there and parse.
///
/// Hand-rolled rather than pulling in `chrono`: the crate doesn't depend on it, the only shape
/// these APIs emit is `YYYY-MM-DDTHH:MM:SS(.fff)?(Z|±HH:MM)`, and the frontend does the actual
/// formatting. Returns `None` rather than guessing on anything it doesn't recognise.
pub fn duration_secs(from: Option<&str>, to: Option<&str>) -> Option<i64> {
    let a = epoch_secs(from?)?;
    let b = epoch_secs(to?)?;
    Some((b - a).max(0))
}

/// Seconds since the epoch for an RFC3339 stamp, UTC or with an offset.
fn epoch_secs(stamp: &str) -> Option<i64> {
    let bytes = stamp.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> { stamp.get(from..to)?.parse::<i64>().ok() };
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, s) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);

    // Days since 1970-01-01, by the civil-from-days algorithm (Howard Hinnant's), which is exact
    // for every proleptic Gregorian date and needs no table.
    let y_adj = if mo <= 2 { y - 1 } else { y };
    let era = if y_adj >= 0 { y_adj } else { y_adj - 399 } / 400;
    let yoe = y_adj - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;

    let mut secs = days * 86_400 + h * 3600 + mi * 60 + s;

    // An offset means the stamp is *local*; subtracting it gets back to UTC.
    if let Some(sign_at) = stamp[19..].find(['+', '-']).map(|at| at + 19) {
        let offset = &stamp[sign_at..];
        if offset.len() >= 6 {
            let oh: i64 = offset.get(1..3)?.parse().ok()?;
            let om: i64 = offset.get(4..6)?.parse().ok()?;
            let magnitude = oh * 3600 + om * 60;
            secs += if offset.starts_with('-') { magnitude } else { -magnitude };
        }
    }
    Some(secs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_logs_are_returned_whole() {
        let (out, cut) = head_and_tail("one\ntwo\nthree\n", 500);
        assert_eq!(out, "one\ntwo\nthree\n");
        assert!(!cut);
    }

    #[test]
    fn truncation_keeps_the_end_which_is_the_whole_point() {
        let mut log = String::new();
        for i in 0..2000 {
            log.push_str(&format!("line {i}\n"));
        }
        log.push_str("error[E0599]: no method named `get_text`\n");

        let (out, cut) = head_and_tail(&log, 900);
        assert!(cut);
        // The failure survived...
        assert!(out.contains("error[E0599]"));
        // ...and so did the beginning, which says what was being run.
        assert!(out.starts_with("line 0\n"));
        assert!(out.contains("omitidos por CodeFlow"));
        // Nothing was cut mid-line: every line is one the original had.
        for line in out.lines().filter(|l| l.starts_with("line ")) {
            assert!(log.contains(&format!("{line}\n")), "línea partida: {line}");
        }
    }

    #[test]
    fn a_single_enormous_line_still_keeps_its_end() {
        let log = format!("{}FINAL", "x".repeat(5000));
        let (out, cut) = head_and_tail(&log, 100);
        assert!(cut);
        // The whole point: a progress bar that never printed a newline still surrenders its last
        // screen, which is where the failure is.
        assert!(out.ends_with("FINAL"));
        // There is no line boundary anywhere, so no head survives — only the marker and the tail.
        assert!(out.starts_with('\n'));
        // The budget bounds the *log*; the marker is CodeFlow talking, and it is allowed to cost
        // its own length on top. Anything else would mean silently returning less than asked for.
        let marker = elision(0).chars().count() + 8;
        assert!(out.chars().count() <= 100 + marker, "{} caracteres", out.chars().count());
    }

    #[test]
    fn multibyte_logs_are_cut_on_character_boundaries() {
        let log = "héllo wörld ñ\n".repeat(500);
        let (out, cut) = head_and_tail(&log, 200);
        assert!(cut);
        // Reaching here at all means no slice landed inside a character; assert the content too.
        assert!(out.contains("héllo"));
    }

    #[test]
    fn ci_scaffolding_goes_but_the_hosts_own_diagnosis_stays() {
        let raw = "2026-08-21T17:04:11.1234567Z ##[group]Run cargo test\n\
                   2026-08-21T17:04:12.0000000Z    Compiling codeflow_lib\n\
                   section_start:1755795851:step_script\n\
                   ##[endgroup]\n\
                   ##[error]Process completed with exit code 101.\n";
        let out = clean_ci_markers(raw);
        assert!(!out.contains("##[group]"));
        assert!(!out.contains("##[endgroup]"));
        assert!(!out.contains("section_start:"));
        assert!(!out.contains("2026-08-21T"));
        assert!(out.contains("Compiling codeflow_lib"));
        // The one marker worth its bytes.
        assert!(out.contains("##[error]Process completed with exit code 101."));
    }

    #[test]
    fn a_line_that_merely_starts_with_digits_keeps_them() {
        assert_eq!(strip_timestamp("2000 packages installed"), "2000 packages installed");
        assert_eq!(strip_timestamp("   indented"), "   indented");
    }

    #[test]
    fn durations_come_out_in_seconds() {
        assert_eq!(
            duration_secs(Some("2026-08-21T17:04:11Z"), Some("2026-08-21T17:07:31Z")),
            Some(200)
        );
        // Across a month boundary, which is where a hand-rolled calendar earns its test.
        assert_eq!(
            duration_secs(Some("2026-01-31T23:59:00Z"), Some("2026-02-01T00:00:00Z")),
            Some(60)
        );
        // Leap day.
        assert_eq!(
            duration_secs(Some("2028-02-28T00:00:00Z"), Some("2028-03-01T00:00:00Z")),
            Some(172_800)
        );
        // An offset is resolved to UTC, not taken at face value.
        assert_eq!(
            duration_secs(Some("2026-08-21T19:04:11+02:00"), Some("2026-08-21T17:07:31Z")),
            Some(200)
        );
        // A run that hasn't finished has no duration, rather than a wrong one.
        assert_eq!(duration_secs(Some("2026-08-21T17:04:11Z"), None), None);
        assert_eq!(duration_secs(Some("no es una fecha"), Some("2026-08-21T17:04:11Z")), None);
    }

    #[test]
    fn live_is_only_the_two_moving_buckets() {
        assert!(is_live(status::RUNNING));
        assert!(is_live(status::QUEUED));
        for done in [status::SUCCESS, status::WARNING, status::FAILED, status::CANCELLED, status::SKIPPED] {
            assert!(!is_live(done), "{done} no debería contar como vivo");
        }
    }
    /// Trimming an already-trimmed log must not eat the end of it.
    ///
    /// `analyze_pipeline_failure` applies a second, defensive ceiling on top of the caller's, so
    /// the two run back to back on the same text. A head-keeping `chars().take()` there would undo
    /// the whole point of this function — and, because the first pass leaves the text *exactly* at
    /// the budget plus an elision marker, it bit on every trimmed log rather than only on long ones.
    #[test]
    fn trimming_twice_still_keeps_the_end() {
        let mut log = String::new();
        for i in 0..3000 {
            log.push_str(&format!("line {i}\n"));
        }
        log.push_str("##[error]Process completed with exit code 101.\n");

        let (once, _) = head_and_tail(&log, 1200);
        let (twice, _) = head_and_tail(&once, 1200);
        assert!(twice.contains("##[error]Process completed with exit code 101."));
        assert!(twice.ends_with('\n'));
    }

}
