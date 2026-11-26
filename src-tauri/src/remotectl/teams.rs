//! The team engine, as a phone is shown it.
//!
//! # Why a shape of its own
//!
//! A run's real record (`team::RunState`) is what the desk's live view draws: every member with the
//! prompt it was given and the account it runs on, the whole policy, every item's instruction and
//! output, every message ever exchanged. Handing that to a phone would be wrong twice. It is
//! megabytes over somebody's wifi to draw a list of rows, and it carries things a control surface
//! has no use for — a member's system prompt, an account id, a worktree path — that a stolen
//! device token should not be a way to read.
//!
//! So the phone gets what it needs to answer the three questions it is opened for: *is anything
//! waiting for me* ([`RunRow::gate`], [`RunRow::questions`]), *how far along is it*
//! ([`RunRow::done`] of [`RunRow::total`]), and *what exactly am I being asked* ([`RunView`]).
//! Everything is cut to a length a phone screen can show — see [`clip`].
//!
//! Like `flows::waits::phone_view`, this is a view and nothing else: it reads, and the four verbs a
//! phone has on a run go through the same commands the desk's buttons call (`dispatch.rs`).

use rusqlite::Connection;
use serde::Serialize;

use crate::team::{self, Item, Message, RunState};

/// How many runs a phone lists. Newest first, and the ones waiting for somebody always among them
/// (they are the newest by definition — a gate is the last thing that happened to a run).
const MAX_RUNS: usize = 40;

/// How much of a run's conversation the phone is shown: the tail, which is what is being read.
const MAX_MESSAGES: usize = 40;

/// How many of an impact gate's files are named. Past it the phone is told to read the rest at the
/// desk, which is where the diff is anyway.
const MAX_GATE_FILES: usize = 40;

/// One run in the list.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunRow {
    pub id: String,
    /// The run's title, or the start of its goal when it was never given one.
    pub title: String,
    pub team_name: String,
    /// `running | gated | paused | done | failed | aborted`.
    pub status: String,
    /// What a `gated` run waits for, whole (`item:<id>`): sent back as the precondition of the
    /// answer, so a decision made on a stale screen is refused instead of applied to another gate.
    pub gate: String,
    /// The gate's kind alone — `plan`, `item`, `merge`, `review`, `deps`, `budget`, `stuck`,
    /// `sandbox`, `amend`, `amend_failed`, `impact` — which is what the phone words its buttons by.
    pub gate_kind: String,
    /// Questions a member asked the user that nobody has answered.
    pub questions: usize,
    /// The work itself — the lead's own planning turns are not counted, on either side.
    pub done: usize,
    pub total: usize,
    pub running: usize,
    pub failed: usize,
    pub updated_at: String,
    pub pinned: bool,
}

/// One task of a run.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemRow {
    pub id: String,
    pub title: String,
    pub member: String,
    /// `plan | final | answer | work | investigate | review | integrate`…
    pub kind: String,
    /// `pending | gated | running | waiting | done | error | cancelled | skipped`.
    pub status: String,
    /// `queued | running | verifying` while it runs; empty otherwise.
    pub phase: String,
    pub attempts: i64,
    pub last_error: String,
    /// Whether `retry:<id>` / `skip:<id>` would do something now — the engine's own conditions,
    /// so the phone offers a button only where the desk does.
    pub can_retry: bool,
    pub can_skip: bool,
    /// Whether there is work of its own to read: a branch, or a folder it is working in. What the
    /// phone offers "see the changes" by (`diff`).
    pub has_changes: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionRow {
    pub id: String,
    pub from: String,
    pub body: String,
    pub options: Vec<String>,
    /// The task it was asked from, so the question is read with what it is about.
    pub task: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRow {
    pub id: String,
    pub from: String,
    pub to: String,
    /// `plan | decision | handoff | question | answer | note | finding | status | merge | error`.
    pub kind: String,
    pub body: String,
    pub answer: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoRow {
    /// Named back to ask for this repository's changes (`diff`).
    pub project_id: String,
    pub name: String,
    pub target_branch: String,
    /// `ready | merged | left | pr | failed`, or empty while the run works.
    pub status: String,
    pub last_error: String,
    pub pr_url: String,
}

/// Who a note can be addressed to.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberRow {
    pub id: String,
    pub name: String,
    pub role: String,
    pub lead: bool,
}

/// One run, opened.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunView {
    pub run: RunRow,
    pub goal: String,
    /// What the engine wrote about the gate — the plan's summary, why it got stuck.
    pub gate_note: String,
    /// The task a gate is about, when it is about one.
    pub gate_task: Option<ItemRow>,
    /// That task's instruction, for the gates where it is what is being approved.
    pub gate_instruction: String,
    /// The tasks a `plan` gate proposes, in order.
    pub planned: Vec<ItemRow>,
    /// What else is being approved, for the gates whose question is not in the note: why a change
    /// is high-impact (or how it weakened its tests), or the lead's summary of an amendment.
    pub gate_reasons: Vec<String>,
    /// The files an `impact` gate is about. Their diff stays at the desk — a phone is told *what*
    /// would change, and reads it there before saying yes to something it cannot see.
    pub gate_files: Vec<String>,
    /// The tasks an `amend` gate would add, and how many it would cancel.
    pub gate_adds: Vec<String>,
    pub gate_cancels: usize,
    /// `merge` or `pr`: what approving the last gate does, so the button can say it.
    pub integrate: String,
    pub repos: Vec<RepoRow>,
    pub items: Vec<ItemRow>,
    pub questions: Vec<QuestionRow>,
    pub messages: Vec<MessageRow>,
    pub members: Vec<MemberRow>,
}

