use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::ado;
use crate::ai;
use crate::commands::claude_cmd::{load_ai_config, AiTask};
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

/// Opens an external URL in the default browser. Used for links the app surfaces from a provider's
/// own message (e.g. opencode's billing page when it reports an empty balance), so the user can act
/// on it without copying the URL out of an error banner. Restricted to http(s) so a malformed or
/// hostile string from a CLI can't launch an arbitrary local handler.
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("only http(s) links can be opened".to_string());
    }
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
    app: AppHandle,
    db: State<'_, Db>,
    project_id: String,
    source_branch: String,
    target_branch: String,
    run_id: Option<String>,
) -> Result<PrDescriptionDraft, String> {
    let project = load_project(&db, &project_id)?;
    let (config, template) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let config = load_ai_config(&conn, AiTask::PrDescription)?;
        // The PR-description template is now the workspace's own (editable) copy — provider-neutral,
        // seeded with the built-in default. Falls back to that default when blanked.
        let template = queries::get_workspace_prompt(&conn, &project.workspace_id, "pr_description")
            .map_err(|e| e.to_string())?;
        (config, template)
    };
    let diff_files = git::diff::get_branch_diff(&project.local_path, &target_branch, &source_branch)?;
    let diff_text = git::diff::render_diff_for_prompt(&diff_files);
    let raw = crate::ai_runs::scoped(app, run_id, async {
        ai::generate_pr_description(
            &*config.engine,
            &config.binary,
            &config.model,
            &source_branch,
            &target_branch,
            &diff_text,
            &template,
        )
        .await
    })
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
    level: String,
    // When an SDD/Harness agent runs this review, its provider + model + prompt for this run.
    agent_provider: Option<String>,
    agent_model: Option<String>,
    agent_prompt: Option<String>,
) -> Result<String, String> {
    let project = load_project(&db, &project_id)?;
    let link = linked_repo(&project)?;
    let workspace_id = project.workspace_id.clone();

    let (contexts, mcps, skills, config, review_template) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let contexts = queries::list_review_contexts(&conn, &workspace_id).map_err(|e| e.to_string())?;
        let mcps = queries::list_workspace_mcps(&conn, &workspace_id).map_err(|e| e.to_string())?;
        let skills = queries::list_workspace_skills(&conn, &workspace_id).map_err(|e| e.to_string())?;
        // An active agent reviews on its own provider + model; otherwise the Review task routing.
        let config = match (agent_provider.as_deref(), agent_model.as_deref()) {
            (Some(p), Some(m)) if !p.trim().is_empty() && !m.trim().is_empty() => {
                crate::commands::claude_cmd::load_ai_config_for(&conn, p, m)?
            }
            _ => load_ai_config(&conn, AiTask::Review)?,
        };
        // The review methodology is the workspace's own (editable) PR review standard — the
        // transversal base every review runs under. Always non-empty (falls back to the built-in
        // default), so it's the prompt directly; project-specific rules ride along in `contexts`.
        let review_template = queries::get_workspace_prompt(&conn, &workspace_id, "review_standard")
            .map_err(|e| e.to_string())?;
        (contexts, mcps, skills, config, review_template)
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

    // The head commit this review will run against. On a re-review, if it matches the last run's
    // head, nothing changed — skip the whole (costly) analysis. Otherwise remember which files
    // changed since, so untouched-file findings auto-persist during reconciliation.
    let head_sha = git::diff::resolve_sha(&project.local_path, &head_ref).unwrap_or_default();
    let prev_head = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::latest_review_head(&conn, &project_id, pr_id).ok().flatten()
    };
    if let Some(prev) = &prev_head {
        if !head_sha.is_empty() && prev == &head_sha {
            let short = &head_sha[..head_sha.len().min(8)];
            return Ok(format!(
                "🔁 Sin cambios desde la última revisión (mismo commit `{short}`). No se volvió a analizar."
            ));
        }
    }
    let changed_files = match &prev_head {
        Some(prev) if !prev.is_empty() => git::diff::changed_files_between(&project.local_path, prev, &head_ref).ok(),
        _ => None,
    };

    // Also best-effort: skills are a nice-to-have for the review, not a precondition —
    // don't block the review if e.g. the project directory is read-only.
    let _ = skills_cmd::sync_skills_into_project(&skills, &workspace_id, &project.local_path);

    let diff_files = git::diff::get_branch_diff(&project.local_path, &pr.target_branch, &head_ref)?;
    let diff_text = git::diff::render_diff_for_prompt(&diff_files);

    let mut enabled_contexts: Vec<(String, String)> = contexts
        .into_iter()
        .filter(|c| c.enabled)
        .map(|c| (c.name, c.content))
        .collect();
    // The active agent's own instructions go first, so the role frames the review.
    if let Some(prompt) = agent_prompt.as_deref().filter(|p| !p.trim().is_empty()) {
        enabled_contexts.insert(0, ("Agent".to_string(), prompt.to_string()));
    }

    let mcp_config_path = build_mcp_config(&mcps, &workspace_id)?;

    // Same identity for the job row and the run, so the row can stream its own output and stop it.
    let result = crate::ai_runs::scoped(app.clone(), Some(job_id.clone()), async {
        ai::review_pull_request(
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
            &level,
            mcp_config_path.as_deref(),
        )
        .await
    })
    .await;

    // A stopped run leaves nothing behind (no history row, no saved memory) — return as-is.
    if matches!(&result, Err(e) if e.starts_with(crate::ai_runs::CANCELLED_MARKER)) {
        return result;
    }

    let label = format!("#{} {}", pr.id, pr.title);
    let history_meta = serde_json::json!({ "prId": pr.id, "prTitle": pr.title, "level": level }).to_string();
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    // On success, save durable memory of the run into the DB and, when this PR was reviewed
    // before, reconcile against the previous run so the delta (new / still-present / resolved)
    // rides on top of the returned review. Best-effort: a memory write must never turn a good
    // review into a failure.
    let result = match result {
        Ok(text) => {
            let text = persist_review_run(
                &conn, &job_id, &project, &workspace_id, &pr, &level, config.engine.label(), &config.model,
                &diff_text, &head_sha, changed_files.as_deref(), text,
            );
            let _ = queries::add_job_history(
                &conn, &job_id, &project_id, "pr-review", &label, "done", Some(&text), None, &history_meta,
            );
            Ok(text)
        }
        Err(e) => {
            let _ = queries::add_job_history(
                &conn, &job_id, &project_id, "pr-review", &label, "error", None, Some(&e), &history_meta,
            );
            Err(e)
        }
    };

    result
}

