//! Collect → write → keep, the one path Notas' form, Codi's «¿qué hice ayer?» and the Flujos node
//! all take, so the three cannot drift apart.

use chrono::NaiveDate;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::git::{self as wgit, Identity};
use super::prs::{self, Mine};
use super::render::{self, Request};
use super::{note, sources, writer, Format, PrItem, RepoLog, WorkLog};
use crate::db::models::NoteMeta;
use crate::db::Db;

/// Most repositories read for one summary — a workspace with more is unusual, and every one costs
/// a git walk and a few calls to its host.
const MAX_REPOS: usize = 40;
/// Most commits kept per repository.
const MAX_COMMITS: usize = 200;
/// Repositories whose host is asked at once.
const AT_ONCE: usize = 6;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub title: String,
    /// The summary alone — what the copy buttons copy.
    pub markdown: String,
    /// The note's whole body: the summary, «Fuentes», the marker.
    pub body: String,
    pub log: WorkLog,
    /// The provider that wrote it, or `none` for the deterministic text.
    pub engine: String,
    pub fallback_reason: Option<String>,
    pub language: String,
    pub request: Request,
    /// The note it was kept in, when it was.
    pub note: Option<NoteMeta>,
}

fn date(raw: &Option<String>) -> Option<NaiveDate> {
    raw.as_deref().and_then(|d| NaiveDate::parse_from_str(d.trim(), "%Y-%m-%d").ok())
}

pub fn language(app: &AppHandle, request: &Request) -> &'static str {
    if request.language.trim().is_empty() {
        app.state::<Db>().0.lock().map(|conn| crate::speech::app_language(&conn)).unwrap_or("es")
    } else {
        super::language_or_default(&request.language)
    }
}

/// Everything the user did in the period the request names.
pub async fn collect(app: &AppHandle, request: &Request) -> Result<WorkLog, String> {
    let today = chrono::Local::now().date_naive();
    let period = super::period(request.period, today, date(&request.from), date(&request.to))?;
    let format = request.format.unwrap_or_else(|| Format::for_period(request.period));
    let (repos, extra, meetings, tickets) = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let workspace = request.workspace_id.as_deref().filter(|w| !w.trim().is_empty());
        (
            sources::repos(&conn, workspace).map_err(|e| e.to_string())?,
            sources::extra_emails(&conn),
            sources::meetings(&conn, workspace, &period).map_err(|e| e.to_string())?,
            sources::tickets_moved(&conn, workspace, &period),
        )
    };
    let mut notices: Vec<String> = Vec::new();
    if repos.len() > MAX_REPOS {
        notices.push(format!("{} repositories; the first {MAX_REPOS} were read", repos.len()));
    }
    let repos: Vec<_> = repos.into_iter().take(MAX_REPOS).collect();

    let mut identity = Identity::default();
    if let Ok(global) = crate::git::identity::get_identity() {
        global.email.iter().for_each(|e| identity.add_email(e));
        global.name.iter().for_each(|n| identity.add_name(n));
    }
    extra.iter().for_each(|e| identity.add_email(e));

    // Git first, off the async workers: a walk over a large history is real work.
    let mut logs: Vec<RepoLog> = Vec::new();
    for repo in &repos {
        let (path, who, window) = (repo.path.clone(), identity.clone(), period.clone());
        let walked = tauri::async_runtime::spawn_blocking(move || wgit::commits(&path, &who, &window, MAX_COMMITS)).await.map_err(|e| e.to_string())?;
        let (commits, open_branches) = match walked {
            Ok(found) => found,
            Err(error) => {
                notices.push(format!("{}: {error}", repo.name));
                (Vec::new(), Vec::new())
            }
        };
        let reviews = {
            let db = app.state::<Db>();
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            sources::reviews(&conn, &repo.project_id, &period).map_err(|e| e.to_string())?
        };
        logs.push(RepoLog {
            project_id: repo.project_id.clone(),
            repo: repo.name.clone(),
            workspace_id: repo.workspace_id.clone(),
            workspace: repo.workspace.clone(),
            commits,
            reviews,
            open_branches,
            ..Default::default()
        });
    }

    // Then the hosts, a few repositories at a time.
    let mut names: Vec<String> = identity.names.clone();
    names.extend(identity.emails.iter().filter_map(|e| e.split('@').next()).map(str::to_string));
    for chunk in logs.chunks_mut(AT_ONCE) {
        let asks = chunk.iter().map(|log| {
            let mut branches: Vec<String> = log.open_branches.clone();
            branches.extend(log.commits.iter().map(|c| c.branch.clone()));
            branches.sort();
            branches.dedup();
            // The default branch is everybody's: a PR from `main` is not mine because I committed there.
            branches.retain(|b| !matches!(b.as_str(), "main" | "master" | "trunk" | "develop" | "HEAD"));
            let mine = Mine { logins: Vec::new(), names: names.clone(), branches };
            let project_id = log.project_id.clone();
            let window = period.clone();
            async move { prs::collect(app, &project_id, mine, &window).await }
        });
        let answers = futures_util::future::join_all(asks).await;
        for (log, answer) in chunk.iter_mut().zip(answers) {
            match answer {
                Ok(Some((sorted, all))) => {
                    log.prs_opened = sorted.opened;
                    log.prs_merged = sorted.merged;
                    log.prs_in_progress = sorted.in_progress;
                    log.prs_awaiting_my_review = sorted.awaiting_my_review;
                    log.prs_reviewed = reviewed(&log.reviews, &all);
                }
                Ok(None) => log.prs_reviewed = reviewed(&log.reviews, &[]),
                Err(error) => {
                    notices.push(format!("{}: {error}", log.repo));
                    log.prs_reviewed = reviewed(&log.reviews, &[]);
                }
            }
        }
    }
    logs.retain(|log| !log.is_empty() || !log.open_branches.is_empty());
    Ok(WorkLog { period, format, identity: identity.emails, repos: logs, meetings, tickets, notices })
}