/// Cuts text to what a phone shows, on a character boundary, saying that it was cut.
fn clip(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut cut: String = text.chars().take(max).collect();
    cut.push('…');
    cut
}

fn gate_kind(gate: &str) -> String {
    gate.split(':').next().unwrap_or_default().to_string()
}

/// A question the user owes an answer to. The same test the desk's inbox uses.
fn open_question(message: &Message) -> bool {
    message.kind == "question" && message.to_id == "user" && message.answered_at.is_empty()
}

fn row(run: &team::Run, items: &[Item], messages: &[Message]) -> RunRow {
    let work: Vec<&Item> = items.iter().filter(|item| !item.is_lead()).collect();
    let title = if run.title.trim().is_empty() { clip(&run.goal, 80) } else { clip(&run.title, 120) };
    RunRow {
        id: run.id.clone(),
        title,
        team_name: run.team_name.clone(),
        status: run.status.clone(),
        gate: if run.status == "gated" { run.gate.clone() } else { String::new() },
        gate_kind: if run.status == "gated" { gate_kind(&run.gate) } else { String::new() },
        questions: messages.iter().filter(|m| open_question(m)).count(),
        done: work.iter().filter(|item| matches!(item.status.as_str(), "done" | "skipped")).count(),
        total: work.len(),
        running: work.iter().filter(|item| item.status == "running").count(),
        failed: work.iter().filter(|item| item.status == "error").count(),
        updated_at: run.updated_at.clone(),
        pinned: run.pinned,
    }
}

fn item_row(item: &Item) -> ItemRow {
    // The engine's own conditions (`engine::control`, and the desk's buttons in `RunParts.tsx`),
    // repeated here so a phone never offers a verb the engine would silently ignore.
    let recovering = item.status == "waiting" && item.intelligence.recovery.is_some();
    ItemRow {
        id: item.id.clone(),
        title: clip(&item.title, 160),
        member: item.member_name.clone(),
        kind: item.kind.clone(),
        status: item.status.clone(),
        phase: item.intelligence.phase.clone(),
        attempts: item.attempts,
        last_error: clip(&item.last_error, 600),
        can_retry: matches!(item.status.as_str(), "error" | "cancelled" | "skipped") || recovering,
        can_skip: matches!(item.status.as_str(), "pending" | "gated" | "error" | "waiting")
            && item.intelligence.impact.is_none()
            && !(item.kind == "amend" && item.status == "gated"),
        has_changes: item.writes() && (!item.branch.is_empty() || !item.worktree_path.is_empty()),
    }
}

