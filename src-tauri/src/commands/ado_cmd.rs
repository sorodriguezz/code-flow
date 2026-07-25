use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::ado;
use crate::ai;
use crate::commands::claude_cmd::{load_ai_config, shared_template, AiTask};
use crate::commands::skills_cmd;
use crate::db::{
    models::{Project, WorkspaceMcp},
    queries, Db,
};
use crate::git;
use crate::github;
use crate::paths;
use crate::secrets;

/// Which VCS host a project's PR features talk to, resolved from whichever set of link columns
/// is populated. A project links to at most one host; GitHub wins if both were somehow set.
/// This is the single dispatch point the shared PR commands (list / review / comment) branch
/// on, so the frontend, the `prStore`, and the whole Claude review pipeline stay provider-neutral.
enum LinkedRepo {
    Azure { org: String, project: String, repo_id: String },
    /// `host` is "github.com" or a GitHub Enterprise hostname — picks both the token to use and
    /// the REST base URL.
    GitHub { host: String, owner: String, repo: String },
}

fn linked_repo(project: &Project) -> Result<LinkedRepo, String> {
    if let (Some(owner), Some(repo)) = (project.github_owner.clone(), project.github_repo.clone()) {
        let host = project.github_host.clone().unwrap_or_else(|| github::GITHUB_COM.to_string());
        return Ok(LinkedRepo::GitHub { host, owner, repo });
    }
    if let (Some(org), Some(ado_project), Some(repo_id)) =
        (project.ado_org.clone(), project.ado_project.clone(), project.ado_repo_id.clone())
    {
        return Ok(LinkedRepo::Azure { org, project: ado_project, repo_id });
    }
    Err("This project isn't linked to a pull-request host yet".to_string())
}

fn github_token(host: &str) -> Result<String, String> {
    secrets::get_secret(&secrets::github_token_key(host))?
        .ok_or_else(|| format!("No GitHub token saved for \"{host}\" — connect it in Settings first"))
}

#[derive(Deserialize)]
struct GithubConnectionHost {
    host: String,
}

/// The GitHub hosts we're allowed to auto-detect: `github.com` always, plus every Enterprise
/// host the user has connected (persisted by Settings as the `github_connections` JSON list).
/// Without this allowlist an Enterprise remote is indistinguishable from any other self-hosted
/// git server, so only configured hosts are recognized.
fn github_known_hosts(db: &State<'_, Db>) -> Result<Vec<String>, String> {
    let mut hosts = vec![github::GITHUB_COM.to_string()];
    let raw = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::get_setting(&conn, "github_connections").map_err(|e| e.to_string())?
    };
    if let Some(raw) = raw {
        if let Ok(conns) = serde_json::from_str::<Vec<GithubConnectionHost>>(&raw) {
            for c in conns {
                if !hosts.iter().any(|h| h.eq_ignore_ascii_case(&c.host)) {
                    hosts.push(c.host);
                }
            }
        }
    }
    Ok(hosts)
}

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
    /// Detected a supported remote (Azure Repos or GitHub) and a token for it was already
    /// saved — linked automatically, no user action needed.
    Linked { project: Project },
    /// Detected a supported remote, but no token is saved for it yet. `provider` is
    /// "azure" | "github"; `identifier` is the org (Azure) or owner (GitHub) it was detected
    /// under, shown in the "needs a token" hint.
    NeedsToken { provider: String, identifier: String },
    /// The remote isn't a recognized host (or there's no remote at all) — falls back to
    /// manual linking.
    NotDetected,
}