/// Saves one completed review into `review_runs` (durable memory, in the DB) and, when the PR has
/// a previous run, reconciles the new findings against it — returning the review text with a
/// one-line re-review delta banner prepended. Best-effort: any failure just returns the review
/// unchanged, since losing memory must never fail the review the user is waiting on.
#[allow(clippy::too_many_arguments)]
fn persist_review_run(
    conn: &rusqlite::Connection,
    job_id: &str,
    project: &Project,
    workspace_id: &str,
    pr: &ado::PullRequestSummary,
    level: &str,
    engine_label: &str,
    model: &str,
    diff_text: &str,
    head_sha: &str,
    changed_files: Option<&[String]>,
    text: String,
) -> String {
    use crate::review_memory as mem;

    let prior = queries::count_review_runs(conn, &project.id, pr.id).unwrap_or(0) as usize;
    let parsed = mem::parse_findings(&text);

    // Reconcile against the previous run's findings when there is one; otherwise it's the first
    // run and the parsed findings are the whole set (introduced this iteration).
    let (findings, delta) = if prior > 0 {
        let prev: Vec<mem::MemoryFinding> = queries::latest_review_findings(conn, &project.id, pr.id)
            .ok()
            .flatten()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default();
        let (merged, d) = mem::reconcile(&prev, &parsed, prior, changed_files);
        (merged, Some(d))
    } else {
        let mut first = parsed;
        for f in first.iter_mut() {
            f.introducido_en_iter = 1;
        }
        (first, None)
    };
    let iter = prior + 1;

    // On a re-review, append the cumulative "resolved findings" traceability to the review body
    // and prepend the delta banner — the stored memory and the returned text are identical.
    let mut text = match mem::resolved_history_section(&findings) {
        Some(section) => format!("{text}{section}"),
        None => text,
    };
    if let Some(d) = &delta {
        text = format!("{}{}", mem::delta_banner(d), text);
    }

    let meta = mem::ReviewMeta {
        pr_id: pr.id,
        pr_title: pr.title.clone(),
        pr_description: pr.description.clone(),
        author: pr.author.clone(),
        source_branch: pr.source_branch.clone(),
        target_branch: pr.target_branch.clone(),
        url: pr.url.clone(),
        provider: pr.provider.clone(),
        level: level.to_string(),
        engine: engine_label.to_string(),
        model: model.to_string(),
        project_id: project.id.clone(),
        project_name: project.name.clone(),
        workspace_id: workspace_id.to_string(),
        timestamp: chrono::Local::now().to_rfc3339(),
        iter,
        head_sha: head_sha.to_string(),
    };

    let meta_json = serde_json::to_string(&meta).unwrap_or_else(|_| "{}".to_string());
    let findings_json = serde_json::to_string(&findings).unwrap_or_else(|_| "[]".to_string());
    if let Err(e) = queries::add_review_run(
        conn, job_id, &project.id, workspace_id, pr.id, iter as i64, level, &meta_json, &text, diff_text, &findings_json,
    ) {
        eprintln!("failed to save review memory: {e}");
    }

    text
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommentLocation {
    pub file: String,
    pub start_line: i64,
    pub end_line: i64,
}

/// One human-selected finding to post. Identity (`file` + `category`) matches it back to the stored
/// run finding so its thread is reused across re-reviews.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PostFindingItem {
    pub file: Option<String>,
    pub category: String,
    /// Full comment markdown, used when opening a new thread.
    pub content: String,
    pub location: Option<CommentLocation>,
}