/// The runs of a workspace, as rows: the ones waiting for somebody first, then the newest.
pub fn runs(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<RunRow>> {
    let mut rows = Vec::new();
    for run in team::list_runs(conn, workspace_id)?.into_iter().take(MAX_RUNS) {
        let items = team::list_items(conn, &run.id)?;
        let messages = team::list_messages(conn, &run.id)?;
        rows.push(row(&run, &items, &messages));
    }
    // Stable, so within each group the newest-first order `list_runs` gave is kept.
    rows.sort_by_key(|row| attention_rank(row));
    Ok(rows)
}

/// Where a run sorts: a question or a gate is a request and goes above everything; then what is
/// moving; then what is over.
fn attention_rank(row: &RunRow) -> u8 {
    if row.status == "gated" || row.questions > 0 {
        0
    } else if matches!(row.status.as_str(), "running" | "paused") {
        1
    } else {
        2
    }
}

/// One run, opened. See [`RunView`].
pub fn view(state: &RunState) -> RunView {
    let run = &state.run;
    let gated = run.status == "gated";
    let gate_id = if gated { run.gate.split(':').nth(1).unwrap_or_default() } else { "" };
    let gate_item = state.items.iter().find(|item| !gate_id.is_empty() && item.id == gate_id);
    let task_title = |item_id: &str| {
        state.items.iter().find(|item| item.id == item_id).map(|item| clip(&item.title, 120)).unwrap_or_default()
    };

    let planned = if gated && run.gate == "plan" {
        state
            .items
            .iter()
            .filter(|item| item.status == "pending" && !matches!(item.kind.as_str(), "plan" | "final" | "answer" | "advise"))
            .map(item_row)
            .collect()
    } else {
        Vec::new()
    };

    let impact = gate_item.and_then(|item| item.intelligence.impact.as_ref()).filter(|_| run.gate.starts_with("impact:"));
    let amendment = gate_item
        .and_then(|item| item.intelligence.amendment.as_ref())
        .filter(|_| run.gate.starts_with("amend:") || run.gate.starts_with("amend_failed:"));
    let mut gate_reasons: Vec<String> = impact.map(|impact| impact.reasons.iter().map(|reason| clip(reason, 300)).collect()).unwrap_or_default();
    if let Some(amendment) = amendment {
        if !amendment.summary.trim().is_empty() {
            gate_reasons.push(clip(&amendment.summary, 2000));
        }
    }

    let tail = state.messages.len().saturating_sub(MAX_MESSAGES);
    RunView {
        run: row(run, &state.items, &state.messages),
        goal: clip(&run.goal, 4000),
        gate_note: if gated { clip(&run.gate_note, 6000) } else { String::new() },
        gate_task: gate_item.map(item_row),
        gate_instruction: gate_item.map(|item| clip(&item.instruction, 3000)).unwrap_or_default(),
        planned,
        gate_reasons,
        gate_files: impact.map(|impact| impact.files.iter().take(MAX_GATE_FILES).cloned().collect()).unwrap_or_default(),
        gate_adds: amendment.map(|a| a.items.iter().map(|item| clip(&item.title, 160)).collect()).unwrap_or_default(),
        gate_cancels: amendment.map(|a| a.cancel.len()).unwrap_or_default(),
        integrate: run.policy.integrate.clone(),
        repos: state
            .repos
            .iter()
            .map(|repo| RepoRow {
                project_id: repo.project_id.clone(),
                name: repo.name.clone(),
                target_branch: repo.target_branch.clone(),
                status: repo.status.clone(),
                last_error: clip(&repo.last_error, 600),
                pr_url: repo.pr_url.clone(),
            })
            .collect(),
        items: state.items.iter().filter(|item| !item.is_lead()).map(item_row).collect(),
        questions: state
            .messages
            .iter()
            .filter(|m| open_question(m))
            .map(|m| QuestionRow {
                id: m.id.clone(),
                from: m.from_name.clone(),
                body: clip(&m.body, 3000),
                options: m.options.iter().map(|option| clip(option, 200)).collect(),
                task: task_title(&m.item_id),
                created_at: m.created_at.clone(),
            })
            .collect(),
        messages: state.messages[tail..]
            .iter()
            .map(|m| MessageRow {
                id: m.id.clone(),
                from: m.from_name.clone(),
                to: m.to_name.clone(),
                kind: m.kind.clone(),
                body: clip(&m.body, 1500),
                answer: clip(&m.answer, 1500),
                created_at: m.created_at.clone(),
            })
            .collect(),
        members: run
            .members
            .iter()
            .map(|snap| MemberRow {
                id: snap.member.id.clone(),
                name: snap.member.name.clone(),
                role: clip(&snap.member.role, 120),
                lead: snap.member.id == run.lead,
            })
            .collect(),
    }
}

// ---------------------------------------------------------------- the teams themselves

/// One team, as the phone lists it to start a run or open its chat.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRow {
    pub id: String,
    pub name: String,
    pub description: String,
    /// The lead's name, or empty for a team that works from a fixed plan.
    pub lead: String,
    pub members: Vec<String>,
    /// Whether it can take a task now, and — when it cannot — the engine's own reason.
    pub runnable: bool,
    pub problem: String,
}