/// Called once per project when its Pull Requests section first needs data: tries to derive
/// the host org/project/repo (Azure) or owner/repo (GitHub) straight from the local repo's own
/// remote URL instead of making the user hunt through dropdowns for something git already knows.
///
/// Reads the remote straight from the repo's actual git config rather than the `projects`
/// table's `remote_url` column — that column is only populated at "Clone repository" time,
/// so a repo added via "Add a local repository" (or one whose origin changed since) would
/// otherwise never be detectable even though `git remote -v` has the answer right there.
#[tauri::command]
pub fn auto_link_project(db: State<Db>, project_id: String) -> Result<AutoLinkResult, String> {
    let project = load_project(&db, &project_id)?;
    if linked_repo(&project).is_ok() {
        return Ok(AutoLinkResult::Linked { project });
    }

    // Scan every remote, not just `origin` — a repo whose PR host lives on a differently-named
    // remote (upstream, fork, …) should still bind on its own. `origin` is checked first as the
    // canonical upstream, then the rest.
    let remotes = git::remotes::list_remotes(&project.local_path)?;
    let mut ordered: Vec<&git::remotes::RemoteInfo> = Vec::new();
    if let Some(origin) = remotes.iter().find(|r| r.name == "origin") {
        ordered.push(origin);
    }
    ordered.extend(remotes.iter().filter(|r| r.name != "origin"));

    let known_github_hosts = github_known_hosts(&db)?;

    // The repo binds to the first remote we recognize *and* already have a token for — so with
    // both GitHub and Azure DevOps connected, each repo auto-links to the host that's actually
    // its own, with no manual "pick one" step. If a remote is recognized but its token is
    // missing, remember the first such case to report which token to add (only if nothing turns
    // out to be linkable outright).
    let mut needs_token: Option<AutoLinkResult> = None;

    for remote in &ordered {
        let url = remote.url.as_str();
        if let Some(detected) = github::detect_from_remote_url(url, &known_github_hosts) {
            if secrets::get_secret(&secrets::github_token_key(&detected.host))?.is_some() {
                let conn = db.0.lock().map_err(|e| e.to_string())?;
                queries::link_project_github(&conn, &project_id, &detected.owner, &detected.repo, &detected.host)
                    .map_err(|e| e.to_string())?;
                let linked = queries::get_project(&conn, &project_id)
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| "Project not found".to_string())?;
                return Ok(AutoLinkResult::Linked { project: linked });
            } else if needs_token.is_none() {
                needs_token = Some(AutoLinkResult::NeedsToken { provider: "github".to_string(), identifier: detected.owner });
            }
        } else if let Some(detected) = ado::detect_from_remote_url(url) {
            if secrets::get_secret(&secrets::ado_pat_key(&detected.org))?.is_some() {
                let conn = db.0.lock().map_err(|e| e.to_string())?;
                queries::link_project_ado(&conn, &project_id, &detected.org, &detected.project, &detected.repo)
                    .map_err(|e| e.to_string())?;
                let linked = queries::get_project(&conn, &project_id)
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| "Project not found".to_string())?;
                return Ok(AutoLinkResult::Linked { project: linked });
            } else if needs_token.is_none() {
                needs_token = Some(AutoLinkResult::NeedsToken { provider: "azure".to_string(), identifier: detected.org });
            }
        }
    }

    Ok(needs_token.unwrap_or(AutoLinkResult::NotDetected))
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

/// Clears whichever VCS link (Azure DevOps or GitHub) a project currently has — the sidebar's
/// "Disconnect" doesn't need to know which provider it was.
#[tauri::command]
pub fn unlink_project(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::unlink_project(&conn, &id).map_err(|e| e.to_string())
}

/// Percent-encodes spaces in an Azure DevOps org/project/repo path segment for a browser URL
/// (those names routinely contain spaces — "Marketing Website"). GitHub owner/repo can't
/// contain spaces, so they need no encoding.
fn web_encode(s: &str) -> String {
    s.replace(' ', "%20")
}

