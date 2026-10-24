//! The summary written without a model — what a note gets when no engine is set up or the engine
//! fails, so «Resumen de tu trabajo» works on any machine (user, 2026-10-23: «un texto determinista
//! de respaldo») — plus the pieces every summary carries: its title, the «Fuentes» section, the
//! marker «Regenerar» reads back, what the model is handed, and the sentence Codi says.
//!
//! **Nothing here invents.** Every line is an item of the [`WorkLog`]; a section with nothing says so
//! («Ninguno»), it is never filled with something plausible.

use chrono::{Datelike, NaiveDate};
use serde::{Deserialize, Serialize};

use super::{CommitItem, Format, PeriodKind, PrItem, RepoLog, WorkLog};

/// What a summary was asked for — kept in the note so «Regenerar» asks the same again.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Request {
    pub period: PeriodKind,
    /// `YYYY-MM-DD`, for a custom range.
    pub from: Option<String>,
    pub to: Option<String>,
    /// `None`: what the period reads as ([`Format::for_period`]).
    pub format: Option<Format>,
    /// `None`: every workspace.
    pub workspace_id: Option<String>,
    /// `{ provider, model, account }` — empty for the Notes row's engine.
    pub engine: Option<serde_json::Value>,
    /// Write the deterministic text even when an engine is there.
    pub plain: bool,
    /// `es` · `en`; empty for the app's language.
    pub language: String,
}

struct Words {
    yesterday: &'static str,
    today: &'static str,
    next: &'static str,
    blockers: &'static str,
    none: &'static str,
    nothing: &'static str,
    nothing_next: &'static str,
    commits: &'static str,
    commit_one: &'static str,
    opened: &'static str,
    merged: &'static str,
    reviewed: &'static str,
    meeting: &'static str,
    ticket: &'static str,
    continue_pr: &'static str,
    continue_branch: &'static str,
    review_asked: &'static str,
    failing: &'static str,
    waiting: &'static str,
    summary: &'static str,
    by_project: &'static str,
    meetings: &'static str,
    tickets: &'static str,
    pending: &'static str,
    sources: &'static str,
    notices: &'static str,
    findings: &'static str,
    branches: &'static str,
    repos: &'static str,
    in_word: &'static str,
    daily: &'static str,
    weekly: &'static str,
}

const ES: Words = Words {
    yesterday: "Ayer",
    today: "Hoy",
    next: "Siguiente",
    blockers: "Bloqueos",
    none: "Ninguno.",
    nothing: "Sin actividad registrada en este período.",
    nothing_next: "Nada en curso a la vista (sin PRs abiertos ni ramas sin mergear).",
    commits: "commits",
    commit_one: "commit",
    opened: "PR abierto",
    merged: "PR mergeado",
    reviewed: "Revisé",
    meeting: "Reunión",
    ticket: "Ticket",
    continue_pr: "Sigo con",
    continue_branch: "Sigo en la rama",
    review_asked: "Revisar (me lo pidieron)",
    failing: "tiene checks fallando",
    waiting: "espera revisión",
    summary: "Resumen",
    by_project: "Por proyecto",
    meetings: "Reuniones",
    tickets: "Tickets",
    pending: "Pendiente y bloqueos",
    sources: "Fuentes",
    notices: "No se pudo leer",
    findings: "hallazgos",
    branches: "ramas",
    repos: "repositorios",
    in_word: "en",
    daily: "Daily",
    weekly: "Semanal",
};

