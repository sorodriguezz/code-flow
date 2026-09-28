//! IPC surface for agent tasks — the work items the Agents view manages.
//!
//! Thin wrappers over `db::queries` and nothing else. **No engine is invoked from here**: a task's
//! turns go through `claude_cmd::send_chat_message` exactly like a chat turn, with the task's
//! agent passed as the `agent_*` override. That is deliberate — an agent task is a conversation
//! with a role attached, not a second way to run a CLI, and giving it its own runner would mean
//! two code paths that have to keep agreeing about checkpoints, MCP config and cancellation.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use tauri::State;
use tokio::io::AsyncReadExt;
use tokio::sync::Notify;

use crate::db::{
    models::{
        AgentChain, AgentProject, AgentTask, ChainClaim, ChainDetail, ChainStepBrief, ChainTemplate,
        GatedChain, HarvestOutcome, NewChainStep, NewStoryWorkItem, StepCheck,
    },
    queries, Db,
};

/// How long a step's check may run before it is treated as a failure.
///
/// Generous, because the checks worth writing are the slow ones — a test suite, a build — and a
/// bound that cut those short would push people towards checks that prove nothing. Bounded at all
/// because a command that hangs is a chain that hangs: there is no user watching an autonomous run
/// to notice that `npm test` is sitting on a prompt it will never be answered.
const CHECK_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// How long the output pipes are waited on once the check itself is over. A background process the
/// check left behind holds them open for as long as it lives, and a verdict must not wait on that.
const PIPE_DRAIN: Duration = Duration::from_secs(3);

/// Checks in flight, by step id: the chain each belongs to, and the signal that stops it.
///
/// The only way an abort can reach a check. The check is awaited inside a command the webview is
/// waiting on, and nothing else holds its process — so without a registry, aborting a plan left
/// its test suite running to the end (up to [`CHECK_TIMEOUT`]) in a tree the user had just
/// declared finished.
static RUNNING_CHECKS: LazyLock<Mutex<HashMap<String, (String, Arc<Notify>)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Removes a check from [`RUNNING_CHECKS`] however its command ends — returned, or dropped.
struct CheckRegistration(String);

impl CheckRegistration {
    fn new(step_id: &str, chain_id: &str, stop: Arc<Notify>) -> Self {
        if let Ok(mut map) = RUNNING_CHECKS.lock() {
            map.insert(step_id.to_string(), (chain_id.to_string(), stop));
        }
        CheckRegistration(step_id.to_string())
    }
}

impl Drop for CheckRegistration {
    fn drop(&mut self) {
        if let Ok(mut map) = RUNNING_CHECKS.lock() {
            map.remove(&self.0);
        }
    }
}

/// Stops every check a chain has running. `notify_one` rather than `notify_waiters`: it leaves a
/// permit behind, so an abort that lands in the instant between registering and waiting still
/// stops the check instead of being lost.
fn stop_checks_for_chain(chain_id: &str) {
    if let Ok(map) = RUNNING_CHECKS.lock() {
        for (owner, stop) in map.values() {
            if owner == chain_id {
                stop.notify_one();
            }
        }
    }
}

/// How a check's process ended.
#[derive(Debug)]
enum CheckEnd {
    Exited { success: bool, output: String },
    TimedOut { output: String },
    /// Stopped from outside — the plan was aborted or deleted.
    Stopped,
    /// It could not be started at all.
    Failed(String),
}

/// Reads one of a check's pipes to its end on a task of its own, so neither pipe can fill up and
/// stall the process while the other is being read.
fn drain<R: tokio::io::AsyncRead + Unpin + Send + 'static>(pipe: Option<R>) -> tokio::task::JoinHandle<Vec<u8>> {
    tokio::spawn(async move {
        let mut buffer = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut buffer).await;
        }
        buffer
    })
}

