//! The execute step: this app — not an agent — walking the plan against the local model.
//!
//! Runs inside `send_chat_message`, under the run id the chain claimed, so it has everything a CLI
//! turn has: Stop (`ai_runs` cancellation), the run card and the status bar (`emit_engine`,
//! `emit_line`), the per-conversation lease, and exactly one `activity_log` row written by the
//! caller with whatever this returns. See `commands::claude_cmd::send_chat_message`.
//!
//! What each task gets is decided in [`super::prompts::executor_prompt`] — instruction, target,
//! references in priority order, never more than the budget, never a silently trimmed prompt. What
//! each answer has to be before it touches the disk is decided in [`super::apply`].

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::{watch, Notify, Semaphore};

use super::apply;
use super::budget;
use super::local_llm::{self, BackendKind, ChatRequest, Finish, LocalError};
use super::plan::{PlanCheck, RepoRef};
use super::prompts::{self, Reference, Target};
use super::runtime;
use crate::ai_runs;
use crate::db::hybrid_queries::{self, HybridItem, HybridRun, ItemOutcome};
use crate::db::Db;

/// Prefixes an error that should **pause** the chain rather than spend an attempt: the local model
/// cannot be reached at all, which no retry fixes and starting the server does. Recognised by
/// `queries::chain_pause_reason`.
pub const LOCAL_UNAVAILABLE_MARKER: &str = "LOCAL_MODEL_UNAVAILABLE::";

/// A task changed state. Payload: the chain id and the item as it now stands.
pub const ITEM_EVENT: &str = "hybrid:item";
/// A task is being written: live token count. Not stored anywhere.
pub const PROGRESS_EVENT: &str = "hybrid:progress";

/// One generation at a time on this machine, across every run in every window. Two runs feeding
/// one local server would each get half a GPU and twice the memory pressure; queueing is honest.
static LOCAL_GATE: Semaphore = Semaphore::const_new(1);

/// Each reference is cut to this many lines before the budget is even consulted — a reference is
/// for reading a signature or a pattern, not a second copy of a module.
const REFERENCE_MAX_LINES: usize = 400;
/// How much of a check's output travels in the report.
const CHECK_OUTPUT_MAX: usize = 6_000;
/// The report is the review step's context; [`queries`]'s handoff clamp is 60k characters, and a
/// report kept under it is never cut in the middle.
const REPORT_MAX: usize = 56_000;

#[derive(Clone, Serialize)]
struct ItemEvent {
    chain_id: String,
    item: HybridItem,
}

#[derive(Clone, Serialize)]
struct ProgressEvent {
    chain_id: String,
    item_id: String,
    /// Estimated tokens written so far.
    tokens: u64,
    elapsed_ms: u64,
}

/// What [`run`] needs from its caller.
pub struct Job<'a, R: Runtime> {
    pub app: &'a AppHandle<R>,
    pub db: &'a Db,
    pub chain_id: &'a str,
    /// The run's repositories, first one first. An item's empty `project_id` is the first.
    pub repos: &'a [RepoRef],
}

impl<R: Runtime> Job<'_, R> {
    /// Where an item, a reference or a check lives.
    fn repo(&self, project_id: &str) -> Option<&RepoRef> {
        if project_id.is_empty() {
            return self.repos.first();
        }
        self.repos.iter().find(|repo| repo.project_id == project_id).or_else(|| self.repos.first())
    }

    fn multi(&self) -> bool {
        self.repos.len() > 1
    }

    /// `file`, prefixed with its repository's name when the run has more than one.
    fn label(&self, project_id: &str, file: &str) -> String {
        match self.repo(project_id) {
            Some(repo) if self.multi() => format!("{}/{file}", repo.name),
            _ => file.to_string(),
        }
    }
}

/// What kind of failure an item's `error` is, stored beside it as `error_code`: the sentence is
/// English because the review model reads it, and the panel says the kind in the reader's language.
pub(crate) mod why {
    /// The file could not be resolved, read or written.
    pub const FILE: &str = "file";
    /// The plan's regions no longer match the file.
    pub const MOVED: &str = "moved";
    /// The task does not fit the local model's budget.
    pub const TOO_BIG: &str = "too-big";
    /// The server processed far fewer tokens than were sent.
    pub const CUT_PROMPT: &str = "cut-prompt";
    /// The server answered with an error.
    pub const SERVER: &str = "server";
    /// The answer could not be used: cut off, no code, a placeholder, code dropped, nothing changed.
    pub const ANSWER: &str = "answer";
    /// Somebody else wrote the file while the model worked.
    pub const CHANGED: &str = "changed";
    /// A task it depends on did not finish.
    pub const DEPENDENCY: &str = "dependency";
}