/// The project's repository home page on its host, reconstructed from the repo's own git
/// remote (the reliable source of the human-readable names) rather than the stored link
/// columns — which may hold an Azure DevOps repo GUID from the manual picker, or be briefly
/// stale for a repo auto-linked this session. Returns `None` if no remote is recognized.
fn repo_web_url(db: &State<'_, Db>, project_id: &str) -> Result<Option<String>, String> {
    let project = load_project(db, project_id)?;
    let remotes = git::remotes::list_remotes(&project.local_path)?;
    let mut ordered: Vec<&git::remotes::RemoteInfo> = Vec::new();
    if let Some(origin) = remotes.iter().find(|r| r.name == "origin") {
        ordered.push(origin);
    }
    ordered.extend(remotes.iter().filter(|r| r.name != "origin"));

    let known_github_hosts = github_known_hosts(db)?;
    for remote in &ordered {
        if let Some(d) = github::detect_from_remote_url(&remote.url, &known_github_hosts) {
            return Ok(Some(format!("https://{}/{}/{}", d.host, d.owner, d.repo)));
        }
        if let Some(d) = ado::detect_from_remote_url(&remote.url) {
            return Ok(Some(format!(
                "https://dev.azure.com/{}/{}/_git/{}",
                web_encode(&d.org),
                web_encode(&d.project),
                web_encode(&d.repo)
            )));
        }
    }
    Ok(None)
}

/// Opens the project's repository home page in the default browser — the "open on the web"
/// shortcut next to the Pull Requests section.
#[tauri::command]
pub fn open_repo_in_browser(db: State<Db>, project_id: String) -> Result<(), String> {
    let url = repo_web_url(&db, &project_id)?
        .ok_or_else(|| "Couldn't determine this repository's web address from its remote".to_string())?;
    open::that(&url).map_err(|e| format!("couldn't open the browser: {e}"))
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
    match linked_repo(&project)? {
        LinkedRepo::Azure { org, project: ado_project, repo_id } => {
            let pat = pat_for_org(&org)?;
            ado::list_pull_requests(&org, &ado_project, &repo_id, &pat).await
        }
        LinkedRepo::GitHub { host, owner, repo } => {
            let token = github_token(&host)?;
            github::list_pull_requests(&host, &owner, &repo, &token).await
        }
    }
}

/// A drafted PR title + body, produced by the AI from the branch diff. The frontend fills the
/// "Create PR" form with these.
#[derive(Serialize)]
pub struct PrDescriptionDraft {
    pub title: String,
    pub body: String,
}

/// Splits the model's raw output ("TITLE: …" first line, then the Markdown body) into the two
/// form fields. When no `TITLE:` marker is present, the whole text becomes the body.
fn parse_pr_draft(raw: &str) -> PrDescriptionDraft {
    let trimmed = raw.trim();
    let mut title = String::new();
    let mut found_title = false;
    let mut body_lines: Vec<&str> = Vec::new();
    for line in trimmed.lines() {
        if !found_title {
            if let Some(rest) = line.trim_start().strip_prefix("TITLE:") {
                title = rest.trim().to_string();
                found_title = true;
                continue;
            }
        }
        body_lines.push(line);
    }
    if !found_title {
        return PrDescriptionDraft { title: String::new(), body: trimmed.to_string() };
    }
    PrDescriptionDraft { title, body: body_lines.join("\n").trim().to_string() }
}

/// Drafts a PR title + description from the diff between two branches, using the active engine.
/// Generation only needs the local repo (the diff is computed from git), so it works even before
/// the source branch is pushed.
#[tauri::command]
pub async fn generate_pr_description(
    db: State<'_, Db>,
    project_id: String,
    source_branch: String,
    target_branch: String,
) -> Result<PrDescriptionDraft, String> {
    let project = load_project(&db, &project_id)?;
    let (config, template) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let config = load_ai_config(&conn, AiTask::PrDescription)?;
        let template = shared_template(&conn, "pr_description_template", "claude_pr_description_template")?;
        (config, template)
    };
    let diff_files = git::diff::get_branch_diff(&project.local_path, &target_branch, &source_branch)?;
    let diff_text = git::diff::render_diff_for_prompt(&diff_files);
    let raw = ai::generate_pr_description(
        &*config.engine,
        &config.binary,
        &config.model,
        &source_branch,
        &target_branch,
        &diff_text,
        &template,
    )
    .await?;
    Ok(parse_pr_draft(&raw))
}

