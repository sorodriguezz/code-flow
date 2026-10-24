//! «Resumen de tu trabajo»: the daily standup and the weekly report, written from what the user
//! actually did — commits, pull requests, CodeFlow's own PR reviews, meetings and tickets — over a
//! period (user, 2026-10-23: «Junta tus commits, PRs abiertos, revisados y mergeados, revisiones del
//! revisor, reuniones (con su resumen) y tickets movidos, por día o por semana»).
//!
//! Three halves, kept apart so each can be tested without the others:
//! - **collecting** ([`git`], [`sources`], [`prs`]) builds a [`WorkLog`] — plain data, nothing
//!   written; git and the database are read locally, the hosts are asked over the network with a cap
//!   and a time limit (it is a user-triggered or scheduled action, never a background poll);
//! - **writing** ([`render`] is the deterministic text that needs no model, [`writer`] asks the
//!   engine the user picked for «Ayer / Hoy / Bloqueos» or the weekly report, and falls back on the
//!   deterministic text when there is no engine or it fails);
//! - **keeping** ([`note`]) files the result as an ordinary note in Notas.
//!
//! **Nothing here publishes anything.** The result is a note and, from the UI, copy buttons; the
//! scheduled flow only creates the note and a local notification (user, 2026-10-23: «sin
//! publicarlo solo»).

pub mod codi;
pub mod git;
pub mod note;
pub mod prs;
pub mod render;
pub mod run;
pub mod sources;
pub mod writer;

use chrono::{Datelike, Duration, Local, NaiveDate, TimeZone, Weekday};
use serde::{Deserialize, Serialize};

/// Which stretch of time a summary covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum PeriodKind {
    /// The working day before today — what a standup calls «ayer». Monday looks at Friday.
    #[default]
    PreviousWorkday,
    Today,
    /// Monday of this week up to today.
    ThisWeek,
    /// Monday to Sunday of the week before.
    LastWeek,
    /// `from..=to`, as dates.
    Custom,
}

/// What is written: the standup («Ayer / Hoy / Bloqueos») or the weekly report by project.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Format {
    #[default]
    Daily,
    Weekly,
}

impl Format {
    /// The format a period reads as when nobody said: a week is a report, a day is a standup.
    pub fn for_period(kind: PeriodKind) -> Format {
        match kind {
            PeriodKind::ThisWeek | PeriodKind::LastWeek => Format::Weekly,
            _ => Format::Daily,
        }
    }
}

/// A period resolved to dates: `from` and `to` are both included, `start..end` are the Unix seconds
/// (local midnight of `from` to local midnight after `to`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Period {
    pub kind: PeriodKind,
    pub from: NaiveDate,
    pub to: NaiveDate,
    pub start: i64,
    pub end: i64,
}

impl Period {
    pub fn contains(&self, seconds: i64) -> bool {
        seconds >= self.start && seconds < self.end
    }

    pub fn contains_rfc3339(&self, stamp: &str) -> bool {
        parse_stamp(stamp).is_some_and(|s| self.contains(s))
    }
}

/// Seconds of an RFC 3339 stamp, or of a bare `YYYY-MM-DD HH:MM:SS` (read as UTC) — the two shapes
/// the tables write.
pub fn parse_stamp(stamp: &str) -> Option<i64> {
    let stamp = stamp.trim();
    if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(stamp) {
        return Some(parsed.timestamp());
    }
    chrono::NaiveDateTime::parse_from_str(stamp, "%Y-%m-%d %H:%M:%S").ok().map(|n| n.and_utc().timestamp())
}

/// The working day before `today`: Monday (and the weekend) looks back at Friday.
pub fn previous_workday(today: NaiveDate) -> NaiveDate {
    let back = match today.weekday() {
        Weekday::Mon => 3,
        Weekday::Sun => 2,
        _ => 1,
    };
    today - Duration::days(back)
}

fn monday_of(day: NaiveDate) -> NaiveDate {
    day - Duration::days(day.weekday().num_days_from_monday() as i64)
}