/// Signals a process group that has lost its leader. [`crate::ai_runs::kill_tree`] needs the
/// `Child`, which only knows its pid until it has been waited on; this is for what a finished check
/// left running behind it.
fn kill_group(pid: Option<u32>) {
    #[cfg(unix)]
    if let Some(pid) = pid {
        // SAFETY: `kill` takes only integers. The pid is the group id (`proc::own_process_group`),
        // and a group that has already emptied answers `ESRCH`, which is the outcome wanted anyway.
        unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
    }
    #[cfg(not(unix))]
    let _ = pid;
}

/// Runs one check command to its end, its timeout, or `stop` — whichever comes first — and makes
/// sure **nothing it started outlives it**.
///
/// The check is its own process group (`proc::own_process_group`), because what people write here
/// is `npm test` or `cargo test`: a shell that starts a runner that starts workers. The old
/// `timeout(cmd.output())` dropped the future on timeout and killed nothing at all — not even the
/// shell — so a hung suite kept its workers, its ports and its CPU for as long as it cared to, with
/// the chain long since moved on. Now a timeout or a stop takes the whole group down
/// ([`crate::ai_runs::kill_tree`]), and a check that exits on its own has its leftovers reaped too.
async fn run_check_process(command: &str, cwd: &str, timeout: Duration, stop: &Notify) -> CheckEnd {
    let mut cmd = if cfg!(windows) {
        let mut c = crate::proc::command("cmd");
        c.arg("/C").arg(command);
        c
    } else {
        let mut c = crate::proc::command("sh");
        c.arg("-c").arg(command);
        c
    };
    cmd.current_dir(cwd);
    // Never inherited: a check that reads stdin would block forever behind a terminal that does
    // not exist.
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    crate::proc::own_process_group(&mut cmd);
    // If this future is ever dropped mid-check (the app quitting), the shell at least goes with it.
    cmd.kill_on_drop(true);

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        // The command could not be started at all — a missing binary, an unreadable directory.
        Err(e) => return CheckEnd::Failed(format!("{command}: {e}")),
    };
    // Read now: `id()` answers `None` once the child has been waited on, and the group has to be
    // reachable after that.
    let pid = child.id();
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());

    enum Ending {
        Exited(bool),
        TimedOut,
        Stopped,
    }
    let ending = tokio::select! {
        status = child.wait() => Ending::Exited(status.map(|s| s.success()).unwrap_or(false)),
        _ = tokio::time::sleep(timeout) => Ending::TimedOut,
        _ = stop.notified() => Ending::Stopped,
    };
    match ending {
        Ending::Exited(_) => kill_group(pid),
        Ending::TimedOut | Ending::Stopped => crate::ai_runs::kill_tree(&mut child).await,
    }

    let collect = |task: tokio::task::JoinHandle<Vec<u8>>| async move {
        match tokio::time::timeout(PIPE_DRAIN, task).await {
            Ok(Ok(bytes)) => String::from_utf8_lossy(&bytes).into_owned(),
            _ => String::new(),
        }
    };
    let mut output = collect(stdout).await;
    let errors = collect(stderr).await;
    if !errors.trim().is_empty() {
        if !output.trim().is_empty() {
            output.push('\n');
        }
        output.push_str(&errors);
    }

    match ending {
        Ending::Exited(success) => CheckEnd::Exited { success, output },
        Ending::TimedOut => CheckEnd::TimedOut { output },
        Ending::Stopped => CheckEnd::Stopped,
    }
}