/// Creates a pull request on whichever host the project is linked to.
#[tauri::command]
pub async fn create_pull_request(
    db: State<'_, Db>,
    project_id: String,
    title: String,
    description: String,
    source_branch: String,
    target_branch: String,
    draft: bool,
) -> Result<ado::PullRequestSummary, String> {
    let project = load_project(&db, &project_id)?;
    match linked_repo(&project)? {
        LinkedRepo::Azure { org, project: ado_project, repo_id } => {
            let pat = pat_for_org(&org)?;
            ado::create_pull_request(
                &org, &ado_project, &repo_id, &title, &description, &source_branch, &target_branch, draft, &pat,
            )
            .await
        }
        LinkedRepo::GitHub { host, owner, repo } => {
            let token = github_token(&host)?;
            github::create_pull_request(
                &host, &owner, &repo, &title, &description, &source_branch, &target_branch, draft, &token,
            )
            .await
        }
    }
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
    match linked_repo(&project)? {
        LinkedRepo::Azure { org, project: ado_project, repo_id } => {
            let pat = pat_for_org(&org)?;
            ado::list_pr_comment_threads(&org, &ado_project, &repo_id, pr_id, &pat).await
        }
        LinkedRepo::GitHub { host, owner, repo } => {
            let token = github_token(&host)?;
            github::list_pr_comment_threads(&host, &owner, &repo, pr_id, &token).await
        }
    }
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
    let link = linked_repo(&project)?;
    let workspace_id = project.workspace_id.clone();

    let (contexts, md_files, mcps, config, review_template) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let contexts = queries::list_review_contexts(&conn, &workspace_id).map_err(|e| e.to_string())?;
        let md_files = queries::list_workspace_md_files(&conn, &workspace_id).map_err(|e| e.to_string())?;
        let mcps = queries::list_workspace_mcps(&conn, &workspace_id).map_err(|e| e.to_string())?;
        let config = load_ai_config(&conn, AiTask::Review)?;
        let review_template = shared_template(&conn, "review_template", "claude_review_template")?;
        (contexts, md_files, mcps, config, review_template)
    };

    let prs = match &link {
        LinkedRepo::Azure { org, project: ado_project, repo_id } => {
            let pat = pat_for_org(org)?;
            ado::list_pull_requests(org, ado_project, repo_id, &pat).await?
        }
        LinkedRepo::GitHub { host, owner, repo } => {
            let token = github_token(host)?;
            github::list_pull_requests(host, owner, repo, &token).await?
        }
    };
    let pr = prs
        .into_iter()
        .find(|p| p.id == pr_id)
        .ok_or_else(|| "Pull request not found".to_string())?;

    // Best-effort — if the fetch fails (offline, auth hiccup) we still try to diff
    // against whatever refs are already local rather than blocking the review outright.
    let _ = crate::remote::fetch(app.clone(), project.local_path.clone(), None).await;

    // For GitHub, also fetch the PR's canonical head ref (`refs/pull/<n>/head`) into a local
    // tracking ref and diff against that — so the review reflects the PR's exact head commit
    // even when it comes from a fork or a head branch that isn't a normal origin branch. Falls
    // back to the head branch name if that targeted fetch fails.
    let head_ref = match &link {
        LinkedRepo::GitHub { .. } => {
            let local_ref = format!("refs/remotes/origin/codeflow-pr-{pr_id}");
            let refspec = format!("+refs/pull/{pr_id}/head:{local_ref}");
            match crate::remote::fetch_refspec(app.clone(), project.local_path.clone(), "origin".to_string(), refspec).await {
                Ok(_) => local_ref,
                Err(_) => pr.source_branch.clone(),
            }
        }
        LinkedRepo::Azure { .. } => pr.source_branch.clone(),
    };

    // Also best-effort: skills are a nice-to-have for the review, not a precondition —
    // don't block the review if e.g. the project directory is read-only.
    let _ = skills_cmd::sync_skills_into_project(&workspace_id, &project.local_path);

    let diff_files = git::diff::get_branch_diff(&project.local_path, &pr.target_branch, &head_ref)?;
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

    let mcp_config_path = build_mcp_config(&mcps, &workspace_id)?;

    let result = ai::review_pull_request(
        &*config.engine,
        &config.binary,
        &config.model,
        &pr.title,
        &pr.description,
        &enabled_contexts,
        &diff_text,
        &config.tools,
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
    let link = linked_repo(&project)?;

    let mut failures = Vec::new();
    match link {
        LinkedRepo::Azure { org, project: ado_project, repo_id } => {
            let pat = pat_for_org(&org)?;
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
        }
        LinkedRepo::GitHub { host, owner, repo } => {
            let token = github_token(&host)?;
            // One head-SHA fetch for the whole batch (anchored comments all pin to the same
            // commit). Best-effort: if it fails, anchored comments fall back to general PR
            // comments rather than aborting the whole post.
            let head_sha = if comments.iter().any(|c| c.location.is_some()) {
                github::head_sha_for(&host, &owner, &repo, pr_id, &token).await.ok()
            } else {
                None
            };
            for (i, comment) in comments.iter().enumerate() {
                let result = match (&comment.location, &head_sha) {
                    (Some(loc), Some(sha)) => {
                        github::post_pr_comment_anchored(
                            &host,
                            &owner,
                            &repo,
                            pr_id,
                            &comment.content,
                            &loc.file,
                            loc.start_line,
                            loc.end_line,
                            sha,
                            &token,
                        )
                        .await
                    }
                    _ => github::post_pr_comment(&host, &owner, &repo, pr_id, &comment.content, &token).await,
                };
                if let Err(e) = result {
                    failures.push(format!("#{} of {}: {e}", i + 1, comments.len()));
                }
            }
        }
    }
    if !failures.is_empty() {
        return Err(format!("{} comment(s) failed to post — {}", failures.len(), failures.join("; ")));
    }
    Ok(())
}

