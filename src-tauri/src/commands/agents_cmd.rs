//! IPC surface for agent tasks — the work items the Agents view manages.
//!
//! Thin wrappers over `db::queries` and nothing else. **No engine is invoked from here**: a task's
//! turns go through `claude_cmd::send_chat_message` exactly like a chat turn, with the task's
//! agent passed as the `agent_*` override. That is deliberate — an agent task is a conversation
//! with a role attached, not a second way to run a CLI, and giving it its own runner would mean
//! two code paths that have to keep agreeing about checkpoints, MCP config and cancellation.

use tauri::State;

use crate::db::{
    models::{
        AgentChain, AgentProject, AgentTask, ChainClaim, ChainDetail, ChainStepBrief, ChainTemplate,
        NewChainStep,
    },
    queries, Db,
};

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

#[tauri::command]
pub fn get_chain_detail(db: State<Db>, chain_id: String) -> Result<Option<ChainDetail>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::get_chain_detail(&conn, &chain_id).map_err(|e| e.to_string())
}

/// Refuses a plan longer than the cap here as well as in the dialog: the cap is what makes a
/// runaway impossible, and a limit enforced only in the UI is a limit a stale window can exceed.
#[tauri::command]
pub fn create_agent_chain(
    db: State<Db>,
    project_id: String,
    title: String,
    goal: String,
    steps: Vec<NewChainStep>,
    agent_project_id: String,
) -> Result<ChainDetail, String> {
    if steps.is_empty() {
        return Err("chain.noSteps".to_string());
    }
    if steps.len() > queries::MAX_CHAIN_STEPS {
        return Err("chain.tooManySteps".to_string());
    }
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::create_agent_chain(&conn, &project_id, &title, &goal, &steps, &agent_project_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn claim_next_chain_step(db: State<Db>, chain_id: String, run_id: String) -> Result<ChainClaim, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::claim_next_chain_step(&conn, &chain_id, &run_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn complete_chain_step(
    db: State<Db>,
    step_id: String,
    outcome: String,
    output_text: String,
    reason: String,
) -> Result<Option<AgentChain>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::complete_chain_step(&conn, &step_id, &outcome, &output_text, &reason).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn approve_chain_gate(db: State<Db>, chain_id: String, input: String) -> Result<Option<AgentChain>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::approve_chain_gate(&conn, &chain_id, &input).map_err(|e| e.to_string())
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

#[tauri::command]
pub fn resume_chain(db: State<Db>, chain_id: String) -> Result<Option<AgentChain>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::resume_chain(&conn, &chain_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn abort_chain(db: State<Db>, chain_id: String) -> Result<Option<AgentChain>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::abort_chain(&conn, &chain_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_chain(db: State<Db>, chain_id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::delete_chain(&conn, &chain_id).map_err(|e| e.to_string())
}

/// Polled for a step whose run outlived the webview. `None` means its turn has not landed yet.
#[tauri::command]
pub fn harvest_chain_step(db: State<Db>, step_id: String) -> Result<Option<AgentChain>, String> {
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