/// Runs one step's declared check in its own repository and reports what happened.
///
/// **Exit code 0 and nothing else.** No parsing of the output, no asking a model whether it thinks
/// it succeeded — the point of this whole mechanism is to introduce one fact into a chain that no
/// agent authored, and a verdict inferred from prose would not be one.
///
/// Through the platform shell on purpose: the checks people actually write are `npm test`,
/// `cargo test`, `make lint` — shell words, with the pipes and `&&` that go with them. That does
/// mean the command runs with the user's full privileges, which is the same bargain the rest of
/// this view already makes: the agents it runs edit the working copy directly.
#[tauri::command]
pub async fn run_chain_step_check(db: State<'_, Db>, step_id: String) -> Result<StepCheck, String> {
    // Read and release. The connection is behind a `Mutex` and the process below is awaited, so a
    // guard held across it would freeze every other command for as long as a test suite takes.
    let target = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::chain_step_check(&conn, &step_id).map_err(|e| e.to_string())?
    };
    let Some((chain_id, command, cwd)) = target else {
        return Ok(StepCheck { ran: false, passed: false, output: String::new() });
    };

    let stop = Arc::new(Notify::new());
    let _registered = CheckRegistration::new(&step_id, &chain_id, stop.clone());
    Ok(match run_check_process(&command, &cwd, CHECK_TIMEOUT, &stop).await {
        CheckEnd::Exited { success, output } => StepCheck { ran: true, passed: success, output },
        // What it printed before it hung goes with the verdict: "where did it stop" is the first
        // thing the next attempt needs to know.
        CheckEnd::TimedOut { output } => StepCheck {
            ran: true,
            passed: false,
            output: format!(
                "The check timed out after {} minutes.\n{output}",
                CHECK_TIMEOUT.as_secs() / 60
            )
            .trim_end()
            .to_string(),
        },
        // The plan was aborted under it. No verdict at all rather than a failed one: a failure
        // would send the plan back to an earlier step, and there is no plan left to send.
        CheckEnd::Stopped => StepCheck { ran: false, passed: false, output: String::new() },
        // Reported as a *failed* check rather than as an error, because a step whose verdict
        // cannot be taken has not been verified, and silently passing it is the one outcome that
        // would make the whole mechanism worse than not having it.
        CheckEnd::Failed(output) => StepCheck { ran: true, passed: false, output },
    })
}