/// The teams of a workspace. No policy, no plan and no agent ids: the phone names a team and the
/// desk resolves the rest, exactly as it does for a chat turn's engine.
pub fn teams(conn: &Connection, workspace_id: &str) -> rusqlite::Result<Vec<TeamRow>> {
    Ok(team::list_teams(conn, workspace_id)?
        .into_iter()
        .map(|tm| {
            let problem = team::runnable(&tm).err().unwrap_or_default();
            TeamRow {
                lead: tm.members.iter().find(|m| m.id == tm.lead).map(|m| m.name.clone()).unwrap_or_default(),
                members: tm.members.iter().map(|m| m.name.clone()).collect(),
                runnable: problem.is_empty(),
                problem,
                id: tm.id,
                name: tm.name,
                description: clip(&tm.description, 400),
            }
        })
        .collect())
}

// ---------------------------------------------------------------- a team's conversation

/// How much of a conversation the phone is shown: the tail. The count of what is above it travels
/// too, so the screen can say there is more at the desk rather than look like the beginning.
const MAX_CHAT_MESSAGES: usize = 80;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageRow {
    pub id: String,
    /// `user`, or the role the engine filed a member's turn under.
    pub role: String,
    pub member: String,
    pub content: String,
    pub provider: String,
    pub model: String,
    pub created_at: String,
}

/// A conversation with a team, opened. The chat's own record carries every member's prompt and
/// account and the whole policy; this is the transcript and who is answering.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatView {
    pub id: String,
    pub team_id: String,
    pub team_name: String,
    /// `idle | running | cancelling | error`.
    pub status: String,
    /// Who is answering right now, by name; empty when nobody is.
    pub active_member: String,
    pub error: String,
    pub messages: Vec<ChatMessageRow>,
    /// Messages older than the ones sent.
    pub earlier: usize,
}

pub fn chat_view(state: &team::chat::ChatState) -> ChatView {
    chat_rows(&state.chat, &state.messages)
}

/// [`chat_view`] without the task row a `ChatState` carries, which a phone is never shown.
fn chat_rows(chat: &team::chat::Chat, messages: &[team::chat::Message]) -> ChatView {
    let tail = messages.len().saturating_sub(MAX_CHAT_MESSAGES);
    ChatView {
        id: chat.id.clone(),
        team_id: chat.team_id.clone(),
        team_name: chat.team_name.clone(),
        status: chat.status.clone(),
        active_member: chat
            .members
            .iter()
            .find(|snap| snap.member.id == chat.active_member_id)
            .map(|snap| snap.member.name.clone())
            .unwrap_or_default(),
        error: clip(&chat.error, 1200),
        messages: messages[tail..]
            .iter()
            .map(|m| ChatMessageRow {
                id: m.id.clone(),
                role: m.role.clone(),
                member: m.member_name.clone(),
                content: clip(&m.content, 24_000),
                provider: m.provider.clone(),
                model: m.model.clone(),
                created_at: m.created_at.clone(),
            })
            .collect(),
        earlier: tail,
    }
}

// ---------------------------------------------------------------- what a gate would bring in

/// How many diff lines a phone is sent for one question. Past it whole files are left out and
/// counted (`more`): a change of ten thousand lines is not read on a phone, and saying "and 14 more
/// files" is honest where sending them would be a frozen screen.
const MAX_DIFF_LINES: usize = 6000;