/// The PRs behind the reviews CodeFlow ran, once each, with the host's facts when it was read.
fn reviewed(reviews: &[super::ReviewItem], listed: &[crate::ado::PullRequestSummary]) -> Vec<PrItem> {
    let mut out: Vec<PrItem> = Vec::new();
    for review in reviews {
        if out.iter().any(|p| p.id == review.pr_id) {
            continue;
        }
        out.push(match listed.iter().find(|p| p.id == review.pr_id) {
            Some(pr) => prs::item(pr),
            None => PrItem {
                id: review.pr_id,
                title: review.pr_title.clone(),
                url: review.url.clone(),
                status: String::new(),
                source_branch: String::new(),
                target_branch: String::new(),
                author: review.author.clone(),
                created_at: String::new(),
                failing_checks: Vec::new(),
            },
        });
    }
    out
}

/// Collects and writes; keeps nothing.
pub async fn generate(app: &AppHandle, request: Request) -> Result<Outcome, String> {
    let lang = language(app, &request);
    let log = collect(app, &request).await?;
    let written = writer::write(app, &log, &request, lang).await;
    let title = render::title(&log, lang);
    let body = render::note_body(&written.markdown, &log, &request, lang);
    Ok(Outcome {
        title,
        markdown: written.markdown,
        body,
        log,
        engine: written.engine,
        fallback_reason: written.fallback_reason,
        language: lang.to_string(),
        request,
        note: None,
    })
}

/// Generates and keeps it: over `note_id` when given (and still there), else as a new note of
/// `workspace_id`. Tells every window the note changed, the way a flow's note does.
pub async fn generate_into_note(app: &AppHandle, request: Request, workspace_id: &str, note_id: Option<&str>) -> Result<Outcome, String> {
    let mut outcome = generate(app, request).await?;
    let meta = {
        let db = app.state::<Db>();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let replaced = match note_id.filter(|id| !id.is_empty()) {
            Some(id) => note::replace(&conn, id, &outcome.title, &outcome.body, outcome.log.format, &outcome.language)?,
            None => None,
        };
        match replaced {
            Some(meta) => meta,
            None => note::create(&conn, workspace_id, &outcome.title, &outcome.body, outcome.log.format, &outcome.language)?,
        }
    };
    let _ = app.emit("notes:changed", serde_json::json!({ "workspaceId": meta.workspace_id, "noteId": meta.id }));
    outcome.note = Some(meta);
    Ok(outcome)
}

