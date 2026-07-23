use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::ado;
use crate::claude;
use crate::commands::skills_cmd;
use crate::db::{models::WorkspaceMcp, queries, Db};
use crate::git;
use crate::paths;
use crate::secrets;

/// Builds a `--mcp-config` JSON file for whichever of a workspace's MCP servers are
/// enabled — persisted under the workspace's own CodeFlow folder rather than a tempfile so
/// it's easy to find/inspect, and gets overwritten on every review anyway.
pub(crate) fn build_mcp_config(mcps: &[WorkspaceMcp], workspace_id: &str) -> Result<Option<String>, String> {
    let enabled: Vec<&WorkspaceMcp> = mcps.iter().filter(|m| m.enabled).collect();
    if enabled.is_empty() {
        return Ok(None);
    }

    let mut servers = serde_json::Map::new();
    for mcp in enabled {
        let args: Vec<String> = mcp.args.split_whitespace().map(|s| s.to_string()).collect();
        let mut env = serde_json::Map::new();
        for line in mcp.env.lines() {
            if let Some((key, value)) = line.split_once('=') {
                env.insert(key.trim().to_string(), serde_json::Value::String(value.trim().to_string()));
            }
        }
        servers.insert(
            mcp.name.clone(),
            serde_json::json!({ "command": mcp.command, "args": args, "env": env }),
        );
    }

    let config = serde_json::json!({ "mcpServers": servers });
    let path = paths::base_dir().join("workspaces").join(workspace_id).join("mcp.json");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status")]
pub enum AutoLinkResult {
    /// Detected an Azure Repos remote and a PAT for its org was already saved — linked
    /// automatically, no user action needed.
    Linked { project: crate::db::models::Project },
    /// Detected an Azure Repos remote, but no PAT is saved for that org yet.
    NeedsToken { org: String },
    /// The remote isn't an Azure Repos URL (or there's no remote at all) — falls back to
    /// manual linking.
    NotDetected,
}

/// Called once per project when its Pull Requests section first needs data: tries to
/// derive the Azure DevOps org/project/repo straight from the local repo's own remote URL
/// instead of making the user hunt through dropdowns for something git already knows.
///
/// Reads the remote straight from the repo's actual git config rather than the `projects`
/// table's `remote_url` column — that column is only populated at "Clone repository" time,
/// so a repo added via "Add a local repository" (or one whose origin changed since) would
/// otherwise never be detectable even though `git remote -v` has the answer right there.
#[tauri::command]
pub fn auto_link_project_ado(db: State<Db>, project_id: String) -> Result<AutoLinkResult, String> {
    let project = load_project(&db, &project_id)?;
    if ado_link(&project).is_ok() {
        return Ok(AutoLinkResult::Linked { project });
    }
    let remotes = git::remotes::list_remotes(&project.local_path)?;
    let remote_url = remotes
        .iter()
        .find(|r| r.name == "origin")
        .or_else(|| remotes.first())
        .map(|r| r.url.as_str());
    let Some(remote_url) = remote_url else {
        return Ok(AutoLinkResult::NotDetected);
    };
    let Some(detected) = ado::detect_from_remote_url(remote_url) else {
        return Ok(AutoLinkResult::NotDetected);
    };
    let has_token = secrets::get_secret(&secrets::ado_pat_key(&detected.org))?.is_some();
    if !has_token {
        return Ok(AutoLinkResult::NeedsToken { org: detected.org });
    }

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::link_project_ado(&conn, &project_id, &detected.org, &detected.project, &detected.repo)
        .map_err(|e| e.to_string())?;
    let linked = queries::get_project(&conn, &project_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Project not found".to_string())?;
    Ok(AutoLinkResult::Linked { project: linked })
}

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

/// Existing PR comment threads — e.g. from a human reviewer — so they can be shown alongside
/// CodeFlow's own AI findings and resolved with AI the same way.
#[tauri::command]
pub async fn list_pr_comment_threads(
    db: State<'_, Db>,
    project_id: String,
    pr_id: i64,
) -> Result<Vec<ado::PrCommentThread>, String> {
    let project = load_project(&db, &project_id)?;
    let (org, ado_project, repo_id) = ado_link(&project)?;
    let pat = pat_for_org(&org)?;
    ado::list_pr_comment_threads(&org, &ado_project, &repo_id, pr_id, &pat).await
}

#[tauri::command]
pub async fn review_pull_request(
    app: AppHandle,
    db: State<'_, Db>,
    project_id: String,
    pr_id: i64,
    job_id: String,
) -> Result<String, String> {
    let project = load_project(&db, &project_id)?;
    let (org, ado_project, repo_id) = ado_link(&project)?;
    let pat = pat_for_org(&org)?;
    let workspace_id = project.workspace_id.clone();

    let (contexts, md_files, mcps, binary, model, tools_setting, review_template) = {
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
        let review_template = queries::get_setting(&conn, "claude_review_template")
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        (contexts, md_files, mcps, binary, model, tools, review_template)
    };

    let prs = ado::list_pull_requests(&org, &ado_project, &repo_id, &pat).await?;
    let pr = prs
        .into_iter()
        .find(|p| p.id == pr_id)
        .ok_or_else(|| "Pull request not found".to_string())?;

    // Best-effort — if the fetch fails (offline, auth hiccup) we still try to diff
    // against whatever refs are already local rather than blocking the review outright.
    let _ = crate::remote::fetch(app, project.local_path.clone(), None).await;

    // Also best-effort: skills are a nice-to-have for the review, not a precondition —
    // don't block the review if e.g. the project directory is read-only.
    let _ = skills_cmd::sync_skills_into_project(&workspace_id, &project.local_path);

    let diff_files = git::diff::get_branch_diff(&project.local_path, &pr.target_branch, &pr.source_branch)?;
    let diff_text = git::diff::render_diff_for_prompt(&diff_files);

    let mut enabled_contexts: Vec<(String, String)> = contexts
        .into_iter()
        .filter(|c| c.enabled)
        .map(|c| (c.name, c.content))
        .collect();
    enabled_contexts.extend(
        md_files
            .into_iter()
            .filter(|f| f.enabled)
            .map(|f| (f.filename, f.content)),
    );

    let allowed_tools: Vec<String> = tools_setting
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    let mcp_config_path = build_mcp_config(&mcps, &workspace_id)?;

    let result = claude::review_pull_request(
        &binary,
        &model,
        &pr.title,
        &pr.description,
        &enabled_contexts,
        &diff_text,
        &allowed_tools,
        &project.local_path,
        &review_template,
        mcp_config_path.as_deref(),
    )
    .await;

    {
        let label = format!("#{} {}", pr.id, pr.title);
        let meta = serde_json::json!({ "prId": pr.id, "prTitle": pr.title }).to_string();
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let _ = match &result {
            Ok(text) => queries::add_job_history(&conn, &job_id, &project_id, "pr-review", &label, "done", Some(text), None, &meta),
            Err(e) => queries::add_job_history(&conn, &job_id, &project_id, "pr-review", &label, "error", None, Some(e), &meta),
        };
    }

    result
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentLocation {
    pub file: String,
    pub start_line: i64,
    pub end_line: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewComment {
    pub content: String,
    /// Present for a per-finding comment (anchors it to that file/line via the PR's latest
    /// iteration); absent for the summary comment or a finding whose location the model
    /// didn't provide in a parseable form, which just posts as a general PR comment.
    pub location: Option<CommentLocation>,
}

/// Posts each finding as its own comment thread — anchored to its file/line when the model
/// reported one (`debe-ser.png`-style inline review), a general PR comment otherwise —
/// rather than a single comment dumping the whole review. Posted sequentially (not
/// concurrently) to avoid bursting Azure DevOps' API, and every thread is attempted even if
/// an earlier one fails so one bad comment doesn't silently swallow the rest of the review.
#[tauri::command]
pub async fn post_pr_review_comment(
    db: State<'_, Db>,
    project_id: String,
    pr_id: i64,
    comments: Vec<ReviewComment>,
) -> Result<(), String> {
    let project = load_project(&db, &project_id)?;
    let (org, ado_project, repo_id) = ado_link(&project)?;
    let pat = pat_for_org(&org)?;

    let mut failures = Vec::new();
    for (i, comment) in comments.iter().enumerate() {
        let result = match &comment.location {
            Some(loc) => {
                ado::post_pr_comment_anchored(
                    &org,
                    &ado_project,
                    &repo_id,
                    pr_id,
                    &comment.content,
                    &loc.file,
                    loc.start_line,
                    loc.end_line,
                    &pat,
                )
                .await
            }
            None => ado::post_pr_comment(&org, &ado_project, &repo_id, pr_id, &comment.content, &pat).await,
        };
        if let Err(e) = result {
            failures.push(format!("#{} of {}: {e}", i + 1, comments.len()));
        }
    }
    if !failures.is_empty() {
        return Err(format!("{} comment(s) failed to post — {}", failures.len(), failures.join("; ")));
    }
    Ok(())
}
