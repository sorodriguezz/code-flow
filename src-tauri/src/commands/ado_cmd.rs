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

/// A stable name for the repository a review ran against, written into every run's memory.
///
/// Review memory is only ever allowed to be read back for the *same* repository — see `repo_key`
/// on `ReviewMeta`. Lower-cased because neither host treats these names case-sensitively, and a
/// project re-linked with different capitalisation is the same repository.
fn repo_key(link: &LinkedRepo) -> String {
    match link {
        LinkedRepo::GitHub { host, owner, repo } => {
            format!("github:{host}/{owner}/{repo}").to_lowercase()
        }
        LinkedRepo::Azure { org, project, repo_id } => {
            format!("azure:{org}/{project}/{repo_id}").to_lowercase()
        }
    }
}

fn github_token(host: &str) -> Result<String, String> {
    secrets::get_secret(&secrets::github_token_key(host))?
        .ok_or_else(|| format!("No GitHub token saved for \"{host}\" — connect it in Settings first"))
}

#[derive(Deserialize)]
struct GithubConnectionHost {
    host: String,
}

#[derive(Deserialize)]
struct AdoConnectionOrg {
    org: String,
}

/// Which hosts/orgs the user has actually connected in Settings.
///
/// These two functions are how auto-linking answers "do we already have a credential for this
/// remote?" *without* touching the OS credential store. Settings writes the connection list and
/// the credential in the same operation (and removes them together), so the list is a faithful
/// stand-in for the credential's existence.
///
/// The distinction matters on macOS: an app signed ad-hoc rather than with a stable Developer ID
/// isn't recognized by the ACL on its own Keychain items, so every read pops a "enter your
/// password" dialog. [`auto_link_project`] runs on every repo opened or switched to, so reading
/// the Keychain from here meant one such prompt per repo switch. The credential itself is still
/// read — later, only when a request to the host is actually made.
fn github_connected_hosts(db: &State<'_, Db>) -> Result<Vec<String>, String> {
    let raw = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::get_setting(&conn, "github_connections").map_err(|e| e.to_string())?
    };
    let Some(raw) = raw else { return Ok(Vec::new()) };
    Ok(serde_json::from_str::<Vec<GithubConnectionHost>>(&raw)
        .map(|conns| conns.into_iter().map(|c| c.host).collect())
        .unwrap_or_default())
}

fn ado_connected_orgs(db: &State<'_, Db>) -> Result<Vec<String>, String> {
    let (raw, legacy) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        (
            queries::get_setting(&conn, "ado_connections").map_err(|e| e.to_string())?,
            queries::get_setting(&conn, "ado_default_org").map_err(|e| e.to_string())?,
        )
    };
    if let Some(raw) = raw {
        if let Ok(conns) = serde_json::from_str::<Vec<AdoConnectionOrg>>(&raw) {
            return Ok(conns.into_iter().map(|c| c.org).collect());
        }
    }
    // Back-compat with the pre-multi-org setting, mirroring `loadAdoConnections` on the frontend:
    // before `ado_connections` existed a single org lived in `ado_default_org`.
    Ok(legacy.into_iter().collect())
}

/// The GitHub hosts we're allowed to auto-detect: `github.com` always, plus every Enterprise
/// host the user has connected. Without this allowlist an Enterprise remote is indistinguishable
/// from any other self-hosted git server, so only configured hosts are recognized. Detection is
/// deliberately wider than [`github_connected_hosts`]: `github.com` is recognizable whether or not
/// a token is saved, which is what lets a detected-but-unconnected remote report `NeedsToken`.
fn github_known_hosts(db: &State<'_, Db>) -> Result<Vec<String>, String> {
    Ok(detectable_github_hosts(&github_connected_hosts(db)?))
}