/// The Flujos node's op (`worklog.generate`): what the node asked, run for the flow's workspace,
/// answered as one item — the text to hand on, the counts to branch on, the structured items.
pub async fn flow_op(app: &AppHandle, workspace_id: &str, args: &serde_json::Value) -> Result<serde_json::Value, String> {
    use serde_json::{json, Value};
    let period = match args.get("period").and_then(Value::as_str) {
        Some("today") => super::PeriodKind::Today,
        Some("thisWeek") => super::PeriodKind::ThisWeek,
        Some("lastWeek") => super::PeriodKind::LastWeek,
        _ => super::PeriodKind::PreviousWorkday,
    };
    let format = match args.get("format").and_then(Value::as_str) {
        Some("daily") => Some(Format::Daily),
        Some("weekly") => Some(Format::Weekly),
        _ => None,
    };
    let all = args.get("allWorkspaces").and_then(Value::as_bool).unwrap_or(false);
    let engine = args.get("engine").cloned().filter(|e| e.get("provider").and_then(Value::as_str).is_some_and(|p| !p.trim().is_empty()));
    let request = Request {
        period,
        format,
        workspace_id: (!all).then(|| workspace_id.to_string()),
        engine,
        plain: args.get("plain").and_then(Value::as_bool).unwrap_or(false),
        ..Default::default()
    };
    let outcome = if args.get("saveNote").and_then(Value::as_bool).unwrap_or(false) {
        generate_into_note(app, request, workspace_id, None).await?
    } else {
        generate(app, request).await?
    };
    let log = &outcome.log;
    let sum = |pick: fn(&RepoLog) -> usize| log.repos.iter().map(pick).sum::<usize>();
    Ok(json!({
        "title": outcome.title,
        "text": outcome.markdown,
        "engine": outcome.engine,
        "fallbackReason": outcome.fallback_reason,
        "period": { "kind": log.period.kind, "from": log.period.from, "to": log.period.to },
        "format": log.format,
        "counts": {
            "commits": log.commit_count(),
            "prsOpened": sum(|r| r.prs_opened.len()),
            "prsMerged": sum(|r| r.prs_merged.len()),
            "prsInProgress": sum(|r| r.prs_in_progress.len()),
            "prsAwaitingMyReview": sum(|r| r.prs_awaiting_my_review.len()),
            "reviews": sum(|r| r.reviews.len()),
            "meetings": log.meetings.len(),
            "tickets": log.tickets.len(),
        },
        "empty": log.is_empty(),
        "items": { "repos": log.repos, "meetings": log.meetings, "tickets": log.tickets, "notices": log.notices },
        "noteId": outcome.note.as_ref().map(|n| n.id.clone()),
        "noteTitle": outcome.note.as_ref().map(|n| n.title.clone()),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::worklog::ReviewItem;

    #[test]
    fn a_pr_reviewed_twice_is_listed_once_with_the_hosts_facts() {
        let review = |id: &str, pr: i64| ReviewItem { run_id: id.into(), pr_id: pr, pr_title: format!("PR {pr}"), url: String::new(), author: "ana".into(), level: "quick".into(), findings: 0, at: String::new() };
        let listed = vec![crate::ado::PullRequestSummary {
            id: 4,
            title: "Login".into(),
            description: String::new(),
            status: "open".into(),
            source_branch: "feature/login".into(),
            target_branch: "main".into(),
            author: "ana".into(),
            created_at: String::new(),
            url: "https://example.com/pr/4".into(),
            provider: "github".into(),
        }];
        let out = reviewed(&[review("a", 4), review("b", 4), review("c", 9)], &listed);
        assert_eq!(out.len(), 2);
        assert_eq!((out[0].title.as_str(), out[0].status.as_str()), ("Login", "open"));
        assert_eq!(out[1].title, "PR 9");
    }
}
