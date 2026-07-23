use serde::Serialize;
use tauri::State;

use crate::claude;
use crate::commands::ado_cmd::build_mcp_config;
use crate::commands::skills_cmd::sync_skills_into_project;
use crate::db::{queries, Db};
use crate::git;

#[derive(Serialize)]
pub struct ChatReply {
    text: String,
    session_id: Option<String>,
    /// Model that actually answered this turn, when the CLI reported one — shown as-is in the
    /// chat's "who am I talking to" chip. `None` falls back to the configured setting there.
    model: Option<String>,
}

#[tauri::command]
pub async fn generate_commit_message(db: State<'_, Db>, diff: String) -> Result<String, String> {
    let (binary, template) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let binary = queries::get_setting(&conn, "claude_binary_path").map_err(|e| e.to_string())?;
        let template = queries::get_setting(&conn, "claude_commit_template").map_err(|e| e.to_string())?;
        (binary, template)
    };
    let binary = binary.unwrap_or_else(|| "claude".to_string());
    let template = template.unwrap_or_default();
    claude::generate_commit_message(&binary, &diff, &template).await
}

#[tauri::command]
pub fn default_commit_template() -> String {
    claude::DEFAULT_COMMIT_TEMPLATE.to_string()
}

#[tauri::command]
pub fn default_review_template() -> String {
    claude::DEFAULT_REVIEW_PROMPT.to_string()
}

#[tauri::command]
pub fn default_analyze_template() -> String {
    claude::DEFAULT_ANALYZE_TEMPLATE.to_string()
}

/// Scans whatever's currently sitting in the working directory (the "Changes" list —
/// unstaged + untracked, not what's already staged) for bugs/vulnerabilities before the
/// user commits it. Folds in the same workspace-level context/instructions/skills/MCPs as
/// a PR review, just pointed at the local diff instead of a pull request.
#[tauri::command]
pub async fn analyze_working_changes(db: State<'_, Db>, project_id: String, job_id: String) -> Result<String, String> {
    let project = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::get_project(&conn, &project_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Project not found".to_string())?
    };
    let workspace_id = project.workspace_id.clone();

    let (contexts, md_files, mcps, binary, model, tools_setting, analyze_template) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let contexts = queries::list_review_contexts(&conn, &workspace_id).map_err(|e| e.to_string())?;
        let md_files = queries::list_workspace_md_files(&conn, &workspace_id).map_err(|e| e.to_string())?;
        let mcps = queries::list_workspace_mcps(&conn, &workspace_id).map_err(|e| e.to_string())?;
        let binary = queries::get_setting(&conn, "claude_binary_path")
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| "claude".to_string());
        let model = queries::get_setting(&conn, "claude_model")
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        let tools = queries::get_setting(&conn, "claude_allowed_tools")
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        let analyze_template = queries::get_setting(&conn, "claude_analyze_template")
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        (contexts, md_files, mcps, binary, model, tools, analyze_template)
    };

    // Best-effort, same as the PR review path — a missing/unwritable skills dir shouldn't
    // block the analysis itself.
    let _ = sync_skills_into_project(&workspace_id, &project.local_path);

    let diff_files = git::diff::get_working_diff(&project.local_path)?;
    let diff_text = git::diff::render_diff_for_prompt(&diff_files);

    let mut enabled_contexts: Vec<(String, String)> = contexts
        .into_iter()
        .filter(|c| c.enabled)
        .map(|c| (c.name, c.content))
        .collect();
    enabled_contexts.extend(md_files.into_iter().filter(|f| f.enabled).map(|f| (f.filename, f.content)));

    let allowed_tools: Vec<String> = tools_setting
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    let mcp_config_path = build_mcp_config(&mcps, &workspace_id)?;

    let result = claude::analyze_changes(
        &binary,
        &model,
        &enabled_contexts,
        &diff_text,
        &allowed_tools,
        &project.local_path,
        &analyze_template,
        mcp_config_path.as_deref(),
    )
    .await;

    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let _ = match &result {
            Ok(text) => queries::add_job_history(&conn, &job_id, &project_id, "analyze-changes", "Análisis de cambios", "done", Some(text), None, "{}"),
            Err(e) => queries::add_job_history(&conn, &job_id, &project_id, "analyze-changes", "Análisis de cambios", "error", None, Some(e), "{}"),
        };
    }

    result
}

/// Asks Claude to apply one finding's fix (from a PR review or a pre-commit analysis)
/// directly to the working tree — `finding_prompt` is the finding's location/why/suggestion,
/// pre-formatted by the frontend from the already-parsed finding. Leaves the result as
/// uncommitted changes; nothing here stages, commits, or pushes anything.
#[tauri::command]
pub async fn resolve_finding_with_ai(db: State<'_, Db>, project_id: String, finding_prompt: String) -> Result<String, String> {
    let project = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::get_project(&conn, &project_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Project not found".to_string())?
    };
    let (binary, model) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let binary = queries::get_setting(&conn, "claude_binary_path")
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| "claude".to_string());
        let model = queries::get_setting(&conn, "claude_model").map_err(|e| e.to_string())?.unwrap_or_default();
        (binary, model)
    };

    claude::apply_finding_fix(&binary, &model, &finding_prompt, &project.local_path).await
}

/// Open-ended chat about the project — "preguntas abiertas del repositorio", the free-text
/// half of the AI panel alongside PR review and change analysis. `session_id` is `None` for a
/// brand new conversation and whatever the previous call returned for every turn after that,
/// so Claude Code resumes the same session instead of losing prior context each message.
#[tauri::command]
pub async fn send_chat_message(
    db: State<'_, Db>,
    project_id: String,
    message: String,
    session_id: Option<String>,
) -> Result<ChatReply, String> {
    let project = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::get_project(&conn, &project_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Project not found".to_string())?
    };
    let workspace_id = project.workspace_id.clone();

    let (contexts, md_files, mcps, binary, model, tools_setting) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let contexts = queries::list_review_contexts(&conn, &workspace_id).map_err(|e| e.to_string())?;
        let md_files = queries::list_workspace_md_files(&conn, &workspace_id).map_err(|e| e.to_string())?;
        let mcps = queries::list_workspace_mcps(&conn, &workspace_id).map_err(|e| e.to_string())?;
        let binary = queries::get_setting(&conn, "claude_binary_path")
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| "claude".to_string());
        let model = queries::get_setting(&conn, "claude_model")
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        let tools = queries::get_setting(&conn, "claude_allowed_tools")
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        (contexts, md_files, mcps, binary, model, tools)
    };

    let _ = sync_skills_into_project(&workspace_id, &project.local_path);

    let mut enabled_contexts: Vec<(String, String)> = contexts
        .into_iter()
        .filter(|c| c.enabled)
        .map(|c| (c.name, c.content))
        .collect();
    enabled_contexts.extend(md_files.into_iter().filter(|f| f.enabled).map(|f| (f.filename, f.content)));

    let allowed_tools: Vec<String> = tools_setting
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    let mcp_config_path = build_mcp_config(&mcps, &workspace_id)?;

    let run = claude::chat_with_repo(
        &binary,
        &model,
        &enabled_contexts,
        &message,
        session_id.as_deref(),
        &allowed_tools,
        &project.local_path,
        mcp_config_path.as_deref(),
    )
    .await?;

    if let Some(sid) = &run.session_id {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let _ = queries::add_activity_log(&conn, &project_id, sid, &message, &run.text);
    }

    Ok(ChatReply { text: run.text, session_id: run.session_id, model: run.model })
}