const EN: Words = Words {
    yesterday: "Yesterday",
    today: "Today",
    next: "Next",
    blockers: "Blockers",
    none: "None.",
    nothing: "No activity recorded in this period.",
    nothing_next: "Nothing in progress in sight (no open PRs or unmerged branches).",
    commits: "commits",
    commit_one: "commit",
    opened: "PR opened",
    merged: "PR merged",
    reviewed: "Reviewed",
    meeting: "Meeting",
    ticket: "Ticket",
    continue_pr: "Continue with",
    continue_branch: "Continue on branch",
    review_asked: "Review (requested)",
    failing: "has failing checks",
    waiting: "waits for review",
    summary: "Summary",
    by_project: "By project",
    meetings: "Meetings",
    tickets: "Tickets",
    pending: "Pending and blockers",
    sources: "Sources",
    notices: "Could not read",
    findings: "findings",
    branches: "branches",
    repos: "repositories",
    in_word: "in",
    daily: "Daily",
    weekly: "Weekly",
};

fn words(lang: &str) -> &'static Words {
    if lang == "en" {
        &EN
    } else {
        &ES
    }
}

const MONTHS_ES: [&str; 12] = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const MONTHS_EN: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

fn date(day: NaiveDate, lang: &str) -> String {
    let m = day.month0() as usize;
    if lang == "en" {
        format!("{} {}, {}", MONTHS_EN[m], day.day(), day.year())
    } else {
        format!("{} {} {}", day.day(), MONTHS_ES[m], day.year())
    }
}

fn range(from: NaiveDate, to: NaiveDate, lang: &str) -> String {
    if from == to {
        return date(from, lang);
    }
    if from.year() == to.year() && from.month() == to.month() {
        return if lang == "en" {
            format!("{} {}–{}, {}", MONTHS_EN[from.month0() as usize], from.day(), to.day(), to.year())
        } else {
            format!("{}–{} {} {}", from.day(), to.day(), MONTHS_ES[to.month0() as usize], to.year())
        };
    }
    format!("{} – {}", date(from, lang), date(to, lang))
}

/// «Daily — 23 oct 2026» · «Semanal — 19–23 oct 2026».
pub fn title(log: &WorkLog, lang: &str) -> String {
    let w = words(lang);
    let kind = if log.format == Format::Weekly { w.weekly } else { w.daily };
    format!("{kind} — {}", range(log.period.from, log.period.to, lang))
}

fn pr_link(pr: &PrItem) -> String {
    if pr.url.is_empty() {
        format!("#{} {}", pr.id, pr.title)
    } else {
        format!("[#{} {}]({})", pr.id, pr.title, pr.url)
    }
}

/// A commit's link into the graph, read by the note preview (`#cf-commit=` survives the sanitizer,
/// a custom scheme would not).
pub fn commit_link(workspace_id: &str, project_id: &str, commit: &CommitItem) -> String {
    let short: String = commit.sha.chars().take(7).collect();
    format!("[`{short}`](#cf-commit={workspace_id}:{project_id}:{})", commit.sha)
}

fn quoted_subjects(commits: &[CommitItem], max: usize) -> String {
    let mut shown: Vec<String> = commits.iter().take(max).map(|c| format!("«{}»", c.subject)).collect();
    if commits.len() > max {
        shown.push(format!("(+{})", commits.len() - max));
    }
    shown.join(", ")
}

fn count(n: usize, w: &Words) -> String {
    format!("{n} {}", if n == 1 { w.commit_one } else { w.commits })
}

/// What was done: the standup's first section, one line per fact.
fn done_lines(log: &WorkLog, w: &Words) -> Vec<String> {
    let mut lines = Vec::new();
    for repo in log.active_repos() {
        if !repo.commits.is_empty() {
            lines.push(format!("**{}**: {} — {}", repo.repo, count(repo.commits.len(), w), quoted_subjects(&repo.commits, 4)));
        }
        for pr in &repo.prs_opened {
            lines.push(format!("{}: {} ({})", w.opened, pr_link(pr), repo.repo));
        }
        for pr in &repo.prs_merged {
            lines.push(format!("{}: {} ({})", w.merged, pr_link(pr), repo.repo));
        }
        for review in &repo.reviews {
            let pr = PrItem { id: review.pr_id, title: review.pr_title.clone(), url: review.url.clone(), ..empty_pr() };
            lines.push(format!("{}: {} ({}) — {} {}", w.reviewed, pr_link(&pr), repo.repo, review.findings, w.findings));
        }
    }
    for meeting in &log.meetings {
        let summary = if meeting.summary.is_empty() { String::new() } else { format!(" — {}", meeting.summary) };
        lines.push(format!("{}: {} ({} min){summary}", w.meeting, meeting.title, meeting.minutes));
    }
    for ticket in &log.tickets {
        let state = if ticket.state.is_empty() { String::new() } else { format!(" → {}", ticket.state) };
        lines.push(format!("{}: {} {}{state}", w.ticket, ticket.key, ticket.title));
    }
    lines
}