/// The dates a period covers, from `today` — pure, so the boundaries are tested without a clock.
pub fn dates_for(kind: PeriodKind, today: NaiveDate, from: Option<NaiveDate>, to: Option<NaiveDate>) -> Result<(NaiveDate, NaiveDate), String> {
    Ok(match kind {
        PeriodKind::PreviousWorkday => {
            let day = previous_workday(today);
            (day, day)
        }
        PeriodKind::Today => (today, today),
        PeriodKind::ThisWeek => (monday_of(today), today),
        PeriodKind::LastWeek => {
            let monday = monday_of(today) - Duration::days(7);
            (monday, monday + Duration::days(6))
        }
        PeriodKind::Custom => {
            let from = from.ok_or("A custom range needs its first day")?;
            let to = to.unwrap_or(from);
            if to < from {
                return Err("The range ends before it starts".into());
            }
            if (to - from).num_days() > 92 {
                return Err("A range is at most three months".into());
            }
            (from, to)
        }
    })
}

/// Local midnight of `day`, in Unix seconds. A day that starts inside a DST gap starts at the first
/// moment that exists.
fn local_midnight(day: NaiveDate) -> i64 {
    let naive = day.and_hms_opt(0, 0, 0).expect("midnight exists");
    match Local.from_local_datetime(&naive) {
        chrono::LocalResult::Single(t) => t.timestamp(),
        chrono::LocalResult::Ambiguous(first, _) => first.timestamp(),
        chrono::LocalResult::None => Local.from_local_datetime(&(naive + Duration::hours(1))).earliest().map(|t| t.timestamp()).unwrap_or(naive.and_utc().timestamp()),
    }
}

/// A period of local days.
pub fn period(kind: PeriodKind, today: NaiveDate, from: Option<NaiveDate>, to: Option<NaiveDate>) -> Result<Period, String> {
    let (from, to) = dates_for(kind, today, from, to)?;
    Ok(Period { kind, from, to, start: local_midnight(from), end: local_midnight(to + Duration::days(1)) })
}

/// One commit of the user's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitItem {
    pub sha: String,
    pub branch: String,
    pub subject: String,
    /// Unix seconds, the author's time.
    pub time: i64,
    pub files_changed: usize,
    pub insertions: usize,
    pub deletions: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrItem {
    pub id: i64,
    pub title: String,
    pub url: String,
    /// `open` · `draft` · `merged` · `closed`.
    pub status: String,
    pub source_branch: String,
    pub target_branch: String,
    pub author: String,
    pub created_at: String,
    /// Checks of its head that failed, when they were read (own open PRs only).
    #[serde(default)]
    pub failing_checks: Vec<String>,
}

/// A review CodeFlow's reviewer ran (`review_runs`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewItem {
    pub run_id: String,
    pub pr_id: i64,
    pub pr_title: String,
    pub url: String,
    pub author: String,
    pub level: String,
    pub findings: usize,
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingItem {
    pub meeting_id: String,
    pub note_id: String,
    pub title: String,
    pub started_at: String,
    pub minutes: i64,
    /// The start of the meeting's note, which is where its minutes are written — empty when it has none.
    pub summary: String,
}

/// A ticket moved, started or linked to a branch in the range — see [`sources::tickets_moved`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TicketItem {
    pub key: String,
    pub title: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub branch: String,
    #[serde(default)]
    pub url: String,
    pub at: String,
}

/// One repository's share of the period.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoLog {
    pub project_id: String,
    pub repo: String,
    pub workspace_id: String,
    pub workspace: String,
    pub commits: Vec<CommitItem>,
    pub prs_opened: Vec<PrItem>,
    pub prs_merged: Vec<PrItem>,
    /// PRs of others the user reviewed in CodeFlow in the period.
    pub prs_reviewed: Vec<PrItem>,
    /// The user's PRs still open — what «Hoy» goes on with.
    pub prs_in_progress: Vec<PrItem>,
    /// Open PRs whose review is asked of the user — waiting on them.
    pub prs_awaiting_my_review: Vec<PrItem>,
    pub reviews: Vec<ReviewItem>,
    /// Branches other than the default with the user's commits of the period — not merged yet.
    pub open_branches: Vec<String>,
}

impl RepoLog {
    pub fn is_empty(&self) -> bool {
        self.commits.is_empty()
            && self.prs_opened.is_empty()
            && self.prs_merged.is_empty()
            && self.prs_reviewed.is_empty()
            && self.prs_in_progress.is_empty()
            && self.prs_awaiting_my_review.is_empty()
            && self.reviews.is_empty()
    }
}