/// The allowlist itself, split out so a caller that already loaded the connected hosts (see
/// [`auto_link_project`]) doesn't read the same setting twice.
fn detectable_github_hosts(connected: &[String]) -> Vec<String> {
    let mut hosts = vec![github::GITHUB_COM.to_string()];
    for host in connected {
        if !hosts.iter().any(|h| h.eq_ignore_ascii_case(host)) {
            hosts.push(host.clone());
        }
    }
    hosts
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

    let connected_github_hosts = github_connected_hosts(&db)?;
    let connected_ado_orgs = ado_connected_orgs(&db)?;
    let known_github_hosts = detectable_github_hosts(&connected_github_hosts);

    // The repo binds to the first remote we recognize *and* already have a token for — so with
    // both GitHub and Azure DevOps connected, each repo auto-links to the host that's actually
    // its own, with no manual "pick one" step. If a remote is recognized but its token is
    // missing, remember the first such case to report which token to add (only if nothing turns
    // out to be linkable outright).
    let mut needs_token: Option<AutoLinkResult> = None;

    for remote in &ordered {
        let url = remote.url.as_str();
        if let Some(detected) = github::detect_from_remote_url(url, &known_github_hosts) {
            if connected_github_hosts.iter().any(|h| h.eq_ignore_ascii_case(&detected.host)) {
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
            if connected_ado_orgs.iter().any(|o| o.eq_ignore_ascii_case(&detected.org)) {
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

/// What a pasted pull-request link turned out to be. The point of the whole flow is that a link
/// from a chat message is enough: the user never has to know which of their repos it belongs to,
/// nor find it in the sidebar first.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status")]
pub enum PrLinkResolution {
    /// The link resolved to a PR *and* to a local repository, which is now linked to that host —
    /// so selecting this PR gives the full review pipeline (local diff, findings, comments,
    /// review memory), identical to picking it in the sidebar.
    Ready {
        project_id: String,
        workspace_id: String,
        project_name: String,
        pr: ado::PullRequestSummary,
    },
    /// The host is recognized but nothing is saved to authenticate with it — `identifier` is the
    /// GitHub host or the Azure DevOps organization the token is missing for.
    NeedsToken { provider: String, identifier: String },
    /// The PR was read fine, but no repository in CodeFlow points at it. `clone_url` is what the
    /// "clone it and review" offer uses; the PR itself is carried so it can still be previewed.
    NoLocalRepo {
        provider: String,
        repo_label: String,
        clone_url: String,
        pr: ado::PullRequestSummary,
    },
    /// Not a pull-request URL on a host we can talk to.
    Unrecognized,
}

/// Case-insensitive compare for the host/owner/repo/org names both providers treat as
/// case-insensitive — a link copied as `Acme/Widget` must still match a remote of `acme/widget`.
fn same(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

fn same_opt(a: &Option<String>, b: &str) -> bool {
    a.as_deref().map(|v| same(v, b)).unwrap_or(false)
}

/// Finds the local repository a pull-request link belongs to.
///
/// Two passes, in order: a project already linked to exactly this repo (no writes at all), then
/// any project whose *own git remote* points at it — which gets linked on the spot, since the
/// remote is the ground truth for where a repo lives and the PR commands dispatch off the link
/// columns. `matches_remote` answers "does this remote URL point at the link's repo?".
fn find_project_for_link(
    db: &State<'_, Db>,
    projects: &[Project],
    already_linked: impl Fn(&Project) -> bool,
    matches_remote: impl Fn(&str) -> bool,
    link: impl Fn(&rusqlite::Connection, &str) -> Result<(), String>,
) -> Result<Option<Project>, String> {
    if let Some(project) = projects.iter().find(|p| already_linked(p)) {
        return Ok(Some(project.clone()));
    }

    for project in projects {
        // A project whose folder moved or was deleted simply can't answer — skip it rather than
        // failing the whole lookup on one bad row.
        let remotes = git::remotes::list_remotes(&project.local_path).unwrap_or_default();
        if !remotes.iter().any(|r| matches_remote(&r.url)) {
            continue;
        }
        {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            // Clear whatever it was linked to first: a project holds at most one host's columns,
            // and `linked_repo` prefers GitHub, so leaving a stale Azure/GitHub pair behind would
            // dispatch the review at the wrong provider.
            queries::unlink_project(&conn, &project.id).map_err(|e| e.to_string())?;
            link(&conn, &project.id)?;
        }
        // Re-read the row so the caller gets the project as it now is, not the pre-link copy.
        return load_project(db, &project.id).map(Some);
    }

    Ok(None)
}

/// Resolves a pasted pull-request URL — GitHub (including Enterprise) or Azure DevOps — into a
/// PR plus the local repository it belongs to, linking that repository to its host if it wasn't
/// already. This is what makes "review this PR" reachable from a link someone sent you, instead
/// of only from the sidebar list of a project you already had open.
#[tauri::command]
pub async fn resolve_pr_link(db: State<'_, Db>, url: String) -> Result<PrLinkResolution, String> {
    let known_hosts = github_known_hosts(&db)?;
    let Some(target) = crate::pr_link::parse(&url, &known_hosts) else {
        return Ok(PrLinkResolution::Unrecognized);
    };

    let projects = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::list_all_projects(&conn).map_err(|e| e.to_string())?
    };

    match target {
        crate::pr_link::PrLinkTarget::GitHub { host, owner, repo, number } => {
            let Some(token) = secrets::get_secret(&secrets::github_token_key(&host))? else {
                return Ok(PrLinkResolution::NeedsToken {
                    provider: "github".to_string(),
                    identifier: host,
                });
            };
            let pr = github::get_pull_request(&host, &owner, &repo, number, &token).await?;
            let found = find_project_for_link(
                &db,
                &projects,
                |p| {
                    same_opt(&p.github_owner, &owner)
                        && same_opt(&p.github_repo, &repo)
                        && same(p.github_host.as_deref().unwrap_or(github::GITHUB_COM), &host)
                },
                |remote_url| {
                    github::detect_from_remote_url(remote_url, &known_hosts)
                        .map(|d| same(&d.host, &host) && same(&d.owner, &owner) && same(&d.repo, &repo))
                        .unwrap_or(false)
                },
                |conn, project_id| {
                    queries::link_project_github(conn, project_id, &owner, &repo, &host)
                        .map_err(|e| e.to_string())
                },
            )?;
            Ok(match found {
                Some(project) => PrLinkResolution::Ready {
                    project_id: project.id,
                    workspace_id: project.workspace_id,
                    project_name: project.name,
                    pr,
                },
                None => PrLinkResolution::NoLocalRepo {
                    provider: "github".to_string(),
                    repo_label: format!("{owner}/{repo}"),
                    clone_url: format!("https://{host}/{owner}/{repo}.git"),
                    pr,
                },
            })
        }
        crate::pr_link::PrLinkTarget::Azure { org, project: ado_project, repo, number } => {
            let Some(pat) = secrets::get_secret(&secrets::ado_pat_key(&org))? else {
                return Ok(PrLinkResolution::NeedsToken {
                    provider: "azure".to_string(),
                    identifier: org,
                });
            };
            // The link may name the project/repo by GUID (Azure's notification e-mails do), so
            // everything from here on uses the names Azure itself reported — that's what a git
            // remote can be matched against, and what belongs in the project's link columns.
            let detail = ado::get_pull_request(&org, &ado_project, &repo, number, &pat).await?;
            let (pr, ado_project, repo) = (detail.summary, detail.project_name, detail.repo_name);
            let found = find_project_for_link(
                &db,
                &projects,
                |p| {
                    same_opt(&p.ado_org, &org)
                        && same_opt(&p.ado_project, &ado_project)
                        && same_opt(&p.ado_repo_id, &repo)
                        // `linked_repo` prefers GitHub, so a project carrying both would dispatch
                        // there instead. Leave it to the remote pass, which repairs the columns.
                        && !(p.github_owner.is_some() && p.github_repo.is_some())
                },
                |remote_url| {
                    ado::detect_from_remote_url(remote_url)
                        .map(|d| same(&d.org, &org) && same(&d.project, &ado_project) && same(&d.repo, &repo))
                        .unwrap_or(false)
                },
                |conn, project_id| {
                    // Azure's Git REST API takes the repository *name* wherever it takes a GUID,
                    // so the name straight out of the link is a valid `ado_repo_id`.
                    queries::link_project_ado(conn, project_id, &org, &ado_project, &repo)
                        .map_err(|e| e.to_string())
                },
            )?;
            Ok(match found {
                Some(project) => PrLinkResolution::Ready {
                    project_id: project.id,
                    workspace_id: project.workspace_id,
                    project_name: project.name,
                    pr,
                },
                None => PrLinkResolution::NoLocalRepo {
                    provider: "azure".to_string(),
                    repo_label: format!("{ado_project}/{repo}"),
                    clone_url: format!(
                        "https://dev.azure.com/{}/{}/_git/{}",
                        web_encode(&org),
                        web_encode(&ado_project),
                        web_encode(&repo)
                    ),
                    pr,
                },
            })
        }
    }
}

/// The link's coordinates plus the credential for its host. Both of the repo-less commands below
/// start here; the typed "unrecognized"/"no token" states the user is shown come from
/// [`resolve_pr_link`], so by the time these run a plain error is the right shape.
fn link_credentials(
    db: &State<'_, Db>,
    url: &str,
) -> Result<(crate::pr_link::PrLinkTarget, String), String> {
    let known_hosts = github_known_hosts(db)?;
    let target = crate::pr_link::parse(url, &known_hosts)
        .ok_or_else(|| "That isn't a pull-request link CodeFlow can read".to_string())?;
    let credential = match &target {
        crate::pr_link::PrLinkTarget::GitHub { host, .. } => github_token(host)?,
        crate::pr_link::PrLinkTarget::Azure { org, .. } => pat_for_org(org)?,
    };
    Ok((target, credential))
}

/// How a repo-less pull request names the repository it lives in — "owner/repo" on GitHub,
/// "project/repo" on Azure DevOps — plus where that repository could be cloned from.
///
/// Same strings [`resolve_pr_link`] reports for `NoLocalRepo`, so a review filed in Activity names
/// its repository exactly like the modal that opened it did. `canonical` carries the project/repo
/// names the provider itself reported: an Azure link addresses them by GUID often enough (its
/// notification e-mails do) that the raw link is not a name worth showing.
fn link_repo_coords(target: &crate::pr_link::PrLinkTarget, canonical: Option<(&str, &str)>) -> (String, String) {
    match target {
        crate::pr_link::PrLinkTarget::GitHub { host, owner, repo, .. } => {
            (format!("{owner}/{repo}"), format!("https://{host}/{owner}/{repo}.git"))
        }
        crate::pr_link::PrLinkTarget::Azure { org, project, repo, .. } => {
            let (project, repo) = canonical.unwrap_or((project, repo));
            (
                format!("{project}/{repo}"),
                format!(
                    "https://dev.azure.com/{}/{}/_git/{}",
                    web_encode(org),
                    web_encode(project),
                    web_encode(repo)
                ),
            )
        }
    }
}

/// A pull request read from its host with nothing checked out: the PR, its diff, and the two
/// strings that let the review be named and (if the user changes their mind) cloned.
struct LinkPr {
    pr: ado::PullRequestSummary,
    diff: String,
    repo_label: String,
    clone_url: String,
}

/// Reads a pull request and its diff from the host's API alone — no clone, no `projects` row.
async fn fetch_pr_and_diff(
    target: &crate::pr_link::PrLinkTarget,
    credential: &str,
) -> Result<LinkPr, String> {
    match target {
        crate::pr_link::PrLinkTarget::GitHub { host, owner, repo, number } => {
            let pr = github::get_pull_request(host, owner, repo, *number, credential).await?;
            let diff = github::pull_request_diff(host, owner, repo, *number, credential).await?;
            let (repo_label, clone_url) = link_repo_coords(target, None);
            Ok(LinkPr { pr, diff, repo_label, clone_url })
        }
        crate::pr_link::PrLinkTarget::Azure { org, project, repo, number } => {
            // Canonical names, so a link carrying GUIDs still addresses the blobs endpoint.
            let detail = ado::get_pull_request(org, project, repo, *number, credential).await?;
            let diff =
                ado::pull_request_diff(org, &detail.project_name, &detail.repo_name, *number, credential).await?;
            let (repo_label, clone_url) =
                link_repo_coords(target, Some((&detail.project_name, &detail.repo_name)));
            Ok(LinkPr { pr: detail.summary, diff, repo_label, clone_url })
        }
    }
}

/// What a repo-less review or decision carries into Activity: enough to name the row ("#42
/// owner/repo · Fix login") and to reopen the whole review later without the link being pasted
/// again — including a snapshot of the pull request, so reopening it works offline.
fn link_activity_meta(
    url: &str,
    pr: &ado::PullRequestSummary,
    repo_label: &str,
    clone_url: &str,
    extra: serde_json::Value,
) -> String {
    let mut meta = serde_json::json!({
        "prId": pr.id,
        "prTitle": pr.title,
        "prUrl": url,
        "repoLabel": repo_label,
        "cloneUrl": clone_url,
        "pr": pr,
    });
    if let (Some(base), Some(extra)) = (meta.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            base.insert(key.clone(), value.clone());
        }
    }
    meta.to_string()
}

/// "#42 owner/repo · Fix login" — the repository is in the title because nothing else here says
/// which one it was: the row shows next to reviews of repositories the user actually has.
fn link_activity_label(pr: &ado::PullRequestSummary, repo_label: &str) -> String {
    format!("#{} {} · {}", pr.id, repo_label, pr.title)
}

/// Keeps a directory name to what every filesystem accepts.
fn slugify(value: &str) -> String {
    value
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect()
}

/// Lays out the working directory a repo-less review runs in.
///
/// The engine needs *some* working directory, and pointing it at an unrelated folder would be
/// worse than useless — so it gets one holding this pull request's own diff and description.
/// Its file tools then have something real to read, and nothing else to wander into. Reused
/// (overwritten) across re-runs of the same PR rather than piling up temp directories.
fn link_review_workspace(
    target: &crate::pr_link::PrLinkTarget,
    pr: &ado::PullRequestSummary,
    diff: &str,
) -> Result<String, String> {
    let slug = match target {
        crate::pr_link::PrLinkTarget::GitHub { host, owner, repo, number } => {
            slugify(&format!("github-{host}-{owner}-{repo}-{number}"))
        }
        crate::pr_link::PrLinkTarget::Azure { org, project, repo, number } => {
            slugify(&format!("azure-{org}-{project}-{repo}-{number}"))
        }
    };
    let dir = paths::base_dir().join("pr-link-reviews").join(slug);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let description = if pr.description.trim().is_empty() { "(sin descripción)" } else { &pr.description };
    let overview = format!(
        "# #{} {}\n\n- Autor: {}\n- Rama origen: `{}`\n- Rama destino: `{}`\n- URL: {}\n\n## Descripción\n\n{}\n",
        pr.id, pr.title, pr.author, pr.source_branch, pr.target_branch, pr.url, description
    );
    std::fs::write(dir.join("PULL_REQUEST.md"), overview).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("changes.diff"), diff).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

/// Tells the model, up front, that it is reviewing without the surrounding codebase — so it
/// works from the diff instead of trying to open files that aren't there, and grades what it
/// can't confirm accordingly rather than asserting it.
const NO_CLONE_CONTEXT: &str = "Esta revisión corre SIN un clon local del repositorio. Por stdin recibes el diff completo del pull request, y el directorio de trabajo solo contiene `PULL_REQUEST.md` y `changes.diff`. No intentes explorar el árbol del repositorio ni abrir archivos que no estén ahí. Basa la revisión en el diff: cuando un hallazgo dependa de código que no ves (una función llamada pero no incluida, un contrato definido en otro archivo), decláralo explícitamente y baja la confianza en consecuencia, o clasifícalo como Security Hotspot en lugar de afirmar un bug que no puedes demostrar.";

/// Reviews a pull request from nothing but its link — reading the diff from the host's API
/// instead of from a working copy.
///
/// This trades depth for reach, on purpose: the model sees the diff and the PR's description but
/// not the surrounding codebase, so it can't confirm a caller, check whether a test exists, or
/// have a fix applied afterwards. That's a genuinely weaker review than the project-backed one
/// ([`review_pull_request`]), and the prompt says so to the model.
///
/// The run is still recorded, in `workspace_activity` rather than `job_history`: it has no project
/// to file itself under, but it does have the workspace it ran in, and that is the scope at which
/// it is useful — a review of a repository this machine doesn't have shouldn't vanish just because
/// the user moved to another repo, nor follow them into an unrelated workspace.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn review_pr_from_link(
    app: AppHandle,
    db: State<'_, Db>,
    url: String,
    job_id: String,
    level: String,
    workspace_id: String,
    agent_provider: Option<String>,
    agent_model: Option<String>,
    agent_prompt: Option<String>,
) -> Result<String, String> {
    let (target, credential) = link_credentials(&db, &url)?;

    let (contexts, mcps, skills, config, review_template) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let contexts = queries::list_review_contexts(&conn, &workspace_id).map_err(|e| e.to_string())?;
        let mcps = queries::list_workspace_mcps(&conn, &workspace_id).map_err(|e| e.to_string())?;
        let skills = queries::list_workspace_skills(&conn, &workspace_id).map_err(|e| e.to_string())?;
        let config = match (agent_provider.as_deref(), agent_model.as_deref()) {
            (Some(p), Some(m)) if !p.trim().is_empty() && !m.trim().is_empty() => {
                crate::commands::claude_cmd::load_ai_config_for(&conn, p, m)?
            }
            _ => load_ai_config(&conn, AiTask::Review)?,
        };
        let review_template = queries::get_workspace_prompt(&conn, &workspace_id, "review_standard")
            .map_err(|e| e.to_string())?;
        (contexts, mcps, skills, config, review_template)
    };

    let LinkPr { pr, diff: diff_text, repo_label, clone_url } = fetch_pr_and_diff(&target, &credential).await?;
    let cwd = link_review_workspace(&target, &pr, &diff_text)?;
    // Best-effort, same as the project-backed review: skills are a nice-to-have, not a
    // precondition.
    let _ = skills_cmd::sync_skills_into_project(&skills, &workspace_id, &cwd);

    let mut enabled_contexts: Vec<(String, String)> = contexts
        .into_iter()
        .filter(|c| c.enabled)
        .map(|c| (c.name, c.content))
        .collect();
    enabled_contexts.insert(0, ("Modo de revisión".to_string(), NO_CLONE_CONTEXT.to_string()));
    if let Some(prompt) = agent_prompt.as_deref().filter(|p| !p.trim().is_empty()) {
        enabled_contexts.insert(0, ("Agent".to_string(), prompt.to_string()));
    }

    // The conversation already open on the PR, same as the project-backed review — minus the
    // memory half, which a link session never has (nothing is saved for a PR with no project).
    let open_threads = match &target {
        crate::pr_link::PrLinkTarget::GitHub { host, owner, repo, number } => {
            github::list_pr_comment_threads(host, owner, repo, *number, &credential).await.unwrap_or_default()
        }
        crate::pr_link::PrLinkTarget::Azure { org, project, repo, number } => {
            ado::list_pr_comment_threads(org, project, repo, *number, &credential).await.unwrap_or_default()
        }
    };
    if let Some(block) = pending_comments_block(&[], &open_threads) {
        enabled_contexts.push(("Conversación abierta en el PR".to_string(), block));
    }

    let mcp_config_path = build_mcp_config(&mcps, &workspace_id)?;

    let result = crate::ai_runs::scoped(app, Some(job_id.clone()), async {
        ai::review_pull_request(
            &*config.engine,
            &config.binary,
            &config.model,
            &pr.title,
            &pr.description,
            &enabled_contexts,
            &diff_text,
            &config.tools,
            &cwd,
            &review_template,
            &level,
            mcp_config_path.as_deref(),
        )
        .await
    })
    .await;

    // A stopped run leaves nothing behind, same as the project-backed review.
    if matches!(&result, Err(e) if e.starts_with(crate::ai_runs::CANCELLED_MARKER)) {
        return result;
    }

    let label = link_activity_label(&pr, &repo_label);
    let meta = link_activity_meta(
        &url,
        &pr,
        &repo_label,
        &clone_url,
        serde_json::json!({ "level": level }),
    );
    // Best-effort: failing to remember a review must never turn a good one into an error.
    if let Ok(conn) = db.0.lock() {
        let (status, text, error) = match &result {
            Ok(text) => ("done", Some(text.as_str()), None),
            Err(e) => ("error", None, Some(e.as_str())),
        };
        let _ = queries::add_workspace_activity(
            &conn, &job_id, &workspace_id, "pr-review", &label, status, text, error, &meta,
        );
    }

    result
}

/// The pull request behind a link, re-read from its host. Lets a review with no clone refresh
/// its own header the way the project-backed one refreshes from the PR list.
#[tauri::command]
pub async fn pr_link_pull_request(db: State<'_, Db>, url: String) -> Result<ado::PullRequestSummary, String> {
    let (target, credential) = link_credentials(&db, &url)?;
    match &target {
        crate::pr_link::PrLinkTarget::GitHub { host, owner, repo, number } => {
            github::get_pull_request(host, owner, repo, *number, &credential).await
        }
        crate::pr_link::PrLinkTarget::Azure { org, project, repo, number } => {
            Ok(ado::get_pull_request(org, project, repo, *number, &credential).await?.summary)
        }
    }
}

/// The PR's existing comment threads, addressed by link — the repo-less twin of
/// [`list_pr_comment_threads`]. Reading a conversation never needed a working copy.
#[tauri::command]
pub async fn pr_link_comment_threads(db: State<'_, Db>, url: String) -> Result<Vec<ado::PrCommentThread>, String> {
    let (target, credential) = link_credentials(&db, &url)?;
    match &target {
        crate::pr_link::PrLinkTarget::GitHub { host, owner, repo, number } => {
            github::list_pr_comment_threads(host, owner, repo, *number, &credential).await
        }
        crate::pr_link::PrLinkTarget::Azure { org, project, repo, number } => {
            ado::list_pr_comment_threads(org, project, repo, *number, &credential).await
        }
    }
}

/// Closing a conversation on the host, addressed by link — the repo-less twin of
/// [`resolve_pr_comment_thread`]. Resolving a thread is a host call, so a review with no clone can
/// do it too.
#[tauri::command]
pub async fn pr_link_resolve_comment_thread(db: State<'_, Db>, url: String, thread_id: i64) -> Result<(), String> {
    let (target, credential) = link_credentials(&db, &url)?;
    match &target {
        crate::pr_link::PrLinkTarget::GitHub { host, owner, repo, number } => {
            github::resolve_review_thread_for_comment(host, owner, repo, *number, thread_id, &credential).await
        }
        crate::pr_link::PrLinkTarget::Azure { org, project, repo, number } => {
            ado::set_pr_thread_status(org, project, repo, *number, thread_id, THREAD_FIXED, &credential).await
        }
    }
}

/// What the signed-in user has already decided on the PR behind a link — the repo-less twin of
/// [`pr_review_decision`].
#[tauri::command]
pub async fn pr_link_decision(db: State<'_, Db>, url: String) -> Result<String, String> {
    let (target, credential) = link_credentials(&db, &url)?;
    match &target {
        crate::pr_link::PrLinkTarget::GitHub { host, owner, repo, number } => {
            github::viewer_decision(host, owner, repo, *number, &credential).await
        }
        crate::pr_link::PrLinkTarget::Azure { org, project, repo, number } => {
            ado::viewer_decision(org, project, repo, *number, &credential).await
        }
    }
}

/// Approve / request-changes / close the PR behind a link — the repo-less twin of
/// [`act_on_pull_request`], and the reason a review with no clone is a real review rather than a
/// read-only preview. Returns the pull request as the host reports it afterwards, together with
/// the Activity row the decision was filed as — in `workspace_activity`, for the same reason the
/// review itself is: no project to file it against, but a workspace that outlives the session.
#[tauri::command]
pub async fn act_on_pr_link(
    db: State<'_, Db>,
    url: String,
    workspace_id: String,
    action: String,
    body: Option<String>,
) -> Result<PrLinkActionOutcome, String> {
    let (target, credential) = link_credentials(&db, &url)?;
    let comment = body.unwrap_or_default();
    let (pr, canonical) = match &target {
        crate::pr_link::PrLinkTarget::GitHub { host, owner, repo, number } => {
            match action.as_str() {
                "approve" => github::submit_pr_review(host, owner, repo, *number, "APPROVE", &comment, &credential).await,
                "request_changes" => {
                    let text = if comment.trim().is_empty() { "Cambios solicitados desde CodeFlow." } else { &comment };
                    github::submit_pr_review(host, owner, repo, *number, "REQUEST_CHANGES", text, &credential).await
                }
                "close" => github::close_pull_request(host, owner, repo, *number, &credential).await,
                other => Err(format!("unknown PR action: {other}")),
            }?;
            (github::get_pull_request(host, owner, repo, *number, &credential).await?, None)
        }
        crate::pr_link::PrLinkTarget::Azure { org, project, repo, number } => {
            match action.as_str() {
                "approve" => ado::set_reviewer_vote(org, project, repo, *number, 10, &credential).await,
                "request_changes" => ado::set_reviewer_vote(org, project, repo, *number, -10, &credential).await,
                "close" => ado::abandon_pull_request(org, project, repo, *number, &credential).await,
                other => Err(format!("unknown PR action: {other}")),
            }?;
            let detail = ado::get_pull_request(org, project, repo, *number, &credential).await?;
            let names = (detail.project_name.clone(), detail.repo_name.clone());
            (detail.summary, Some(names))
        }
    };

    let (repo_label, clone_url) =
        link_repo_coords(&target, canonical.as_ref().map(|(p, r)| (p.as_str(), r.as_str())));
    let id = uuid::Uuid::new_v4().to_string();
    let label = link_activity_label(&pr, &repo_label);
    let meta = link_activity_meta(&url, &pr, &repo_label, &clone_url, serde_json::json!({ "action": action }));
    let activity = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::add_workspace_activity(
            &conn,
            &id,
            &workspace_id,
            "pr-action",
            &label,
            "done",
            Some(&pr.url),
            None,
            &meta,
        )
        .map_err(|e| e.to_string())?
    };

    Ok(PrLinkActionOutcome { pr, activity })
}

/// Posts the selected findings of a repo-less review onto the pull request, addressed by link.
///
/// Unlike [`post_pr_review_comment`] there is no saved run to reconcile against — a review with
/// no project has nowhere to keep its memory — so every finding opens a fresh thread instead of
/// continuing the one it opened last time. Every item is attempted even if one fails.
#[tauri::command]
pub async fn post_pr_link_review_comment(
    db: State<'_, Db>,
    url: String,
    items: Vec<PostFindingItem>,
    post_summary: bool,
    summary: Option<String>,
) -> Result<(), String> {
    let (target, credential) = link_credentials(&db, &url)?;
    let mut failures: Vec<String> = Vec::new();

    match &target {
        crate::pr_link::PrLinkTarget::GitHub { host, owner, repo, number } => {
            let head_sha = if items.iter().any(|it| it.location.is_some()) {
                github::head_sha_for(host, owner, repo, *number, &credential).await.ok()
            } else {
                None
            };
            for (i, item) in items.iter().enumerate() {
                let posted = match (&item.location, &head_sha) {
                    (Some(loc), Some(sha)) => github::post_pr_comment_anchored(
                        host, owner, repo, *number, &item.content, &loc.file, loc.start_line, loc.end_line, sha,
                        &credential,
                    )
                    .await
                    .map(|_| ()),
                    _ => github::post_pr_comment(host, owner, repo, *number, &item.content, &credential)
                        .await
                        .map(|_| ()),
                };
                if let Err(e) = posted {
                    failures.push(format!("#{}: {e}", i + 1));
                }
            }
            if post_summary {
                if let Some(s) = &summary {
                    if let Err(e) = github::post_pr_comment(host, owner, repo, *number, s, &credential).await {
                        failures.push(format!("summary: {e}"));
                    }
                }
            }
        }
        crate::pr_link::PrLinkTarget::Azure { org, project, repo, number } => {
            // The link may carry GUIDs; the thread endpoints take either, so they're used as-is.
            for (i, item) in items.iter().enumerate() {
                let posted = match &item.location {
                    Some(loc) => ado::post_pr_comment_anchored(
                        org, project, repo, *number, &item.content, &loc.file, loc.start_line, loc.end_line,
                        &credential,
                    )
                    .await
                    .map(|_| ()),
                    None => ado::post_pr_comment(org, project, repo, *number, &item.content, &credential)
                        .await
                        .map(|_| ()),
                };
                if let Err(e) = posted {
                    failures.push(format!("#{}: {e}", i + 1));
                }
            }
            if post_summary {
                if let Some(s) = &summary {
                    if let Err(e) = ado::post_pr_comment(org, project, repo, *number, s, &credential).await {
                        failures.push(format!("summary: {e}"));
                    }
                }
            }
        }
    }

    if !failures.is_empty() {
        return Err(format!("{} comment(s) failed to post — {}", failures.len(), failures.join("; ")));
    }
    Ok(())
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

/// Azure DevOps' thread status for "this was fixed" — what its own **Resolve** button sets. The
/// other statuses (won't fix, by design) are judgements CodeFlow has no business making on the
/// reviewer's behalf, so resolving from here always means this one.
const THREAD_FIXED: i32 = 2;

/// Marks one comment thread as resolved on the host: Azure's `fixed`, GitHub's
/// `resolveReviewThread`. The counterpart of "resolve with AI" — once the fix is applied, the
/// conversation it came from can be closed without leaving the app.
///
/// `thread_id` is the id [`list_pr_comment_threads`] reported, which is a real thread on Azure and
/// the root comment of a review thread on GitHub (the shape each host's API addresses). GitHub's
/// conversation-level comments belong to no review thread and cannot be resolved at all — that
/// surfaces as an error from the GraphQL lookup rather than silently doing nothing.
#[tauri::command]
pub async fn resolve_pr_comment_thread(
    db: State<'_, Db>,
    project_id: String,
    pr_id: i64,
    thread_id: i64,
) -> Result<(), String> {
    let project = load_project(&db, &project_id)?;
    match linked_repo(&project)? {
        LinkedRepo::Azure { org, project: ado_project, repo_id } => {
            let pat = pat_for_org(&org)?;
            ado::set_pr_thread_status(&org, &ado_project, &repo_id, pr_id, thread_id, THREAD_FIXED, &pat).await
        }
        LinkedRepo::GitHub { host, owner, repo } => {
            let token = github_token(&host)?;
            github::resolve_review_thread_for_comment(&host, &owner, &repo, pr_id, thread_id, &token).await
        }
    }
}

/// Azure DevOps' thread status for "this is not going to be fixed" — the honest close for a
/// finding a human rejected. Distinct from [`THREAD_FIXED`] on purpose: closing a false positive as
/// *fixed* would put a lie on the record, and Azure surfaces the two differently.
const THREAD_WONT_FIX: i32 = 3;

/// What discarding a finding actually managed to do. The local mark is the part that must always
/// hold, so a host that refuses the reply comes back as a warning here rather than as an error that
/// throws the mark away with it.
#[derive(Debug, Serialize)]
pub struct DiscardOutcome {
    /// True when the finding's thread on the PR was replied to and closed.
    pub host_notified: bool,
    /// Why the host wasn't updated, when it wasn't. The mark still stands.
    pub host_error: Option<String>,
    /// True when a standing repository-level rule was written.
    pub rule_added: bool,
}

/// Rejects one finding of a saved review — the action behind "this is a false positive".
///
/// Three effects, each optional and each independently useful:
///
/// 1. **The mark**, always. The finding turns `falso_positivo` / `ignorado` in the run's memory,
///    which drops it out of the active set (and so out of the Quality Gate), carries it forward
///    through every later re-review of this PR, and hands it back to the model as "don't raise
///    this" (see `review_memory::discarded_block`). Passing `abierto` undoes all of that.
/// 2. **The reply on the host** (`notify_host`), when the finding was published and has a thread:
///    the reason is posted to that thread and the thread is closed as *won't fix*. Without it the
///    rejection only exists on one machine, and the PR keeps showing an open comment nobody intends
///    to act on — which is the state the author is actually looking at.
/// 3. **The standing rule** (`scope_repo`): the same judgement, promoted to the whole repository,
///    so the next PR doesn't re-derive it. See [`crate::review_memory::FpSuppression`].
///
/// Ordering is deliberate: the local mark is written and committed first, then the host is called.
/// The reverse would let a mid-flight failure leave a "won't fix" reply on a PR for a finding this
/// app still believes is open.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn discard_pr_finding(
    db: State<'_, Db>,
    project_id: String,
    pr_id: i64,
    run_id: String,
    finding_id: String,
    estado: String,
    motivo: Option<String>,
    scope_repo: bool,
    notify_host: bool,
) -> Result<DiscardOutcome, String> {
    let project = load_project(&db, &project_id)?;
    let link = linked_repo(&project)?;
    let repo = repo_key(&link);
    let motivo = motivo.map(|m| m.trim().to_string()).filter(|m| !m.is_empty());
    let discarding = matches!(estado.as_str(), "falso_positivo" | "ignorado");

    // Everything touching the database happens inside this scope: the guard cannot be held across
    // the host `.await` below, and the mark must be durable before the PR is told about it.
    let (thread_id, rule_added) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let run = queries::get_review_run(&conn, &run_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Review run not found".to_string())?;
        let mut findings: Vec<crate::review_memory::MemoryFinding> =
            serde_json::from_str(&run.findings).map_err(|e| e.to_string())?;
        let f = findings
            .iter_mut()
            .find(|f| f.id == finding_id)
            .ok_or_else(|| "Finding not found in this run".to_string())?;

        if discarding {
            f.estado = estado.clone();
            f.motivo_descarte = motivo.clone();
        } else {
            // Un-mark: back to open, or posted when the finding still owns a thread.
            f.estado = if f.thread_id.is_some() { "posteado".to_string() } else { "abierto".to_string() };
            f.motivo_descarte = None;
        }
        let (thread_id, categoria, archivo) = (f.thread_id, f.categoria.clone(), f.archivo.clone());

        let json = serde_json::to_string(&findings).map_err(|e| e.to_string())?;
        queries::set_review_run_findings(&conn, &run_id, &json).map_err(|e| e.to_string())?;

        // A repository rule only makes sense for a rejection, and only for a false positive:
        // "ignorado" says *not now*, which is a call about this pull request, not about the code.
        let rule_added = if scope_repo && estado == "falso_positivo" {
            let mut rules = crate::commands::settings::load_fp_suppressions(&conn, &project.workspace_id);
            // Re-marking the same finding must not stack duplicate rules onto every review's prompt.
            let already = rules
                .iter()
                .any(|r| r.repo_key == repo && r.matches(&categoria, archivo.as_deref()));
            if already {
                false
            } else {
                rules.insert(
                    0,
                    crate::review_memory::FpSuppression {
                        id: uuid::Uuid::new_v4().to_string(),
                        repo_key: repo.clone(),
                        categoria,
                        archivo,
                        motivo: motivo.clone().unwrap_or_else(|| "Descartado por la persona revisora".to_string()),
                        pr_id,
                        created_at: chrono::Utc::now().to_rfc3339(),
                    },
                );
                crate::commands::settings::save_fp_suppressions(&conn, &project.workspace_id, &rules)?;
                true
            }
        } else {
            false
        };

        (thread_id, rule_added)
    };

    let mut outcome = DiscardOutcome { host_notified: false, host_error: None, rule_added };

    let Some(thread_id) = thread_id.filter(|_| notify_host && discarding) else {
        return Ok(outcome);
    };

    let etiqueta = if estado == "falso_positivo" { "Falso positivo" } else { "Ignorado" };
    let cuerpo = match &motivo {
        Some(m) => format!(
            "🚫 **{etiqueta}** — descartado por la persona revisora.\n\n> {m}\n\n_Marcado desde CodeFlow. \
             Este hallazgo no se volverá a reportar en las próximas revisiones._"
        ),
        None => format!(
            "🚫 **{etiqueta}** — descartado por la persona revisora.\n\n_Marcado desde CodeFlow. \
             Este hallazgo no se volverá a reportar en las próximas revisiones._"
        ),
    };

    // Reply first, close second: a closed thread with no explanation on it is worse for the author
    // than an open one, so the sentence has to land before the conversation is shut.
    let host = async {
        match &link {
            LinkedRepo::Azure { org, project: ado_project, repo_id } => {
                let pat = pat_for_org(org)?;
                ado::reply_pr_thread(org, ado_project, repo_id, pr_id, thread_id, &cuerpo, &pat).await?;
                ado::set_pr_thread_status(org, ado_project, repo_id, pr_id, thread_id, THREAD_WONT_FIX, &pat).await
            }
            LinkedRepo::GitHub { host, owner, repo } => {
                let token = github_token(host)?;
                github::reply_pr_review_comment(host, owner, repo, pr_id, thread_id, &cuerpo, &token).await?;
                github::resolve_review_thread_for_comment(host, owner, repo, pr_id, thread_id, &token).await
            }
        }
    }
    .await;

    match host {
        Ok(()) => outcome.host_notified = true,
        Err(e) => outcome.host_error = Some(e),
    }
    Ok(outcome)
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
    // Every memory read and write below is scoped to this repository, so a project re-linked
    // elsewhere starts with a clean slate instead of inheriting findings about other code.
    let repo = repo_key(&link);
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
        queries::latest_review_head(&conn, &project_id, pr_id, &repo).ok().flatten()
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
    let scope = diff_scope(&diff_files);

    let mut enabled_contexts: Vec<(String, String)> = contexts
        .into_iter()
        .filter(|c| c.enabled)
        .map(|c| (c.name, c.content))
        .collect();
    // The active agent's own instructions go first, so the role frames the review.
    if let Some(prompt) = agent_prompt.as_deref().filter(|p| !p.trim().is_empty()) {
        enabled_contexts.insert(0, ("Agent".to_string(), prompt.to_string()));
    }

    // What the conversation on the PR still has open — the findings this app published and that
    // the last run left active, plus whatever else the host still shows unresolved. A re-review
    // without them only re-derives defects from the diff, and says nothing about the question the
    // second run is actually asked: were the comments already left on this PR addressed?
    //
    // Both halves are best-effort. Losing the reviewer's own memory or the host's thread list
    // costs context, and context is not worth failing a review the user is waiting on.
    let (remembered, repo_rules) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let remembered: Vec<crate::review_memory::MemoryFinding> =
            queries::latest_review_findings(&conn, &project_id, pr_id, &repo)
                .ok()
                .flatten()
                .and_then(|json| serde_json::from_str(&json).ok())
                .unwrap_or_default();
        // Standing rules are the workspace's, filtered to this repository — a judgement made on one
        // repo must not silence a finding on another that happens to share a category name.
        let repo_rules: Vec<crate::review_memory::FpSuppression> =
            crate::commands::settings::load_fp_suppressions(&conn, &workspace_id)
                .into_iter()
                .filter(|r| r.repo_key == repo)
                .collect();
        (remembered, repo_rules)
    };
    let open_threads = match &link {
        LinkedRepo::Azure { org, project: ado_project, repo_id } => match pat_for_org(org) {
            Ok(pat) => ado::list_pr_comment_threads(org, ado_project, repo_id, pr_id, &pat).await.unwrap_or_default(),
            Err(_) => Vec::new(),
        },
        LinkedRepo::GitHub { host, owner, repo } => match github_token(host) {
            Ok(token) => github::list_pr_comment_threads(host, owner, repo, pr_id, &token).await.unwrap_or_default(),
            Err(_) => Vec::new(),
        },
    };
    if let Some(block) = pending_comments_block(&remembered, &open_threads) {
        enabled_contexts.push(("Conversación abierta en el PR".to_string(), block));
    }
    // Two "do not raise this" blocks, deliberately not folded into the one above: that block asks
    // the model to *answer* what is still open, and these ask it to stay off ground a human already
    // ruled on. One list carrying both meanings is a list the model has to guess its way through.
    //
    // Without them a dismissed finding is re-derived on every run — reconciliation re-applies the
    // mark afterwards, so the user never sees it, but it is re-analysed and re-paid for each time.
    if let Some(block) = crate::review_memory::discarded_block(&remembered) {
        enabled_contexts.push(("Hallazgos ya descartados en este PR".to_string(), block));
    }
    if let Some(block) = crate::review_memory::suppressions_block(&repo_rules) {
        enabled_contexts.push(("Falsos positivos conocidos de este repositorio".to_string(), block));
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
                &conn, &job_id, &project, &repo, &workspace_id, &pr, &level, config.engine.label(),
                &config.model, &diff_text, &head_sha, scope, changed_files.as_deref(), text,
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

/// Files touched and lines added / removed in the diff this review was handed — the numbers behind
/// the summary's "scope analysed" line. Counted from the same `FileDiffInfo` the prompt was
/// rendered from, so the summary can never claim a scope the review didn't actually see.
fn diff_scope(files: &[git::diff::FileDiffInfo]) -> crate::review_memory::DiffScope {
    let mut scope = crate::review_memory::DiffScope { files: files.len(), additions: 0, deletions: 0 };
    for file in files {
        for hunk in &file.hunks {
            for line in &hunk.lines {
                match line.origin.as_str() {
                    "+" => scope.additions += 1,
                    "-" => scope.deletions += 1,
                    _ => {}
                }
            }
        }
    }
    scope
}

/// How much of one comment's text is carried into the prompt. Enough to know what was asked;
/// short enough that twenty threads don't crowd out the diff.
const COMMENT_EXCERPT: usize = 500;

/// At most this many host threads are carried. Past it the conversation is long enough that the
/// tail adds noise rather than context, and the truncation is stated in the block itself.
const MAX_THREADS: usize = 20;

/// The still-open conversation on a pull request, rendered as one context block for the review
/// prompt.
///
/// Two sources, deliberately kept apart: the findings **this app** published and still holds
/// active (from the durable review memory — they carry their stable `F-NNN` id, which is what lets
/// reconciliation match the re-review's findings back to the threads already opened for them), and
/// every other thread the host still shows open (a human reviewer's). The instructions matter as
/// much as the list: a finding that persists must be re-reported *with the same file and category*
/// or reconciliation reads it as fixed, and one that really was fixed must be left out and said so
/// in the summary — that is exactly the signal that flips it to `resuelto`.
///
/// Returns `None` when nothing is pending: a first review has no conversation to carry, and an
/// empty "still open" section only invites the model to invent one.
fn pending_comments_block(
    remembered: &[crate::review_memory::MemoryFinding],
    threads: &[ado::PrCommentThread],
) -> Option<String> {
    let published: Vec<&crate::review_memory::MemoryFinding> = remembered
        .iter()
        .filter(|f| f.is_active() && f.thread_id.is_some())
        .collect();
    // Threads CodeFlow opened are already described, in richer terms, by the memory above —
    // listing them again would ask the model to answer the same finding twice.
    let ours: std::collections::HashSet<i64> = remembered.iter().filter_map(|f| f.thread_id).collect();
    let others: Vec<&ado::PrCommentThread> = threads.iter().filter(|t| !ours.contains(&t.id)).collect();
    if published.is_empty() && others.is_empty() {
        return None;
    }

    // Leading newline: contexts are rendered as `- {name}: {content}`, and a multi-line block
    // reads as part of that bullet unless it starts on its own line.
    let mut out = String::from(
        "\nEste pull request ya tiene conversación abierta. Además de revisar el diff actual, \
         responde explícitamente por cada punto pendiente si esta iteración lo corrige.\n",
    );

    if !published.is_empty() {
        out.push_str(
            "\n## Hallazgos que esta app publicó y siguen abiertos\n\
             Reglas: si el hallazgo SIGUE presente, vuelve a reportarlo con el mismo archivo y la \
             misma categoría (así se reconoce como el mismo hallazgo y se responde en su hilo). Si \
             ya está corregido, NO lo reportes como hallazgo y dilo en el resumen.\n\n",
        );
        for f in &published {
            let loc = match (&f.archivo, &f.lineas) {
                (Some(file), Some(lines)) => format!(" · `{file}:{lines}`"),
                (Some(file), None) => format!(" · `{file}`"),
                _ => String::new(),
            };
            out.push_str(&format!(
                "- **{}** · {} · categoría `{}`{} — {}\n",
                f.id, f.severity, f.categoria, loc, f.subtitulo
            ));
        }
    }

    if !others.is_empty() {
        out.push_str(
            "\n## Otros comentarios abiertos en el PR\n\
             Son de personas revisoras. Indica en el resumen si el cambio actual los atiende.\n\n",
        );
        for thread in others.iter().take(MAX_THREADS) {
            let loc = match (&thread.file_path, thread.start_line) {
                (Some(file), Some(line)) => format!(" (`{file}:{line}`)"),
                (Some(file), None) => format!(" (`{file}`)"),
                _ => String::new(),
            };
            out.push_str(&format!("- Hilo #{}{}\n", thread.id, loc));
            for c in &thread.comments {
                let text: String = c.content.chars().take(COMMENT_EXCERPT).collect();
                let ellipsis = if c.content.chars().count() > COMMENT_EXCERPT { "…" } else { "" };
                out.push_str(&format!("  - {}: {}{}\n", c.author, text.replace('\n', " "), ellipsis));
            }
        }
        if others.len() > MAX_THREADS {
            out.push_str(&format!("\n_(+{} hilos abiertos no listados.)_\n", others.len() - MAX_THREADS));
        }
    }

    Some(out)
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
    // The repository this run reviewed (see `repo_key`) — both the scope its memory is read back
    // under and what gets stored, so the two can never disagree.
    repo: &str,
    workspace_id: &str,
    pr: &ado::PullRequestSummary,
    level: &str,
    engine_label: &str,
    model: &str,
    diff_text: &str,
    head_sha: &str,
    scope: crate::review_memory::DiffScope,
    changed_files: Option<&[String]>,
    text: String,
) -> String {
    use crate::review_memory as mem;

    let prior = queries::count_review_runs(conn, &project.id, pr.id, repo).unwrap_or(0) as usize;
    let parsed = mem::parse_findings(&text);

    // Reconcile against the previous run's findings when there is one; otherwise it's the first
    // run and the parsed findings are the whole set (introduced this iteration).
    let (findings, delta) = if prior > 0 {
        let prev: Vec<mem::MemoryFinding> = queries::latest_review_findings(conn, &project.id, pr.id, repo)
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
        repo_key: repo.to_string(),
        workspace_id: workspace_id.to_string(),
        timestamp: chrono::Local::now().to_rfc3339(),
        iter,
        head_sha: head_sha.to_string(),
        files: scope.files,
        additions: scope.additions,
        deletions: scope.deletions,
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
                            let _ =
                                ado::set_pr_thread_status(org, ado_project, repo_id, pr_id, tid, THREAD_FIXED, &pat)
                                    .await;
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

/// The decision the signed-in user has already recorded on a pull request — `"approved"` |
/// `"changes_requested"` | `"none"`. Read from the host, so a vote cast on the website counts
/// exactly as much as one cast here.
#[tauri::command]
pub async fn pr_review_decision(db: State<'_, Db>, project_id: String, pr_id: i64) -> Result<String, String> {
    let project = load_project(&db, &project_id)?;
    match linked_repo(&project)? {
        LinkedRepo::Azure { org, project: ado_project, repo_id } => {
            let pat = pat_for_org(&org)?;
            ado::viewer_decision(&org, &ado_project, &repo_id, pr_id, &pat).await
        }
        LinkedRepo::GitHub { host, owner, repo } => {
            let token = github_token(&host)?;
            github::viewer_decision(&host, &owner, &repo, pr_id, &token).await
        }
    }
}

/// What a PR decision left behind: the pull request as the host now reports it (so "closed" is the
/// host's answer, not an optimistic guess), and the Activity row the action was filed under.
#[derive(Serialize)]
pub struct PrActionOutcome {
    pub pr: ado::PullRequestSummary,
    pub activity: crate::db::models::JobHistoryEntry,
}

/// The same, for a decision taken on a PR reached by link — its Activity row belongs to the
/// workspace rather than to a project.
#[derive(Serialize)]
pub struct PrLinkActionOutcome {
    pub pr: ado::PullRequestSummary,
    pub activity: crate::db::models::WorkspaceActivityEntry,
}

/// Approve / request-changes / close a pull request on whichever host it's linked to. `action`
/// is one of `"approve"` | `"request_changes"` | `"close"`; the provider-specific mapping lives
/// here (GitHub review events / state vs Azure reviewer vote / abandon). `body` is an optional
/// comment carried on a GitHub review (GitHub requires a non-empty body to request changes, so a
/// default is substituted when blank); Azure votes carry no message.
///
/// Deciding on a pull request is a real event in the project's history, not a fire-and-forget
/// button, so it's filed in Activity alongside the reviews — and the PR is re-read from the host
/// afterwards so the UI settles into the state the action actually produced.
#[tauri::command]
pub async fn act_on_pull_request(
    db: State<'_, Db>,
    project_id: String,
    pr_id: i64,
    action: String,
    body: Option<String>,
) -> Result<PrActionOutcome, String> {
    let project = load_project(&db, &project_id)?;
    let comment = body.unwrap_or_default();
    let link = linked_repo(&project)?;

    let pr = match &link {
        LinkedRepo::Azure { org, project: ado_project, repo_id } => {
            let pat = pat_for_org(org)?;
            match action.as_str() {
                "approve" => ado::set_reviewer_vote(org, ado_project, repo_id, pr_id, 10, &pat).await,
                "request_changes" => ado::set_reviewer_vote(org, ado_project, repo_id, pr_id, -10, &pat).await,
                "close" => ado::abandon_pull_request(org, ado_project, repo_id, pr_id, &pat).await,
                other => Err(format!("unknown PR action: {other}")),
            }?;
            ado::get_pull_request(org, ado_project, repo_id, pr_id, &pat).await?.summary
        }
        LinkedRepo::GitHub { host, owner, repo } => {
            let token = github_token(host)?;
            match action.as_str() {
                "approve" => github::submit_pr_review(host, owner, repo, pr_id, "APPROVE", &comment, &token).await,
                "request_changes" => {
                    let text = if comment.trim().is_empty() { "Cambios solicitados desde CodeFlow." } else { &comment };
                    github::submit_pr_review(host, owner, repo, pr_id, "REQUEST_CHANGES", text, &token).await
                }
                "close" => github::close_pull_request(host, owner, repo, pr_id, &token).await,
                other => Err(format!("unknown PR action: {other}")),
            }?;
            github::get_pull_request(host, owner, repo, pr_id, &token).await?
        }
    };

    let job_id = uuid::Uuid::new_v4().to_string();
    let label = format!("#{} {}", pr.id, pr.title);
    let meta = serde_json::json!({ "prId": pr.id, "prTitle": pr.title, "action": action }).to_string();
    let activity = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::add_job_history(
            &conn,
            &job_id,
            &project_id,
            "pr-action",
            &label,
            "done",
            Some(&pr.url),
            None,
            &meta,
        )
        .map_err(|e| e.to_string())?
    };

    Ok(PrActionOutcome { pr, activity })
}