fn empty_pr() -> PrItem {
    PrItem {
        id: 0,
        title: String::new(),
        url: String::new(),
        status: String::new(),
        source_branch: String::new(),
        target_branch: String::new(),
        author: String::new(),
        created_at: String::new(),
        failing_checks: Vec::new(),
    }
}

/// What goes on: the user's open PRs and their unmerged branches, and the reviews asked of them.
fn next_lines(log: &WorkLog, w: &Words) -> Vec<String> {
    let mut lines = Vec::new();
    for repo in &log.repos {
        for pr in &repo.prs_in_progress {
            lines.push(format!("{} {} ({})", w.continue_pr, pr_link(pr), repo.repo));
        }
        let in_prs: Vec<&str> = repo.prs_in_progress.iter().map(|p| p.source_branch.as_str()).collect();
        for branch in &repo.open_branches {
            let local = branch.strip_prefix("origin/").unwrap_or(branch);
            if !in_prs.contains(&local) {
                lines.push(format!("{} `{branch}` ({})", w.continue_branch, repo.repo));
            }
        }
        for pr in &repo.prs_awaiting_my_review {
            lines.push(format!("{}: {} ({})", w.review_asked, pr_link(pr), repo.repo));
        }
    }
    lines
}

/// What stands in the way: failing checks on the user's open PRs, and their PRs still waiting on a
/// review.
fn blocker_lines(log: &WorkLog, w: &Words) -> Vec<String> {
    let mut lines = Vec::new();
    for repo in &log.repos {
        for pr in &repo.prs_in_progress {
            if !pr.failing_checks.is_empty() {
                lines.push(format!("{} {}: {}", pr_link(pr), w.failing, pr.failing_checks.join(", ")));
            } else if pr.status == "open" {
                lines.push(format!("{} {}", pr_link(pr), w.waiting));
            }
        }
    }
    lines
}

fn section(out: &mut String, heading: &str, lines: &[String], empty: &str) {
    out.push_str(&format!("## {heading}\n\n"));
    if lines.is_empty() {
        out.push_str(&format!("- {empty}\n\n"));
    } else {
        for line in lines {
            out.push_str(&format!("- {line}\n"));
        }
        out.push('\n');
    }
}

fn totals(log: &WorkLog, w: &Words, lang: &str) -> String {
    let repos = log.active_repos().filter(|r| !r.commits.is_empty()).count();
    let opened: usize = log.repos.iter().map(|r| r.prs_opened.len()).sum();
    let merged: usize = log.repos.iter().map(|r| r.prs_merged.len()).sum();
    let reviews: usize = log.repos.iter().map(|r| r.reviews.len()).sum();
    let (o, m, rv, mt) = if lang == "en" { ("PRs opened", "merged", "reviews", "meetings") } else { ("PRs abiertos", "mergeados", "revisiones", "reuniones") };
    format!(
        "{} {} {repos} {} · {opened} {o} · {merged} {m} · {reviews} {rv} · {} {mt}",
        count(log.commit_count(), w),
        w.in_word,
        w.repos,
        log.meetings.len()
    )
}

