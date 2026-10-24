//! The user's pull requests, read from the host a repository is linked to (GitHub, GitLab, Azure
//! DevOps, Bitbucket — through the same commands the PR panel uses), plus the ones waiting on their
//! review. Network, so capped (two pages, five check reads) and time-limited per call: a host that
//! does not answer costs the summary that repository's PRs and a line in its notices, never the rest.
//!
//! **"Mine"** is decided without a per-host user lookup where there is none to make: the host's
//! login when it has an API for it (GitHub, GitLab), the git name and the email's local part
//! otherwise — and, on every host, a PR whose source branch carries the user's commits of the period.
//!
//! **Merged "in the period"** is approximate: the lists carry when a PR was opened, not when it was
//! merged. A merged PR of the user's counts when it was opened in the period or its branch got their
//! commits in it — the cases a standup is about.

use std::time::Duration;

use tauri::{AppHandle, Manager};

use super::{Period, PrItem};
use crate::ado::PullRequestSummary;
use crate::commands::ado_cmd::{self, LinkedRepo};
use crate::db::Db;

/// How long one call to a host may take.
const CALL_LIMIT: Duration = Duration::from_secs(15);
/// Pages of the "all" list read per repository (newest first).
const PAGES: u32 = 2;
/// Open PRs of the user's whose checks are read — the «Bloqueos» of a standup.
const CHECKED: usize = 5;

/// Who the user is on the host, for telling their PRs apart.
#[derive(Debug, Clone, Default)]
pub struct Mine {
    pub logins: Vec<String>,
    pub names: Vec<String>,
    /// Branches with the user's commits of the period.
    pub branches: Vec<String>,
}

impl Mine {
    pub fn owns(&self, pr: &PullRequestSummary) -> bool {
        let author = pr.author.trim();
        let by_name = !author.is_empty() && self.logins.iter().chain(self.names.iter()).any(|me| me.eq_ignore_ascii_case(author));
        let by_branch = self.branches.iter().any(|b| {
            let local = b.split_once('/').filter(|(remote, _)| *remote == "origin").map(|(_, rest)| rest).unwrap_or(b);
            !pr.source_branch.is_empty() && (pr.source_branch == *b || pr.source_branch == local)
        });
        by_name || by_branch
    }
}

/// The user's PRs of a repository, sorted into what a summary says about them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Sorted {
    pub opened: Vec<PrItem>,
    pub merged: Vec<PrItem>,
    pub in_progress: Vec<PrItem>,
    pub awaiting_my_review: Vec<PrItem>,
}

pub fn item(pr: &PullRequestSummary) -> PrItem {
    PrItem {
        id: pr.id,
        title: pr.title.clone(),
        url: pr.url.clone(),
        status: pr.status.clone(),
        source_branch: pr.source_branch.clone(),
        target_branch: pr.target_branch.clone(),
        author: pr.author.clone(),
        created_at: pr.created_at.clone(),
        failing_checks: Vec::new(),
    }
}

/// Pure: the list, the user and the ids whose review is asked of them → what goes where.
pub fn sort(prs: &[PullRequestSummary], mine: &Mine, period: &Period, review_requested: &[i64]) -> Sorted {
    let mut out = Sorted::default();
    for pr in prs {
        let open = matches!(pr.status.as_str(), "open" | "draft");
        if mine.owns(pr) {
            let opened_now = period.contains_rfc3339(&pr.created_at);
            let worked_now = mine.branches.iter().any(|b| pr.source_branch == *b || b.ends_with(&format!("/{}", pr.source_branch)));
            if opened_now {
                out.opened.push(item(pr));
            }
            if pr.status == "merged" && (opened_now || worked_now) {
                out.merged.push(item(pr));
            }
            if open {
                out.in_progress.push(item(pr));
            }
        } else if open && review_requested.contains(&pr.id) {
            out.awaiting_my_review.push(item(pr));
        }
    }
    out
}

async fn limited<T>(work: impl std::future::Future<Output = Result<T, String>>) -> Result<T, String> {
    tokio::time::timeout(CALL_LIMIT, work).await.map_err(|_| "the host did not answer in time".to_string())?
}

/// The login of the token's account on hosts that say it.
async fn host_login(link: &LinkedRepo) -> Option<String> {
    match link {
        LinkedRepo::GitHub { host, .. } => {
            let token = ado_cmd::github_token(host).ok()?;
            limited(crate::github::get_authenticated_user(host, &token)).await.ok()
        }
        LinkedRepo::GitLab { host, .. } => {
            let token = ado_cmd::gitlab_token(host).ok()?;
            limited(crate::gitlab::get_authenticated_user(host, &token)).await.ok()
        }
        _ => None,
    }
}