/// Approve / request-changes / close a pull request on whichever host it's linked to. `action`
/// is one of `"approve"` | `"request_changes"` | `"close"`; the provider-specific mapping lives
/// here (GitHub review events / state vs Azure reviewer vote / abandon). `body` is an optional
/// comment carried on a GitHub review (GitHub requires a non-empty body to request changes, so a
/// default is substituted when blank); Azure votes carry no message.
#[tauri::command]
pub async fn act_on_pull_request(
    db: State<'_, Db>,
    project_id: String,
    pr_id: i64,
    action: String,
    body: Option<String>,
) -> Result<(), String> {
    let project = load_project(&db, &project_id)?;
    let comment = body.unwrap_or_default();
    match linked_repo(&project)? {
        LinkedRepo::Azure { org, project: ado_project, repo_id } => {
            let pat = pat_for_org(&org)?;
            match action.as_str() {
                "approve" => ado::set_reviewer_vote(&org, &ado_project, &repo_id, pr_id, 10, &pat).await,
                "request_changes" => ado::set_reviewer_vote(&org, &ado_project, &repo_id, pr_id, -10, &pat).await,
                "close" => ado::abandon_pull_request(&org, &ado_project, &repo_id, pr_id, &pat).await,
                other => Err(format!("unknown PR action: {other}")),
            }
        }
        LinkedRepo::GitHub { host, owner, repo } => {
            let token = github_token(&host)?;
            match action.as_str() {
                "approve" => github::submit_pr_review(&host, &owner, &repo, pr_id, "APPROVE", &comment, &token).await,
                "request_changes" => {
                    let text = if comment.trim().is_empty() { "Cambios solicitados desde CodeFlow." } else { &comment };
                    github::submit_pr_review(&host, &owner, &repo, pr_id, "REQUEST_CHANGES", text, &token).await
                }
                "close" => github::close_pull_request(&host, &owner, &repo, pr_id, &token).await,
                other => Err(format!("unknown PR action: {other}")),
            }
        }
    }
}