fn repo_block(repo: &RepoLog, w: &Words) -> String {
    let mut out = format!("### {} ({})\n\n", repo.repo, repo.workspace);
    if !repo.commits.is_empty() {
        let mut branches: Vec<&str> = repo.commits.iter().map(|c| c.branch.as_str()).collect();
        branches.dedup();
        branches.sort_unstable();
        branches.dedup();
        out.push_str(&format!("- {} ({}: {})\n", count(repo.commits.len(), w), w.branches, branches.join(", ")));
        let mut biggest: Vec<&CommitItem> = repo.commits.iter().collect();
        biggest.sort_by_key(|c| std::cmp::Reverse(c.insertions + c.deletions));
        let top: Vec<CommitItem> = biggest.into_iter().take(5).cloned().collect();
        out.push_str(&format!("- {}\n", quoted_subjects(&top, 5)));
    }
    for pr in &repo.prs_opened {
        out.push_str(&format!("- {}: {}\n", w.opened, pr_link(pr)));
    }
    for pr in &repo.prs_merged {
        out.push_str(&format!("- {}: {}\n", w.merged, pr_link(pr)));
    }
    for review in &repo.reviews {
        let pr = PrItem { id: review.pr_id, title: review.pr_title.clone(), url: review.url.clone(), ..empty_pr() };
        out.push_str(&format!("- {}: {} — {} {}\n", w.reviewed, pr_link(&pr), review.findings, w.findings));
    }
    out.push('\n');
    out
}

/// The summary without a model.
pub fn fallback(log: &WorkLog, lang: &str) -> String {
    let w = words(lang);
    let mut out = String::new();
    if log.format == Format::Weekly {
        out.push_str(&format!("## {}\n\n- {}\n\n", w.summary, totals(log, w, lang)));
        out.push_str(&format!("## {}\n\n", w.by_project));
        let active: Vec<&RepoLog> = log.active_repos().filter(|r| !r.commits.is_empty() || !r.prs_opened.is_empty() || !r.prs_merged.is_empty() || !r.reviews.is_empty()).collect();
        if active.is_empty() {
            out.push_str(&format!("- {}\n\n", w.nothing));
        }
        for repo in active {
            out.push_str(&repo_block(repo, w));
        }
        let meetings: Vec<String> = log.meetings.iter().map(|m| format!("{} ({} min){}", m.title, m.minutes, if m.summary.is_empty() { String::new() } else { format!(" — {}", m.summary) })).collect();
        if !meetings.is_empty() {
            section(&mut out, w.meetings, &meetings, w.none);
        }
        let tickets: Vec<String> = log.tickets.iter().map(|t| format!("{} {}", t.key, t.title)).collect();
        if !tickets.is_empty() {
            section(&mut out, w.tickets, &tickets, w.none);
        }
        let mut pending = next_lines(log, w);
        pending.extend(blocker_lines(log, w));
        section(&mut out, w.pending, &pending, w.none);
    } else {
        let (first, second) = if log.period.kind == PeriodKind::Today { (w.today, w.next) } else { (w.yesterday, w.today) };
        section(&mut out, first, &done_lines(log, w), w.nothing);
        section(&mut out, second, &next_lines(log, w), w.nothing_next);
        section(&mut out, w.blockers, &blocker_lines(log, w), w.none);
    }
    out.trim_end().to_string() + "\n"
}