/// The changes behind a decision.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffView {
    /// What is being compared, as two names a person recognises: a branch against a branch.
    pub base: String,
    pub head: String,
    pub files: Vec<crate::git::diff::FileDiffInfo>,
    /// Files left out for size.
    pub more: usize,
    /// The change as plain diff text, when that is what there is: the diff an impact gate recorded,
    /// or a task's uncommitted work read from its folder. Empty when `files` carries it.
    pub text: String,
}

/// The changes one decision is about: a task's (`item_id`), or everything a repository's
/// integration would bring into its target branch (`project_id`).
///
/// Read from the repository itself — branches are shared by all its worktrees — and never from a
/// path the phone names: the phone names a run and one of its tasks or repositories, and every
/// path and branch is the run's own record.
pub fn diff(state: &RunState, item_id: Option<&str>, project_id: Option<&str>) -> Result<DiffView, String> {
    let repo_of = |project: &str| {
        state.repos.iter().find(|repo| repo.project_id == project).ok_or_else(|| "Ese repositorio no está en la corrida.".to_string())
    };
    if let Some(item_id) = item_id.filter(|id| !id.is_empty()) {
        let item = state.items.iter().find(|item| item.id == item_id).ok_or("Esa tarea ya no está en la corrida.")?;
        let repo = repo_of(&item.project_id)?;
        // What the impact gate itself recorded, when this is that gate: it is the exact text the
        // desk shows above the same two buttons.
        if let Some(impact) = item.intelligence.impact.as_ref().filter(|impact| !impact.diff.trim().is_empty()) {
            return Ok(DiffView { base: repo.integration_branch.clone(), head: item.branch.clone(), files: Vec::new(), more: 0, text: impact.diff.clone() });
        }
        // Against what it will be merged into — or, once it has been, against where the run started,
        // since a merged branch has nothing left that the integration lacks.
        let base = if item.merged { &repo.target_branch } else { &repo.integration_branch };
        if !item.branch.is_empty() {
            if let Ok(files) = crate::git::diff::get_branch_diff(&repo.local_path, base, &item.branch) {
                if !files.is_empty() {
                    let (files, more) = fit(files);
                    return Ok(DiffView { base: base.clone(), head: item.branch.clone(), files, more, text: String::new() });
                }
            }
        }
        // Work not committed yet lives only in the task's folder.
        if !item.worktree_path.is_empty() && std::path::Path::new(&item.worktree_path).is_dir() {
            let text = crate::team::gitops::handoff_diff(&item.worktree_path, base);
            if !text.is_empty() {
                return Ok(DiffView { base: base.clone(), head: item.branch.clone(), files: Vec::new(), more: 0, text });
            }
        }
        return Ok(DiffView { base: base.clone(), head: item.branch.clone(), files: Vec::new(), more: 0, text: String::new() });
    }
    let repo = repo_of(project_id.unwrap_or_default())?;
    let (files, more) = fit(crate::git::diff::get_branch_diff(&repo.local_path, &repo.target_branch, &repo.integration_branch)?);
    Ok(DiffView { base: repo.target_branch.clone(), head: repo.integration_branch.clone(), files, more, text: String::new() })
}

/// Keeps whole files up to [`MAX_DIFF_LINES`], and says how many were left out. Never half a file:
/// a diff that stops mid-hunk reads as a change that stops there.
fn fit(files: Vec<crate::git::diff::FileDiffInfo>) -> (Vec<crate::git::diff::FileDiffInfo>, usize) {
    let total = files.len();
    let mut lines = 0usize;
    let mut kept = Vec::new();
    for file in files {
        let size: usize = file.hunks.iter().map(|hunk| hunk.lines.len()).sum();
        // The first file always goes, however large: one file too big to show is still the answer.
        if !kept.is_empty() && lines + size > MAX_DIFF_LINES {
            break;
        }
        lines += size;
        kept.push(file);
    }
    let more = total - kept.len();
    (kept, more)
}

