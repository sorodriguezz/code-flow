use tauri::{AppHandle, State};

use crate::ado;
use crate::claude;
use crate::db::{queries, Db};
use crate::git;
use crate::secrets;

fn ado_link(project: &crate::db::models::Project) -> Result<(String, String, String), String> {
    match (
        project.ado_org.clone(),
        project.ado_project.clone(),
        project.ado_repo_id.clone(),
    ) {
        (Some(org), Some(ado_project), Some(repo_id)) => Ok((org, ado_project, repo_id)),
        _ => Err("This project isn't linked to an Azure DevOps repository yet".to_string()),
    }
}

fn pat_for_org(org: &str) -> Result<String, String> {
    secrets::get_secret(&secrets::ado_pat_key(org))?
        .ok_or_else(|| format!("No Azure DevOps token saved for organization \"{org}\" — connect it in Settings first"))
}

#[tauri::command]
pub async fn ado_list_projects(org: String) -> Result<Vec<ado::AdoProject>, String> {
    let pat = pat_for_org(&org)?;
    ado::list_projects(&org, &pat).await
}

#[tauri::command]
pub async fn ado_list_repos(org: String, project: String) -> Result<Vec<ado::AdoRepo>, String> {
    let pat = pat_for_org(&org)?;
    ado::list_repos(&org, &project, &pat).await
}

#[tauri::command]
pub fn link_project_ado(
    db: State<Db>,
    id: String,
    ado_org: String,
    ado_project: String,
    ado_repo_id: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::link_project_ado(&conn, &id, &ado_org, &ado_project, &ado_repo_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn unlink_project_ado(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::unlink_project_ado(&conn, &id).map_err(|e| e.to_string())
}

fn load_project(db: &State<'_, Db>, project_id: &str) -> Result<crate::db::models::Project, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::get_project(&conn, project_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Project not found".to_string())
}

#[tauri::command]
pub async fn list_pull_requests(
    db: State<'_, Db>,
    project_id: String,
) -> Result<Vec<ado::PullRequestSummary>, String> {
    let project = load_project(&db, &project_id)?;
    let (org, ado_project, repo_id) = ado_link(&project)?;
    let pat = pat_for_org(&org)?;
    ado::list_pull_requests(&org, &ado_project, &repo_id, &pat).await
}

#[tauri::command]
pub async fn review_pull_request(app: AppHandle, db: State<'_, Db>, project_id: String, pr_id: i64) -> Result<String, String> {
    let project = load_project(&db, &project_id)?;
    let (org, ado_project, repo_id) = ado_link(&project)?;
    let pat = pat_for_org(&org)?;

    let (contexts, binary, model, tools_setting) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let contexts = queries::list_review_contexts(&conn, &project_id).map_err(|e| e.to_string())?;
        let binary = queries::get_setting(&conn, "claude_binary_path")
            .map_err(|e| e.to_string())?
            .unwrap_or_else(|| "claude".to_string());
        let model = queries::get_setting(&conn, "claude_model")
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        let tools = queries::get_setting(&conn, "claude_allowed_tools")
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        (contexts, binary, model, tools)
    };

    let prs = ado::list_pull_requests(&org, &ado_project, &repo_id, &pat).await?;
    let pr = prs
        .into_iter()
        .find(|p| p.id == pr_id)
        .ok_or_else(|| "Pull request not found".to_string())?;

    // Best-effort — if the fetch fails (offline, auth hiccup) we still try to diff
    // against whatever refs are already local rather than blocking the review outright.
    let _ = crate::remote::fetch(app, project.local_path.clone(), None).await;

    let diff_files = git::diff::get_branch_diff(&project.local_path, &pr.target_branch, &pr.source_branch)?;
    let diff_text = git::diff::render_diff_for_prompt(&diff_files);

    let enabled_contexts: Vec<(String, String)> = contexts
        .into_iter()
        .filter(|c| c.enabled)
        .map(|c| (c.name, c.content))
        .collect();
    let allowed_tools: Vec<String> = tools_setting
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    claude::review_pull_request(
        &binary,
        &model,
        &pr.title,
        &pr.description,
        &enabled_contexts,
        &diff_text,
        &allowed_tools,
        &project.local_path,
    )
    .await
}

#[tauri::command]
pub async fn post_pr_review_comment(db: State<'_, Db>, project_id: String, pr_id: i64, content: String) -> Result<(), String> {
    let project = load_project(&db, &project_id)?;
    let (org, ado_project, repo_id) = ado_link(&project)?;
    let pat = pat_for_org(&org)?;
    ado::post_pr_comment(&org, &ado_project, &repo_id, pr_id, &content, &pat).await
}