/// The raw items, collapsed, with their links — what the summary was written from.
pub fn sources(log: &WorkLog, lang: &str) -> String {
    let w = words(lang);
    let mut out = format!("<details>\n<summary>{}</summary>\n\n", w.sources);
    let mut any = false;
    for repo in log.active_repos() {
        any = true;
        out.push_str(&format!("**{}** ({})\n\n", repo.repo, repo.workspace));
        for commit in &repo.commits {
            let when = chrono::DateTime::from_timestamp(commit.time, 0).map(|t| t.with_timezone(&chrono::Local).format("%Y-%m-%d %H:%M").to_string()).unwrap_or_default();
            out.push_str(&format!(
                "- {} {} — `{}` · {when} · {} archivos +{} −{}\n",
                commit_link(&repo.workspace_id, &repo.project_id, commit),
                commit.subject,
                commit.branch,
                commit.files_changed,
                commit.insertions,
                commit.deletions
            ));
        }
        let prs = repo.prs_opened.iter().chain(&repo.prs_merged).chain(&repo.prs_in_progress).chain(&repo.prs_awaiting_my_review).chain(&repo.prs_reviewed);
        let mut listed: Vec<i64> = Vec::new();
        for pr in prs {
            if listed.contains(&pr.id) {
                continue;
            }
            listed.push(pr.id);
            out.push_str(&format!("- PR {} · {} · `{}` → `{}` · {}\n", pr_link(pr), pr.status, pr.source_branch, pr.target_branch, pr.author));
        }
        for review in &repo.reviews {
            out.push_str(&format!("- {} #{} · {} · {} {} · {}\n", w.reviewed, review.pr_id, review.level, review.findings, w.findings, review.at));
        }
        out.push('\n');
    }
    for meeting in &log.meetings {
        any = true;
        out.push_str(&format!("- {}: [[{}]] · {} · {} min\n", w.meeting, meeting.title, meeting.started_at, meeting.minutes));
    }
    for ticket in &log.tickets {
        any = true;
        let title = if ticket.url.is_empty() { format!("{} {}", ticket.key, ticket.title) } else { format!("[{} {}]({})", ticket.key, ticket.title, ticket.url) };
        out.push_str(&format!("- {}: {title} · {} · {}\n", w.ticket, ticket.branch, ticket.at));
    }
    if !log.notices.is_empty() {
        out.push_str(&format!("\n{}:\n", w.notices));
        for notice in &log.notices {
            out.push_str(&format!("- {notice}\n"));
        }
    }
    if !any && log.notices.is_empty() {
        out.push_str(&format!("- {}\n", w.nothing));
    }
    let out = if lang == "en" { out.replace(" archivos +", " files +") } else { out };
    out + "\n</details>\n"
}

/// The line at the end of a note that says how it was made — read back by «Regenerar».
pub const MARKER: &str = "<!-- codeflow:worklog ";

pub fn marker(request: &Request) -> String {
    format!("{MARKER}{} -->", serde_json::to_string(request).unwrap_or_else(|_| "{}".into()))
}

/// The request a note was made with, when it is one of these. The frontend reads it the same way
/// (`worklog/marker.ts`); this one holds the format to the round trip.
#[cfg(test)]
pub fn request_of(content: &str) -> Option<Request> {
    let start = content.rfind(MARKER)? + MARKER.len();
    let end = content[start..].find("-->")? + start;
    serde_json::from_str(content[start..end].trim()).ok()
}

/// The whole note: the summary, its sources, its marker.
pub fn note_body(summary: &str, log: &WorkLog, request: &Request, lang: &str) -> String {
    format!("{}\n\n{}\n{}\n", summary.trim_end(), sources(log, lang), marker(request))
}