/// How one attempt at one task ended. Each failure carries its `why` code and the sentence.
enum Attempt {
    Applied { added: i64, removed: i64, hash_before: String, hash_after: String },
    /// Worth one more try, with this note to the model.
    Retry(&'static str, String),
    /// Not worth another local try; the review gets it.
    Escalate(&'static str, String),
    /// Failed for good (the server cut the prompt, the file is not text).
    Fail(&'static str, String),
    Cancelled,
    Unavailable(String),
}

fn log(line: &str) {
    if let Some(ctx) = ai_runs::current() {
        ai_runs::emit_line(&ctx, "stdout", line);
    }
}

fn stop_requested(rx: &Option<watch::Receiver<bool>>) -> bool {
    rx.as_ref().is_some_and(|rx| *rx.borrow()) || ai_runs::stopping()
}

fn emit_item<R: Runtime>(app: &AppHandle<R>, db: &Db, chain_id: &str, item_id: &str) {
    let item = db.0.lock().ok().and_then(|conn| hybrid_queries::get_item(&conn, item_id).ok().flatten());
    if let Some(item) = item {
        let _ = app.emit(ITEM_EVENT, ItemEvent { chain_id: chain_id.to_string(), item });
    }
}

fn backend_label(kind: BackendKind) -> &'static str {
    match kind {
        BackendKind::Bundled => "CodeFlow",
        BackendKind::Ollama => "Ollama",
        BackendKind::Openai => "OpenAI-compatible",
    }
}

fn kilo(tokens: i64) -> String {
    if tokens >= 1_000 {
        format!("{:.1}k", tokens as f64 / 1_000.0)
    } else {
        tokens.to_string()
    }
}

/// Runs the plan. `Ok` is the report the review reads (never empty); `Err` is a failure for the
/// chain — prefixed [`LOCAL_UNAVAILABLE_MARKER`] to pause it, or the cancel marker after a Stop.
pub async fn run<R: Runtime>(job: Job<'_, R>) -> Result<String, String> {
    let cancel_id = ai_runs::current().map(|ctx| ctx.run_id.clone()).unwrap_or_default();
    let mut rx = ai_runs::subscribe(&cancel_id);

    let run = {
        let conn = job.db.0.lock().map_err(|e| e.to_string())?;
        // A task left mid-request by a crash or a Stop is simply pending again.
        hybrid_queries::requeue_running_items(&conn, Some(job.chain_id)).map_err(|e| e.to_string())?;
        hybrid_queries::get_run(&conn, job.chain_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "This hybrid run has no configuration.".to_string())?
    };
    let kind = BackendKind::from_setting(&run.backend).unwrap_or(BackendKind::Ollama);
    if let Some(ctx) = ai_runs::current() {
        ai_runs::emit_engine(&ctx, "local-exec", backend_label(kind), &run.model, None);
    }

    // The baseline, before anything is written — and if it cannot be taken, nothing is written.
    // One per repository; a resumed run (or a correction round) finds the ones its first attempt took.
    let mut first_baseline = String::new();
    for repo in job.repos {
        let commit = crate::git::checkpoint::create_baseline(&repo.path, job.chain_id).map_err(|e| {
            format!("Couldn't snapshot {} before writing ({e}). Nothing was changed.", repo.name)
        })?;
        if first_baseline.is_empty() {
            first_baseline = commit;
        }
    }
    if run.baseline_commit.is_empty() && !first_baseline.is_empty() {
        if let Ok(conn) = job.db.0.lock() {
            let _ = hybrid_queries::set_baseline(&conn, job.chain_id, &first_baseline);
        }
    }

    let items = {
        let conn = job.db.0.lock().map_err(|e| e.to_string())?;
        hybrid_queries::list_items(&conn, job.chain_id).map_err(|e| e.to_string())?
    };
    let local: Vec<&HybridItem> = items
        .iter()
        .filter(|item| item.enabled && item.assignee == "local" && item.status == "pending")
        .collect();

    // Disabled tasks are recorded as such, so the report and the panel agree on what happened.
    {
        let conn = job.db.0.lock().map_err(|e| e.to_string())?;
        for item in items.iter().filter(|item| !item.enabled && item.status == "pending") {
            let _ = hybrid_queries::finish_item(
                &conn,
                &item.id,
                &ItemOutcome { status: "skipped".into(), ..Default::default() },
            );
        }
    }

    let started = Instant::now();
    if !local.is_empty() {
        // Queue behind any other run that has the local model.
        let _permit = match LOCAL_GATE.try_acquire() {
            Ok(permit) => permit,
            Err(_) => {
                log("Waiting: the local model is busy with another hybrid task.");
                tokio::select! {
                    biased;
                    _ = ai_runs::cancelled(&mut rx) => return Err(cancelled_error()),
                    permit = LOCAL_GATE.acquire() => permit.map_err(|e| e.to_string())?,
                }
            }
        };

        log(&format!("Connecting to {} · {} · context {}", backend_label(kind), run.model, run.ctx));
        let live = runtime::connect(kind, &run.base_url, &run.model, run.ctx as u32)
            .await
            .map_err(|e| format!("{LOCAL_UNAVAILABLE_MARKER}{e}"))?;
        if kind != BackendKind::Bundled {
            if let Err(failure) = local_llm::ping(&live.endpoint).await {
                return Err(format!("{LOCAL_UNAVAILABLE_MARKER}{}", failure.sentence()));
            }
        }
        let _presence: Vec<_> = job
            .repos
            .iter()
            .filter(|repo| local.iter().any(|item| job.repo(&item.project_id).is_some_and(|r| r.project_id == repo.project_id)))
            .map(|repo| crate::ai_locks::enter(&repo.path, &format!("Local model · {}", run.model)))
            .collect();

        for item in &local {
            if stop_requested(&rx) || chain_aborted(job.db, job.chain_id) {
                return Err(cancelled_error());
            }
            // Read again: an earlier task's outcome decides whether this one can run.
            let siblings = {
                let conn = job.db.0.lock().map_err(|e| e.to_string())?;
                hybrid_queries::list_items(&conn, job.chain_id).map_err(|e| e.to_string())?
            };
            if let Some(blocker) = unmet_dependency(item, &siblings) {
                if let Ok(conn) = job.db.0.lock() {
                    let _ = hybrid_queries::finish_item(
                        &conn,
                        &item.id,
                        &ItemOutcome {
                            status: "skipped".into(),
                            error: blocker.clone(),
                            error_code: why::DEPENDENCY.into(),
                            ..Default::default()
                        },
                    );
                }
                emit_item(job.app, job.db, job.chain_id, &item.id);
                log(&format!("· {} — skipped: {blocker}", item.file));
                continue;
            }

            if let Ok(conn) = job.db.0.lock() {
                let _ = hybrid_queries::mark_item_running(&conn, &item.id);
            }
            emit_item(job.app, job.db, job.chain_id, &item.id);
            log(&format!("▸ {} — {}", job.label(&item.project_id, &item.file), item.title));

            let outcome = run_item(&job, &run, kind, &live, item, &mut rx).await;
            let outcome = match outcome {
                Ok(outcome) => outcome,
                Err(Stop::Cancelled) => {
                    if let Ok(conn) = job.db.0.lock() {
                        let _ = hybrid_queries::requeue_running_items(&conn, Some(job.chain_id));
                    }
                    emit_item(job.app, job.db, job.chain_id, &item.id);
                    return Err(cancelled_error());
                }
                Err(Stop::Unavailable(reason)) => {
                    if let Ok(conn) = job.db.0.lock() {
                        let _ = hybrid_queries::requeue_running_items(&conn, Some(job.chain_id));
                    }
                    emit_item(job.app, job.db, job.chain_id, &item.id);
                    return Err(format!("{LOCAL_UNAVAILABLE_MARKER}{reason}"));
                }
            };
            if let Ok(conn) = job.db.0.lock() {
                let _ = hybrid_queries::finish_item(&conn, &item.id, &outcome);
            }
            emit_item(job.app, job.db, job.chain_id, &item.id);
            log(&match outcome.status.as_str() {
                "done" => format!(
                    "✓ {} (+{} −{}) · {}→{} tok · {} s",
                    item.file,
                    outcome.lines_added,
                    outcome.lines_removed,
                    kilo(outcome.tokens_in),
                    kilo(outcome.tokens_out),
                    outcome.ms / 1000
                ),
                "escalated" => format!("↗ {} — for the review: {}", item.file, outcome.error),
                _ => format!("✗ {} — {}", item.file, outcome.error),
            });
        }

        if run.unload {
            match kind {
                BackendKind::Ollama => local_llm::ollama_unload(&live.endpoint, &run.model).await,
                BackendKind::Bundled => {
                    drop(live);
                    crate::localai::executor::shutdown().await;
                }
                BackendKind::Openai => {}
            }
        }
    } else {
        log("No task was delegated to the local model; the review does them all.");
    }

    let checks = run_checks(&job, &run.approved_checks, &mut rx).await?;
    let items = {
        let conn = job.db.0.lock().map_err(|e| e.to_string())?;
        hybrid_queries::list_items(&conn, job.chain_id).map_err(|e| e.to_string())?
    };
    // A plan of a couple of easy tasks that the local model finished, with checks that ran and
    // passed, has nothing left a review would buy: the checks already said yes. Skipping it is the
    // difference between a small change costing the subscription one turn or two.
    if review_unneeded(&run, &items, &checks) {
        if let Ok(conn) = job.db.0.lock() {
            let _ = hybrid_queries::skip_review_step(&conn, job.chain_id, "small");
        }
        log("Small plan, every task done locally and every check passed: the review is skipped.");
    }
    Ok(report(&job, &run, kind, &items, &checks, started.elapsed().as_secs()))
}

/// Whether a finished round leaves nothing for a review to add. Never for a direct run (it has no
/// review to skip) or a correction round (the review asked for those fixes and checks them).
fn review_unneeded(run: &HybridRun, items: &[HybridItem], checks: &[CheckResult]) -> bool {
    if run.direct || run.fix_round > 0 || checks.is_empty() || !checks.iter().all(|check| check.passed) {
        return false;
    }
    let enabled: Vec<&HybridItem> = items.iter().filter(|item| item.enabled).collect();
    !enabled.is_empty()
        && enabled.len() <= 2
        && enabled.iter().all(|item| item.assignee == "local" && item.status == "done" && item.difficulty == "easy")
}

fn cancelled_error() -> String {
    format!("{}stopped", ai_runs::CANCELLED_MARKER)
}

fn chain_aborted(db: &Db, chain_id: &str) -> bool {
    db.0.lock()
        .ok()
        .and_then(|conn| {
            conn.query_row("SELECT status FROM agent_chains WHERE id = ?1", [chain_id], |row| row.get::<_, String>(0)).ok()
        })
        .is_some_and(|status| status == "aborted")
}

/// Why `item` cannot run yet, if it cannot: a task it depends on that the local model has not
/// finished — failed, skipped, or left for the review.
fn unmet_dependency(item: &HybridItem, all: &[HybridItem]) -> Option<String> {
    for key in &item.depends_on {
        let Some(dependency) = all.iter().find(|other| &other.task_key == key) else { continue };
        if dependency.status != "done" {
            return Some(format!("it depends on {} ({}), which is not done", dependency.task_key, dependency.file));
        }
    }
    None
}

enum Stop {
    Cancelled,
    Unavailable(String),
}

async fn run_item<R: Runtime>(
    job: &Job<'_, R>,
    run: &HybridRun,
    kind: BackendKind,
    live: &runtime::Live,
    item: &HybridItem,
    rx: &mut Option<watch::Receiver<bool>>,
) -> Result<ItemOutcome, Stop> {
    let started = Instant::now();
    let mut tokens = (0i64, 0i64);
    let mut note = String::new();
    let mut code = "";
    for attempt in 0..2 {
        let result = attempt_item(job, run, kind, live, item, &note, rx, &mut tokens).await;
        let ms = started.elapsed().as_millis() as i64;
        let base = ItemOutcome { tokens_in: tokens.0, tokens_out: tokens.1, ms, ..Default::default() };
        match result {
            Attempt::Applied { added, removed, hash_before, hash_after } => {
                return Ok(ItemOutcome {
                    status: "done".into(),
                    lines_added: added,
                    lines_removed: removed,
                    hash_before,
                    hash_after,
                    ..base
                });
            }
            Attempt::Retry(why, reason) if attempt == 0 => {
                log(&format!("  retrying {}: {reason}", item.file));
                note = reason;
                code = why;
            }
            Attempt::Retry(why, reason) | Attempt::Fail(why, reason) => {
                return Ok(ItemOutcome { status: "failed".into(), error: reason, error_code: why.into(), ..base });
            }
            Attempt::Escalate(why, reason) => {
                return Ok(ItemOutcome { status: "escalated".into(), error: reason, error_code: why.into(), ..base })
            }
            Attempt::Cancelled => return Err(Stop::Cancelled),
            Attempt::Unavailable(reason) => return Err(Stop::Unavailable(reason)),
        }
    }
    Ok(ItemOutcome {
        status: "failed".into(),
        error: note,
        error_code: code.into(),
        tokens_in: tokens.0,
        tokens_out: tokens.1,
        ms: started.elapsed().as_millis() as i64,
        ..Default::default()
    })
}

fn read_text(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read(path) {
        Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| "it is not a UTF-8 text file".to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// The references a task asked for, read now — after the tasks before it have written — and cut to
/// what a reference is for. A reference in another of the run's repositories is read from there.
fn references<R: Runtime>(job: &Job<'_, R>, item: &HybridItem) -> Vec<Reference> {
    let mut out = Vec::new();
    for reference in &item.context {
        let owner = reference.repo.as_deref().filter(|id| !id.is_empty()).unwrap_or(item.project_id.as_str());
        let Some(repo) = job.repo(owner) else { continue };
        let Ok(path) = crate::fsops::resolve_existing_for_write(&repo.path, &reference.file) else { continue };
        let Ok(Some(text)) = read_text(&path) else { continue };
        let lines: Vec<&str> = text.lines().collect();
        let (from, to) = match (reference.start_line, reference.end_line) {
            (Some(start), Some(end)) if start >= 1 => {
                let anchor = reference.first_line.as_deref().unwrap_or("");
                let located = if anchor.trim().is_empty() {
                    Ok(((start - 1) as usize, (end.max(start) - 1) as usize))
                } else {
                    apply::reanchor(&lines, start, end.max(start), anchor)
                };
                match located {
                    Ok((from, to)) => (from.min(lines.len()), to.min(lines.len().saturating_sub(1))),
                    Err(_) => continue,
                }
            }
            _ => (0, lines.len().saturating_sub(1)),
        };
        if lines.is_empty() || from > to {
            continue;
        }
        let to = to.min(from + REFERENCE_MAX_LINES - 1);
        let shown = job.label(owner, &reference.file);
        let label = if from == 0 && to + 1 == lines.len() {
            format!("{shown} — {}", reference.why.trim())
        } else {
            format!("{shown} (lines {}-{}) — {}", from + 1, to + 1, reference.why.trim())
        };
        out.push(Reference { label, file: reference.file.clone(), text: lines[from..=to].join("\n") });
    }
    out
}

#[allow(clippy::too_many_arguments)]
async fn attempt_item<R: Runtime>(
    job: &Job<'_, R>,
    run: &HybridRun,
    kind: BackendKind,
    live: &runtime::Live,
    item: &HybridItem,
    note: &str,
    rx: &mut Option<watch::Receiver<bool>>,
    tokens: &mut (i64, i64),
) -> Attempt {
    let Some(repo) = job.repo(&item.project_id) else {
        return Attempt::Fail(why::FILE, "Its repository is no longer part of this run.".into());
    };
    let root = repo.path.as_str();
    // Where the file is, through the same guard a save uses.
    let path: PathBuf = match item.action.as_str() {
        "create" => match crate::fsops::resolve_path_for_create(root, &item.file) {
            Ok(path) => path,
            // Something appeared there since the plan: it is a rewrite now.
            Err(_) => match crate::fsops::resolve_existing_for_write(root, &item.file) {
                Ok(path) => path,
                Err(e) => return Attempt::Fail(why::FILE, e),
            },
        },
        _ => match crate::fsops::resolve_existing_for_write(root, &item.file) {
            Ok(path) => path,
            Err(e) => return Attempt::Fail(why::FILE, e),
        },
    };
    let original = match read_text(&path) {
        Ok(text) => text,
        Err(e) => return Attempt::Fail(why::FILE, format!("{} can't be edited: {e}", item.file)),
    };
    let hash_before = apply::hash_text(original.as_deref());

    if item.action == "delete" {
        let removed = original.as_deref().map_or(0, |text| text.lines().count() as i64);
        if original.is_some() {
            if let Err(e) = std::fs::remove_file(&path) {
                return Attempt::Fail(why::FILE, e.to_string());
            }
        }
        return Attempt::Applied { added: 0, removed, hash_before, hash_after: String::new() };
    }

    let refs = references(job, item);
    let lines: Vec<&str> = original.as_deref().map(|text| text.lines().collect()).unwrap_or_default();
    let mut spans: Vec<(usize, usize)> = Vec::new();
    let targets: Vec<Target> = match (&original, item.regions.is_empty()) {
        (None, _) => vec![Target::Create],
        (Some(text), true) => vec![Target::Whole { text: text.as_str() }],
        (Some(_), false) => {
            for region in &item.regions {
                match apply::reanchor(&lines, region.start_line, region.end_line, &region.first_line) {
                    Ok(span) => spans.push(span),
                    Err(reason) => return Attempt::Escalate(why::MOVED, reason),
                }
            }
            spans.sort();
            if spans.windows(2).any(|pair| pair[0].1 >= pair[1].0) {
                return Attempt::Escalate(why::MOVED, "Its regions overlap now; the plan's line numbers no longer fit the file.".into());
            }
            let count = spans.len();
            spans
                .iter()
                .enumerate()
                .map(|(index, (start, end))| Target::Region {
                    text: "",
                    start: *start,
                    end: *end,
                    index,
                    count,
                })
                .collect()
        }
    };

    let mut replacements: Vec<(usize, usize, String)> = Vec::new();
    let mut whole: Option<String> = None;
    for target in &targets {
        // A region's text is sliced here so the borrow of `lines` stays local.
        let region_text: String;
        let target = match target {
            Target::Region { start, end, index, count, .. } => {
                region_text = lines[*start..=*end].join("\n");
                Target::Region { text: region_text.as_str(), start: *start, end: *end, index: *index, count: *count }
            }
            Target::Create => Target::Create,
            Target::Whole { text } => Target::Whole { text: *text },
        };
        let prompt = match prompts::executor_prompt(
            item,
            &target,
            &refs,
            &run.gate_note,
            note,
            run.budget_input.max(0) as u64,
            run.budget_output.max(0) as u64,
        ) {
            Ok(prompt) => prompt,
            Err(reason) => return Attempt::Escalate(why::TOO_BIG, reason),
        };
        if prompt.references_used < refs.len() {
            log(&format!("  {} of {} references fit the budget", prompt.references_used, refs.len()));
        }
        // Counted exactly where the server can count (llama.cpp's `/tokenize`); estimated otherwise.
        let sent = match local_llm::count_tokens(&live.endpoint, &format!("{}\n{}", prompts::EXECUTOR_SYSTEM, prompt.user)).await {
            Some(exact) if exact > run.budget_input.max(0) as u64 => {
                return Attempt::Escalate(
                    why::TOO_BIG,
                    format!("The task needs {exact} tokens and the local model's budget is {}.", run.budget_input),
                )
            }
            Some(exact) => exact,
            None => prompt.estimate,
        };

        let request = ChatRequest {
            model: &live.model,
            system: prompts::EXECUTOR_SYSTEM,
            user: &prompt.user,
            num_ctx: (kind == BackendKind::Ollama).then_some(run.ctx as u32),
            max_tokens: run.budget_output.max(256) as u32,
            temperature: 0.1,
            think: run.thinking.then_some(false),
            keep_alive: (kind == BackendKind::Ollama).then_some("10m"),
        };
        let _in_flight = live.engine.as_ref().map(|engine| engine.begin());
        let call_started = Instant::now();
        let mut written_chars = 0usize;
        let mut last_emit = Instant::now();
        let app = job.app.clone();
        let chain_id = job.chain_id.to_string();
        let item_id = item.id.clone();
        let answer = local_llm::chat(
            &live.endpoint,
            &request,
            |piece| {
                written_chars += piece.chars().count();
                if last_emit.elapsed().as_millis() >= 500 {
                    last_emit = Instant::now();
                    let _ = app.emit(
                        PROGRESS_EVENT,
                        ProgressEvent {
                            chain_id: chain_id.clone(),
                            item_id: item_id.clone(),
                            tokens: (written_chars as f64 / budget::CHARS_PER_TOKEN) as u64,
                            elapsed_ms: call_started.elapsed().as_millis() as u64,
                        },
                    );
                }
            },
            ai_runs::cancelled(rx),
        )
        .await;
        let outcome = match answer {
            Ok(outcome) => outcome,
            Err(LocalError::Cancelled) => return Attempt::Cancelled,
            Err(failure) if failure.is_unreachable() => return Attempt::Unavailable(failure.sentence()),
            Err(failure) => return Attempt::Retry(why::SERVER, failure.sentence()),
        };
        let prompt_tokens = outcome.prompt_tokens.unwrap_or(sent) as i64;
        let completion_tokens = outcome
            .completion_tokens
            .unwrap_or_else(|| budget::estimate_tokens(&outcome.text)) as i64;
        tokens.0 += prompt_tokens;
        tokens.1 += completion_tokens;
        crate::ai_usage::record(
            "local-exec",
            &run.model,
            crate::ai::task::HYBRID_EXECUTE,
            None,
            &crate::ai::AiUsage {
                input_tokens: prompt_tokens,
                output_tokens: completion_tokens,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                cost_usd: Some(0.0),
            },
        );

        if budget::truncated(sent, outcome.prompt_tokens) {
            return Attempt::Fail(
                why::CUT_PROMPT,
                format!(
                    "The server processed {} of ~{sent} tokens: it cut the prompt, so the answer can't be trusted. Raise the server's context.",
                    outcome.prompt_tokens.unwrap_or(0)
                ),
            );
        }
        if outcome.finish == Finish::Length {
            return Attempt::Retry(why::ANSWER, "Your answer was cut off at the length limit. Write only what was asked, completely.".into());
        }
        let code = match apply::extract_code(&outcome.text) {
            Ok(code) => code,
            Err(reason) => return Attempt::Retry(why::ANSWER, reason),
        };
        if let Some(line) = apply::lazy_marker(&code) {
            return Attempt::Retry(why::ANSWER, format!("You wrote a placeholder instead of code (`{line}`). Write every line."));
        }
        match target {
            Target::Region { text, start, end, .. } => {
                if apply::suspiciously_short(text, &code, &item.instruction) {
                    return Attempt::Retry(
                        why::ANSWER,
                        "Your answer dropped most of the region's existing code. Return the whole region.".into(),
                    );
                }
                replacements.push((start, end, code));
            }
            Target::Whole { text } => {
                if apply::suspiciously_short(text, &code, &item.instruction) {
                    return Attempt::Retry(
                        why::ANSWER,
                        "Your answer dropped most of the file's existing code. Return the whole file.".into(),
                    );
                }
                whole = Some(apply::conform(Some(text), &code));
            }
            Target::Create => whole = Some(apply::conform(None, &code)),
        }
    }

    let content = match (&original, whole) {
        (_, Some(content)) => content,
        (Some(text), None) => apply::splice(text, replacements),
        (None, None) => return Attempt::Fail(why::ANSWER, "Nothing was produced.".into()),
    };
    if original.as_deref() == Some(content.as_str()) {
        return Attempt::Retry(why::ANSWER, "You returned the code unchanged. Apply the instruction.".into());
    }
    // Nobody wrote the file while the model worked — a chat in the same repository, the user.
    match read_text(&path) {
        Ok(now) if apply::hash_text(now.as_deref()) != hash_before => {
            return Attempt::Retry(
                why::CHANGED,
                "The file changed on disk while the model was writing; it has been read again.".into(),
            );
        }
        Err(e) => return Attempt::Fail(why::FILE, e),
        _ => {}
    }
    if let Err(e) = apply::write_atomic(&path, &content) {
        return Attempt::Fail(why::FILE, format!("Couldn't write {}: {e}", item.file));
    }
    let (added, removed) = apply::line_stats(original.as_deref().unwrap_or(""), &content);
    Attempt::Applied { added, removed, hash_before, hash_after: apply::hash_text(Some(&content)) }
}

/// What one approved check printed.
struct CheckResult {
    command: String,
    passed: bool,
    output: String,
}

async fn run_checks<R: Runtime>(
    job: &Job<'_, R>,
    checks: &[PlanCheck],
    rx: &mut Option<watch::Receiver<bool>>,
) -> Result<Vec<CheckResult>, String> {
    use crate::commands::agents_cmd::{run_check_process, CheckEnd, CHECK_TIMEOUT};
    let mut out = Vec::new();
    for check in checks {
        let Some(repo) = job.repo(&check.repo) else { continue };
        let command = &check.command;
        let shown = if job.multi() { format!("{} $ {command}", repo.name) } else { format!("$ {command}") };
        log(&shown);
        let stop = Arc::new(Notify::new());
        let end = tokio::select! {
            biased;
            _ = ai_runs::cancelled(rx) => {
                stop.notify_waiters();
                return Err(cancelled_error());
            }
            end = run_check_process(command, &repo.path, CHECK_TIMEOUT, &stop) => end,
        };
        let (passed, output) = match end {
            CheckEnd::Exited { success, output } => (success, output),
            CheckEnd::TimedOut { output } => (false, format!("{output}\n[timed out]")),
            CheckEnd::Failed(reason) => (false, reason),
            CheckEnd::Stopped => return Err(cancelled_error()),
        };
        log(&format!("  {}", if passed { "passed" } else { "failed" }));
        let command = if job.multi() { format!("{}: {command}", repo.name) } else { command.clone() };
        out.push(CheckResult { command, passed, output: clamp(&output, CHECK_OUTPUT_MAX) });
    }
    Ok(out)
}

/// Head and tail, for output whose summary is at the end.
fn clamp(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.trim().chars().collect();
    if chars.len() <= max {
        return chars.into_iter().collect();
    }
    let head: String = chars[..max / 3].iter().collect();
    let tail: String = chars[chars.len() - max * 2 / 3..].iter().collect();
    format!("{head}\n…\n{tail}")
}

/// The execute step's answer: what the review reads. In a correction round, the round's own tasks
/// first and the earlier ones after, so the review starts from what it asked for.
fn report<R: Runtime>(job: &Job<'_, R>, run: &HybridRun, kind: BackendKind, items: &[HybridItem], checks: &[CheckResult], seconds: u64) -> String {
    let current: Vec<&HybridItem> = items.iter().filter(|item| item.round == run.fix_round).collect();
    let done = current.iter().filter(|i| i.status == "done").count();
    let local = current.iter().filter(|i| i.enabled && i.assignee == "local").count();
    let written: i64 = current.iter().map(|i| i.tokens_out).sum();
    let mut out = if run.fix_round > 0 {
        format!("## Local execution report — correction round {}\n", run.fix_round)
    } else {
        String::from("## Local execution report\n")
    };
    out.push_str(&format!(
        "{} · {} · context {} — {done} of {local} delegated task(s) done in {} min {} s, {} tokens written locally.\n",
        run.model,
        backend_label(kind),
        run.ctx,
        seconds / 60,
        seconds % 60,
        kilo(written)
    ));
    if !run.gate_note.trim().is_empty() {
        out.push_str(&format!("\nThe user's note at approval: {}\n", run.gate_note.trim()));
    }
    let line = |item: &HybridItem| {
        format!("- {} `{}` — {}: {}\n", item.task_key, job.label(&item.project_id, &item.file), item.title, prompts::status_word(item))
    };
    if run.fix_round > 0 {
        out.push_str(&format!("\n### Your corrections (round {})\n", run.fix_round));
        for item in &current {
            out.push_str(&line(item));
        }
        out.push_str("\n### Earlier tasks\n");
        for item in items.iter().filter(|item| item.round < run.fix_round) {
            out.push_str(&line(item));
        }
    } else {
        out.push_str("\n### Tasks\n");
        for item in items {
            out.push_str(&line(item));
        }
    }
    let mine = prompts::for_review(run, items);
    if !mine.is_empty() {
        out.push_str("\n### For you — implement these yourself\n");
        for item in mine {
            out.push_str(&format!(
                "\n#### {} `{}` ({}) — {}\n",
                item.task_key,
                job.label(&item.project_id, &item.file),
                item.action,
                item.title
            ));
            if item.status != "pending" && !item.error.is_empty() {
                out.push_str(&format!("Local attempt: {}\n", item.error));
            }
            out.push_str(&format!("{}\n", item.instruction.trim()));
            for line in &item.acceptance {
                out.push_str(&format!("- [ ] {line}\n"));
            }
        }
    }
    if !checks.is_empty() {
        out.push_str("\n### Checks\n");
        for check in checks {
            out.push_str(&format!(
                "`{}` — {}\n",
                check.command,
                if check.passed { "passed" } else { "FAILED" }
            ));
            if !check.passed && !check.output.is_empty() {
                out.push_str(&format!("```\n{}\n```\n", check.output));
            }
        }
    }
    // Every repository gets its share of what is left, so a large diff in one cannot push another
    // out of the report altogether.
    let room = REPORT_MAX.saturating_sub(out.len()).max(4_000);
    let share = (room / job.repos.len().max(1)).max(2_000);
    out.push_str("\n### Diff since the run started\n");
    for repo in job.repos {
        if job.multi() {
            out.push_str(&format!("\n#### {}\n", repo.name));
        }
        match crate::git::checkpoint::baseline_diff(&repo.path, job.chain_id, share) {
            Ok(diff) if !diff.trim().is_empty() => {
                out.push_str("```diff\n");
                out.push_str(&diff);
                out.push_str("\n```\n");
            }
            Ok(_) => out.push_str("No file has changed since the run started.\n"),
            Err(e) => out.push_str(&format!("(The diff could not be produced: {e})\n")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(key: &str, status: &str, depends: &[&str]) -> HybridItem {
        HybridItem {
            id: key.into(),
            chain_id: "c".into(),
            ord: 0,
            task_key: key.into(),
            title: key.into(),
            file: format!("{key}.ts"),
            action: "create".into(),
            regions: vec![],
            instruction: String::new(),
            context: vec![],
            acceptance: vec![],
            depends_on: depends.iter().map(|d| d.to_string()).collect(),
            difficulty: "easy".into(),
            assignee: "local".into(),
            enabled: true,
            status: status.into(),
            attempts: 0,
            error: String::new(),
            error_code: String::new(),
            tokens_in: 0,
            tokens_out: 0,
            ms: 0,
            lines_added: 0,
            lines_removed: 0,
            hash_before: String::new(),
            hash_after: String::new(),
            updated_at: String::new(),
            project_id: String::new(),
            round: 0,
        }
    }

    fn run_config(direct: bool, fix_round: i64) -> HybridRun {
        HybridRun {
            chain_id: "c".into(),
            backend: "ollama".into(),
            base_url: String::new(),
            model: "m".into(),
            ctx: 16_384,
            budget_input: 11_776,
            budget_output: 4_096,
            delegate: "medium".into(),
            on_fail: "review".into(),
            review_mode: "local".into(),
            unload: false,
            thinking: false,
            plan_summary: String::new(),
            plan_risks: vec![],
            checks: vec![],
            approved_checks: vec![],
            gate_note: String::new(),
            baseline_commit: String::new(),
            plan_input_tokens: 0,
            plan_output_tokens: 0,
            review_input_tokens: 0,
            review_output_tokens: 0,
            direct,
            fix_round,
            review_skip: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn check(passed: bool) -> CheckResult {
        CheckResult { command: "npm test".into(), passed, output: String::new() }
    }

    /// The review is skipped only when it has nothing left to add: a plan of at most two easy
    /// tasks, all done locally, with checks that ran and passed.
    #[test]
    fn a_small_plan_whose_checks_passed_needs_no_review() {
        let done = |key: &str| item(key, "done", &[]);
        let run = run_config(false, 0);
        assert!(review_unneeded(&run, &[done("t1"), done("t2")], &[check(true)]));
        assert!(!review_unneeded(&run, &[done("t1"), done("t2")], &[]), "no check, no verdict but the review's");
        assert!(!review_unneeded(&run, &[done("t1")], &[check(false)]));
        assert!(!review_unneeded(&run, &[done("t1"), done("t2"), done("t3")], &[check(true)]), "three tasks is not small");
        let mut medium = done("t1");
        medium.difficulty = "medium".into();
        assert!(!review_unneeded(&run, &[medium], &[check(true)]));
        let mut theirs = item("t1", "pending", &[]);
        theirs.assignee = "sub".into();
        assert!(!review_unneeded(&run, &[done("t2"), theirs], &[check(true)]), "a task for the review needs the review");
        assert!(!review_unneeded(&run_config(true, 0), &[done("t1")], &[check(true)]), "a direct run has no review to skip");
        assert!(!review_unneeded(&run_config(false, 1), &[done("t1")], &[check(true)]), "a correction round is checked by its review");
    }

    #[test]
    fn a_task_waits_on_what_it_depends_on() {
        let all = vec![item("t1", "failed", &[]), item("t2", "pending", &["t1"]), item("t3", "pending", &["t9"])];
        assert!(unmet_dependency(&all[1], &all).unwrap().contains("t1"));
        assert_eq!(unmet_dependency(&all[2], &all), None, "an unknown dependency blocks nothing");
        let done = vec![item("t1", "done", &[]), item("t2", "pending", &["t1"])];
        assert_eq!(unmet_dependency(&done[1], &done), None);
    }

    #[test]
    fn check_output_keeps_both_ends() {
        let text = format!("{}{}", "a".repeat(10_000), "THE ERROR");
        let clamped = clamp(&text, 300);
        assert!(clamped.ends_with("THE ERROR"));
        assert!(clamped.chars().count() < 320);
    }
}

/// Against a real Ollama, so ignored by default. Run with
/// `CODEFLOW_LIVE_OLLAMA=1 cargo test --lib -- --ignored --nocapture hybrid::execute::live`
/// while Ollama serves `qwen2.5-coder:7b`. Exercises the whole executor on a real repository: a new
/// file, a region rewritten in an existing one, a dependency, the report and the baseline diff.
#[cfg(test)]
mod live {
    use super::*;
    use crate::db::hybrid_queries;
    use crate::hybrid::plan::{Plan, PlanTask, Region};

    fn git(repo: &Path, args: &[&str]) {
        let status = std::process::Command::new("git").args(args).current_dir(repo).status().expect("git");
        assert!(status.success(), "git {args:?}");
    }

    #[tokio::test]
    #[ignore]
    async fn the_local_model_executes_a_plan_on_a_real_repository() {
        if std::env::var("CODEFLOW_LIVE_OLLAMA").is_err() {
            return;
        }
        let repo = std::env::temp_dir().join(format!("cf-hybrid-live-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(repo.join("src")).unwrap();
        let math = "export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function sub(a: number, b: number): number {\n  return a - b;\n}\n";
        std::fs::write(repo.join("src/math.ts"), math).unwrap();
        git(&repo, &["init", "-q"]);
        git(&repo, &["-c", "user.email=t@example.com", "-c", "user.name=t", "add", "."]);
        git(&repo, &["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init"]);

        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        let ws = crate::db::queries::create_workspace(&conn, "ws", "folder", "#fff").unwrap();
        let project = crate::db::queries::create_project(
            &conn,
            crate::db::models::NewProject {
                workspace_id: ws.id.clone(),
                name: "live".into(),
                local_path: repo.to_string_lossy().into_owned(),
                remote_url: None,
                color: "#fff".into(),
                icon: "folder".into(),
                ado_org: None,
                ado_project: None,
                ado_repo_id: None,
                github_owner: None,
                github_repo: None,
                github_host: None,
                gitlab_project: None,
                gitlab_host: None,
            },
        )
        .unwrap();
        let agent = crate::db::queries::upsert_workspace_agent(&conn, None, &ws.id, "A", "", "claude", "opus", "", true, None).unwrap();
        let budget = budget::budget_for(16_384);
        let run_config = hybrid_queries::HybridRun {
            chain_id: String::new(),
            backend: "ollama".into(),
            base_url: "http://127.0.0.1:11434".into(),
            model: "qwen2.5-coder:7b".into(),
            ctx: 16_384,
            budget_input: budget.input as i64,
            budget_output: budget.output as i64,
            delegate: "all".into(),
            on_fail: "review".into(),
            review_mode: "fix".into(),
            unload: false,
            thinking: false,
            plan_summary: String::new(),
            plan_risks: vec![],
            checks: vec![],
            approved_checks: vec![PlanCheck { repo: String::new(), command: "test -f src/csv.ts".into() }],
            gate_note: String::new(),
            baseline_commit: String::new(),
            plan_input_tokens: 0,
            plan_output_tokens: 0,
            review_input_tokens: 0,
            review_output_tokens: 0,
            direct: false,
            fix_round: 0,
            review_skip: String::new(),
            created_at: crate::db::queries::now(),
            updated_at: crate::db::queries::now(),
        };
        let detail = crate::db::queries::create_hybrid_chain(
            &conn,
            &[project.id.clone()],
            "Live",
            "Add CSV and clamp",
            &agent.id,
            &agent.id,
            "",
            false,
            &run_config,
            None,
        )
        .unwrap();
        let plan = Plan {
            summary: "A CSV helper and a clamp function.".into(),
            tasks: vec![
                PlanTask {
                    id: "t1".into(),
                    title: "CSV helper".into(),
                    repo: project.id.clone(),
                    file: "src/csv.ts".into(),
                    action: "create".into(),
                    regions: vec![],
                    instruction: "Create and export `toCsv(rows: string[][]): string`. Join the cells of each row with commas and the rows with \"\\n\". Wrap a cell in double quotes when it contains a comma, a double quote or a newline, doubling any double quote inside it.".into(),
                    context: vec![],
                    acceptance: vec!["exports toCsv".into()],
                    depends_on: vec![],
                    difficulty: "easy".into(),
                },
                PlanTask {
                    id: "t2".into(),
                    title: "clamp".into(),
                    repo: project.id.clone(),
                    file: "src/math.ts".into(),
                    action: "modify".into(),
                    regions: vec![Region { start_line: 5, end_line: 7, first_line: "export function sub(a: number, b: number): number {".into() }],
                    instruction: "Keep `sub` exactly as it is and add, right after it, `export function clamp(value: number, min: number, max: number): number` returning value limited to the range [min, max].".into(),
                    context: vec![],
                    acceptance: vec!["sub is unchanged".into(), "exports clamp".into()],
                    depends_on: vec!["t1".into()],
                    difficulty: "easy".into(),
                },
            ],
            checks: vec![],
            risks: vec![],
        };
        hybrid_queries::store_plan(&conn, &detail.chain.id, &plan, budget::Delegate::All).unwrap();
        let db = Db(std::sync::Mutex::new(conn));
        let app = tauri::test::mock_app();
        let repos = vec![RepoRef { project_id: project.id.clone(), name: "live".into(), path: repo.to_string_lossy().into_owned() }];
        let report = run(Job { app: app.handle(), db: &db, chain_id: &detail.chain.id, repos: &repos })
            .await
            .expect("the run completes");
        eprintln!("{report}");

        let csv = std::fs::read_to_string(repo.join("src/csv.ts")).expect("csv.ts written");
        assert!(csv.contains("toCsv"), "{csv}");
        let math_after = std::fs::read_to_string(repo.join("src/math.ts")).unwrap();
        assert!(math_after.contains("export function add(a: number, b: number): number {"), "the region's neighbours are untouched");
        assert!(math_after.contains("clamp"), "{math_after}");
        assert!(report.contains("Local execution report") && report.contains("Diff since the run started"));
        assert!(report.contains("`test -f src/csv.ts` — passed"), "{report}");
        let items = hybrid_queries::list_items(&db.0.lock().unwrap(), &detail.chain.id).unwrap();
        assert!(items.iter().all(|item| item.status == "done"), "{:?}", items.iter().map(|i| (&i.file, &i.status, &i.error)).collect::<Vec<_>>());
        assert!(items.iter().all(|item| item.tokens_out > 0 && !item.hash_after.is_empty()));
        std::fs::remove_dir_all(repo).ok();
    }
}