#[tauri::command]
pub fn list_agent_tasks(db: State<Db>, workspace_id: String) -> Result<Vec<AgentTask>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::list_agent_tasks(&conn, &workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_agent_task(db: State<Db>, id: String) -> Result<Option<AgentTask>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::get_agent_task(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_agent_task(
    db: State<Db>,
    workspace_id: String,
    project_id: String,
    agent_id: String,
    agent_name: String,
    provider: String,
    model: String,
    prompt: String,
    goal: String,
    title: String,
    agent_project_id: String,
    account: Option<String>,
) -> Result<AgentTask, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::create_agent_task(
        &conn,
        &workspace_id,
        &project_id,
        &agent_id,
        &agent_name,
        &provider,
        &model,
        &prompt,
        &goal,
        &title,
        &agent_project_id,
        account.as_deref(),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_agent_task_run(
    db: State<Db>,
    id: String,
    status: String,
    model: String,
    turns: i64,
    last_error: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::update_agent_task_run(&conn, &id, &status, &model, turns, &last_error).map_err(|e| e.to_string())
}

/// Silently a no-op once the task has turns — the guard lives in the SQL so a stale UI cannot
/// move a task that has already touched a working tree.
#[tauri::command]
pub fn set_agent_task_project(db: State<Db>, id: String, project_id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::set_agent_task_project(&conn, &id, &project_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_agent_task(db: State<Db>, id: String, title: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::rename_agent_task(&conn, &id, &title).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_agent_task(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::delete_agent_task(&conn, &id).map_err(|e| e.to_string())
}

// ---------- chains ----------
//
// The scheduler lives here, not in the frontend. Every one of these holds the single
// `Mutex<Connection>` for its whole body, which is what makes a decision and the writes that
// record it atomic against every other command in the process — including a second chain, and
// including a hand-typed turn. The frontend's job is to carry out the decision it is handed.

#[tauri::command]
pub fn list_agent_chains(db: State<Db>, workspace_id: String) -> Result<Vec<AgentChain>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::list_agent_chains(&conn, &workspace_id).map_err(|e| e.to_string())
}

/// Every plan waiting on a human decision, across every workspace.
///
/// No `workspace_id` parameter, and that is the whole point — see [`queries::list_gated_chains`].
/// The status bar is one list for the whole app, so a gate parked in the workspace the user is not
/// standing in still has to be listed there; the row carries its own workspace and crosses back
/// into it when followed.
#[tauri::command]
pub fn list_gated_chains(db: State<Db>) -> Result<Vec<GatedChain>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::list_gated_chains(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_chain_detail(db: State<Db>, chain_id: String) -> Result<Option<ChainDetail>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::get_chain_detail(&conn, &chain_id).map_err(|e| e.to_string())
}

/// The repository set of a chain, deduplicated and in the order the user picked them.
///
/// A repository listed twice is one repository — the dialog cannot produce that, but a stale window
/// and a hand-made call both can, and `agent_chain_repos` would refuse the second insert while the
/// step expansion would happily have run everything twice.
fn repo_set(project_ids: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(project_ids.len());
    for id in project_ids {
        let id = id.trim();
        if !id.is_empty() && !out.iter().any(|kept| kept == id) {
            out.push(id.to_string());
        }
    }
    out
}

/// Refuses a plan longer than the cap here as well as in the dialog: the cap is what makes a
/// runaway impossible, and a limit enforced only in the UI is a limit a stale window can exceed.
///
/// Two caps now, because a step can say "every repository": [`queries::MAX_CHAIN_STEPS`] bounds what
/// was written and [`queries::MAX_CHAIN_ROWS`] bounds what it expands into.
#[tauri::command]
pub fn create_agent_chain(
    db: State<Db>,
    project_ids: Vec<String>,
    title: String,
    goal: String,
    steps: Vec<NewChainStep>,
    agent_project_id: String,
) -> Result<ChainDetail, String> {
    let project_ids = repo_set(&project_ids);
    if project_ids.is_empty() {
        return Err("chain.noRepos".to_string());
    }
    if project_ids.len() > queries::MAX_CHAIN_REPOS {
        return Err("chain.tooManyRepos".to_string());
    }
    if steps.is_empty() {
        return Err("chain.noSteps".to_string());
    }
    if steps.len() > queries::MAX_CHAIN_STEPS {
        return Err("chain.tooManySteps".to_string());
    }
    if queries::expanded_step_count(&steps, &project_ids) > queries::MAX_CHAIN_ROWS {
        return Err("chain.tooManySteps".to_string());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::create_agent_chain(&conn, &project_ids, &title, &goal, &steps, &agent_project_id)
        .map_err(|e| e.to_string())
}

/// A story run: one work item, N candidate repositories, and the two agents that will read it and
/// then write it.
///
/// The plan is fixed at 2N steps and is built in `queries` rather than sent from the dialog — the
/// instructions the two phases run under are the feature, not a form field, and a client that could
/// send its own would be a client that could quietly drop "do not edit any file" out of the analysis
/// pass.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn create_story_chain(
    db: State<Db>,
    project_ids: Vec<String>,
    title: String,
    notes: String,
    analyst_agent_id: String,
    implementer_agent_id: String,
    agent_project_id: String,
    work_item: NewStoryWorkItem,
) -> Result<ChainDetail, String> {
    let project_ids = repo_set(&project_ids);
    if project_ids.is_empty() {
        return Err("chain.noRepos".to_string());
    }
    // Half of `MAX_CHAIN_REPOS`' worth would still fit the row cap, but the repository cap is about
    // how long a run a person will actually watch, and a story run is two passes per repository.
    if project_ids.len() > queries::MAX_CHAIN_REPOS || project_ids.len() * 2 > queries::MAX_CHAIN_ROWS {
        return Err("chain.tooManyRepos".to_string());
    }
    if analyst_agent_id.trim().is_empty() || implementer_agent_id.trim().is_empty() {
        return Err("chain.agentNotRoutable".to_string());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::create_story_chain(
        &conn,
        &project_ids,
        &title,
        &notes,
        &analyst_agent_id,
        &implementer_agent_id,
        &agent_project_id,
        &work_item,
    )
    .map_err(|e| e.to_string())
}

/// Freezes what one step will be sent, ahead of the gate it sits behind. See
/// [`queries::set_chain_step_input`].
#[tauri::command]
pub fn set_chain_step_input(db: State<Db>, step_id: String, input: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::set_chain_step_input(&conn, &step_id, &input).map_err(|e| e.to_string())
}

/// Takes one step out of the plan, or puts it back. See [`queries::set_chain_step_skipped`].
#[tauri::command]
pub fn set_chain_step_skipped(db: State<Db>, step_id: String, skipped: bool) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::set_chain_step_skipped(&conn, &step_id, skipped).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn claim_next_chain_step(db: State<Db>, chain_id: String, run_id: String) -> Result<ChainClaim, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::claim_next_chain_step(&conn, &chain_id, &run_id).map_err(|e| e.to_string())
}

/// Records how a step ended, and — when it answered — files that answer into the chain's memory.
///
/// The note is written **after** the database has taken the outcome, and its failure is nobody's
/// problem: `agent_chain_steps.output_text` is the system of record, and the folder is a copy that
/// exists so the *next* agent can read it with its own tools. A repository that has gone read-only
/// must not turn a completed engine run into a failed one.
#[tauri::command]
pub fn complete_chain_step(
    db: State<Db>,
    step_id: String,
    outcome: String,
    output_text: String,
    reason: String,
) -> Result<Option<AgentChain>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    // Read before the write: `complete_chain_step` can send the plan backwards, and a backward jump
    // resets this step to `pending`, which would leave nothing to name the note after.
    let filed = queries::chain_step_note(&conn, &step_id).map_err(|e| e.to_string())?;
    let chain = queries::complete_chain_step(&conn, &step_id, &outcome, &output_text, &reason)
        .map_err(|e| e.to_string())?;

    if let (Some((chain_id, step_index, agent_name)), true) = (filed, !output_text.trim().is_empty()) {
        let repos = queries::chain_repo_paths(&conn, &chain_id).unwrap_or_default();
        let repo_name = queries::step_repo_name(&conn, &step_id).unwrap_or_default();
        crate::chain_memory::write_note(&chain_id, step_index, &agent_name, &repo_name, &output_text, &repos);
        // The plan is over: leave behind the one file that answers "what did all of this do?"
        // without opening eight of them.
        if chain.as_ref().is_some_and(|c| c.status == "done" || c.status == "failed") {
            if let Ok(sections) = queries::chain_summary_sections(&conn, &chain_id) {
                let title = chain.as_ref().map(|c| c.title.clone()).unwrap_or_default();
                crate::chain_memory::write_summary(&chain_id, &title, &sections, &repos);
            }
        }
    }
    Ok(chain)
}

/// Clears the gate a chain is parked at.
///
/// `step_id` is the step the caller was *looking at* when it decided to approve, and it is checked
/// against the step the chain is actually parked on. It is optional only because a client that has
/// no step id to offer cannot be wrong about one; every caller that draws a gate has it and should
/// send it. See [`queries::approve_chain_gate`] for what a mismatch costs.
#[tauri::command]
pub fn approve_chain_gate(
    db: State<Db>,
    chain_id: String,
    input: String,
    step_id: Option<String>,
) -> Result<Option<AgentChain>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    match queries::approve_chain_gate(&conn, &chain_id, &input, step_id.as_deref())
        .map_err(|e| e.to_string())?
    {
        queries::GateApproval::Approved(chain) => Ok(chain),
        // Loud, and with nothing written: the caller's screen is describing a moment that has
        // passed, and the honest thing is to say so and let it re-read rather than to act on it.
        queries::GateApproval::Moved => Err(queries::GATE_MOVED.to_string()),
    }
}

#[tauri::command]
pub fn skip_chain_step(db: State<Db>, chain_id: String) -> Result<Option<AgentChain>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::skip_chain_step(&conn, &chain_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn retry_chain_step(db: State<Db>, chain_id: String) -> Result<Option<AgentChain>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::retry_chain_step(&conn, &chain_id).map_err(|e| e.to_string())
}

/// "Do that again, but…" — the plan from one step onward, carrying the user's own words into it.
#[tauri::command]
pub fn rerun_chain_from(
    db: State<Db>,
    chain_id: String,
    step_index: i64,
    note: String,
) -> Result<Option<AgentChain>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::rerun_chain_from(&conn, &chain_id, step_index, &note).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn resume_chain(db: State<Db>, chain_id: String) -> Result<Option<AgentChain>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::resume_chain(&conn, &chain_id).map_err(|e| e.to_string())
}

/// Aborts the plan **and whatever check it has running**. The row first, so the check's own
/// verdict — which the stop makes it deliver at once — finds a chain that is already aborted and
/// moves nothing (see `queries::complete_chain_step`).
#[tauri::command]
pub fn abort_chain(db: State<Db>, chain_id: String) -> Result<Option<AgentChain>, String> {
    let chain = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::abort_chain(&conn, &chain_id).map_err(|e| e.to_string())?
    };
    stop_checks_for_chain(&chain_id);
    Ok(chain)
}

/// Arms (seconds since the epoch) or, with `0`, disarms a paused chain's automatic resume. See
/// [`queries::set_chain_resume_at`].
#[tauri::command]
pub fn set_chain_resume_at(db: State<Db>, chain_id: String, resume_at: i64) -> Result<Option<AgentChain>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::set_chain_resume_at(&conn, &chain_id, resume_at).map_err(|e| e.to_string())
}