/// What the model is handed: every fact, one per line, with nothing to interpret.
pub fn facts(log: &WorkLog, lang: &str) -> String {
    let mut out = format!(
        "PERIOD: {} → {} ({:?})\nFORMAT: {:?}\nLANGUAGE: {lang}\n",
        log.period.from, log.period.to, log.period.kind, log.format
    );
    for repo in &log.repos {
        if repo.is_empty() && repo.open_branches.is_empty() {
            continue;
        }
        out.push_str(&format!("\nREPO {} (workspace {})\n", repo.repo, repo.workspace));
        for c in &repo.commits {
            let when = chrono::DateTime::from_timestamp(c.time, 0).map(|t| t.with_timezone(&chrono::Local).format("%a %Y-%m-%d %H:%M").to_string()).unwrap_or_default();
            out.push_str(&format!("  COMMIT [{}] {when} {} (files {}, +{} -{})\n", c.branch, c.subject, c.files_changed, c.insertions, c.deletions));
        }
        let pr = |label: &str, prs: &[PrItem], out: &mut String| {
            for p in prs {
                let failing = if p.failing_checks.is_empty() { String::new() } else { format!(" FAILING CHECKS: {}", p.failing_checks.join(", ")) };
                out.push_str(&format!("  {label} #{} \"{}\" status={} {} -> {} by {} opened {} url={}{failing}\n", p.id, p.title, p.status, p.source_branch, p.target_branch, p.author, p.created_at, p.url));
            }
        };
        pr("PR_OPENED", &repo.prs_opened, &mut out);
        pr("PR_MERGED", &repo.prs_merged, &mut out);
        pr("PR_STILL_OPEN_MINE", &repo.prs_in_progress, &mut out);
        pr("PR_REVIEW_REQUESTED_FROM_ME", &repo.prs_awaiting_my_review, &mut out);
        pr("PR_I_REVIEWED", &repo.prs_reviewed, &mut out);
        for r in &repo.reviews {
            out.push_str(&format!("  CODEFLOW_REVIEW #{} \"{}\" level={} findings={} at {}\n", r.pr_id, r.pr_title, r.level, r.findings, r.at));
        }
        for b in &repo.open_branches {
            out.push_str(&format!("  UNMERGED_BRANCH_WITH_MY_COMMITS {b}\n"));
        }
    }
    for m in &log.meetings {
        out.push_str(&format!("\nMEETING \"{}\" at {} ({} min): {}\n", m.title, m.started_at, m.minutes, m.summary));
    }
    for t in &log.tickets {
        out.push_str(&format!("\nTICKET {} \"{}\" state={} branch={} at {}\n", t.key, t.title, t.state, t.branch, t.at));
    }
    if log.is_empty() {
        out.push_str("\n(NO ACTIVITY RECORDED)\n");
    }
    out
}