/// Posts the human-selected findings to the PR, reconciling against what was already posted so a
/// finding keeps ONE thread for the PR's whole life ("un hallazgo = un thread"): no thread yet →
/// open a new (anchored) one; already posted and still present → a follow-up reply; now resolved →
/// a reply plus its thread marked resolved/fixed. New thread ids are written back onto the run so a
/// later re-post continues the same threads instead of duplicating. Works on both Azure DevOps
/// (threads) and GitHub (review-comment replies + GraphQL thread resolve). Optionally posts a
/// summary comment. Every item is attempted even if one fails.
#[tauri::command]
pub async fn post_pr_review_comment(
    db: State<'_, Db>,
    project_id: String,
    pr_id: i64,
    run_id: String,
    items: Vec<PostFindingItem>,
    post_summary: bool,
    summary: Option<String>,
) -> Result<(), String> {
    use crate::review_memory::finding_identity;
    let project = load_project(&db, &project_id)?;
    let link = linked_repo(&project)?;

    // Stored findings are the source of truth for existing thread ids / state.
    let (mut findings, iter): (Vec<crate::review_memory::MemoryFinding>, i64) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        match queries::get_review_run(&conn, &run_id).map_err(|e| e.to_string())? {
            Some(r) => (serde_json::from_str(&r.findings).unwrap_or_default(), r.iter),
            None => (Vec::new(), 1),
        }
    };
    let index_of = |findings: &[crate::review_memory::MemoryFinding], item: &PostFindingItem| {
        let key = finding_identity(item.file.as_deref(), &item.category);
        findings
            .iter()
            .position(|f| finding_identity(f.archivo.as_deref(), &f.categoria) == key)
    };

    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let mut failures = Vec::new();

    match &link {
        LinkedRepo::Azure { org, project: ado_project, repo_id } => {
            let pat = pat_for_org(org)?;
            for (i, item) in items.iter().enumerate() {
                let idx = index_of(&findings, item);
                let thread = idx.and_then(|k| findings[k].thread_id);
                let resolved = idx.map(|k| findings[k].estado == "resuelto").unwrap_or(false);
                let outcome = match thread {
                    None => match &item.location {
                        Some(loc) => ado::post_pr_comment_anchored(org, ado_project, repo_id, pr_id, &item.content, &loc.file, loc.start_line, loc.end_line, &pat)
                            .await
                            .map(Some),
                        None => ado::post_pr_comment(org, ado_project, repo_id, pr_id, &item.content, &pat).await.map(Some),
                    },
                    Some(tid) => {
                        let text = if resolved {
                            format!("✔️ _Resuelto en la iteración {iter} — {today}. Marcado como fixed._")
                        } else {
                            format!("➡️ _Sigue presente en la iteración {iter} — {today}._")
                        };
                        let r = ado::reply_pr_thread(org, ado_project, repo_id, pr_id, tid, &text, &pat).await;
                        if r.is_ok() && resolved {
                            let _ = ado::set_pr_thread_status(org, ado_project, repo_id, pr_id, tid, 2, &pat).await;
                        }
                        r.map(|_| None)
                    }
                };
                apply_post_outcome(&mut findings, idx, outcome, i, &mut failures);
            }
            if post_summary {
                if let Some(s) = &summary {
                    if let Err(e) = ado::post_pr_comment(org, ado_project, repo_id, pr_id, s, &pat).await {
                        failures.push(format!("summary: {e}"));
                    }
                }
            }
        }
        LinkedRepo::GitHub { host, owner, repo } => {
            let token = github_token(host)?;
            let head_sha = if items.iter().any(|it| it.location.is_some()) {
                github::head_sha_for(host, owner, repo, pr_id, &token).await.ok()
            } else {
                None
            };
            for (i, item) in items.iter().enumerate() {
                let idx = index_of(&findings, item);
                let comment = idx.and_then(|k| findings[k].thread_id);
                let resolved = idx.map(|k| findings[k].estado == "resuelto").unwrap_or(false);
                let outcome = match comment {
                    None => match (&item.location, &head_sha) {
                        (Some(loc), Some(sha)) => github::post_pr_comment_anchored(host, owner, repo, pr_id, &item.content, &loc.file, loc.start_line, loc.end_line, sha, &token)
                            .await
                            .map(Some),
                        _ => github::post_pr_comment(host, owner, repo, pr_id, &item.content, &token).await.map(Some),
                    },
                    Some(cid) => {
                        let text = if resolved {
                            format!("✔️ Resuelto en la iteración {iter} — {today}.")
                        } else {
                            format!("➡️ Sigue presente en la iteración {iter} — {today}.")
                        };
                        let r = github::reply_pr_review_comment(host, owner, repo, pr_id, cid, &text, &token).await;
                        if r.is_ok() && resolved {
                            let _ = github::resolve_review_thread_for_comment(host, owner, repo, pr_id, cid, &token).await;
                        }
                        r.map(|_| None)
                    }
                };
                apply_post_outcome(&mut findings, idx, outcome, i, &mut failures);
            }
            if post_summary {
                if let Some(s) = &summary {
                    if let Err(e) = github::post_pr_comment(host, owner, repo, pr_id, s, &token).await {
                        failures.push(format!("summary: {e}"));
                    }
                }
            }
        }
    }

    // Write back the thread ids / states we just changed.
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let json = serde_json::to_string(&findings).unwrap_or_else(|_| "[]".to_string());
        let _ = queries::set_review_run_findings(&conn, &run_id, &json);
    }

    if !failures.is_empty() {
        return Err(format!("{} comment(s) failed to post — {}", failures.len(), failures.join("; ")));
    }
    Ok(())
}

/// Applies the result of posting one item to the stored finding: `Ok(Some(id))` means a new thread
/// was opened (record its id + mark posted); `Ok(None)` means a reply on an existing thread (no id
/// change); `Err` is collected. Keeps the per-provider loops small.
fn apply_post_outcome(
    findings: &mut [crate::review_memory::MemoryFinding],
    idx: Option<usize>,
    outcome: Result<Option<i64>, String>,
    i: usize,
    failures: &mut Vec<String>,
) {
    match outcome {
        Ok(Some(new_thread)) => {
            if let Some(k) = idx {
                findings[k].thread_id = Some(new_thread);
                if findings[k].estado == "abierto" {
                    findings[k].estado = "posteado".to_string();
                }
            }
        }
        Ok(None) => {}
        Err(e) => failures.push(format!("#{}: {e}", i + 1)),
    }
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