/// The host's label, for a notice.
fn host_name(link: &LinkedRepo) -> String {
    match link {
        LinkedRepo::GitHub { host, .. } | LinkedRepo::GitLab { host, .. } => host.clone(),
        LinkedRepo::Azure { org, .. } => format!("Azure DevOps ({org})"),
        LinkedRepo::Bitbucket { workspace, .. } => format!("Bitbucket ({workspace})"),
    }
}

/// Reads one repository's PRs. `Ok(None)` for a repository not linked to a host — nothing to say.
pub async fn collect(app: &AppHandle, project_id: &str, mut mine: Mine, period: &Period) -> Result<Option<(Sorted, Vec<PullRequestSummary>)>, String> {
    let project = {
        let db = app.state::<Db>();
        ado_cmd::load_project(&db, project_id)?
    };
    let Ok(link) = ado_cmd::linked_repo(&project) else { return Ok(None) };
    if let Some(login) = host_login(&link).await {
        mine.logins.push(login);
    }
    let mut all: Vec<PullRequestSummary> = Vec::new();
    for page in 1..=PAGES {
        let answer = limited(ado_cmd::list_pull_requests_page(app.state::<Db>(), project_id.to_string(), Some("all".into()), Some(page)))
            .await
            .map_err(|e| format!("{}: {e}", host_name(&link)))?;
        // Newest first: a page that ends before the period has nothing older worth reading.
        let older = answer.items.last().is_some_and(|pr| crate::worklog::parse_stamp(&pr.created_at).is_some_and(|t| t < period.start - 30 * 86_400));
        all.extend(answer.items);
        if !answer.has_more || older {
            break;
        }
    }
    let requested = limited(ado_cmd::pr_review_requested(app.state::<Db>(), project_id.to_string())).await.unwrap_or_default();
    let mut sorted = sort(&all, &mine, period, &requested);
    for pr in sorted.in_progress.iter_mut().take(CHECKED) {
        if let Ok(checks) = limited(ado_cmd::pr_checks(app.state::<Db>(), project_id.to_string(), pr.id)).await {
            pr.failing_checks = checks.checks.iter().filter(|c| c.state == crate::ci::status::FAILED).map(|c| c.name.clone()).collect();
        }
    }
    Ok(Some((sorted, all)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worklog::{period, PeriodKind};
    use chrono::NaiveDate;

    fn pr(id: i64, author: &str, status: &str, branch: &str, created: &str) -> PullRequestSummary {
        PullRequestSummary {
            id,
            title: format!("PR {id}"),
            description: String::new(),
            status: status.into(),
            source_branch: branch.into(),
            target_branch: "main".into(),
            author: author.into(),
            created_at: created.into(),
            url: format!("https://example.com/pr/{id}"),
            provider: "github".into(),
        }
    }

    #[test]
    fn prs_are_sorted_by_whose_and_what_state() {
        let p = period(PeriodKind::Custom, NaiveDate::from_ymd_opt(2026, 10, 26).unwrap(), NaiveDate::from_ymd_opt(2026, 10, 22), NaiveDate::from_ymd_opt(2026, 10, 24)).unwrap();
        let mine = Mine { logins: vec!["me".into()], names: vec![], branches: vec!["origin/feature/pay".into()] };
        let list = vec![
            pr(1, "me", "open", "feature/login", "2026-10-23T10:00:00Z"),
            pr(2, "someone", "merged", "feature/pay", "2026-10-01T10:00:00Z"),
            pr(3, "Me", "merged", "fix/old", "2026-09-01T10:00:00Z"),
            pr(4, "ana", "open", "feature/ana", "2026-10-21T10:00:00Z"),
            pr(5, "luis", "open", "feature/luis", "2026-10-21T10:00:00Z"),
        ];
        let sorted = sort(&list, &mine, &p, &[4, 1]);
        assert_eq!(sorted.opened.iter().map(|p| p.id).collect::<Vec<_>>(), vec![1]);
        assert_eq!(sorted.merged.iter().map(|p| p.id).collect::<Vec<_>>(), vec![2], "merged long ago and untouched is not news");
        assert_eq!(sorted.in_progress.iter().map(|p| p.id).collect::<Vec<_>>(), vec![1]);
        assert_eq!(sorted.awaiting_my_review.iter().map(|p| p.id).collect::<Vec<_>>(), vec![4], "my own is not waiting on me");
    }
}