/// Everything the user did in a period, as data — what the writer reads and the note's «Fuentes» lists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkLog {
    pub period: Period,
    pub format: Format,
    /// The emails commits were matched on.
    pub identity: Vec<String>,
    pub repos: Vec<RepoLog>,
    pub meetings: Vec<MeetingItem>,
    pub tickets: Vec<TicketItem>,
    /// What could not be read («github.com: no token») — said in the note, never hidden.
    pub notices: Vec<String>,
}

impl WorkLog {
    pub fn commit_count(&self) -> usize {
        self.repos.iter().map(|r| r.commits.len()).sum()
    }

    pub fn active_repos(&self) -> impl Iterator<Item = &RepoLog> {
        self.repos.iter().filter(|r| !r.is_empty())
    }

    pub fn is_empty(&self) -> bool {
        self.active_repos().next().is_none() && self.meetings.is_empty() && self.tickets.is_empty()
    }
}

/// The language a summary is written in: `es` or `en`.
pub fn language_or_default(language: &str) -> &'static str {
    if language.trim().eq_ignore_ascii_case("en") {
        "en"
    } else {
        "es"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn monday_looks_back_at_friday() {
        // 2026-10-26 is a Monday.
        assert_eq!(previous_workday(day("2026-10-26")), day("2026-10-23"));
        assert_eq!(previous_workday(day("2026-10-27")), day("2026-10-26"));
        assert_eq!(previous_workday(day("2026-10-25")), day("2026-10-23"), "Sunday too");
        assert_eq!(previous_workday(day("2026-10-24")), day("2026-10-23"), "Saturday too");
    }

    #[test]
    fn weeks_start_on_monday() {
        let thursday = day("2026-10-22");
        assert_eq!(dates_for(PeriodKind::ThisWeek, thursday, None, None).unwrap(), (day("2026-10-19"), thursday));
        assert_eq!(dates_for(PeriodKind::LastWeek, thursday, None, None).unwrap(), (day("2026-10-12"), day("2026-10-18")));
        assert_eq!(dates_for(PeriodKind::ThisWeek, day("2026-10-19"), None, None).unwrap(), (day("2026-10-19"), day("2026-10-19")));
    }

    #[test]
    fn a_custom_range_is_checked() {
        assert!(dates_for(PeriodKind::Custom, day("2026-10-22"), None, None).is_err());
        assert!(dates_for(PeriodKind::Custom, day("2026-10-22"), Some(day("2026-10-10")), Some(day("2026-10-01"))).is_err());
        assert_eq!(dates_for(PeriodKind::Custom, day("2026-10-22"), Some(day("2026-10-10")), None).unwrap(), (day("2026-10-10"), day("2026-10-10")));
    }

    #[test]
    fn a_period_holds_its_whole_last_day_and_not_the_next() {
        let p = period(PeriodKind::PreviousWorkday, day("2026-10-26"), None, None).unwrap();
        assert_eq!((p.from, p.to), (day("2026-10-23"), day("2026-10-23")));
        let friday_noon = Local.from_local_datetime(&day("2026-10-23").and_hms_opt(12, 0, 0).unwrap()).unwrap().timestamp();
        let friday_late = Local.from_local_datetime(&day("2026-10-23").and_hms_opt(23, 59, 59).unwrap()).unwrap().timestamp();
        let saturday = Local.from_local_datetime(&day("2026-10-24").and_hms_opt(0, 0, 0).unwrap()).unwrap().timestamp();
        let thursday_late = Local.from_local_datetime(&day("2026-10-22").and_hms_opt(23, 59, 59).unwrap()).unwrap().timestamp();
        assert!(p.contains(friday_noon) && p.contains(friday_late));
        assert!(!p.contains(saturday) && !p.contains(thursday_late));
    }

    #[test]
    fn stamps_of_both_shapes_are_read() {
        assert_eq!(parse_stamp("2026-10-23T10:00:00+00:00"), Some(1_792_749_600));
        assert_eq!(parse_stamp("2026-10-23 10:00:00"), Some(1_792_749_600));
        assert_eq!(parse_stamp("ayer"), None);
    }

    #[test]
    fn a_week_reads_as_a_report() {
        assert_eq!(Format::for_period(PeriodKind::LastWeek), Format::Weekly);
        assert_eq!(Format::for_period(PeriodKind::PreviousWorkday), Format::Daily);
    }
}