/// The sentence Codi says: counts, not the whole note.
pub fn spoken(log: &WorkLog, lang: &str) -> String {
    let commits = log.commit_count();
    let repos = log.active_repos().filter(|r| !r.commits.is_empty()).count();
    let opened: usize = log.repos.iter().map(|r| r.prs_opened.len()).sum();
    let merged: usize = log.repos.iter().map(|r| r.prs_merged.len()).sum();
    let reviews: usize = log.repos.iter().map(|r| r.reviews.len()).sum();
    let meetings = log.meetings.len();
    let failing = log.repos.iter().flat_map(|r| &r.prs_in_progress).filter(|p| !p.failing_checks.is_empty()).count();
    let es = lang != "en";
    let when = match (log.period.kind, es) {
        (PeriodKind::PreviousWorkday, true) => "Ayer",
        (PeriodKind::PreviousWorkday, false) => "Yesterday",
        (PeriodKind::Today, true) => "Hoy",
        (PeriodKind::Today, false) => "Today",
        (PeriodKind::ThisWeek, true) => "Esta semana",
        (PeriodKind::ThisWeek, false) => "This week",
        (PeriodKind::LastWeek, true) => "La semana pasada",
        (PeriodKind::LastWeek, false) => "Last week",
        (PeriodKind::Custom, true) => "En ese período",
        (PeriodKind::Custom, false) => "In that period",
    };
    if log.is_empty() {
        return if es { format!("{when} no encuentro actividad tuya registrada.") } else { format!("{when} I find no activity of yours recorded.") };
    }
    let mut parts: Vec<String> = Vec::new();
    if commits > 0 {
        parts.push(if es {
            format!("{commits} {} en {repos} {}", if commits == 1 { "commit" } else { "commits" }, if repos == 1 { "repositorio" } else { "repositorios" })
        } else {
            format!("{commits} {} in {repos} {}", if commits == 1 { "commit" } else { "commits" }, if repos == 1 { "repository" } else { "repositories" })
        });
    }
    if opened > 0 {
        parts.push(if es { format!("{opened} PR abiertos") } else { format!("{opened} PRs opened") });
    }
    if merged > 0 {
        parts.push(if es { format!("{merged} mergeados") } else { format!("{merged} merged") });
    }
    if reviews > 0 {
        parts.push(if es { format!("{reviews} revisiones") } else { format!("{reviews} reviews") });
    }
    if meetings > 0 {
        parts.push(if es { format!("{meetings} {}", if meetings == 1 { "reunión" } else { "reuniones" }) } else { format!("{meetings} {}", if meetings == 1 { "meeting" } else { "meetings" }) });
    }
    let and = if es { " y " } else { " and " };
    let list = match parts.as_slice() {
        [] => String::new(),
        [one] => one.clone(),
        [rest @ .., last] => format!("{}{and}{last}", rest.join(", ")),
    };
    let blockers = if failing > 0 {
        if es {
            format!(" Ojo: {failing} PR con checks fallando.")
        } else {
            format!(" Heads up: {failing} PR with failing checks.")
        }
    } else {
        String::new()
    };
    if es {
        format!("{when}: {list}.{blockers} Te dejé el resumen en Notas.")
    } else {
        format!("{when}: {list}.{blockers} I left the summary in Notes.")
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::worklog::{period, MeetingItem, ReviewItem};

    pub fn sample(format: Format) -> WorkLog {
        let p = period(PeriodKind::PreviousWorkday, NaiveDate::from_ymd_opt(2026, 10, 26).unwrap(), None, None).unwrap();
        let pr = |id: i64, title: &str, status: &str, branch: &str| PrItem {
            id,
            title: title.into(),
            url: format!("https://example.com/pr/{id}"),
            status: status.into(),
            source_branch: branch.into(),
            target_branch: "main".into(),
            author: "me".into(),
            created_at: "2026-10-23T10:00:00Z".into(),
            failing_checks: vec![],
        };
        let mut open = pr(12, "Pagos en cuotas", "open", "feature/pay");
        open.failing_checks = vec!["build".into()];
        WorkLog {
            period: p.clone(),
            format,
            identity: vec!["me@example.com".into()],
            repos: vec![RepoLog {
                project_id: "p1".into(),
                repo: "api-pagos".into(),
                workspace_id: "w1".into(),
                workspace: "Clientes".into(),
                commits: vec![CommitItem { sha: "abcdef1234567".into(), branch: "feature/pay".into(), subject: "Cuotas sin interés".into(), time: p.start + 3600 * 10, files_changed: 3, insertions: 40, deletions: 2 }],
                prs_opened: vec![open.clone()],
                prs_merged: vec![],
                prs_reviewed: vec![],
                prs_in_progress: vec![open],
                prs_awaiting_my_review: vec![pr(4, "Login", "open", "feature/login")],
                reviews: vec![ReviewItem { run_id: "r1".into(), pr_id: 4, pr_title: "Login".into(), url: "https://example.com/pr/4".into(), author: "ana".into(), level: "standard".into(), findings: 2, at: "2026-10-23T14:00:00+00:00".into() }],
                open_branches: vec!["feature/pay".into()],
            }],
            meetings: vec![MeetingItem { meeting_id: "m1".into(), note_id: "n1".into(), title: "Planning".into(), started_at: "2026-10-23T15:00:00+00:00".into(), minutes: 30, summary: "Lanzamos el viernes".into() }],
            tickets: vec![],
            notices: vec![],
        }
    }

    #[test]
    fn the_daily_without_a_model_says_only_what_happened() {
        let text = fallback(&sample(Format::Daily), "es");
        assert!(text.starts_with("## Ayer\n\n- **api-pagos**: 1 commit — «Cuotas sin interés»\n"), "{text}");
        assert!(text.contains("- PR abierto: [#12 Pagos en cuotas](https://example.com/pr/12) (api-pagos)"));
        assert!(text.contains("- Revisé: [#4 Login](https://example.com/pr/4) (api-pagos) — 2 hallazgos"));
        assert!(text.contains("- Reunión: Planning (30 min) — Lanzamos el viernes"));
        assert!(text.contains("## Hoy\n\n- Sigo con [#12 Pagos en cuotas](https://example.com/pr/12) (api-pagos)\n- Revisar (me lo pidieron): [#4 Login]"));
        assert!(!text.contains("Sigo en la rama `feature/pay`"), "a branch with its PR is said once");
        assert!(text.contains("## Bloqueos\n\n- [#12 Pagos en cuotas](https://example.com/pr/12) tiene checks fallando: build"));
    }

    #[test]
    fn an_empty_period_says_none_instead_of_inventing() {
        let mut log = sample(Format::Daily);
        log.repos.clear();
        log.meetings.clear();
        let text = fallback(&log, "es");
        assert!(text.contains("## Ayer\n\n- Sin actividad registrada en este período."));
        assert!(text.contains("## Bloqueos\n\n- Ninguno."));
        let en = fallback(&log, "en");
        assert!(en.contains("## Blockers\n\n- None."));
        assert_eq!(spoken(&log, "es"), "Ayer no encuentro actividad tuya registrada.");
    }

    #[test]
    fn the_weekly_groups_by_project_with_numbers() {
        let text = fallback(&sample(Format::Weekly), "es");
        assert!(text.starts_with("## Resumen\n\n- 1 commit en 1 repositorios · 1 PRs abiertos · 0 mergeados · 1 revisiones · 1 reuniones"), "{text}");
        assert!(text.contains("### api-pagos (Clientes)\n\n- 1 commit (ramas: feature/pay)"));
        assert!(text.contains("## Reuniones\n\n- Planning (30 min) — Lanzamos el viernes"));
        assert!(text.contains("## Pendiente y bloqueos"));
    }

    #[test]
    fn titles_sources_and_the_marker() {
        let log = sample(Format::Daily);
        assert_eq!(title(&log, "es"), "Daily — 23 oct 2026");
        assert_eq!(title(&log, "en"), "Daily — Oct 23, 2026");
        let mut weekly = sample(Format::Weekly);
        weekly.period = period(PeriodKind::LastWeek, NaiveDate::from_ymd_opt(2026, 10, 26).unwrap(), None, None).unwrap();
        assert_eq!(title(&weekly, "es"), "Semanal — 19–25 oct 2026");
        let src = sources(&log, "es");
        assert!(src.starts_with("<details>\n<summary>Fuentes</summary>"));
        assert!(src.contains("[`abcdef1`](#cf-commit=w1:p1:abcdef1234567) Cuotas sin interés — `feature/pay`"));
        assert!(src.contains("[[Planning]]"));
        let request = Request { period: PeriodKind::ThisWeek, workspace_id: Some("w1".into()), ..Default::default() };
        let body = note_body("## Ayer\n", &log, &request, "es");
        assert_eq!(request_of(&body), Some(request));
        assert_eq!(request_of("# una nota cualquiera"), None);
    }

    #[test]
    fn codi_says_counts() {
        assert_eq!(
            spoken(&sample(Format::Daily), "es"),
            "Ayer: 1 commit en 1 repositorio, 1 PR abiertos, 1 revisiones y 1 reunión. Ojo: 1 PR con checks fallando. Te dejé el resumen en Notas."
        );
    }

    #[test]
    fn the_model_is_handed_every_fact() {
        let facts = facts(&sample(Format::Daily), "es");
        assert!(facts.contains("COMMIT [feature/pay]"));
        assert!(facts.contains("PR_REVIEW_REQUESTED_FROM_ME #4"));
        assert!(facts.contains("FAILING CHECKS: build"));
        assert!(facts.contains("MEETING \"Planning\""));
    }
}