/// One chain waiting on an automatic resume.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ScheduledResume {
    pub chain_id: String,
    /// Seconds since the epoch.
    pub resume_at: i64,
}

/// Every armed automatic resume, across every workspace — what the scheduler re-arms its timers
/// from after the webview reloads. See [`queries::list_scheduled_resumes`].
#[tauri::command]
pub fn list_scheduled_resumes(db: State<Db>) -> Result<Vec<ScheduledResume>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let rows = queries::list_scheduled_resumes(&conn).map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(|(chain_id, resume_at)| ScheduledResume { chain_id, resume_at }).collect())
}

/// Deletes the plan, the tasks its steps produced, and its memory.
///
/// **This is the only thing that erases a chain's notes.** They survive the plan finishing, the app
/// restarting and every step in between, because the point of them is to still be there when
/// somebody asks what happened. Deleting the chain is the user saying they are done asking.
#[tauri::command]
pub fn delete_chain(db: State<Db>, chain_id: String) -> Result<Vec<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    // Both read before the delete, which takes the rows they are read from.
    let orphans = queries::chain_task_ids(&conn, &chain_id).map_err(|e| e.to_string())?;
    let repos = queries::chain_repo_paths(&conn, &chain_id).unwrap_or_default();
    queries::delete_chain(&conn, &chain_id).map_err(|e| e.to_string())?;
    stop_checks_for_chain(&chain_id);
    crate::chain_memory::forget(&chain_id, &repos);
    // Handed back so the frontend can drop the same tasks out of its own list, rather than
    // discovering them missing on the next workspace load.
    Ok(orphans)
}