/// The verbs a phone has over a run, checked before they reach the engine.
///
/// `pause`, `resume` and `abort` for the run; `retry:<id>` and `skip:<id>` for one of its tasks.
/// Anything else the engine understands (`continue-without-deps`) is a decision with a gate of its
/// own, answered through `team_decide`.
pub fn allowed_control(action: &str) -> bool {
    matches!(action, "pause" | "resume" | "abort")
        || action
            .strip_prefix("retry:")
            .or_else(|| action.strip_prefix("skip:"))
            .is_some_and(|id| !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::team::{Member, MemberSnap, Run};

    fn item(id: &str, kind: &str, status: &str) -> Item {
        Item { id: id.into(), kind: kind.into(), status: status.into(), title: format!("Tarea {id}"), ..Default::default() }
    }

    fn question(id: &str, answered: bool) -> Message {
        Message {
            id: id.into(),
            kind: "question".into(),
            to_id: "user".into(),
            from_name: "QA".into(),
            body: "¿Sigo con la migración?".into(),
            answered_at: if answered { "2026-11-26T10:00:00Z".into() } else { String::new() },
            ..Default::default()
        }
    }

    fn run(status: &str, gate: &str) -> Run {
        Run {
            id: "run-1".into(),
            status: status.into(),
            gate: gate.into(),
            goal: "Agregar exportación a CSV".into(),
            lead: "m-lead".into(),
            members: vec![MemberSnap {
                member: Member { id: "m-lead".into(), name: "Líder".into(), ..Default::default() },
                prompt: "PROMPT-SECRETO".into(),
                account_id: Some("cuenta-privada".into()),
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    /// The reason this module exists: a phone must never be handed what a member was told or which
    /// account it runs on. Read as text, the way a thief would.
    #[test]
    fn a_run_shown_to_a_phone_carries_no_prompt_and_no_account() {
        let state = RunState { run: run("gated", "plan"), items: vec![item("a", "work", "pending")], ..Default::default() };
        let text = serde_json::to_string(&view(&state)).unwrap();
        assert!(!text.contains("PROMPT-SECRETO"), "a member's prompt reached the phone");
        assert!(!text.contains("cuenta-privada"), "an account id reached the phone");
        assert!(text.contains("Líder"));
    }

    /// The lead's planning turns are not work: a run with a plan, one task done and one running is
    /// "1 of 2", not "2 of 3".
    #[test]
    fn progress_counts_the_work_and_not_the_planning() {
        let items = vec![item("p", "plan", "done"), item("a", "work", "done"), item("b", "work", "running")];
        let row = row(&run("running", ""), &items, &[]);
        assert_eq!((row.done, row.total, row.running), (1, 2, 1));
    }

    /// Only an unanswered question to the user is a request; an answered one is history.
    #[test]
    fn only_unanswered_questions_ask_for_somebody() {
        let row = row(&run("running", ""), &[], &[question("q1", false), question("q2", true)]);
        assert_eq!(row.questions, 1);
    }

    /// A gate is only a gate while the run is parked on it: the column keeps its last value after.
    #[test]
    fn a_run_that_moved_on_shows_no_gate() {
        let row = row(&run("running", "plan"), &[], &[]);
        assert_eq!(row.gate, "");
        assert_eq!(row.gate_kind, "");
        let gated = row_of("gated", "item:abc");
        assert_eq!(gated.gate, "item:abc");
        assert_eq!(gated.gate_kind, "item");
    }

    fn row_of(status: &str, gate: &str) -> RunRow {
        row(&run(status, gate), &[], &[])
    }

    /// What is waiting for somebody is above what is moving, which is above what is over.
    #[test]
    fn requests_sort_above_reports() {
        assert!(attention_rank(&row_of("gated", "merge")) < attention_rank(&row_of("running", "")));
        assert!(attention_rank(&row_of("running", "")) < attention_rank(&row_of("done", "")));
        let asked = row(&run("running", ""), &[], &[question("q1", false)]);
        assert_eq!(attention_rank(&asked), 0);
    }

    /// A plan gate lists what it proposes, and the task a gate is about travels with it.
    #[test]
    fn a_gate_is_shown_with_what_it_is_about() {
        let mut task = item("abc", "work", "gated");
        task.instruction = "Cambia el esquema".into();
        let state = RunState { run: run("gated", "item:abc"), items: vec![task], ..Default::default() };
        let opened = view(&state);
        assert_eq!(opened.gate_task.as_ref().map(|t| t.id.as_str()), Some("abc"));
        assert_eq!(opened.gate_instruction, "Cambia el esquema");

        let plan = RunState {
            run: run("gated", "plan"),
            items: vec![item("p", "plan", "done"), item("a", "work", "pending"), item("b", "review", "pending")],
            ..Default::default()
        };
        assert_eq!(view(&plan).planned.len(), 2);
    }

    /// A conversation shown to a phone names who is answering and what was said — and, like a run,
    /// never what a member was told or which account it runs on.
    #[test]
    fn a_conversation_shown_to_a_phone_carries_no_prompt_and_no_account() {
        let chat: team::chat::Chat = serde_json::from_value(serde_json::json!({
            "id": "c1", "workspaceId": "w", "projectId": "p", "projectName": "api", "teamId": "t", "teamName": "Backend",
            "teamUpdatedAt": "", "leadId": "m-lead", "taskId": "task", "status": "running", "activeMemberId": "m-lead",
            "activeRunId": "", "error": "", "revision": 1, "createdAt": "",
            "policy": serde_json::to_value(team::Policy::default()).unwrap(),
            "members": [serde_json::to_value(MemberSnap {
                member: Member { id: "m-lead".into(), name: "Líder".into(), ..Default::default() },
                prompt: "PROMPT-SECRETO".into(),
                account_id: Some("cuenta-privada".into()),
                ..Default::default()
            }).unwrap()],
        }))
        .unwrap();
        let said = |n: usize| -> team::chat::Message {
            serde_json::from_value(serde_json::json!({
                "id": format!("m{n}"), "role": "user", "memberId": "", "memberName": "", "content": format!("mensaje {n}"),
                "provider": "", "model": "", "traceId": null, "responseTimeMs": 0, "createdAt": "",
            }))
            .unwrap()
        };
        let messages: Vec<_> = (0..MAX_CHAT_MESSAGES + 5).map(said).collect();
        let view = chat_rows(&chat, &messages);
        let text = serde_json::to_string(&view).unwrap();
        assert!(!text.contains("PROMPT-SECRETO") && !text.contains("cuenta-privada"));
        assert_eq!(view.active_member, "Líder");
        // The tail, and the count of what is above it.
        assert_eq!((view.messages.len(), view.earlier), (MAX_CHAT_MESSAGES, 5));
        assert_eq!(view.messages.last().unwrap().content, format!("mensaje {}", MAX_CHAT_MESSAGES + 4));
    }

    /// A diff cut for a phone keeps whole files and counts the ones left out — and the first file
    /// goes however large it is, since one file too big to show is still the answer.
    #[test]
    fn a_diff_is_cut_at_a_file_and_never_inside_one() {
        let file = |lines: usize| crate::git::diff::FileDiffInfo {
            old_path: None,
            new_path: Some(format!("f{lines}.rs")),
            status: "added".into(),
            binary: false,
            hunks: vec![crate::git::diff::DiffHunkInfo {
                header: "@@".into(),
                lines: (0..lines)
                    .map(|n| crate::git::diff::DiffLine { origin: "+".into(), content: n.to_string(), old_lineno: None, new_lineno: Some(n as u32) })
                    .collect(),
            }],
        };
        let (kept, more) = fit(vec![file(MAX_DIFF_LINES - 10), file(5), file(20), file(1)]);
        assert_eq!((kept.len(), more), (2, 2));
        assert!(kept.iter().all(|f| !f.hunks[0].lines.is_empty()));
        let (huge, more) = fit(vec![file(MAX_DIFF_LINES * 2), file(1)]);
        assert_eq!((huge.len(), more), (1, 1));
        assert_eq!(fit(Vec::new()).1, 0);
    }

    /// Long text is cut on a character boundary — never inside one — and says so.
    #[test]
    fn text_is_clipped_on_a_character_boundary() {
        assert_eq!(clip("  hola  ", 10), "hola");
        assert_eq!(clip("añoñoñoñ", 3), "año…");
    }

    /// The control verbs a phone has, and the ones it does not.
    #[test]
    fn only_the_listed_controls_reach_the_engine() {
        for ok in ["pause", "resume", "abort", "retry:item-1", "skip:8f2c_a"] {
            assert!(allowed_control(ok), "{ok}");
        }
        for no in ["continue-without-deps", "retry:", "skip:../x", "delete", "retry:a b", ""] {
            assert!(!allowed_control(no), "{no}");
        }
    }
}