/// Polled for a step whose run outlived the webview. `None` means its turn has not landed yet.
#[tauri::command]
pub fn harvest_chain_step(db: State<Db>, step_id: String) -> Result<HarvestOutcome, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::harvest_chain_step(&conn, &step_id).map_err(|e| e.to_string())
}

/// "Carry on from here" — a chain seeded with a finished task as its first, already-done step.
#[tauri::command]
pub fn create_continuation_chain(
    db: State<Db>,
    source_task_id: String,
    title: String,
    goal: String,
    steps: Vec<NewChainStep>,
    agent_project_id: String,
) -> Result<ChainDetail, String> {
    if steps.is_empty() {
        return Err("chain.noSteps".to_string());
    }
    // The seed occupies one of them, so the cap counts it.
    if steps.len() + 1 > queries::MAX_CHAIN_STEPS {
        return Err("chain.tooManySteps".to_string());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::create_continuation_chain(&conn, &source_task_id, &title, &goal, &steps, &agent_project_id)
        .map_err(|e| e.to_string())
}

// ---------- chain templates ----------

#[tauri::command]
pub fn list_chain_templates(db: State<Db>, workspace_id: String) -> Result<Vec<ChainTemplate>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::list_chain_templates(&conn, &workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn upsert_chain_template(
    db: State<Db>,
    id: Option<String>,
    workspace_id: String,
    name: String,
    description: String,
    steps: Vec<NewChainStep>,
) -> Result<ChainTemplate, String> {
    if steps.len() > queries::MAX_CHAIN_STEPS {
        return Err("chain.tooManySteps".to_string());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::upsert_chain_template(&conn, id, &workspace_id, &name, &description, &steps).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_chain_template(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::delete_chain_template(&conn, &id).map_err(|e| e.to_string())
}

// ---------- agent projects ----------
//
// The folders the task tree is grouped by, and the four writers that file work into them. None of
// these runs anything: a folder is where a task is kept, never where it runs.

#[tauri::command]
pub fn list_agent_projects(db: State<Db>, workspace_id: String) -> Result<Vec<AgentProject>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::list_agent_projects(&conn, &workspace_id).map_err(|e| e.to_string())
}

/// Refuses a nameless folder here rather than only in the dialog: a row the tree can't label is one
/// the user can never find again. The message is a translation key — the frontend renders an
/// unrecognised reason verbatim, so it has to be something it can look up.
#[tauri::command]
pub fn upsert_agent_project(
    db: State<Db>,
    id: Option<String>,
    workspace_id: String,
    name: String,
    description: String,
    color: String,
) -> Result<AgentProject, String> {
    if name.trim().is_empty() {
        return Err("agents.projectNameRequired".to_string());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::upsert_agent_project(&conn, id.as_deref(), &workspace_id, &name, &description, &color)
        .map_err(|e| e.to_string())
}

/// Keeps everything the folder held; only the filing goes away.
#[tauri::command]
pub fn delete_agent_project(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::delete_agent_project(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reorder_agent_projects(db: State<Db>, ids: Vec<String>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::reorder_agent_projects(&conn, &ids).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_agent_task_group(db: State<Db>, id: String, agent_project_id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::set_agent_task_group(&conn, &id, &agent_project_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_agent_task_pinned(db: State<Db>, id: String, pinned: bool) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::set_agent_task_pinned(&conn, &id, pinned).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_chain_group(db: State<Db>, chain_id: String, agent_project_id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::set_chain_group(&conn, &chain_id, &agent_project_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_chain_pinned(db: State<Db>, chain_id: String, pinned: bool) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::set_chain_pinned(&conn, &chain_id, pinned).map_err(|e| e.to_string())
}

/// Every chain's steps at once, slim — what the task list needs to draw a chain as a group.
#[tauri::command]
pub fn list_workspace_chain_steps(
    db: State<Db>,
    workspace_id: String,
) -> Result<Vec<ChainStepBrief>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::list_workspace_chain_steps(&conn, &workspace_id).map_err(|e| e.to_string())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::Instant;

    fn alive(pid: i32) -> bool {
        // SAFETY: signal 0 only asks whether the process exists.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    /// Reaping is asynchronous — an orphan is collected by init shortly after it dies — so "gone"
    /// is polled for rather than asserted on the spot.
    async fn gone_within(pid: i32, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        while alive(pid) && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        !alive(pid)
    }

    fn scratch() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cf-check-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    async fn pid_in(file: &std::path::Path) -> i32 {
        // The script writes it a moment after starting; wait for the line to be there.
        for _ in 0..100 {
            if let Ok(text) = std::fs::read_to_string(file) {
                if let Ok(pid) = text.trim().parse() {
                    return pid;
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("the check never wrote its child's pid");
    }

    /// A check that hangs is killed at its timeout **with everything it started** — the old
    /// `timeout(cmd.output())` dropped the future and killed nothing, not even the shell.
    #[tokio::test]
    async fn a_check_that_times_out_takes_its_whole_tree_with_it() {
        let dir = scratch();
        let pidfile = dir.join("pid");
        let command = format!("sleep 30 & echo $! > '{}'; echo empezó; wait", pidfile.display());
        let started = Instant::now();
        let end = run_check_process(&command, &dir.to_string_lossy(), Duration::from_millis(600), &Notify::new()).await;

        match end {
            CheckEnd::TimedOut { output } => assert!(output.contains("empezó"), "what it printed is kept: {output}"),
            other => panic!("expected a timeout, got {other:?}"),
        }
        assert!(started.elapsed() < Duration::from_secs(10), "and it did not wait for the sleep");
        let pid = pid_in(&pidfile).await;
        assert!(gone_within(pid, Duration::from_secs(3)).await, "the sleep the check started is gone too");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Aborting the plan stops its check at once, grandchildren included.
    #[tokio::test]
    async fn a_stopped_check_is_killed_straight_away() {
        let dir = scratch();
        let pidfile = dir.join("pid");
        let command = format!("sleep 30 & echo $! > '{}'; wait", pidfile.display());
        let stop = Arc::new(Notify::new());
        let trigger = stop.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            trigger.notify_one();
        });
        let started = Instant::now();
        let end = run_check_process(&command, &dir.to_string_lossy(), Duration::from_secs(60), &stop).await;
        assert!(matches!(end, CheckEnd::Stopped), "got {end:?}");
        assert!(started.elapsed() < Duration::from_secs(10));
        let pid = pid_in(&pidfile).await;
        assert!(gone_within(pid, Duration::from_secs(3)).await);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A stop that arrives before the check has even started waiting is not lost.
    #[tokio::test]
    async fn a_stop_sent_before_the_check_waits_still_stops_it() {
        let dir = scratch();
        let stop = Notify::new();
        stop.notify_one();
        let end = run_check_process("sleep 30", &dir.to_string_lossy(), Duration::from_secs(60), &stop).await;
        assert!(matches!(end, CheckEnd::Stopped), "got {end:?}");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A check that finishes on its own reports its exit code and both streams — and whatever it
    /// left running in the background is reaped rather than kept alive holding the pipes.
    #[tokio::test]
    async fn a_finished_check_reports_its_verdict_and_leaves_nothing_behind() {
        let dir = scratch();
        let pidfile = dir.join("pid");
        let command = format!("sleep 30 & echo $! > '{}'; echo hola; echo mal >&2; exit 3", pidfile.display());
        let started = Instant::now();
        let end = run_check_process(&command, &dir.to_string_lossy(), Duration::from_secs(60), &Notify::new()).await;
        match end {
            CheckEnd::Exited { success, output } => {
                assert!(!success, "exit 3 is a failed check");
                assert!(output.contains("hola") && output.contains("mal"), "both streams: {output}");
            }
            other => panic!("expected an exit, got {other:?}"),
        }
        assert!(started.elapsed() < Duration::from_secs(10), "the background sleep did not hold the verdict");
        let pid = pid_in(&pidfile).await;
        assert!(gone_within(pid, Duration::from_secs(3)).await, "the leftover is reaped");

        let passed = run_check_process("true", &dir.to_string_lossy(), Duration::from_secs(60), &Notify::new()).await;
        assert!(matches!(passed, CheckEnd::Exited { success: true, .. }));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Only the aborted chain's checks are stopped — a registry that stopped every check would let
    /// one abort kill the verdict of an unrelated plan.
    #[test]
    fn stopping_a_chains_checks_leaves_the_others_running() {
        let mine = Arc::new(Notify::new());
        let theirs = Arc::new(Notify::new());
        let _a = CheckRegistration::new("step-a", "chain-a", mine.clone());
        let _b = CheckRegistration::new("step-b", "chain-b", theirs.clone());
        stop_checks_for_chain("chain-a");

        let runtime = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap();
        runtime.block_on(async {
            assert!(tokio::time::timeout(Duration::from_millis(50), mine.notified()).await.is_ok());
            assert!(tokio::time::timeout(Duration::from_millis(50), theirs.notified()).await.is_err());
        });
    }
}
