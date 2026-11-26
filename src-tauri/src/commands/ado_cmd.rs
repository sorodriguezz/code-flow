use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::ado;
use crate::bitbucket;
use crate::commands::review_pipeline;
use crate::ai;
use crate::commands::claude_cmd::{load_ai_config_as, load_ai_config_in, AiTask};
use crate::commands::skills_cmd;
use crate::db::{
    models::Project,
    queries, Db,
};
use crate::git;
use crate::github;
use crate::gitlab;
use crate::paths;
use crate::review::context::is_newer_than;
use crate::review::contract::level_rank;
use crate::secrets;

/// Which VCS host a project's PR features talk to, resolved from whichever set of link columns
/// is populated. A project links to at most one host; the order below is the tie-break if more
/// than one set were somehow written — GitHub, then GitLab, then Bitbucket, then Azure — and the same order is
/// asserted by the "already linked" guards in [`resolve_pr_link`], so a project carrying two
/// providers' columns can never be routed at one host here and matched at another there.
/// This is the single dispatch point the shared PR commands (list / review / comment) branch
/// on, so the frontend, the `prStore`, and the whole Claude review pipeline stay provider-neutral.
pub(crate) enum LinkedRepo {
    Azure { org: String, project: String, repo_id: String },
    /// `host` is "github.com" or a GitHub Enterprise hostname — picks both the token to use and
    /// the REST base URL.
    GitHub { host: String, owner: String, repo: String },
    /// One path field rather than an owner/repo pair: GitLab groups nest, so
    /// `acme/backend/services/auth` is an ordinary project with nothing to split off the front.
    GitLab { host: String, project: String },
    /// No host: Bitbucket Cloud is bitbucket.org and nothing else. The workspace picks the
    /// credential, the slug the repository.
    Bitbucket { workspace: String, repo: String },
}

pub(crate) const PR_HOST_NOT_LINKED: &str = "This project isn't linked to a pull-request host yet";

pub(crate) fn linked_repo(project: &Project) -> Result<LinkedRepo, String> {
    if let (Some(owner), Some(repo)) = (project.github_owner.clone(), project.github_repo.clone()) {
        let host = project.github_host.clone().unwrap_or_else(|| github::GITHUB_COM.to_string());
        return Ok(LinkedRepo::GitHub { host, owner, repo });
    }
    if let Some(path) = project.gitlab_project.clone().filter(|p| !p.trim().is_empty()) {
        let host = project.gitlab_host.clone().unwrap_or_else(|| gitlab::GITLAB_COM.to_string());
        return Ok(LinkedRepo::GitLab { host, project: path });
    }
    // Both halves non-blank, like GitLab's path: a workspace alone names no repository.
    if let (Some(workspace), Some(repo)) = (
        project.bitbucket_workspace.clone().filter(|w| !w.trim().is_empty()),
        project.bitbucket_repo.clone().filter(|r| !r.trim().is_empty()),
    ) {
        return Ok(LinkedRepo::Bitbucket { workspace, repo });
    }
    if let (Some(org), Some(ado_project), Some(repo_id)) =
        (project.ado_org.clone(), project.ado_project.clone(), project.ado_repo_id.clone())
    {
        return Ok(LinkedRepo::Azure { org, project: ado_project, repo_id });
    }
    Err(PR_HOST_NOT_LINKED.to_string())
}

/// A stable name for the repository a review ran against, written into every run's memory.
///
/// Review memory is only ever allowed to be read back for the *same* repository — see `repo_key`
/// on `ReviewMeta`. Lower-cased because neither host treats these names case-sensitively, and a
/// project re-linked with different capitalisation is the same repository.
pub(crate) fn repo_key(link: &LinkedRepo) -> String {
    match link {
        LinkedRepo::GitHub { host, owner, repo } => {
            format!("github:{host}/{owner}/{repo}").to_lowercase()
        }
        // Variable-length for GitLab, since its groups nest — harmless, because this string is
        // only ever compared for equality, never parsed back apart. The `gitlab:` prefix is what
        // stops a GitLab project inheriting a same-named GitHub one's findings.
        LinkedRepo::GitLab { host, project } => format!("gitlab:{host}/{project}").to_lowercase(),
        // No host in it: there is one Bitbucket Cloud.
        LinkedRepo::Bitbucket { workspace, repo } => format!("bitbucket:{workspace}/{repo}").to_lowercase(),
        LinkedRepo::Azure { org, project, repo_id } => {
            format!("azure:{org}/{project}/{repo_id}").to_lowercase()
        }
    }
}

/// The repository key of a project, or `None` when it isn't linked to a pull-request host yet.
///
/// Goes through [`linked_repo`] rather than reading the columns directly so it inherits that
/// function's provider precedence: a project carrying two providers' columns must resolve to the
/// same repository here as it does when a review actually runs, or memory recorded under one key
/// would be looked for under another.
pub(crate) fn project_repo_key(project: &Project) -> Option<String> {
    linked_repo(project).ok().map(|link| repo_key(&link))
}

pub(crate) fn github_token(host: &str) -> Result<String, String> {
    secrets::get_secret(&secrets::github_token_key(host))?
        .ok_or_else(|| format!("No GitHub token saved for \"{host}\" — connect it in Settings first"))
}

pub(crate) fn gitlab_token(host: &str) -> Result<String, String> {
    secrets::get_secret(&secrets::gitlab_token_key(host))?
        .ok_or_else(|| format!("No GitLab token saved for \"{host}\" — connect it in Settings first"))
}

/// The credential saved for a Bitbucket workspace — an API token with its e-mail, or an access
/// token. See `bitbucket::BitbucketAuth` for why both halves live in the one keychain entry.
pub(crate) fn bitbucket_auth(workspace: &str) -> Result<bitbucket::BitbucketAuth, String> {
    let raw = secrets::get_secret(&secrets::bitbucket_token_key(workspace))?.ok_or_else(|| {
        format!("No Bitbucket credential saved for workspace \"{workspace}\" — connect it in Settings first")
    })?;
    bitbucket::BitbucketAuth::from_secret(&raw).ok_or_else(|| {
        format!("The Bitbucket credential saved for \"{workspace}\" is unreadable — connect the workspace again in Settings")
    })
}

/// The `[{"host": …}]` shape both `github_connections` and `gitlab_connections` are stored in.
#[derive(Deserialize)]
struct ConnectionHost {
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
/// password" dialog. [`auto_link_project`] runs whenever a repository's pull request list is
/// opened, so reading the Keychain from here meant one such prompt each time. The credential
/// itself is still read — later, only when a request to the host is actually made.
pub(crate) fn connected_hosts(db: &State<'_, Db>, setting: &str) -> Result<Vec<String>, String> {
    let raw = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::get_setting(&conn, setting).map_err(|e| e.to_string())?
    };
    let Some(raw) = raw else { return Ok(Vec::new()) };
    Ok(serde_json::from_str::<Vec<ConnectionHost>>(&raw)
        .map(|conns| conns.into_iter().map(|c| c.host).collect())
        .unwrap_or_default())
}

fn github_connected_hosts(db: &State<'_, Db>) -> Result<Vec<String>, String> {
    connected_hosts(db, "github_connections")
}

fn gitlab_connected_hosts(db: &State<'_, Db>) -> Result<Vec<String>, String> {
    connected_hosts(db, "gitlab_connections")
}

/// The Bitbucket workspaces with a saved credential, from `bitbucket_connections`
/// (`[{"workspace": …}]`) — the same keychain-free stand-in [`connected_hosts`] explains.
pub(crate) fn bitbucket_connected_workspaces(db: &State<'_, Db>) -> Result<Vec<String>, String> {
    #[derive(Deserialize)]
    struct ConnectionWorkspace {
        workspace: String,
    }
    let raw = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::get_setting(&conn, "bitbucket_connections").map_err(|e| e.to_string())?
    };
    let Some(raw) = raw else { return Ok(Vec::new()) };
    Ok(serde_json::from_str::<Vec<ConnectionWorkspace>>(&raw)
        .map(|conns| conns.into_iter().map(|c| bitbucket::normalize_workspace(&c.workspace)).collect())
        .unwrap_or_default())
}

pub(crate) fn ado_connected_orgs(db: &State<'_, Db>) -> Result<Vec<String>, String> {
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
    Ok(detectable_hosts(github::GITHUB_COM, &github_connected_hosts(db)?))
}

/// The same allowlist for GitLab. The rule matters more here than it does for GitHub: a GitLab
/// project path has no fixed number of segments, so without an allowlist every self-hosted git
/// server on earth would look like a plausible GitLab remote.
fn gitlab_known_hosts(db: &State<'_, Db>) -> Result<Vec<String>, String> {
    Ok(detectable_hosts(gitlab::GITLAB_COM, &gitlab_connected_hosts(db)?))
}

/// The allowlist itself, split out so a caller that already loaded the connected hosts (see
/// [`auto_link_project`]) doesn't read the same setting twice.
fn detectable_hosts(canonical: &str, connected: &[String]) -> Vec<String> {
    let mut hosts = vec![canonical.to_string()];
    for host in connected {
        if !hosts.iter().any(|h| h.eq_ignore_ascii_case(host)) {
            hosts.push(host.clone());
        }
    }
    hosts
}


#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status")]
pub enum AutoLinkResult {
    /// Detected a supported remote (Azure Repos, GitHub or GitLab) and a token for it was already
    /// saved — linked automatically, no user action needed.
    Linked { project: Project },
    /// Detected a supported remote, but no token is saved for it yet. `provider` is
    /// "azure" | "github" | "gitlab" | "bitbucket"; `identifier` is what the hint names it by — the
    /// org (Azure), the owner (GitHub), the host (GitLab, whose tokens are per-instance and whose
    /// nested group path has no single "owner" segment to point at), or the workspace (Bitbucket,
    /// whose credentials are per workspace).
    NeedsToken { provider: String, identifier: String },
    /// The remote isn't a recognized host (or there's no remote at all) — falls back to
    /// manual linking.
    NotDetected,
}

/// Called once per project when its Pull Requests section first needs data: tries to derive the
/// host org/project/repo (Azure), owner/repo (GitHub) or full project path (GitLab) straight from
/// the local repo's own remote URL, instead of making the user hunt through dropdowns for
/// something git already knows.
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
    let connected_gitlab_hosts = gitlab_connected_hosts(&db)?;
    let connected_ado_orgs = ado_connected_orgs(&db)?;
    let connected_bitbucket_workspaces = bitbucket_connected_workspaces(&db)?;
    let known_github_hosts = detectable_hosts(github::GITHUB_COM, &connected_github_hosts);
    let known_gitlab_hosts = detectable_hosts(gitlab::GITLAB_COM, &connected_gitlab_hosts);

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
                return link_if_unlinked(&db, &project_id, |conn| {
                    queries::link_project_github(conn, &project_id, &detected.owner, &detected.repo, &detected.host)
                });
            } else if needs_token.is_none() {
                needs_token = Some(AutoLinkResult::NeedsToken { provider: "github".to_string(), identifier: detected.owner });
            }
        } else if let Some(detected) = gitlab::detect_from_remote_url(url, &known_gitlab_hosts) {
            if connected_gitlab_hosts.iter().any(|h| h.eq_ignore_ascii_case(&detected.host)) {
                return link_if_unlinked(&db, &project_id, |conn| {
                    queries::link_project_gitlab(conn, &project_id, &detected.project, &detected.host)
                });
            } else if needs_token.is_none() {
                // The host, not the group: a GitLab token authenticates against the whole
                // instance, so that is what the hint has to tell the user to connect.
                needs_token = Some(AutoLinkResult::NeedsToken { provider: "gitlab".to_string(), identifier: detected.host });
            }
        } else if let Some(detected) = bitbucket::detect_from_remote_url(url) {
            // No allowlist to consult: bitbucket.org is recognisable on its own, and the workspace
            // decides whether there is a credential for it.
            if connected_bitbucket_workspaces.iter().any(|w| w.eq_ignore_ascii_case(&detected.workspace)) {
                return link_if_unlinked(&db, &project_id, |conn| {
                    queries::link_project_bitbucket(conn, &project_id, &detected.workspace, &detected.repo)
                });
            } else if needs_token.is_none() {
                needs_token = Some(AutoLinkResult::NeedsToken {
                    provider: "bitbucket".to_string(),
                    identifier: detected.workspace,
                });
            }
        } else if let Some(detected) = ado::detect_from_remote_url(url) {
            // The *connected* spelling is what gets written, not the one in the remote URL. They
            // match case-insensitively — that is the test on this line — and Azure treats them as
            // one organisation, but everything downstream that names an org by this column should
            // name it the way the user connected it. Writing the URL's spelling is what used to
            // leave a project pointing at `myorg` while Settings had `MyOrg`.
            if let Some(connected) =
                connected_ado_orgs.iter().find(|o| o.eq_ignore_ascii_case(&detected.org))
            {
                return link_if_unlinked(&db, &project_id, |conn| {
                    queries::link_project_ado(conn, &project_id, connected, &detected.project, &detected.repo)
                });
            } else if needs_token.is_none() {
                needs_token = Some(AutoLinkResult::NeedsToken { provider: "azure".to_string(), identifier: detected.org });
            }
        }
    }

    Ok(needs_token.unwrap_or(AutoLinkResult::NotDetected))
}

fn link_if_unlinked(
    db: &State<'_, Db>,
    project_id: &str,
    link: impl FnOnce(&rusqlite::Connection) -> rusqlite::Result<()>,
) -> Result<AutoLinkResult, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let read = || queries::get_project(&conn, project_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Project not found".to_string());
    let mut project = read()?;
    // A desktop or phone may have linked the project while detection read the Git remotes.
    if linked_repo(&project).is_err() {
        link(&conn).map_err(|e| e.to_string())?;
        project = read()?;
    }
    Ok(AutoLinkResult::Linked { project })
}

pub(crate) fn pat_for_org(org: &str) -> Result<String, String> {
    secrets::ado_pat(org)?
        .ok_or_else(|| format!("No Azure DevOps token saved for organization \"{org}\" — connect it in Settings first"))
}

/// Checks an organization + token pair against Azure DevOps and answers with the display name of
/// the account the token belongs to.
///
/// Takes the PAT as an argument rather than reading the saved one, because the point is to run
/// *before* anything is stored: saving first and verifying after would mean a bad token
/// overwriting a good one that was already there, and a rollback path to get it back.
///
/// `connectionData` is the endpoint for this. It is org-scoped, so a typo'd organization fails
/// here rather than at the first PR listing; it needs no scope of its own, so it can't pass for a
/// token that is merely missing one it needs; and it names the account, which turns "saved" into
/// "connected as Sofía Rodríguez" — the difference between a form that accepted your input and one
/// that actually reached the server.
#[tauri::command]
pub async fn ado_verify_pat(org: String, pat: String) -> Result<String, String> {
    ado::authenticated_user_name(&org, &pat).await
}

/// The same check as [`ado_verify_pat`], for an organization whose token is *already* saved —
/// answering the question "is this connection still good?" without asking the user to paste the
/// token again. A PAT expires (Azure caps them at a year, and the default is 30 days), so a row
/// that was genuinely connected when it was added can stop being so on its own.
#[tauri::command]
pub async fn ado_check_org(org: String) -> Result<String, String> {
    let pat = pat_for_org(&org)?;
    ado::authenticated_user_name(&org, &pat).await
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

/// Clears whichever VCS link (Azure DevOps, GitHub or GitLab) a project currently has — the
/// sidebar's "Disconnect" doesn't need to know which provider it was.
#[tauri::command]
pub fn unlink_project(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::unlink_project(&conn, &id).map_err(|e| e.to_string())
}

/// Percent-encodes spaces in an Azure DevOps org/project/repo path segment for a browser URL
/// (those names routinely contain spaces — "Marketing Website"). GitHub owner/repo can't
/// contain spaces, so they need no encoding.
///
/// Deliberately **not** what a GitLab API path needs: there the project's slashes have to become
/// `%2F` or the router reads them as route segments. That encoder lives in `gitlab.rs`; this one
/// stays correct for GitLab's *browser* URLs, where the slashes must stay literal.
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
    let known_gitlab_hosts = gitlab_known_hosts(db)?;
    for remote in &ordered {
        if let Some(d) = github::detect_from_remote_url(&remote.url, &known_github_hosts) {
            return Ok(Some(format!("https://{}/{}/{}", d.host, d.owner, d.repo)));
        }
        if let Some(d) = gitlab::detect_from_remote_url(&remote.url, &known_gitlab_hosts) {
            return Ok(Some(format!("https://{}/{}", d.host, d.project)));
        }
        if let Some(d) = bitbucket::detect_from_remote_url(&remote.url) {
            return Ok(Some(bitbucket::web_repo_url(&d.workspace, &d.repo)));
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

pub(crate) fn load_project(db: &State<'_, Db>, project_id: &str) -> Result<crate::db::models::Project, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::get_project(&conn, project_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Project not found".to_string())
}

/// One page of a linked repository's pull requests, from whichever host it lives on.
async fn fetch_pr_page(link: &LinkedRepo, scope: ado::PrListScope, page: u32) -> Result<ado::PrPage, String> {
    match link {
        LinkedRepo::Azure { org, project: ado_project, repo_id } => {
            let pat = pat_for_org(org)?;
            ado::list_pull_requests_page(org, ado_project, repo_id, scope, page, &pat).await
        }
        LinkedRepo::GitHub { host, owner, repo } => {
            let token = github_token(host)?;
            github::list_pull_requests_page(host, owner, repo, scope, page, &token).await
        }
        LinkedRepo::GitLab { host, project: path } => {
            let token = gitlab_token(host)?;
            gitlab::list_merge_requests_page(host, path, scope, page, &token).await
        }
        LinkedRepo::Bitbucket { workspace, repo } => {
            let auth = bitbucket_auth(workspace)?;
            bitbucket::list_pull_requests_page(workspace, repo, scope, page, &auth).await
        }
    }
}

/// The open pull requests of a project's repository whose review is asked of the signed-in user —
/// what the Flujos pull-request trigger's "review requested" watches.
pub async fn pr_review_requested(db: State<'_, Db>, project_id: String) -> Result<Vec<i64>, String> {
    let project = load_project(&db, &project_id)?;
    match linked_repo(&project)? {
        LinkedRepo::Azure { org, project: ado_project, repo_id } => {
            let pat = pat_for_org(&org)?;
            ado::review_requested_ids(&org, &ado_project, &repo_id, &pat).await
        }
        LinkedRepo::GitHub { host, owner, repo } => {
            let token = github_token(&host)?;
            github::review_requested_numbers(&host, &owner, &repo, &token).await
        }
        LinkedRepo::GitLab { host, project: path } => {
            let token = gitlab_token(&host)?;
            gitlab::review_requested_iids(&host, &path, &token).await
        }
        LinkedRepo::Bitbucket { workspace, repo } => {
            let auth = bitbucket_auth(&workspace)?;
            bitbucket::review_requested_ids(&workspace, &repo, &auth).await
        }
    }
}

/// One pull request of a linked repository, read directly by number — however old it is and
/// whatever its state. Never looked up inside a list: a list is one page, and an open pull request
/// a few weeks old is routinely not on the first one.
pub(crate) async fn fetch_linked_pull_request(link: &LinkedRepo, pr_id: i64) -> Result<ado::PullRequestSummary, String> {
    match link {
        LinkedRepo::Azure { org, project: ado_project, repo_id } => {
            let pat = pat_for_org(org)?;
            Ok(ado::get_pull_request(org, ado_project, repo_id, pr_id, &pat).await?.summary)
        }
        LinkedRepo::GitHub { host, owner, repo } => {
            let token = github_token(host)?;
            github::get_pull_request(host, owner, repo, pr_id, &token).await
        }
        LinkedRepo::GitLab { host, project: path } => {
            let token = gitlab_token(host)?;
            gitlab::get_merge_request(host, path, pr_id, &token).await
        }
        LinkedRepo::Bitbucket { workspace, repo } => {
            let auth = bitbucket_auth(workspace)?;
            bitbucket::get_pull_request(workspace, repo, pr_id, &auth).await
        }
    }
}

/// The first page of the repository's **open** pull requests.
///
/// Kept, with its signature, for the phone, which calls it by name (`remotectl::dispatch`). It used
/// to be the first hundred of every state; the desktop pages through any scope with
/// [`list_pull_requests_page`].
#[tauri::command]
pub async fn list_pull_requests(
    db: State<'_, Db>,
    project_id: String,
) -> Result<Vec<ado::PullRequestSummary>, String> {
    let project = load_project(&db, &project_id)?;
    Ok(fetch_pr_page(&linked_repo(&project)?, ado::PrListScope::Open, 1).await?.items)
}

/// One page of the repository's pull requests: `scope` is `"open"` (the default), `"closed"`
/// (merged and closed) or `"all"`; `page` is 1-based.
#[tauri::command]
pub async fn list_pull_requests_page(
    db: State<'_, Db>,
    project_id: String,
    scope: Option<String>,
    page: Option<u32>,
) -> Result<ado::PrPage, String> {
    let project = load_project(&db, &project_id)?;
    let link = linked_repo(&project)?;
    fetch_pr_page(&link, ado::PrListScope::parse(scope.as_deref()), page.unwrap_or(1)).await
}

/// One pull request, read directly from its host — what opens a PR that isn't on the loaded page
/// (an Activity row, a notification, a closed one) and what refreshes one on screen.
#[tauri::command]
pub async fn get_pull_request(
    db: State<'_, Db>,
    project_id: String,
    pr_id: i64,
) -> Result<ado::PullRequestSummary, String> {
    let project = load_project(&db, &project_id)?;
    fetch_linked_pull_request(&linked_repo(&project)?, pr_id).await
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
    /// GitHub or GitLab host, or the Azure DevOps organization, the token is missing for.
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

/// Resolves a pasted pull-request URL — GitHub (including Enterprise), GitLab (including
/// self-managed) or Azure DevOps — into a PR plus the local repository it belongs to, linking that
/// repository to its host if it wasn't already. This is what makes "review this PR" reachable from
/// a link someone sent you, instead of only from the sidebar list of a project you already had open.
#[tauri::command]
pub async fn resolve_pr_link(db: State<'_, Db>, url: String) -> Result<PrLinkResolution, String> {
    let known_hosts = github_known_hosts(&db)?;
    let known_gitlab_hosts = gitlab_known_hosts(&db)?;
    let Some(target) = crate::pr_link::parse(&url, &known_hosts, &known_gitlab_hosts) else {
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
        crate::pr_link::PrLinkTarget::GitLab { host, project: path, number } => {
            let Some(token) = secrets::get_secret(&secrets::gitlab_token_key(&host))? else {
                return Ok(PrLinkResolution::NeedsToken {
                    provider: "gitlab".to_string(),
                    identifier: host,
                });
            };
            let pr = gitlab::get_merge_request(&host, &path, number, &token).await?;
            let found = find_project_for_link(
                &db,
                &projects,
                |p| {
                    same_opt(&p.gitlab_project, &path)
                        && same(p.gitlab_host.as_deref().unwrap_or(gitlab::GITLAB_COM), &host)
                        // GitHub outranks GitLab in `linked_repo`, so a project carrying both
                        // would dispatch there. The remote pass below repairs the columns.
                        && !(p.github_owner.is_some() && p.github_repo.is_some())
                },
                |remote_url| {
                    gitlab::detect_from_remote_url(remote_url, &known_gitlab_hosts)
                        .map(|d| same(&d.host, &host) && same(&d.project, &path))
                        .unwrap_or(false)
                },
                |conn, project_id| {
                    queries::link_project_gitlab(conn, project_id, &path, &host)
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
                    provider: "gitlab".to_string(),
                    repo_label: path.clone(),
                    clone_url: format!("https://{host}/{path}.git"),
                    pr,
                },
            })
        }
        crate::pr_link::PrLinkTarget::Bitbucket { workspace, repo, number } => {
            let Some(raw) = secrets::get_secret(&secrets::bitbucket_token_key(&workspace))? else {
                return Ok(PrLinkResolution::NeedsToken {
                    provider: "bitbucket".to_string(),
                    identifier: workspace,
                });
            };
            let auth = bitbucket::BitbucketAuth::from_secret(&raw).ok_or_else(|| {
                format!("The Bitbucket credential saved for \"{workspace}\" is unreadable — connect the workspace again in Settings")
            })?;
            let pr = bitbucket::get_pull_request(&workspace, &repo, number, &auth).await?;
            let found = find_project_for_link(
                &db,
                &projects,
                |p| {
                    same_opt(&p.bitbucket_workspace, &workspace)
                        && same_opt(&p.bitbucket_repo, &repo)
                        // GitHub and GitLab outrank Bitbucket in `linked_repo`; a project carrying
                        // either one's columns too would dispatch there. The remote pass repairs it.
                        && !(p.github_owner.is_some() && p.github_repo.is_some())
                        && p.gitlab_project.is_none()
                        && p.bitbucket_repo.is_none()
                },
                |remote_url| {
                    bitbucket::detect_from_remote_url(remote_url)
                        .map(|d| same(&d.workspace, &workspace) && same(&d.repo, &repo))
                        .unwrap_or(false)
                },
                |conn, project_id| {
                    queries::link_project_bitbucket(conn, project_id, &workspace, &repo)
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
                    provider: "bitbucket".to_string(),
                    repo_label: format!("{workspace}/{repo}"),
                    clone_url: format!("{}.git", bitbucket::web_repo_url(&workspace, &repo)),
                    pr,
                },
            })
        }
        crate::pr_link::PrLinkTarget::Azure { org, project: ado_project, repo, number } => {
            // The organisation as it was *connected*, when it is one of them. A pasted link carries
            // whatever spelling the URL had — `parse_azure` even lowercases a `*.visualstudio.com`
            // host — and this value is written into `projects.ado_org` further down. Same rule as
            // `auto_link_project`: the column names the organisation the way Settings does, or the
            // PAT lookup ends up asking for a key nobody wrote.
            let org = ado_connected_orgs(&db)?
                .into_iter()
                .find(|known| known.eq_ignore_ascii_case(&org))
                .unwrap_or(org);
            let Some(pat) = secrets::ado_pat(&org)? else {
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
                        // `linked_repo` ranks GitHub and GitLab above Azure, so a project carrying
                        // either one's columns as well would dispatch there instead. Leave it to
                        // the remote pass, which repairs the columns.
                        && !(p.github_owner.is_some() && p.github_repo.is_some())
                        && p.gitlab_project.is_none()
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
    let known_gitlab_hosts = gitlab_known_hosts(db)?;
    let target = crate::pr_link::parse(url, &known_hosts, &known_gitlab_hosts)
        .ok_or_else(|| "That isn't a pull-request link CodeFlow can read".to_string())?;
    let credential = match &target {
        crate::pr_link::PrLinkTarget::GitHub { host, .. } => github_token(host)?,
        crate::pr_link::PrLinkTarget::GitLab { host, .. } => gitlab_token(host)?,
        // The whole credential as the keychain holds it; `link_host` reads it back.
        crate::pr_link::PrLinkTarget::Bitbucket { workspace, .. } => bitbucket_auth(workspace)?.to_secret(),
        crate::pr_link::PrLinkTarget::Azure { org, .. } => pat_for_org(org)?,
    };
    Ok((target, credential))
}

/// How a repo-less pull request names the repository it lives in — "owner/repo" on GitHub, the
/// full group path on GitLab, "project/repo" on Azure DevOps — plus where it could be cloned from.
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
        // GitLab links always carry the human-readable path, so `canonical` never applies here —
        // the same reason it doesn't on GitHub.
        crate::pr_link::PrLinkTarget::GitLab { host, project, .. } => {
            (project.clone(), format!("https://{host}/{project}.git"))
        }
        crate::pr_link::PrLinkTarget::Bitbucket { workspace, repo, .. } => {
            (format!("{workspace}/{repo}"), format!("{}.git", bitbucket::web_repo_url(workspace, repo)))
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
    /// The repository's memory key — the same one its project would have (see [`link_repo_key`]).
    repo_key: String,
}

/// The repository a pull-request link points at, as the [`LinkedRepo`] its project would hold once
/// cloned and linked — and so [`repo_key`] gives both the same memory key. That equality is the
/// whole contract: a link review's runs are found again by the project's review of the same PR
/// because both name the repository identically (provider, host, owner/group/org and project, repo;
/// case-folded). `canonical` is Azure's own project/repo names: a link may address them by GUID, and
/// a clone's remote never does.
fn link_repo_key(target: &crate::pr_link::PrLinkTarget, canonical: Option<(&str, &str)>) -> String {
    let link = match target {
        crate::pr_link::PrLinkTarget::GitHub { host, owner, repo, .. } => {
            LinkedRepo::GitHub { host: host.clone(), owner: owner.clone(), repo: repo.clone() }
        }
        crate::pr_link::PrLinkTarget::GitLab { host, project, .. } => {
            LinkedRepo::GitLab { host: host.clone(), project: project.clone() }
        }
        crate::pr_link::PrLinkTarget::Bitbucket { workspace, repo, .. } => {
            LinkedRepo::Bitbucket { workspace: workspace.clone(), repo: repo.clone() }
        }
        crate::pr_link::PrLinkTarget::Azure { org, project, repo, .. } => {
            let (project, repo) = canonical.unwrap_or((project, repo));
            LinkedRepo::Azure { org: org.clone(), project: project.to_string(), repo_id: repo.to_string() }
        }
    };
    repo_key(&link)
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
            Ok(LinkPr { pr, diff, repo_label, clone_url, repo_key: link_repo_key(target, None) })
        }
        crate::pr_link::PrLinkTarget::GitLab { host, project, number } => {
            let pr = gitlab::get_merge_request(host, project, *number, credential).await?;
            let diff = gitlab::merge_request_diff(host, project, *number, credential).await?;
            let (repo_label, clone_url) = link_repo_coords(target, None);
            Ok(LinkPr { pr, diff, repo_label, clone_url, repo_key: link_repo_key(target, None) })
        }
        crate::pr_link::PrLinkTarget::Bitbucket { workspace, repo, number } => {
            let auth = bitbucket_link_auth(credential);
            let pr = bitbucket::get_pull_request(workspace, repo, *number, &auth).await?;
            let diff = bitbucket::pull_request_diff(workspace, repo, *number, &auth).await?;
            let (repo_label, clone_url) = link_repo_coords(target, None);
            Ok(LinkPr { pr, diff, repo_label, clone_url, repo_key: link_repo_key(target, None) })
        }
        crate::pr_link::PrLinkTarget::Azure { org, project, repo, number } => {
            // Canonical names, so a link carrying GUIDs still addresses the blobs endpoint.
            let detail = ado::get_pull_request(org, project, repo, *number, credential).await?;
            let diff =
                ado::pull_request_diff(org, &detail.project_name, &detail.repo_name, *number, credential).await?;
            let canonical = Some((detail.project_name.as_str(), detail.repo_name.as_str()));
            let (repo_label, clone_url) = link_repo_coords(target, canonical);
            let repo_key = link_repo_key(target, canonical);
            Ok(LinkPr { pr: detail.summary, diff, repo_label, clone_url, repo_key })
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
        crate::pr_link::PrLinkTarget::GitLab { host, project, number } => {
            slugify(&format!("gitlab-{host}-{project}-{number}"))
        }
        crate::pr_link::PrLinkTarget::Bitbucket { workspace, repo, number } => {
            slugify(&format!("bitbucket-{workspace}-{repo}-{number}"))
        }
        crate::pr_link::PrLinkTarget::Azure { org, project, repo, number } => {
            slugify(&format!("azure-{org}-{project}-{repo}-{number}"))
        }
    };
    let dir = paths::pr_link_review_dir(&slug);
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
    // The account to run under when the review names its own engine; `None` resolves it as usual.
    agent_account: Option<String>,
    // The human already said "review it anyway" to a question the review asked (a promotion).
    force: Option<bool>,
) -> Result<String, String> {
    let force = force.unwrap_or(false);
    let (target, credential) = link_credentials(&db, &url)?;

    let (contexts, skills, config, review_prompt) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let contexts = queries::list_review_contexts(&conn, &workspace_id).map_err(|e| e.to_string())?;
        let skills = queries::list_workspace_skills(&conn, &workspace_id).map_err(|e| e.to_string())?;
        let config = match (agent_provider.as_deref(), agent_model.as_deref()) {
            (Some(p), Some(m)) if !p.trim().is_empty() && !m.trim().is_empty() => {
                load_ai_config_as(&conn, p, m, crate::ai_accounts::Choice::parse(agent_account.as_deref()), Some(AiTask::Review), Some(&workspace_id))?
            }
            _ => load_ai_config_in(&conn, AiTask::Review, Some(&workspace_id))?,
        };
        // The same methodology and the same level directive the project-backed pipeline uses — a
        // review with no clone is shallower in what it can *read*, not in the rules it is held to.
        let (engine_config, contract) = review_pipeline::contract_for(&conn, &workspace_id, &level);
        let prompts = review_pipeline::ReviewPrompts::load(&conn, &workspace_id, &contract)?;
        // The single reviewer writes the report's prose, so it is asked for what is right too.
        let prompt = format!("{}{}", prompts.for_role(None), ai::REVIEW_POSITIVES_NOTE);
        (contexts, skills, config, (prompt, contract.effort.clone(), engine_config, contract))
    };
    let (review_prompt, effort, engine_config, contract) = review_prompt;
    let blocking = crate::review::contract::blocking_severities(&engine_config);

    let LinkPr { pr, diff: diff_text, repo_label, clone_url, repo_key: repo } = fetch_pr_and_diff(&target, &credential).await?;
    // A promotion asks before its first review, the same question a project's plan asks — and, like
    // there, costs nothing and records nothing; the panel offers "review anyway" (`force`).
    if !force {
        let first = {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            let scope = queries::MemoryScope { project_id: None, workspace_id: &workspace_id, repo_key: &repo };
            queries::count_review_runs(&conn, &scope, pr.id).unwrap_or(0) == 0
        };
        if let Some(skip) = review_pipeline::link_promotion_skip(&diff_text, &engine_config, &pr.source_branch, &pr.target_branch, first) {
            return Ok(format!("{}{}", review_pipeline::SKIP_MARKER, skip.reason));
        }
    }
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

    // This pull request's memory, kept by repository: what earlier link reviews (or a clone of the
    // same repository in this workspace) left — the findings to re-judge, the ones a human ruled on,
    // and when it was last looked at.
    let scope = queries::MemoryScope { project_id: None, workspace_id: &workspace_id, repo_key: &repo };
    let (remembered, last_run_at, repo_rules) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let remembered: Vec<crate::review_memory::MemoryFinding> = queries::latest_review_findings(&conn, &scope, pr.id)
            .ok()
            .flatten()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default();
        let rules: Vec<crate::review_memory::FpSuppression> =
            crate::commands::settings::load_fp_suppressions(&conn, &workspace_id)
                .into_iter()
                .filter(|r| r.repo_key.eq_ignore_ascii_case(&repo))
                .collect();
        (remembered, queries::latest_review_run_at(&conn, &scope, pr.id).ok().flatten(), rules)
    };
    // What this repository keeps dismissing, by category — read by its repository key, so a link
    // review and a clone's share one history: a raised confidence bar for those (never a filter).
    let calibration = match db.0.lock() {
        Ok(conn) => review_pipeline::calibration_for(&conn, &workspace_id, &repo, pr.id, &engine_config.calibration),
        Err(_) => Vec::new(),
    };
    let calibration_min_confidence = engine_config.calibration.min_confidence;
    // The reviewer reads the whole diff every time — there is no clone to bound a delta with — so
    // every previous finding still in the code comes back for a verdict.
    let mut reevaluate: Vec<crate::review_memory::MemoryFinding> =
        remembered.iter().filter(|f| f.needs_judgement()).cloned().collect();
    // The debt scan, on the files the host's diff names.
    let touched: Vec<String> = diff_text
        .lines()
        .filter_map(|l| l.strip_prefix("+++ b/").map(|p| p.trim().to_string()))
        .collect();
    let foreign_debt = match db.0.lock() {
        Ok(conn) => foreign_debt_for(&conn, &workspace_id, &repo, pr.id, &touched),
        Err(_) => Vec::new(),
    };
    reevaluate.extend(foreign_debt.iter().map(|d| d.for_review()));

    // The conversation already open on the PR, same as the project-backed review.
    let mut open_threads = match &target {
        crate::pr_link::PrLinkTarget::GitHub { host, owner, repo, number } => {
            github::list_pr_comment_threads(host, owner, repo, *number, &credential).await.unwrap_or_default()
        }
        crate::pr_link::PrLinkTarget::GitLab { host, project, number } => {
            gitlab::list_pr_comment_threads(host, project, *number, &credential).await.unwrap_or_default()
        }
        crate::pr_link::PrLinkTarget::Bitbucket { workspace, repo, number } => {
            bitbucket::list_pr_comment_threads(workspace, repo, *number, &bitbucket_link_auth(&credential))
                .await
                .unwrap_or_default()
        }
        crate::pr_link::PrLinkTarget::Azure { org, project, repo, number } => {
            ado::list_pr_comment_threads(org, project, repo, *number, &credential).await.unwrap_or_default()
        }
    };
    // What the PR's own threads decided about the findings this app published, into the memory (and
    // its newest run) before the reviewer is told anything — same as the project-backed review. No
    // clone means no delta, so nothing counts as "the code moved" here.
    let azure = match &target {
        crate::pr_link::PrLinkTarget::Azure { org, project, repo, .. } => {
            Some((org.clone(), project.clone(), repo.clone(), credential.clone()))
        }
        _ => None,
    };
    let pr_threads = verdict_threads(azure, pr.id, &open_threads, &remembered).await;
    let pr_readings = crate::review::threads::read(
        &remembered,
        &pr_threads,
        matches!(target, crate::pr_link::PrLinkTarget::GitHub { .. }),
    );
    let mut remembered = remembered;
    let pr_sync = match db.0.lock() {
        Ok(conn) => sync_memory_from_pr(&conn, &scope, pr.id, &mut remembered, &pr_readings, None),
        Err(_) => Default::default(),
    };
    // A finding the team just ruled out is not handed back for a verdict; accepted debt still is.
    reevaluate.retain_mut(|f| match remembered.iter().find(|r| r.id == f.id && pr_sync.applied.iter().any(|s| s.id == r.id)) {
        Some(synced) => {
            *f = synced.clone();
            synced.needs_judgement()
        }
        None => true,
    });
    // A conversation somebody already resolved is not pending: handed over, it gets answered again.
    open_threads.retain(|thread| !thread.resolved);
    // The same blocks the project pipeline cuts per reviewer, for the one reviewer that reads it all.
    let inputs = crate::review::context::ReviewInputs {
        remembered: remembered.clone(),
        reevaluate: reevaluate.clone(),
        threads: open_threads,
        since: last_run_at,
        rules: repo_rules.clone(),
        calibration: calibration.clone(),
        calibration_min_confidence,
        ..Default::default()
    };
    enabled_contexts.extend(
        crate::review::context::contexts_for(&inputs, &[], crate::review::context::Audience::All),
    );


    // The CI's line coverage, read beside the review — and only when this level would say something.
    let coverage_threshold = contract.warn_code_coverage_below_pct;
    let result = crate::ai_runs::scoped(app.clone(), Some(job_id.clone()), async {
        let coverage = async {
            if coverage_threshold == 0 {
                return None;
            }
            coverage_on_link(&target, &credential).await
        };
        let review = async {
            if !calibration.is_empty() {
                if let Some(ctx) = crate::ai_runs::current() {
                    crate::ai_runs::emit_line(
                        &ctx,
                        "stdout",
                        &format!(
                            "  calibración: {} categoría(s) que este repo viene descartando piden confianza ≥ {}",
                            calibration.len(),
                            calibration_min_confidence
                        ),
                    );
                }
            }
            // The pre-scan and the deterministic rules, reading the files through the host's API —
            // inside the run, so the job's log shows them and a cancel stops them too.
            let deterministic = crate::review::deterministic::for_link(
                &engine_config.deterministic,
                &contract.level,
                &target,
                &credential,
                &pr.source_branch,
                &diff_text,
            )
            .await;
            if let Some(ctx) = crate::ai_runs::current() {
                for line in deterministic.log_lines() {
                    crate::ai_runs::emit_line(&ctx, "stdout", &line);
                }
            }
            let mut contexts = enabled_contexts.clone();
            contexts.extend(deterministic.contexts());
            ai::review_pull_request(
                &*config.engine,
                &config.binary,
                &config.model,
                &pr.title,
                &pr.description,
                &contexts,
                &diff_text,
                &config.tools,
                &cwd,
                &review_prompt,
                Some(effort.as_str()),
            )
            .await
            .map(|text| (text, deterministic))
        };
        let (reviewed, pct) = tokio::join!(review, coverage);
        reviewed.map(|(text, deterministic)| (text, deterministic, pct))
    })
    .await;
    let (result, deterministic, coverage_pct) = match result {
        Ok((text, deterministic, pct)) => (Ok(text), deterministic, pct),
        Err(e) => (Err(e), Default::default(), None),
    };

    // A stopped run leaves nothing behind, same as the project-backed review.
    if matches!(&result, Err(e) if e.starts_with(crate::ai_runs::CANCELLED_MARKER)) {
        return result;
    }

    // Reconciled against this PR's memory and saved as a run — the same as a project's review, so
    // its findings keep their ids across iterations, a re-publish replies on their threads, and the
    // day the repository is cloned its project picks the memory up (see `link_repo_key`).
    let result = match result {
        Ok(text) => match db.0.lock() {
            Ok(conn) => {
                let mut outcome = review_pipeline::link_outcome(
                    &text,
                    &contract,
                    &repo_rules,
                    &reevaluate,
                    &diff_text,
                    &calibration,
                    calibration_min_confidence,
                    &deterministic,
                );
                // Non-blocking, and only when the CI published a number below the level's line.
                if let Some(note) = crate::review::context::coverage_note(coverage_pct, coverage_threshold) {
                    outcome.notes.push(note);
                }
                Ok(finalize_review(
                    &conn,
                    &job_id,
                    None,
                    &repo_label,
                    &repo,
                    &workspace_id,
                    &pr,
                    &level,
                    config.engine.label(),
                    &config.model,
                    &diff_text,
                    "",
                    None,
                    None,
                    &foreign_debt,
                    outcome,
                    &contract,
                    &blocking,
                ))
            }
            Err(_) => Ok(text),
        },
        Err(e) => Err(e),
    };

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

    if result.is_ok() {
        crate::flows::triggers::app_event(
            &app,
            "prReviewFinished",
            serde_json::json!({"url": url, "level": level, "jobId": job_id}),
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
        crate::pr_link::PrLinkTarget::GitLab { host, project, number } => {
            gitlab::get_merge_request(host, project, *number, &credential).await
        }
        crate::pr_link::PrLinkTarget::Bitbucket { workspace, repo, number } => {
            bitbucket::get_pull_request(workspace, repo, *number, &bitbucket_link_auth(&credential)).await
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
        crate::pr_link::PrLinkTarget::GitLab { host, project, number } => {
            gitlab::list_pr_comment_threads(host, project, *number, &credential).await
        }
        crate::pr_link::PrLinkTarget::Bitbucket { workspace, repo, number } => {
            bitbucket::list_pr_comment_threads(workspace, repo, *number, &bitbucket_link_auth(&credential)).await
        }
        crate::pr_link::PrLinkTarget::Azure { org, project, repo, number } => {
            ado::list_pr_comment_threads(org, project, repo, *number, &credential).await
        }
    }
}

/// Replying to and closing a conversation on the host, addressed by link — the repo-less twin of
/// [`resolve_pr_comment_thread`]. Both are host calls, so a review with no clone answers and closes
/// a conversation exactly like a project-backed one does.
#[tauri::command]
pub async fn pr_link_resolve_comment_thread(
    db: State<'_, Db>,
    url: String,
    thread_id: i64,
    body: Option<String>,
    wont_fix: bool,
) -> Result<ThreadCloseOutcome, String> {
    let (target, credential) = link_credentials(&db, &url)?;
    let (host, pr_id) = link_host(&target, &credential);
    reply_and_close_thread(host, pr_id, thread_id, body.as_deref(), wont_fix).await
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
        crate::pr_link::PrLinkTarget::GitLab { host, project, number } => {
            gitlab::viewer_decision(host, project, *number, &credential).await
        }
        crate::pr_link::PrLinkTarget::Bitbucket { workspace, repo, number } => {
            bitbucket::viewer_decision(workspace, repo, *number, &bitbucket_link_auth(&credential)).await
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
        crate::pr_link::PrLinkTarget::GitLab { host, project, number } => {
            match action.as_str() {
                "approve" => gitlab::submit_pr_review(host, project, *number, "APPROVE", &comment, &credential).await,
                // GitLab has no free-tier "changes requested" state, so the client withdraws any
                // approval and posts the explanation — which is why a comment is required here
                // rather than optional as it is on GitHub.
                "request_changes" => {
                    let text = if comment.trim().is_empty() { "Cambios solicitados desde CodeFlow." } else { &comment };
                    gitlab::submit_pr_review(host, project, *number, "REQUEST_CHANGES", text, &credential).await
                }
                "close" => gitlab::close_merge_request(host, project, *number, &credential).await,
                other => Err(format!("unknown PR action: {other}")),
            }?;
            (gitlab::get_merge_request(host, project, *number, &credential).await?, None)
        }
        crate::pr_link::PrLinkTarget::Bitbucket { workspace, repo, number } => {
            let auth = bitbucket_link_auth(&credential);
            bitbucket_decide(workspace, repo, *number, &action, &comment, &auth).await?;
            (bitbucket::get_pull_request(workspace, repo, *number, &auth).await?, None)
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
/// With `run_id` it is [`publish_pr_review`] by link: the run's memory (kept by repository, see
/// `link_repo_key`) is reconciled against, so a finding continues the thread it opened last time.
/// Without one — a review saved before link reviews kept memory — every finding opens a fresh
/// thread. Every item is attempted even if one fails, and the outcome says which landed.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn post_pr_link_review_comment(
    db: State<'_, Db>,
    url: String,
    items: Vec<PostFindingItem>,
    post_summary: bool,
    summary: Option<String>,
    // The saved run being published, and whether to close the threads of its resolved findings —
    // the project publish's two arguments, for a link review now that it keeps memory.
    run_id: Option<String>,
    close_resolved: Option<bool>,
) -> Result<PublishOutcome, String> {
    let (target, credential) = link_credentials(&db, &url)?;
    let (host, number) = link_host(&target, &credential);
    // The run this review saved, when it is one: since link reviews keep memory, the same
    // reconciling publish a project gets — one thread per finding for the PR's whole life,
    // "sigue presente" on the ones still there, and the resolved ones closed as fixed.
    let stored = match run_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) => {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            queries::get_review_run(&conn, id).map_err(|e| e.to_string())?
        }
        None => None,
    };
    // The link may carry GUIDs on Azure; the thread endpoints take either, so they're used as-is.
    let Some(run) = stored else {
        // No memory to reconcile against (a review saved before link reviews kept one): every
        // finding opens a fresh thread, and what is already on the PR is skipped by its text.
        let none = |_: &crate::review_memory::MemoryFinding| -> Option<String> { None };
        return Ok(publish_to_host(&host, number, &items, &mut [], None, post_summary, summary.as_deref(), &none).await);
    };
    let mut findings: Vec<crate::review_memory::MemoryFinding> = serde_json::from_str(&run.findings).unwrap_or_default();
    let iter = run.iter.max(1) as usize;
    let all: Vec<PostFindingItem> = if close_resolved.unwrap_or(false) {
        items.iter().cloned().chain(resolved_closures(&findings, iter, &items)).collect()
    } else {
        items
    };
    // No clone to read the fix from: the diff the run kept is the code there is.
    let diff = run.diff.clone();
    let code = move |f: &crate::review_memory::MemoryFinding| -> Option<String> {
        let (file, span) = (crate::review_memory::resolution_file(f)?, crate::review_memory::resolution_span(f)?);
        crate::review_memory::snippet_from_diff(&diff, file, span)
    };
    let outcome = publish_to_host(&host, number, &all, &mut findings, Some(iter), post_summary, summary.as_deref(), &code).await;
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let json = serde_json::to_string(&findings).unwrap_or_else(|_| "[]".to_string());
        let _ = queries::set_review_run_findings(&conn, &run.id, &json);
    }
    Ok(outcome)
}

/// The head commit a saved run reviewed, from its `meta` — empty for a run with no clone, or one
/// saved before heads were recorded.
fn run_head_sha(meta: &str) -> String {
    serde_json::from_str::<serde_json::Value>(meta)
        .ok()
        .and_then(|m| m.get("head_sha").and_then(serde_json::Value::as_str).map(str::to_string))
        .unwrap_or_default()
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
///
/// Anything *before* the `TITLE:` line is discarded rather than kept as body: the format puts the
/// title first, so whatever came earlier is the model narrating its way to the answer — which is
/// what several CLIs (Gemini's `agy`, Codex, any reasoning model) print alongside it.
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
            }
            continue;
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
        let config = load_ai_config_in(&conn, AiTask::PrDescription, Some(&project.workspace_id))?;
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
    // Azure DevOps only. Ignored by the other two providers, which have no equivalent: a work item
    // is an Azure concept, and a branch policy requiring one is why linking at creation time
    // matters rather than being a convenience.
    work_item_ids: Option<Vec<i64>>,
) -> Result<ado::PullRequestSummary, String> {
    let project = load_project(&db, &project_id)?;
    create_pull_request_for(&project, &title, &description, &source_branch, &target_branch, draft, work_item_ids.unwrap_or_default()).await
}

/// [`create_pull_request`] for a project already in hand — what a team run calls when it finishes
/// with `integrate: pr`, where there is no Tauri `State` to read the project through.
pub(crate) async fn create_pull_request_for(
    project: &crate::db::models::Project,
    title: &str,
    description: &str,
    source_branch: &str,
    target_branch: &str,
    draft: bool,
    work_item_ids: Vec<i64>,
) -> Result<ado::PullRequestSummary, String> {
    let (title, description, source_branch, target_branch) = (title.to_string(), description.to_string(), source_branch.to_string(), target_branch.to_string());
    match linked_repo(project)? {
        LinkedRepo::Azure { org, project: ado_project, repo_id } => {
            let pat = pat_for_org(&org)?;
            ado::create_pull_request(
                &org,
                &ado_project,
                &repo_id,
                &title,
                &description,
                &source_branch,
                &target_branch,
                draft,
                &work_item_ids,
                &pat,
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
        LinkedRepo::GitLab { host, project: path } => {
            let token = gitlab_token(&host)?;
            gitlab::create_merge_request(
                &host, &path, &title, &description, &source_branch, &target_branch, draft, &token,
            )
            .await
        }
        LinkedRepo::Bitbucket { workspace, repo } => {
            let auth = bitbucket_auth(&workspace)?;
            bitbucket::create_pull_request(
                &workspace, &repo, &title, &description, &source_branch, &target_branch, draft, &auth,
            )
            .await
        }
    }
}

/// Work items a pull request could be linked to. Azure DevOps only.
///
/// An empty `query` is not an empty answer: it asks for the caller's own open items, which is the
/// list worth showing before anything has been typed.
#[tauri::command]
pub async fn search_work_items(
    db: State<'_, Db>,
    project_id: String,
    query: String,
) -> Result<Vec<ado::WorkItem>, String> {
    let project = load_project(&db, &project_id)?;
    match linked_repo(&project)? {
        LinkedRepo::Azure { org, project: ado_project, .. } => {
            let pat = pat_for_org(&org)?;
            ado::search_work_items(&org, Some(&ado_project), &query, &pat).await
        }
        // Not an error: the picker asks whenever a PR form is open, and the answer for a GitHub or
        // GitLab repository is simply that there is nothing of this kind to offer.
        _ => Ok(vec![]),
    }
}

/// Work items by id or title text — an empty `query` lists the caller's own open ones — in one
/// project, or anywhere in the organisation when `project` is empty. For the review screen.
#[tauri::command]
pub async fn ado_search_work_items(org: String, project: Option<String>, query: String) -> Result<Vec<ado::WorkItem>, String> {
    let pat = pat_for_org(&org)?;
    let project = project.filter(|p| !p.trim().is_empty());
    ado::search_work_items(&org, project.as_deref(), &query, &pat).await
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
        LinkedRepo::GitLab { host, project: path } => {
            let token = gitlab_token(&host)?;
            gitlab::list_pr_comment_threads(&host, &path, pr_id, &token).await
        }
        LinkedRepo::Bitbucket { workspace, repo } => {
            let auth = bitbucket_auth(&workspace)?;
            bitbucket::list_pr_comment_threads(&workspace, &repo, pr_id, &auth).await
        }
    }
}

/// Azure DevOps' thread status for "this was fixed" — what its own **Resolve** button sets.
const THREAD_FIXED: i32 = 2;

/// One host's coordinates for acting on a pull request — its threads, a publish, a merge, its checks
/// — with the credential already resolved. Exists so each of those is written once and both callers
/// — the project-backed command and its link-only twin, which reach their credentials by different
/// routes — share the same behaviour instead of two drifting copies.
enum ThreadHost<'a> {
    Azure { org: &'a str, project: &'a str, repo: &'a str, pat: &'a str },
    GitHub { host: &'a str, owner: &'a str, repo: &'a str, token: &'a str },
    GitLab { host: &'a str, project: &'a str, token: &'a str },
    /// The credential owned rather than borrowed: it is read back from the one keychain string the
    /// other hosts' tokens travel as, see [`bitbucket_link_auth`].
    Bitbucket { workspace: &'a str, repo: &'a str, auth: bitbucket::BitbucketAuth },
}

/// What closing a conversation from CodeFlow actually managed to do.
///
/// Reply and close are two host calls, and they fail independently: GitHub can take a reply on a
/// conversation-level comment it then refuses to resolve (only review threads can be resolved).
/// Reporting a half-done close as an error would hide the half that worked — the reply the author
/// is now looking at — so the outcome says which parts landed and the UI decides what to show.
#[derive(Debug, Serialize)]
pub struct ThreadCloseOutcome {
    /// True when a comment was written to the thread. False when none was asked for.
    pub replied: bool,
    /// True when the conversation was closed on the host.
    pub resolved: bool,
    /// Why closing didn't happen, when it didn't. Any reply already posted still stands.
    pub error: Option<String>,
}

/// Replies to a comment thread and then closes it on the host.
///
/// Ordering is the same as the finding-discard path's, and for the same reason: the sentence has to
/// land before the conversation is shut, since a thread closed with no explanation on it is worse
/// for the author than an open one.
///
/// `wont_fix` is what makes this honest on Azure, which distinguishes the two closes: a review
/// comment the team decided *not* to act on is closed as "won't fix", not as "fixed". GitHub and
/// GitLab each have a single resolved state, so the flag only shapes the reply there.
///
/// Both halves are best-effort in different ways. A failed reply aborts (there is no point closing
/// a conversation whose explanation never arrived); a failed close comes back in the outcome, with
/// the reply left standing.
async fn reply_and_close_thread(
    host: ThreadHost<'_>,
    pr_id: i64,
    thread_id: i64,
    body: Option<&str>,
    wont_fix: bool,
) -> Result<ThreadCloseOutcome, String> {
    let body = body.map(str::trim).filter(|b| !b.is_empty());
    let mut replied = false;

    if let Some(text) = body {
        match &host {
            ThreadHost::Azure { org, project, repo, pat } => {
                ado::reply_pr_thread(org, project, repo, pr_id, thread_id, text, pat).await?;
            }
            ThreadHost::GitHub { host, owner, repo, token } => {
                // The reply endpoint only addresses inline review comments. A conversation-level
                // comment (which this app also lists as a thread) has no reply chain to join, so
                // rather than dropping the user's words the reply becomes a new PR comment.
                if github::reply_pr_review_comment(host, owner, repo, pr_id, thread_id, text, token)
                    .await
                    .is_err()
                {
                    github::post_pr_comment(host, owner, repo, pr_id, text, token).await?;
                }
            }
            ThreadHost::GitLab { host, project, token } => {
                // Same fallback as GitHub's, for the same reason: a plain merge-request note
                // belongs to no discussion, so rather than dropping the user's words the reply
                // becomes a new note on the merge request.
                if gitlab::reply_pr_comment(host, project, pr_id, thread_id, text, token)
                    .await
                    .is_err()
                {
                    gitlab::post_pr_comment(host, project, pr_id, text, token).await?;
                }
            }
            ThreadHost::Bitbucket { workspace, repo, auth } => {
                // A reply names its parent; should Bitbucket refuse it (the thread was deleted),
                // the words still reach the pull request as a comment of their own.
                if bitbucket::reply_pr_comment(workspace, repo, pr_id, thread_id, text, auth)
                    .await
                    .is_err()
                {
                    bitbucket::post_pr_comment(workspace, repo, pr_id, text, auth).await?;
                }
            }
        }
        replied = true;
    }

    let closed = match &host {
        ThreadHost::Azure { org, project, repo, pat } => {
            let status = if wont_fix { THREAD_WONT_FIX } else { THREAD_FIXED };
            ado::set_pr_thread_status(org, project, repo, pr_id, thread_id, status, pat).await
        }
        ThreadHost::GitHub { host, owner, repo, token } => {
            github::resolve_review_thread_for_comment(host, owner, repo, pr_id, thread_id, token).await
        }
        // Only a diff-anchored discussion is resolvable on GitLab; a plain note is not, and the
        // refusal comes back in the outcome rather than being swallowed as a silent success.
        ThreadHost::GitLab { host, project, token } => {
            gitlab::resolve_discussion_for_note(host, project, pr_id, thread_id, token).await
        }
        // Resolved from the thread's root, which is what `thread_id` is; Bitbucket has one resolved
        // state, so `wont_fix` only shapes the reply, as on GitHub and GitLab.
        ThreadHost::Bitbucket { workspace, repo, auth } => {
            bitbucket::resolve_comment_thread(workspace, repo, pr_id, thread_id, auth).await
        }
    };

    Ok(match closed {
        Ok(()) => ThreadCloseOutcome { replied, resolved: true, error: None },
        Err(e) => ThreadCloseOutcome { replied, resolved: false, error: Some(e) },
    })
}

/// Closes one comment thread on the host — Azure's `fixed`/`won't fix`, GitHub's
/// `resolveReviewThread`, GitLab's resolved discussion — optionally leaving a reply on it first.
///
/// The reply is the point: a reviewer's comment is often closed *without* the change being made
/// ("this is intentional", "handled in another PR"), and closing it silently leaves the author
/// looking at a conversation that ended with no answer. So the comment travels with the close, and
/// `wont_fix` keeps the record straight about which of the two happened.
///
/// `thread_id` is the id [`list_pr_comment_threads`] reported: a real thread on Azure, and the
/// root comment of a review thread on GitHub or of a discussion on GitLab (the shape each host's
/// API addresses). GitHub's conversation-level comments and GitLab's plain notes belong to no
/// resolvable thread at all — that comes back as `resolved: false` with the reason, rather than
/// silently doing nothing.
#[tauri::command]
pub async fn resolve_pr_comment_thread(
    db: State<'_, Db>,
    project_id: String,
    pr_id: i64,
    thread_id: i64,
    body: Option<String>,
    wont_fix: bool,
) -> Result<ThreadCloseOutcome, String> {
    let project = load_project(&db, &project_id)?;
    match linked_repo(&project)? {
        LinkedRepo::Azure { org, project: ado_project, repo_id } => {
            let pat = pat_for_org(&org)?;
            let host = ThreadHost::Azure { org: &org, project: &ado_project, repo: &repo_id, pat: &pat };
            reply_and_close_thread(host, pr_id, thread_id, body.as_deref(), wont_fix).await
        }
        LinkedRepo::GitHub { host, owner, repo } => {
            let token = github_token(&host)?;
            let target = ThreadHost::GitHub { host: &host, owner: &owner, repo: &repo, token: &token };
            reply_and_close_thread(target, pr_id, thread_id, body.as_deref(), wont_fix).await
        }
        LinkedRepo::GitLab { host, project: path } => {
            let token = gitlab_token(&host)?;
            let target = ThreadHost::GitLab { host: &host, project: &path, token: &token };
            reply_and_close_thread(target, pr_id, thread_id, body.as_deref(), wont_fix).await
        }
        LinkedRepo::Bitbucket { workspace, repo } => {
            let auth = bitbucket_auth(&workspace)?;
            let target = ThreadHost::Bitbucket { workspace: &workspace, repo: &repo, auth };
            reply_and_close_thread(target, pr_id, thread_id, body.as_deref(), wont_fix).await
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
///    this" (see `review_memory::discarded_block`). Or `deuda_tecnica` (a reason is required):
///    real and accepted, so also out of the gate — but carried visibly in the report and re-judged
///    whenever its file changes, which is how it ends up `resuelto` (paid). Passing `abierto`
///    reopens any of them.
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

    // Everything touching the database happens inside this scope: the guard cannot be held across
    // the host `.await` below, and the mark must be durable before the PR is told about it.
    let (thread_id, rule_added) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        mark_finding_locally(&conn, &project.workspace_id, &repo, pr_id, &run_id, &finding_id, &estado, motivo.clone(), scope_repo)?
    };
    let mut outcome = DiscardOutcome { host_notified: false, host_error: None, rule_added };
    let (Some(thread_id), Some(body)) = (thread_id.filter(|_| notify_host), mark_reply_body(&estado, motivo.as_deref())) else {
        return Ok(outcome);
    };
    let credential = match link_credential(&link) {
        Ok(c) => c,
        Err(e) => {
            outcome.host_error = Some(e);
            return Ok(outcome);
        }
    };
    notify_mark(linked_host(&link, &credential), pr_id, thread_id, &body, &mut outcome).await;
    Ok(outcome)
}

/// [`discard_pr_finding`] for a review reached by link: same marks, same reply on the host, the
/// pull request addressed by its URL and the rule (if any) filed under the run's repository.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn discard_pr_link_finding(
    db: State<'_, Db>,
    url: String,
    workspace_id: String,
    run_id: String,
    finding_id: String,
    estado: String,
    motivo: Option<String>,
    scope_repo: bool,
    notify_host: bool,
) -> Result<DiscardOutcome, String> {
    let (target, credential) = link_credentials(&db, &url)?;
    let (_, number) = link_host(&target, &credential);
    let (thread_id, rule_added) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        // The run already knows which repository it reviewed — with Azure's canonical names, which
        // the link itself may not carry.
        let repo = queries::get_review_run(&conn, &run_id)
            .ok()
            .flatten()
            .map(|r| crate::review_memory::run_repo_key(&r.meta))
            .filter(|k| !k.is_empty())
            .unwrap_or_else(|| link_repo_key(&target, None));
        mark_finding_locally(&conn, &workspace_id, &repo, number, &run_id, &finding_id, &estado, motivo.clone(), scope_repo)?
    };
    let mut outcome = DiscardOutcome { host_notified: false, host_error: None, rule_added };
    if let (Some(thread_id), Some(body)) = (thread_id.filter(|_| notify_host), mark_reply_body(&estado, motivo.as_deref())) {
        let (host, _) = link_host(&target, &credential);
        notify_mark(host, number, thread_id, &body, &mut outcome).await;
    }
    Ok(outcome)
}

/// The local half of marking a finding — always first, always durable before the host hears of it.
///
/// Moves it through [`crate::review_memory::set_finding_state`] (so a debt without a reason is
/// refused here, like everywhere else), and for a false positive with `scope_repo` files the
/// standing repository rule. Returns the finding's thread and whether a rule was added.
#[allow(clippy::too_many_arguments)]
fn mark_finding_locally(
    conn: &rusqlite::Connection,
    workspace_id: &str,
    repo: &str,
    pr_id: i64,
    run_id: &str,
    finding_id: &str,
    estado: &str,
    motivo: Option<String>,
    scope_repo: bool,
) -> Result<(Option<i64>, bool), String> {
    let run = queries::get_review_run(conn, run_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Review run not found".to_string())?;
    let mut findings: Vec<crate::review_memory::MemoryFinding> =
        serde_json::from_str(&run.findings).map_err(|e| e.to_string())?;
    let f = findings
        .iter_mut()
        .find(|f| f.id == finding_id)
        .ok_or_else(|| "Finding not found in this run".to_string())?;
    // Anything that is not a discard or a debt is a reopen: back to active.
    let target = if matches!(estado, "falso_positivo" | "ignorado" | crate::review_memory::ESTADO_DEUDA) { estado } else { "abierto" };
    crate::review_memory::set_finding_state(f, target, motivo.clone(), run.iter.max(1) as usize)?;
    let (thread_id, categoria, archivo) = (f.thread_id, f.categoria.clone(), f.archivo.clone());

    let json = serde_json::to_string(&findings).map_err(|e| e.to_string())?;
    queries::set_review_run_findings(conn, run_id, &json).map_err(|e| e.to_string())?;

    // A repository rule only makes sense for a rejection, and only for a false positive:
    // "ignorado" says *not now*, and debt says *real, later* — calls about this PR, not the code.
    if !(scope_repo && estado == "falso_positivo") {
        return Ok((thread_id, false));
    }
    let mut rules = crate::commands::settings::load_fp_suppressions(conn, workspace_id);
    // Re-marking the same finding must not stack duplicate rules onto every review's prompt.
    if rules.iter().any(|r| r.repo_key == repo && r.matches(&categoria, archivo.as_deref())) {
        return Ok((thread_id, false));
    }
    rules.insert(
        0,
        crate::review_memory::FpSuppression {
            id: uuid::Uuid::new_v4().to_string(),
            repo_key: repo.to_string(),
            categoria,
            archivo,
            motivo: motivo.unwrap_or_else(|| "Descartado por la persona revisora".to_string()),
            pr_id,
            created_at: chrono::Utc::now().to_rfc3339(),
        },
    );
    crate::commands::settings::save_fp_suppressions(conn, workspace_id, &rules)?;
    Ok((thread_id, true))
}

/// What a mark says on the finding's thread before closing it — `None` for a reopen, which says
/// nothing (the thread is the team's, and reopening a finding here is a note to this reviewer).
fn mark_reply_body(estado: &str, motivo: Option<&str>) -> Option<String> {
    let motivo = motivo.map(str::trim).filter(|m| !m.is_empty());
    match estado {
        crate::review_memory::ESTADO_DEUDA => Some(format!(
            "🧾 **Deuda técnica aceptada:** {}\n\n_Marcado desde CodeFlow. Sigue en el código: se mostrará en las \
             próximas revisiones como deuda y se dará por saldada cuando se corrija._",
            motivo.unwrap_or("aceptada por el equipo")
        )),
        "falso_positivo" | "ignorado" => {
            let etiqueta = if estado == "falso_positivo" { "Falso positivo" } else { "Ignorado" };
            let razon = motivo.map(|m| format!("\n\n> {m}")).unwrap_or_default();
            Some(format!(
                "🚫 **{etiqueta}** — descartado por la persona revisora.{razon}\n\n_Marcado desde CodeFlow. \
                 Este hallazgo no se volverá a reportar en las próximas revisiones._"
            ))
        }
        _ => None,
    }
}

/// The host half of a mark: the reply, then the thread closed as *won't fix* where the host tells
/// that apart from *fixed* (Azure) — a debt or a rejection is not a fix, and the record must not say
/// it was. Reply first, close second: a closed thread with no explanation on it is worse for the
/// author than an open one. Failures land in `outcome`; the mark stands either way.
async fn notify_mark(host: ThreadHost<'_>, pr_id: i64, thread_id: i64, body: &str, outcome: &mut DiscardOutcome) {
    match reply_and_close_thread(host, pr_id, thread_id, Some(body), true).await {
        Ok(done) => {
            outcome.host_notified = done.replied && done.resolved;
            outcome.host_error = done.error;
        }
        Err(e) => outcome.host_error = Some(e),
    }
}

/// What reviewing this PR at `level` would read and roughly cost, without running it.
///
/// Read from the refs already on disk — no fetch, so it answers in a moment and costs nothing; the
/// review itself fetches, so the two can differ by whatever was pushed since. An estimate, and the
/// panel says so.
#[tauri::command]
pub async fn preview_pr_review(
    db: State<'_, Db>,
    project_id: String,
    pr_id: i64,
    level: String,
) -> Result<review_pipeline::ReviewPreview, String> {
    let project = load_project(&db, &project_id)?;
    let link = linked_repo(&project)?;
    let repo = repo_key(&link);
    let workspace_id = project.workspace_id.clone();
    let (engine_config, contract, prompts, context_chars, prev_head) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let (engine_config, contract) = review_pipeline::contract_for(&conn, &workspace_id, &level);
        let prompts = review_pipeline::ReviewPrompts::load(&conn, &workspace_id, &contract)?;
        let context_chars: usize = queries::list_review_contexts(&conn, &workspace_id)
            .map_err(|e| e.to_string())?
            .iter()
            .filter(|c| c.enabled)
            .map(|c| c.name.len() + c.content.len() + 4)
            .sum();
        let scope = queries::MemoryScope { project_id: Some(&project_id), workspace_id: &workspace_id, repo_key: &repo };
        let prev = queries::latest_review_head(&conn, &scope, pr_id).ok().flatten();
        (engine_config, contract, prompts, context_chars, prev)
    };
    let pr = fetch_linked_pull_request(&link, pr_id).await?;
    let local_path = project.local_path.clone();
    // The ref the last review fetched, when there is one — the same head the review would read.
    let fetched = match &link {
        LinkedRepo::GitHub { .. } => Some(format!("refs/remotes/origin/codeflow-pr-{pr_id}")),
        LinkedRepo::GitLab { .. } => Some(format!("refs/remotes/origin/codeflow-mr-{pr_id}")),
        _ => None,
    };
    let head_ref = fetched.filter(|r| git::diff::resolve_sha(&local_path, r).is_ok()).unwrap_or_else(|| pr.source_branch.clone());
    let preamble_chars = pr.title.len() + pr.description.len() + context_chars + 200;
    tokio::task::spawn_blocking(move || {
        let diff = git::diff::get_branch_diff(&local_path, &pr.target_branch, &head_ref)?;
        let changed = prev_head
            .filter(|p| !p.is_empty())
            .and_then(|prev| git::diff::changed_files_between(&local_path, &prev, &head_ref).ok());
        Ok(review_pipeline::preview(
            &local_path,
            &head_ref,
            &diff,
            &contract,
            &engine_config,
            &prompts,
            &pr.status,
            changed.as_deref(),
            preamble_chars,
            Some((pr.source_branch.as_str(), pr.target_branch.as_str())),
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Reviews one pull request of a linked project and saves the run as durable memory.
///
/// `force` is the human's answer to a skip that asks ("it is a draft — review it anyway?"). It is
/// only ever set by the panel in reply to a `REVIEW_SKIPPED::` message; a review never assumes it.
#[tauri::command]
pub async fn review_pull_request(
    app: AppHandle,
    db: State<'_, Db>,
    project_id: String,
    pr_id: i64,
    job_id: String,
    level: String,
    force: bool,
    // When an SDD/Harness agent runs this review, its provider + model + prompt for this run.
    agent_provider: Option<String>,
    agent_model: Option<String>,
    agent_prompt: Option<String>,
    // The account to run under when the review names its own engine; `None` resolves it as usual.
    agent_account: Option<String>,
) -> Result<String, String> {
    let project = load_project(&db, &project_id)?;
    let link = linked_repo(&project)?;
    // Every memory read and write below is scoped to this repository, so a project re-linked
    // elsewhere starts with a clean slate instead of inheriting findings about other code.
    let repo = repo_key(&link);
    let workspace_id = project.workspace_id.clone();

    let (contexts, skills, config, engine_config, contract, prompts) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let contexts = queries::list_review_contexts(&conn, &workspace_id).map_err(|e| e.to_string())?;
        let skills = queries::list_workspace_skills(&conn, &workspace_id).map_err(|e| e.to_string())?;
        // An active agent reviews on its own provider + model; otherwise the Review task routing.
        let config = match (agent_provider.as_deref(), agent_model.as_deref()) {
            (Some(p), Some(m)) if !p.trim().is_empty() && !m.trim().is_empty() => {
                load_ai_config_as(&conn, p, m, crate::ai_accounts::Choice::parse(agent_account.as_deref()), Some(AiTask::Review), Some(&workspace_id))?
            }
            _ => load_ai_config_in(&conn, AiTask::Review, Some(&workspace_id))?,
        };
        // The workspace's review policy: what this depth level costs, what fails the gate, what is
        // in scope. Resolved once here and frozen into the run's memory, so a review read months
        // from now still says which rules produced it.
        let (engine_config, contract) = review_pipeline::contract_for(&conn, &workspace_id, &level);
        // The methodology, the level's directive and the two fan-out roles — all editable per
        // workspace; project-specific rules ride along in `contexts`.
        let prompts = review_pipeline::ReviewPrompts::load(&conn, &workspace_id, &contract)?;
        (contexts, skills, config, engine_config, contract, prompts)
    };
    let blocking = crate::review::contract::blocking_severities(&engine_config);

    // Read directly by number. It used to be looked up inside one page of the list — the newest
    // hundred of every state — so an open pull request old enough to have scrolled off it failed
    // with "Pull request not found" and could not be reviewed at all.
    let pr = fetch_linked_pull_request(&link, pr_id).await?;

    // Best-effort — if the fetch fails (offline, auth hiccup) we still try to diff
    // against whatever refs are already local rather than blocking the review outright.
    let _ = crate::remote::fetch(app.clone(), project.local_path.clone(), None).await;

    // For GitHub and GitLab, also fetch the request's canonical head ref into a local tracking
    // ref and diff against that — so the review reflects its exact head commit even when it comes
    // from a fork or a head branch that isn't a normal origin branch. Both hosts publish one;
    // GitHub calls it `refs/pull/<n>/head` and GitLab `refs/merge-requests/<iid>/head`. Falls back
    // to the head branch name if that targeted fetch fails.
    //
    // The two local ref prefixes are deliberately different: a project re-linked from one host to
    // the other would otherwise diff against the previous host's stale ref of the same number.
    let head_ref = match &link {
        LinkedRepo::GitHub { .. } => {
            let local_ref = format!("refs/remotes/origin/codeflow-pr-{pr_id}");
            let refspec = format!("+refs/pull/{pr_id}/head:{local_ref}");
            match crate::remote::fetch_refspec(app.clone(), project.local_path.clone(), "origin".to_string(), refspec).await {
                Ok(_) => local_ref,
                Err(_) => pr.source_branch.clone(),
            }
        }
        LinkedRepo::GitLab { .. } => {
            let local_ref = format!("refs/remotes/origin/codeflow-mr-{pr_id}");
            let refspec = format!("+refs/merge-requests/{pr_id}/head:{local_ref}");
            match crate::remote::fetch_refspec(app.clone(), project.local_path.clone(), "origin".to_string(), refspec).await {
                Ok(_) => local_ref,
                Err(_) => pr.source_branch.clone(),
            }
        }
        // Neither publishes a ref for a pull request's head, so the source branch it is.
        LinkedRepo::Azure { .. } | LinkedRepo::Bitbucket { .. } => pr.source_branch.clone(),
    };

    // The head commit this review will run against, when this PR was last reviewed, and what that
    // run remembered — together they decide whether there is anything new to look at at all.
    //
    // The memory is read here rather than further down (where it is used to build the prompt)
    // because the *ids of the threads this app opened* are part of the skip decision: CodeFlow's own
    // published findings are comments on the PR too, and they must not read as somebody answering.
    let head_sha = git::diff::resolve_sha(&project.local_path, &head_ref).unwrap_or_default();
    // By repository, not only by project: a review of this PR reached earlier by its link, before
    // the repository was cloned here, is this PR's memory too.
    let scope = queries::MemoryScope { project_id: Some(&project_id), workspace_id: &workspace_id, repo_key: &repo };
    let (prev_head, prev_run, last_run_at, remembered, repo_rules) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let remembered: Vec<crate::review_memory::MemoryFinding> =
            queries::latest_review_findings(&conn, &scope, pr_id)
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
        (
            queries::latest_review_head(&conn, &scope, pr_id).ok().flatten(),
            queries::latest_review_depth(&conn, &scope, pr_id).ok().flatten(),
            queries::latest_review_run_at(&conn, &scope, pr_id).ok().flatten(),
            remembered,
            repo_rules,
        )
    };

    // The conversation on the pull request, read before the skip check because it is half of that
    // decision: a comment written after the last run is new input the review hasn't answered yet,
    // even when not a line of code moved. Best-effort — losing the thread list costs context, and
    // context is not worth failing a review the user is waiting on.
    //
    // The signed-in user's own name comes along for the same reason the thread ids do: publishing a
    // review, closing a thread and recording a decision all write to this pull request as them.
    let (mut open_threads, me) = match &link {
        LinkedRepo::Azure { org, project: ado_project, repo_id } => match pat_for_org(org) {
            Ok(pat) => (
                ado::list_pr_comment_threads(org, ado_project, repo_id, pr_id, &pat).await.unwrap_or_default(),
                ado::authenticated_user_name(org, &pat).await.ok(),
            ),
            Err(_) => (Vec::new(), None),
        },
        LinkedRepo::GitHub { host, owner, repo } => match github_token(host) {
            Ok(token) => (
                github::list_pr_comment_threads(host, owner, repo, pr_id, &token).await.unwrap_or_default(),
                github::get_authenticated_user(host, &token).await.ok(),
            ),
            Err(_) => (Vec::new(), None),
        },
        LinkedRepo::GitLab { host, project: path } => match gitlab_token(host) {
            Ok(token) => (
                gitlab::list_pr_comment_threads(host, path, pr_id, &token).await.unwrap_or_default(),
                // The username, which is exactly what GitLab puts in a note's `author.username` —
                // the comparison `comments_since` makes to tell our own comments from a reviewer's.
                gitlab::get_authenticated_user(host, &token).await.ok(),
            ),
            Err(_) => (Vec::new(), None),
        },
        LinkedRepo::Bitbucket { workspace, repo } => match bitbucket_auth(workspace) {
            Ok(auth) => (
                bitbucket::list_pr_comment_threads(workspace, repo, pr_id, &auth).await.unwrap_or_default(),
                // The display name, which is what a comment's author carries. An access token has
                // no account to name, which only costs `comments_since` its precision.
                bitbucket::get_authenticated_user(&auth).await.ok().map(|u| u.display_name).filter(|n| !n.is_empty()),
            ),
            Err(_) => (Vec::new(), None),
        },
    };
    // What the PR's own threads decided about the findings this app published — read from every
    // thread, resolved and closed ones included, since that is where a dismissal lives. Applied to
    // the memory below, once the delta is known (a text-only verdict on code that moved is re-judged).
    let azure = match &link {
        LinkedRepo::Azure { org, project: ado_project, repo_id } => {
            pat_for_org(org).ok().map(|pat| (org.clone(), ado_project.clone(), repo_id.clone(), pat))
        }
        _ => None,
    };
    let pr_threads = verdict_threads(azure, pr_id, &open_threads, &remembered).await;
    let pr_readings = crate::review::threads::read(&remembered, &pr_threads, matches!(link, LinkedRepo::GitHub { .. }));
    // What the PR still has open. Azure and Bitbucket never list a resolved thread; GitHub and GitLab
    // do, and a conversation somebody resolved — handed to the reviewers as pending — got answered
    // again, and a reply in it counted as "something new to review".
    open_threads.retain(|thread| !thread.resolved);
    let ours: std::collections::HashSet<i64> = remembered.iter().filter_map(|f| f.thread_id).collect();
    let new_comments = comments_since(&open_threads, last_run_at.as_deref(), &ours, me.as_deref());
    // A verdict to sync, or a fix claimed since the last run, is new input even on the same commit.
    let pr_spoke = crate::review::threads::worth_a_rerun(&pr_readings, last_run_at.as_deref());

    // Same head *and* nothing new said on the PR — skip the whole (costly) analysis. Unless there is
    // something the last run did not do: it was shallower than what is asked for now, or it lost a
    // reviewer — or the human asked for it anyway.
    if let Some(prev) = &prev_head {
        let (prev_level, prev_incomplete) = prev_run.clone().unwrap_or_default();
        let deeper = level_rank(&level) > level_rank(&prev_level);
        if !force && !deeper && !prev_incomplete && !head_sha.is_empty() && prev == &head_sha && new_comments == 0 && !pr_spoke {
            let short = &head_sha[..head_sha.len().min(8)];
            return Ok(format!(
                "🔁 Sin cambios desde la última revisión (mismo commit `{short}`, nivel {prev_level}). No se volvió a analizar."
            ));
        }
    }
    // Otherwise remember which files changed since the last run, so untouched-file findings
    // auto-persist during reconciliation.
    let changed_files = match &prev_head {
        Some(prev) if !prev.is_empty() => git::diff::changed_files_between(&project.local_path, prev, &head_ref).ok(),
        _ => None,
    };
    // …and which lines, so a new finding on code that was already there last time is called late.
    let delta_lines = match &prev_head {
        Some(prev) if !prev.is_empty() && changed_files.is_some() => {
            git::diff::get_branch_diff(&project.local_path, prev, &head_ref).ok().map(|files| delta_lines_of(&files))
        }
        _ => None,
    };
    // The team's verdicts, into the memory (and its newest run) before anything is handed out: a
    // finding they dismissed is not re-judged and joins the "don't raise these" block; one they say
    // is fixed is re-read even if its file did not move.
    let mut remembered = remembered;
    let pr_sync = match db.0.lock() {
        Ok(conn) => sync_memory_from_pr(&conn, &scope, pr_id, &mut remembered, &pr_readings, changed_files.as_deref()),
        Err(_) => Default::default(),
    };
    let changed_files = with_rejudged(changed_files, &remembered, &pr_sync.rejudge);
    // Every previous finding still in the code whose file this run re-reads goes back to the
    // reviewer that reads it, for a verdict — the only way one becomes `resuelto`.
    let mut reevaluate: Vec<crate::review_memory::MemoryFinding> = remembered
        .iter()
        .filter(|f| f.needs_judgement())
        .filter(|f| match (&changed_files, &f.archivo) {
            (Some(changed), Some(file)) => changed.iter().any(|c| crate::review::outline::same_path(c, file)),
            _ => true,
        })
        .cloned()
        .collect();

    // Also best-effort: skills are a nice-to-have for the review, not a precondition —
    // don't block the review if e.g. the project directory is read-only.
    let _ = skills_cmd::sync_skills_into_project(&skills, &workspace_id, &project.local_path);

    let diff_files = git::diff::get_branch_diff(&project.local_path, &pr.target_branch, &head_ref)?;
    let diff_text = git::diff::render_diff_for_prompt(&diff_files);

    // What this repository already settled about these same files, in OTHER pull requests. Read
    // here because it needs the touched paths, and best-effort because a missing hint costs
    // context, and context is not worth failing a review the user is waiting on.
    let touched: Vec<String> = diff_files
        .iter()
        .filter_map(|f| f.new_path.clone().or_else(|| f.old_path.clone()))
        .collect();
    let hints = match db.0.lock() {
        Ok(conn) => review_pipeline::hints_for(&conn, &workspace_id, &repo, pr_id, &touched),
        Err(_) => Vec::new(),
    };
    // The debt scan (opt-in): debt accepted in other PRs of this repository, on files this one
    // touches — and, on a re-review, re-reads — comes back for a verdict like this PR's own.
    let foreign_debt = match db.0.lock() {
        Ok(conn) => foreign_debt_for(&conn, &workspace_id, &repo, pr_id, &touched),
        Err(_) => Vec::new(),
    };
    reevaluate.extend(
        foreign_debt
            .iter()
            .filter(|d| match (&changed_files, &d.finding.archivo) {
                (Some(changed), Some(file)) => changed.iter().any(|c| crate::review::outline::same_path(c, file)),
                _ => true,
            })
            .map(|d| d.for_review()),
    );
    // And what it keeps dismissing, by category: a raised confidence bar for those (never a filter).
    let calibration = match db.0.lock() {
        Ok(conn) => review_pipeline::calibration_for(&conn, &workspace_id, &repo, pr_id, &engine_config.calibration),
        Err(_) => Vec::new(),
    };
    // The reference repositories the workspace switched on: where the blast radius also looks for
    // the contracts this PR changes, and — for a reviewer with the tools to consult them — named in
    // its context. A cloud engine never hears of one kept for the local model only.
    let references: Vec<crate::review::graph::Reference> = match db.0.lock() {
        Ok(conn) if crate::refrepos::for_review(&conn) => crate::refrepos::enabled_for(&conn, &workspace_id, !config.engine.in_process())
            .into_iter()
            .map(|r| crate::review::graph::Reference { name: r.name.clone(), root: r.path().to_string_lossy().to_string(), purpose: r.purpose })
            .collect(),
        _ => Vec::new(),
    };
    let references_reachable = config.engine.in_process() || matches!(config.engine.id(), "claude" | "codex" | "opencode" | "cline");

    let mut enabled_contexts: Vec<(String, String)> = contexts
        .into_iter()
        .filter(|c| c.enabled)
        .map(|c| (c.name, c.content))
        .collect();
    // The active agent's own instructions go first, so the role frames the review.
    if let Some(prompt) = agent_prompt.as_deref().filter(|p| !p.trim().is_empty()) {
        enabled_contexts.insert(0, ("Agent".to_string(), prompt.to_string()));
    }

    // The repository's conventions, for an engine that would not read them from the checkout itself.
    let conventions = crate::review::context::conventions_block(config.engine.id(), &|name: &str| {
        git::diff::file_at_ref(&project.local_path, &head_ref, name).ok()
    });

    // Everything else the reviewers are told, raw: the pipeline cuts it per reviewer, so each one
    // pays only for what concerns its own files. What is in it, and why each part is there:
    // - the conversation still open on the PR (the findings this app published and the last run left
    //   active, plus whatever else the host shows unresolved) — a re-review without it says nothing
    //   about the question it is actually asked: were the comments already left addressed?
    // - what a human already ruled on (discarded findings, standing false positives) — without it a
    //   dismissed finding is re-derived and re-paid for on every run;
    // - what other PRs settled about these files, and the PR's checks.
    let mut inputs = Some(crate::review::context::ReviewInputs {
        contexts: enabled_contexts,
        remembered: remembered.clone(),
        reevaluate,
        threads: open_threads,
        since: last_run_at.clone(),
        rules: repo_rules,
        hints,
        calibration,
        calibration_min_confidence: engine_config.calibration.min_confidence,
        checks: None,
        conventions,
        references,
        references_reachable,
    });
    let credential = link_credential(&link).ok();
    // The CI's line coverage, read beside the review rather than before it — the reviewers do not
    // wait on it — and only when this level would say something about it.
    let mut coverage_pct: Option<f64> = None;
    let coverage_threshold = contract.warn_code_coverage_below_pct;

    // Everything from here is the pipeline's: the plan, the bundles, the reviewers and the merge.
    // Same identity for the job row and the run, so the row can stream its own output and stop it.
    let result = crate::ai_runs::scoped(app.clone(), Some(job_id.clone()), async {
        // The checkout the reviewers read from, and the PR's checks — independent, so together.
        let checkout = async {
            if !config.engine.agentic() {
                return project.local_path.clone();
            }
            if let Some(ctx) = crate::ai_runs::current() {
                crate::ai_runs::emit_line(&ctx, "stdout", "▶ Preparando la copia del commit del PR para los revisores…");
            }
            let (repo, id, sha) = (project.local_path.clone(), project.id.clone(), head_sha.clone());
            match tokio::task::spawn_blocking(move || crate::review::checkout::prepare(&repo, &id, &sha)).await {
                Ok(Ok(path)) => path,
                Ok(Err(e)) => {
                    if let Some(ctx) = crate::ai_runs::current() {
                        crate::ai_runs::emit_line(&ctx, "stdout", &format!("  sin copia del PR ({e}): los revisores leen tu copia de trabajo"));
                    }
                    project.local_path.clone()
                }
                Err(_) => project.local_path.clone(),
            }
        };
        let checks = async {
            let credential = credential.as_deref()?;
            checks_on(&linked_host(&link, credential), pr_id).await.ok()
        };
        let (tools_cwd, checks) = tokio::join!(checkout, checks);
        // The workspace's skills live in the clone; a reviewer running in the PR's checkout has to
        // find them there too. Best-effort, like the sync into the clone above.
        if tools_cwd != project.local_path {
            let _ = skills_cmd::sync_skills_into_project(&skills, &workspace_id, &tools_cwd);
        }
        let mut inputs = inputs.take().unwrap_or_default();
        inputs.checks = checks.as_ref().and_then(crate::review::context::checks_block);

        let request = review_pipeline::ReviewRequest {
            config: &config,
            repo_path: &project.local_path,
            tools_cwd: &tools_cwd,
            head_ref: &head_ref,
            target_ref: &pr.target_branch,
            source_branch: &pr.source_branch,
            pr_title: &pr.title,
            pr_description: &pr.description,
            pr_status: &pr.status,
            inputs,
            prompts,
            engine: engine_config,
            contract: contract.clone(),
            changed_since: changed_files.clone(),
            force,
            cost: Default::default(),
        };
        let coverage = async {
            if coverage_threshold == 0 {
                return None;
            }
            coverage_on(&link, credential.as_deref(), pr_id, checks.as_ref()).await
        };
        let (result, pct) = tokio::join!(review_pipeline::run(request, &diff_files), coverage);
        coverage_pct = pct;
        result
    })
    .await;

    // A stopped run leaves nothing behind (no history row, no saved memory) — return as-is.
    if matches!(&result, Err(e) if e.starts_with(crate::ai_runs::CANCELLED_MARKER)) {
        return result.map(|_| String::new());
    }

    // A plan that says "probably don't review this" costs nothing and records nothing. The ones
    // that ask come back marked, so the panel can offer to review anyway instead of showing an
    // error for a perfectly ordinary draft.
    let outcome = match result {
        Ok(review_pipeline::Pipeline::Skipped(skip)) => {
            return Ok(match skip.requires_confirmation {
                true => format!("{}{}", review_pipeline::SKIP_MARKER, skip.reason),
                false => format!("⏭️ {}", skip.reason),
            })
        }
        Ok(review_pipeline::Pipeline::Reviewed(mut outcome)) => {
            // Non-blocking, and only when the CI published a number below the level's line.
            if let Some(note) = crate::review::context::coverage_note(coverage_pct, coverage_threshold) {
                outcome.notes.push(note);
            }
            Ok(outcome)
        }
        Err(e) => Err(e),
    };

    let label = format!("#{} {}", pr.id, pr.title);
    let history_meta = serde_json::json!({ "prId": pr.id, "prTitle": pr.title, "level": level }).to_string();
    let conn = db.0.lock().map_err(|e| e.to_string())?;

    // On success, reconcile against this pull request's memory — which is what gives each finding
    // its stable id — render the report from the reconciled set, and save the run. Best-effort on
    // the write: losing memory must never turn a good review into a failure.
    let result = match outcome {
        Ok(outcome) => {
            let text = finalize_review(
                &conn,
                &job_id,
                Some(project.id.as_str()),
                &project.name,
                &repo,
                &workspace_id,
                &pr,
                &level,
                config.engine.label(),
                &config.model,
                &diff_text,
                &head_sha,
                changed_files.as_deref(),
                delta_lines.as_ref(),
                &foreign_debt,
                *outcome,
                &contract,
                &blocking,
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

    // An analysed pull request is an event a flow can start from ("Evento de CodeFlow").
    if result.is_ok() {
        crate::flows::triggers::app_event(
            &app,
            "prReviewFinished",
            serde_json::json!({"projectId": project_id, "prId": pr_id, "level": level, "jobId": job_id}),
        );
    }
    result
}

/// The debt scan's input: accepted debt from the newest run of every other PR of this repository, on
/// the files this one touches. Empty when the workspace has not switched the scan on.
fn foreign_debt_for(
    conn: &rusqlite::Connection,
    workspace_id: &str,
    repo: &str,
    pr_id: i64,
    touched: &[String],
) -> Vec<crate::review_memory::ForeignDebt> {
    if !crate::commands::settings::debt_scan_enabled(conn, workspace_id) || touched.is_empty() {
        return Vec::new();
    }
    let runs = queries::latest_runs_of_other_prs(conn, workspace_id, repo, pr_id).unwrap_or_default();
    crate::review_memory::foreign_debt(&runs, touched)
}

/// Settles, in the run each one came from, the carried-in debt this review's reviewer judged paid —
/// so no later review of either PR pays to look at it again. Best-effort, like the run's own save.
fn settle_foreign_debt(
    conn: &rusqlite::Connection,
    debts: &[crate::review_memory::ForeignDebt],
    verdicts: &std::collections::HashMap<String, crate::review_memory::PriorVerdict>,
    by_pr: i64,
) {
    for debt in debts {
        let Some(verdict) = verdicts.get(&debt.alias).filter(|v| v.resolved) else { continue };
        let Ok(Some(run)) = queries::get_review_run(conn, &debt.run_id) else { continue };
        let mut findings: Vec<crate::review_memory::MemoryFinding> = serde_json::from_str(&run.findings).unwrap_or_default();
        if crate::review_memory::settle_foreign_debt(&mut findings, debt, verdict, by_pr) {
            if let Ok(json) = serde_json::to_string(&findings) {
                let _ = queries::set_review_run_findings(conn, &debt.run_id, &json);
            }
        }
    }
}

/// The new-side lines a diff added, and where it deleted — per file, as ranges — for telling a late
/// finding (on code the delta never touched) from a new one.
fn delta_lines_of(files: &[git::diff::FileDiffInfo]) -> crate::review_memory::DeltaLines {
    let mut out = crate::review_memory::DeltaLines::new();
    for file in files {
        let Some(path) = file.new_path.clone().or_else(|| file.old_path.clone()) else { continue };
        let mut spans: Vec<(u32, u32)> = Vec::new();
        for hunk in &file.hunks {
            let mut last_new: u32 = 0;
            for line in &hunk.lines {
                let at = match line.origin.as_str() {
                    "+" => line.new_lineno,
                    // A deletion sits right after the last new-side line seen.
                    "-" => Some(last_new + 1),
                    _ => None,
                };
                if let Some(n) = line.new_lineno {
                    last_new = n;
                }
                if let Some(n) = at {
                    match spans.last_mut() {
                        Some(span) if n <= span.1 + 1 => span.1 = span.1.max(n),
                        _ => spans.push((n, n)),
                    }
                }
            }
        }
        out.insert(path, spans);
    }
    out
}

/// How many comments *somebody else* wrote on this pull request after the last review ran.
///
/// This is what makes a second review answer a reviewer who wrote something without pushing a
/// commit: without it, "same head commit" alone would skip the run and the comment would never
/// reach the model. `since` of `None` (never reviewed) means nothing to be newer than.
///
/// Two exclusions, and both are what keep the count from counting *this app's own voice* back at
/// itself — publishing a review, replying to close a thread and commenting a decision all land on
/// the pull request seconds after a run, and each would otherwise read as "new input" and re-run a
/// review nobody asked for:
///
/// - `ours` — threads CodeFlow opened for its own findings (from the run's memory).
/// - `me` — the signed-in user, by the name their comments carry. Covers everything the previous
///   rule can't address by id: the summary comment, the decision note, a reply the user typed
///   themselves. `None` when the host wouldn't say who we are, which only costs precision.
fn comments_since(
    threads: &[ado::PrCommentThread],
    since: Option<&str>,
    ours: &std::collections::HashSet<i64>,
    me: Option<&str>,
) -> usize {
    let Some(since) = since else { return 0 };
    threads
        .iter()
        .filter(|t| !ours.contains(&t.id))
        .flat_map(|t| t.comments.iter())
        .filter(|c| !me.is_some_and(|me| c.author.eq_ignore_ascii_case(me)))
        .filter(|c| is_newer_than(&c.published_date, since))
        .count()
}

/// Every thread of the PR as `review::threads` reads them for verdicts. On Azure they are fetched
/// again *with their status* — the listing a review gets drops closed threads, and a thread closed
/// as won't fix or by design is exactly where a dismissal lives. Elsewhere the listing already holds
/// resolved conversations, which is all those hosts can say. Best-effort, and skipped when nothing
/// remembered is active: then there is nothing a verdict could move.
async fn verdict_threads(
    // Azure's org, project, repository and PAT, when the PR is there.
    azure: Option<(String, String, String, String)>,
    pr_id: i64,
    listed: &[ado::PrCommentThread],
    remembered: &[crate::review_memory::MemoryFinding],
) -> Vec<crate::review::threads::HostThread> {
    use crate::review::threads::HostThread;
    if !remembered.iter().any(|f| f.is_active()) {
        return Vec::new();
    }
    match azure {
        Some((org, project, repo, pat)) => ado::list_pr_thread_states(&org, &project, &repo, pr_id, &pat)
            .await
            .map(|threads| threads.iter().map(HostThread::from_azure).collect())
            .unwrap_or_else(|_| listed.iter().map(HostThread::from_listed).collect()),
        None => listed.iter().map(HostThread::from_listed).collect(),
    }
}

/// Applies what the PR's threads decided (`review::threads::apply`) to this PR's memory before a
/// re-review, and writes it back to the newest run — the same row a mark made in the app writes to —
/// so the reviewers' context, the reconciliation that reads the previous run back, and any other
/// client all see the team's verdict. `changed_files` is what decides whether a text-only dismissal
/// may apply (the delta beats words).
fn sync_memory_from_pr(
    conn: &rusqlite::Connection,
    scope: &queries::MemoryScope,
    pr_id: i64,
    remembered: &mut [crate::review_memory::MemoryFinding],
    readings: &[(String, crate::review::threads::FindingReading)],
    changed_files: Option<&[String]>,
) -> crate::review::threads::SyncOutcome {
    // Nothing read must still clear stale offers — but only when there were readings to compare to,
    // or a lost thread list would wipe every pending verdict.
    if readings.is_empty() && !remembered.iter().any(|f| f.is_active() && f.hilo_pr.veredicto_pr.is_some()) {
        return Default::default();
    }
    let iter = queries::count_review_runs(conn, scope, pr_id).unwrap_or(0) as usize + 1;
    let outcome = crate::review::threads::apply(remembered, readings, changed_files, iter);
    if outcome.changed {
        if let (Ok(Some(run_id)), Ok(json)) = (queries::latest_review_run_id_in(conn, scope, pr_id), serde_json::to_string(&remembered)) {
            let _ = queries::set_review_run_findings(conn, &run_id, &json);
        }
    }
    outcome
}

/// The delta a re-review reads, widened by the files of the findings the PR asked to re-judge ("Corregido
/// en …") — so their reviewer reads them and its verdict counts even though the code did not move.
/// `None` stays `None`: a full review reads everything already.
fn with_rejudged(
    changed: Option<Vec<String>>,
    remembered: &[crate::review_memory::MemoryFinding],
    ids: &[String],
) -> Option<Vec<String>> {
    let mut changed = changed?;
    for file in remembered.iter().filter(|f| ids.contains(&f.id)).filter_map(|f| f.archivo.as_ref()) {
        if !changed.iter().any(|c| crate::review::outline::same_path(c, file)) {
            changed.push(file.clone());
        }
    }
    Some(changed)
}

/// Turns one finished pipeline run into the review the user reads, and saves it.
///
/// The order here is the whole point, and it is why rendering does not happen inside the pipeline.
/// A finding's **id is not decided by the review that found it** — it is decided by reconciliation
/// against this pull request's memory, so that a defect still present in iteration four keeps the
/// `F-003` it was given in iteration one, along with the comment thread opened for it. Rendering
/// before that step would produce a report whose numbering disagreed with both the memory and the
/// pull request.
///
/// So: reconcile, carry the reconciled identity back onto the full findings, render, then save.
/// Best-effort on the write — losing memory must never turn a good review into a failure.
#[allow(clippy::too_many_arguments)]
fn finalize_review(
    conn: &rusqlite::Connection,
    job_id: &str,
    // The local project that ran it — `None` for a review reached by link — and the name the run
    // goes by (the project's, or the repository label of a link review).
    project_id: Option<&str>,
    project_name: &str,
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
    changed_files: Option<&[String]>,
    // The lines that changed since the previous run, for marking late findings (see `Rereview`).
    delta_lines: Option<&crate::review_memory::DeltaLines>,
    // Debt from other PRs this run carried in (the debt scan) — reported, and settled when paid.
    foreign_debt: &[crate::review_memory::ForeignDebt],
    mut outcome: review_pipeline::PipelineOutcome,
    contract: &crate::review::contract::LevelContract,
    blocking: &[crate::review::contract::Severity],
) -> String {
    use crate::review::render;
    use crate::review_memory as mem;

    let scope = queries::MemoryScope { project_id, workspace_id, repo_key: repo };
    let prior = queries::count_review_runs(conn, &scope, pr.id).unwrap_or(0) as usize;
    let mut findings = std::mem::take(&mut outcome.findings);
    let projected: Vec<mem::MemoryFinding> = findings.iter().map(|f| f.to_memory()).collect();

    let (mut remembered, delta) = if prior > 0 {
        let prev: Vec<mem::MemoryFinding> = queries::latest_review_findings(conn, &scope, pr.id)
            .ok()
            .flatten()
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default();
        // What this run did not actually re-read — a failed reviewer's files, the ones trimmed out of
        // their bundles — must not read as fixed just because nobody re-reported them.
        let unread_files: Vec<String> = outcome.unreviewed.iter().chain(outcome.degraded.iter()).cloned().collect();
        let unread = mem::Unread { files: &unread_files, unlocated: outcome.unlocated_unread };
        let rereview = mem::Rereview {
            changed_files,
            unread,
            verdicts: Some(&outcome.prior_verdicts),
            delta_lines,
        };
        let (merged, d) = mem::reconcile_with(&prev, &projected, prior, rereview);
        (merged, Some(d))
    } else {
        let mut first = projected;
        for f in first.iter_mut() {
            f.introducido_en_iter = 1;
        }
        (first, None)
    };

    // Carry the reconciled identity back onto the full findings — **by position**: `reconcile`
    // returns `current[i]` as its `merged[i]`, and on a first review the memory *is* the projection,
    // in order. It used to be by file + category, which two findings of one category in one file
    // share: both came out as the first one's `F-NNN`, and the second's comment was stored against
    // the other's id.
    //
    // The comment body each finding would be published as is rendered in the same pass, stored
    // alongside it. Here rather than in `to_memory` because only now are the ids the reconciled ones,
    // and the id is in the heading. The `remembered` entries past `findings.len()` were carried
    // forward from an earlier run — not re-rendered, so they keep whatever body they were stored with
    // (empty, for a run written before this existed).
    debug_assert!(remembered.len() >= findings.len(), "reconciliation keeps every current finding");
    for (finding, stored) in findings.iter_mut().zip(remembered.iter_mut()) {
        finding.id = stored.id.clone();
        finding.estado = stored.estado.clone();
        finding.thread_id = stored.thread_id;
        finding.introducido_en_iter = stored.introducido_en_iter;
        finding.resuelto_en_iter = stored.resuelto_en_iter;
        finding.motivo_descarte = stored.motivo_descarte.clone();
        finding.delta = stored.delta.clone();
        finding.tardio = stored.tardio;
        stored.comentario_md = render::comment_markdown(finding, &pr.provider);
    }

    // The active findings carried forward without being re-read — their file did not change in this
    // re-review, or their reviewer failed — still stand, so they go back into the report and into the
    // gate. They used to stay only in the memory: the report a person reads (and the gate it shows)
    // went quiet about a Blocker just because nobody touched its file again.
    let carried_from = findings.len();
    let carried: Vec<usize> = (carried_from..remembered.len()).filter(|&i| remembered[i].is_active()).collect();
    if !carried.is_empty() {
        let earlier: Vec<Vec<crate::review::merge::Finding>> =
            queries::review_reports_for_pr(conn, &scope, pr.id)
                .unwrap_or_default()
                .iter()
                .map(|md| crate::review::merge::parse(md))
                .collect();
        for i in carried {
            let finding = crate::review::merge::Finding::recovered(&remembered[i], &earlier);
            // A run recorded before comment bodies were kept can be published from the phone again.
            if remembered[i].comentario_md.is_empty() {
                remembered[i].comentario_md = render::comment_markdown(&finding, &pr.provider);
            }
            findings.push(finding);
        }
    }
    let carried_count = findings.len() - carried_from;
    crate::review::merge::sort(&mut findings);

    let plan = &outcome.plan;
    let body = render::review_markdown(
        &findings,
        &render::ReportContext {
            contract,
            blocking,
            narrative: &outcome.narrative,
            files: plan.files.len(),
            additions: plan.additions,
            deletions: plan.deletions,
            out_of_scope: plan.out_of_scope.len(),
            delta_files: (plan.mode == crate::review::plan::PlanMode::Delta).then(|| plan.files.len()),
            degraded: &outcome.degraded,
            workers: outcome.workers,
            unreviewed: &outcome.unreviewed,
            failed_passes: &outcome.failed_passes,
            checking: outcome.checking,
            carried: carried_count,
            notes: &outcome.notes,
        },
    );

    // The cumulative traceability and the delta banner wrap the report the same way they always
    // have — the stored memory and the returned text stay identical.
    let mut text = match mem::resolved_history_section(&remembered) {
        Some(section) => format!("{body}{section}"),
        None => body,
    };
    if let Some(section) = mem::foreign_debt_section(foreign_debt, &outcome.prior_verdicts) {
        text.push_str(&section);
    }
    // What this re-review took from the PR's own threads, said up front: the reader must be able to
    // tell a state the team decided on the PR from one this app decided.
    if let Some(lines) = crate::review::threads::report_lines(&remembered, prior + 1) {
        text = format!("{lines}{text}");
    }
    if let Some(d) = &delta {
        text = format!("{}{}", mem::delta_banner(d), text);
    }
    // What the CLI reported it actually ran beats what was configured — the two differ whenever no
    // model was forced and the CLI picked its own default.
    let text = ai::review_footer(&text, engine_label, outcome.model.as_deref().unwrap_or(model));

    let iter = prior + 1;
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
        project_id: project_id.unwrap_or_default().to_string(),
        project_name: project_name.to_string(),
        repo_key: repo.to_string(),
        workspace_id: workspace_id.to_string(),
        timestamp: chrono::Local::now().to_rfc3339(),
        iter,
        head_sha: head_sha.to_string(),
        // The plan's numbers, not the raw diff's: this field is what a memory browser calls "what
        // this run looked at", and a file the scope globs kept out was never looked at.
        files: plan.files.len(),
        additions: plan.additions,
        deletions: plan.deletions,
        // Frozen per run: a review read months from now has to be able to say which rules produced
        // it, and by then the workspace's policy may be something else entirely.
        level_contract: serde_json::to_value(contract).unwrap_or(serde_json::Value::Null),
        quality_gate_policy: blocking.iter().map(|s| s.label().to_string()).collect(),
        quality_gate: render::passes_gate(&findings, blocking),
        workers: outcome.workers,
        incomplete: !outcome.unreviewed.is_empty() || !outcome.failed_passes.is_empty(),
        // Nothing to say for a run whose passes never reached an engine.
        cost: (outcome.cost.passes > 0).then(|| outcome.cost.clone()),
        // What calibration and which deterministic rules shaped this run, as they were then.
        calibration: outcome.calibration.take(),
        rules: std::mem::take(&mut outcome.rules),
    };

    let meta_json = serde_json::to_string(&meta).unwrap_or_else(|_| "{}".to_string());
    let findings_json = serde_json::to_string(&remembered).unwrap_or_else(|_| "[]".to_string());
    if let Err(e) = queries::add_review_run(
        conn, job_id, project_id, workspace_id, repo, pr.id, iter as i64, level, &meta_json, &text, diff_text, &findings_json,
    ) {
        eprintln!("failed to save review memory: {e}");
    }
    settle_foreign_debt(conn, foreign_debt, &outcome.prior_verdicts, pr.id);

    text
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommentLocation {
    pub file: String,
    pub start_line: i64,
    pub end_line: i64,
}

/// One human-selected finding to post, matched back to its stored finding so its thread is reused
/// across re-reviews — by `id` (see `review_memory::match_publish_item`), with `file` + `category`
/// as the fallback for a client that sends none.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PostFindingItem {
    /// The finding's `F-NNN`. Optional on the wire: the phone predates it.
    #[serde(default)]
    pub id: Option<String>,
    pub file: Option<String>,
    pub category: String,
    /// Full comment markdown, used when opening a new thread.
    pub content: String,
    pub location: Option<CommentLocation>,
}

impl PostFindingItem {
    fn key(&self) -> crate::review_memory::PublishKey<'_> {
        crate::review_memory::PublishKey {
            id: self.id.as_deref(),
            file: self.file.as_deref().or(self.location.as_ref().map(|l| l.file.as_str())),
            category: &self.category,
            lines: self.location.as_ref().map(|l| {
                let start = l.start_line.max(0) as u32;
                (start, (l.end_line.max(0) as u32).max(start))
            }),
        }
    }
}

/// What happened to one item of a publish.
#[derive(Debug, Serialize)]
pub struct PublishedItem {
    /// The finding it was about, as stored (or as the item named it, when nothing stored matched).
    pub id: Option<String>,
    /// `opened` (a new thread) · `fallback` (a general comment naming the line — the host refused the
    /// line itself) · `replied` ("sigue presente" on its thread) · `resolved` (a reply and the thread
    /// closed) · `skipped` (already published in this iteration) · `failed`.
    pub status: String,
    pub error: Option<String>,
}

/// What a publish actually did, item by item. It used to be all or nothing — one failed comment made
/// the whole call an error, and the panel said nothing had been posted while the threads that *had*
/// been opened sat on the pull request (and in the memory).
#[derive(Debug, Default, Serialize)]
pub struct PublishOutcome {
    pub items: Vec<PublishedItem>,
    /// `None` when no summary was asked for.
    pub summary_posted: Option<bool>,
    pub summary_error: Option<String>,
    /// The summary went out by editing the one already on the PR rather than as a new comment.
    pub summary_updated: bool,
}

impl PublishOutcome {
    /// The all-or-nothing answer, for the callers that only know "worked / didn't" — the phone. It
    /// still says what did land, so a partial publish never reads as nothing posted.
    pub fn into_legacy(self) -> Result<(), String> {
        let mut failures: Vec<String> = self
            .items
            .iter()
            .enumerate()
            .filter(|(_, item)| item.status == "failed")
            .map(|(n, item)| format!("#{}: {}", n + 1, item.error.clone().unwrap_or_default()))
            .collect();
        if let Some(error) = &self.summary_error {
            failures.push(format!("summary: {error}"));
        }
        if failures.is_empty() {
            return Ok(());
        }
        let posted = self.items.iter().filter(|item| !matches!(item.status.as_str(), "failed" | "skipped")).count();
        Err(format!(
            "{} comment(s) failed to post ({posted} posted) — {}",
            failures.len(),
            failures.join("; ")
        ))
    }
}

/// The body of a finding's comment when the host refused to anchor it to its line: the same comment,
/// posted on the conversation, saying which line it is about — the location is the one thing the
/// anchoring would have carried and the text doesn't.
fn general_fallback_body(content: &str, location: &CommentLocation) -> String {
    let lines = if location.end_line > location.start_line {
        format!("{}-{}", location.start_line, location.end_line)
    } else {
        location.start_line.to_string()
    };
    format!(
        "📍 `{}:{lines}` _(fuera del diff del pull request: publicado como comentario general)_\n\n{content}",
        location.file.trim_start_matches('/')
    )
}

/// The note a re-publish leaves on a finding's existing thread. On a general comment (which GitHub
/// cannot reply to) it is a comment of its own, so it names the finding it is about.
fn follow_up_text(azure: bool, resolved: bool, iter: usize, today: &str, finding: Option<&str>) -> String {
    let about = finding.map(|id| format!("**{id}** — ")).unwrap_or_default();
    match (azure, resolved) {
        (true, true) => format!("✔️ _{about}Resuelto en la iteración {iter} — {today}. Marcado como fixed._"),
        (true, false) => format!("➡️ _{about}Sigue presente en la iteración {iter} — {today}._"),
        (false, true) => format!("✔️ {about}Resuelto en la iteración {iter} — {today}."),
        (false, false) => format!("➡️ {about}Sigue presente en la iteración {iter} — {today}."),
    }
}

/// Whether a finding was already written to in this iteration — opened, replied on or closed — so a
/// second publish of the same run says nothing about it twice.
fn already_published(finding: &crate::review_memory::MemoryFinding, iter: Option<usize>) -> bool {
    iter.is_some() && finding.publicado_en_iter == iter
}

/// Whether a resolved finding's thread already heard that it was resolved — written to in the
/// iteration that resolved it or any later one.
///
/// A resolved finding is carried forward by every later run, and `already_published` only compares
/// against the *current* iteration: without this the thread got a fresh "resuelto en la iteración
/// N" on every publish after the fix, one per iteration, for as long as the pull request lived.
fn resolution_announced(finding: &crate::review_memory::MemoryFinding) -> bool {
    finding.estado == "resuelto"
        && matches!((finding.publicado_en_iter, finding.resuelto_en_iter), (Some(written), Some(resolved)) if written >= resolved)
}

/// Records on the stored finding what a publish did to it: the thread it opened (and whether that is
/// a general comment), and the iteration it was written in.
fn record_published(
    finding: &mut crate::review_memory::MemoryFinding,
    iter: Option<usize>,
    opened: Option<(i64, bool)>,
) {
    if let Some((thread, general)) = opened {
        finding.thread_id = Some(thread);
        finding.hilo_general = general;
        if finding.estado == "abierto" {
            finding.estado = "posteado".to_string();
        }
    }
    finding.publicado_en_iter = iter;
}

/// Posts the human-selected findings to the PR, reconciling against what was already posted so a
/// finding keeps ONE thread for the PR's whole life ("un hallazgo = un thread"): no thread yet →
/// open a new (anchored) one; already posted and still present → a follow-up reply; now resolved →
/// a reply plus its thread marked resolved/fixed. Thread ids are written back onto the run — every
/// one that landed, even when others failed — so a later re-post continues the same threads instead
/// of duplicating. Optionally posts a summary comment. Every item is attempted even if one fails,
/// and the outcome says, item by item, what happened.
///
/// `close_resolved` also closes, on the host, the threads of every finding this run's memory holds as
/// `resuelto` — the reply "resuelto en la iteración N" and the thread marked fixed — so the PR's
/// conversation follows the code without anybody ticking them. The desktop panel asks for it; a
/// caller that chooses its items itself (Flujos) leaves it off and sends them explicitly.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn publish_pr_review(
    db: State<'_, Db>,
    project_id: String,
    pr_id: i64,
    run_id: String,
    items: Vec<PostFindingItem>,
    post_summary: bool,
    summary: Option<String>,
    close_resolved: Option<bool>,
) -> Result<PublishOutcome, String> {
    publish_project_review(&db, &project_id, pr_id, &run_id, &items, post_summary, summary.as_deref(), close_resolved.unwrap_or(false))
        .await
}

/// [`publish_pr_review`] with the older all-or-nothing answer — kept, with its signature, for the
/// phone, which calls it by name (`remotectl::dispatch`). A partial publish is an error here, one
/// that says what did land.
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
    publish_project_review(&db, &project_id, pr_id, &run_id, &items, post_summary, summary.as_deref(), false)
        .await?
        .into_legacy()
}

/// The items that close the threads of this run's resolved findings — the ones with a thread, not
/// yet written to in this iteration, and not already among `items` (sent twice, the second copy would
/// be matched to some *other* finding of the same kind).
fn resolved_closures(findings: &[crate::review_memory::MemoryFinding], iter: usize, items: &[PostFindingItem]) -> Vec<PostFindingItem> {
    findings
        .iter()
        .filter(|f| f.estado == "resuelto" && f.thread_id.is_some() && !already_published(f, Some(iter)) && !resolution_announced(f))
        .filter(|f| !items.iter().any(|item| item.id.as_deref() == Some(f.id.as_str())))
        .map(|f| PostFindingItem {
            id: Some(f.id.clone()),
            file: f.archivo.clone(),
            category: f.categoria.clone(),
            content: String::new(),
            location: None,
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
async fn publish_project_review(
    db: &State<'_, Db>,
    project_id: &str,
    pr_id: i64,
    run_id: &str,
    items: &[PostFindingItem],
    post_summary: bool,
    summary: Option<&str>,
    close_resolved: bool,
) -> Result<PublishOutcome, String> {
    let project = load_project(db, project_id)?;
    let link = linked_repo(&project)?;

    // Stored findings are the source of truth for existing thread ids / state.
    let (mut findings, iter, head, diff): (Vec<crate::review_memory::MemoryFinding>, usize, String, String) = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        match queries::get_review_run(&conn, run_id).map_err(|e| e.to_string())? {
            Some(r) => (
                serde_json::from_str(&r.findings).unwrap_or_default(),
                r.iter.max(1) as usize,
                run_head_sha(&r.meta),
                r.diff,
            ),
            None => (Vec::new(), 1, String::new(), String::new()),
        }
    };

    let credential = link_credential(&link)?;
    let host = linked_host(&link, &credential);
    let mut all: Vec<PostFindingItem> = Vec::new();
    let items: &[PostFindingItem] = if close_resolved {
        all.extend(items.iter().cloned());
        all.extend(resolved_closures(&findings, iter, items));
        &all
    } else {
        items
    };
    // The code that fixed a resolved finding, from the commit the run reviewed — or, when that is
    // not in the clone any more, from the diff the run kept.
    let local_path = project.local_path.clone();
    let code = move |f: &crate::review_memory::MemoryFinding| -> Option<String> {
        let (file, span) = (crate::review_memory::resolution_file(f)?, crate::review_memory::resolution_span(f)?);
        let from_clone = (!head.is_empty())
            .then(|| git::diff::file_at_ref(&local_path, &head, file).ok())
            .flatten()
            .and_then(|content| crate::review_memory::snippet_from_content(&content, span));
        from_clone.or_else(|| crate::review_memory::snippet_from_diff(&diff, file, span))
    };
    let outcome = publish_to_host(&host, pr_id, items, &mut findings, Some(iter), post_summary, summary, &code).await;

    // Write back the thread ids / states just changed — before anything else can fail: a thread that
    // exists on the pull request and not in the memory is how the next publish opens a duplicate.
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let json = serde_json::to_string(&findings).unwrap_or_else(|_| "[]".to_string());
        let _ = queries::set_review_run_findings(&conn, run_id, &json);
    }
    Ok(outcome)
}

/// The credential a linked repository's host takes.
fn link_credential(link: &LinkedRepo) -> Result<String, String> {
    match link {
        LinkedRepo::Azure { org, .. } => pat_for_org(org),
        LinkedRepo::GitHub { host, .. } => github_token(host),
        LinkedRepo::GitLab { host, .. } => gitlab_token(host),
        // The whole credential as one string, so it can travel where the others' tokens do.
        LinkedRepo::Bitbucket { workspace, .. } => bitbucket_auth(workspace).map(|auth| auth.to_secret()),
    }
}

/// A Bitbucket credential back out of the string [`link_credential`] and [`link_credentials`] carry
/// it as. That string is always `BitbucketAuth::to_secret`'s, so this cannot fail in practice; a
/// value that somehow isn't is read as a bare access token, the reading `from_secret` gives one.
fn bitbucket_link_auth(credential: &str) -> bitbucket::BitbucketAuth {
    bitbucket::BitbucketAuth::from_secret(credential)
        .unwrap_or_else(|| bitbucket::BitbucketAuth::AccessToken { token: credential.to_string() })
}

/// A linked repository as the host operations below address it.
fn linked_host<'a>(link: &'a LinkedRepo, credential: &'a str) -> ThreadHost<'a> {
    match link {
        LinkedRepo::Azure { org, project, repo_id } => ThreadHost::Azure { org, project, repo: repo_id, pat: credential },
        LinkedRepo::GitHub { host, owner, repo } => ThreadHost::GitHub { host, owner, repo, token: credential },
        LinkedRepo::GitLab { host, project } => ThreadHost::GitLab { host, project, token: credential },
        LinkedRepo::Bitbucket { workspace, repo } => {
            ThreadHost::Bitbucket { workspace, repo, auth: bitbucket_link_auth(credential) }
        }
    }
}

/// A pasted link's pull request as the host operations below address it, with its number.
fn link_host<'a>(target: &'a crate::pr_link::PrLinkTarget, credential: &'a str) -> (ThreadHost<'a>, i64) {
    match target {
        crate::pr_link::PrLinkTarget::GitHub { host, owner, repo, number } => {
            (ThreadHost::GitHub { host, owner, repo, token: credential }, *number)
        }
        crate::pr_link::PrLinkTarget::GitLab { host, project, number } => {
            (ThreadHost::GitLab { host, project, token: credential }, *number)
        }
        crate::pr_link::PrLinkTarget::Bitbucket { workspace, repo, number } => {
            (ThreadHost::Bitbucket { workspace, repo, auth: bitbucket_link_auth(credential) }, *number)
        }
        crate::pr_link::PrLinkTarget::Azure { org, project, repo, number } => {
            (ThreadHost::Azure { org, project, repo, pat: credential }, *number)
        }
    }
}

impl ThreadHost<'_> {
    /// Opens a thread anchored to a file and line; returns its id. On GitHub the head commit it is
    /// anchored to has to be supplied (`github_head`).
    async fn open_anchored(
        &self,
        pr_id: i64,
        content: &str,
        loc: &CommentLocation,
        github_head: Option<&str>,
    ) -> Result<i64, String> {
        match self {
            ThreadHost::Azure { org, project, repo, pat } => {
                ado::post_pr_comment_anchored(org, project, repo, pr_id, content, &loc.file, loc.start_line, loc.end_line, pat)
                    .await
            }
            ThreadHost::GitHub { host, owner, repo, token } => {
                let sha = github_head.ok_or_else(|| "GitHub didn't report a head commit for this pull request".to_string())?;
                github::post_pr_comment_anchored(host, owner, repo, pr_id, content, &loc.file, loc.start_line, loc.end_line, sha, token)
                    .await
            }
            ThreadHost::GitLab { host, project, token } => {
                gitlab::post_pr_comment_anchored(host, project, pr_id, content, &loc.file, loc.start_line, loc.end_line, token)
                    .await
            }
            ThreadHost::Bitbucket { workspace, repo, auth } => {
                bitbucket::post_pr_comment_anchored(workspace, repo, pr_id, content, &loc.file, loc.start_line, loc.end_line, auth)
                    .await
            }
        }
    }

    /// Whether an anchoring failure means "not on that line" — worth retrying as a general comment —
    /// rather than a failure of the request itself. Azure anchors to any line, so never there.
    fn refused_the_line(&self, error: &str) -> bool {
        match self {
            ThreadHost::Azure { .. } => false,
            ThreadHost::GitHub { .. } => github::is_unanchorable(error),
            ThreadHost::GitLab { .. } => gitlab::is_unanchorable(error),
            ThreadHost::Bitbucket { .. } => bitbucket::is_unanchorable(error),
        }
    }

    /// Posts a comment on the conversation, not on any line; returns its id.
    async fn open_general(&self, pr_id: i64, content: &str) -> Result<i64, String> {
        match self {
            ThreadHost::Azure { org, project, repo, pat } => ado::post_pr_comment(org, project, repo, pr_id, content, pat).await,
            ThreadHost::GitHub { host, owner, repo, token } => github::post_pr_comment(host, owner, repo, pr_id, content, token).await,
            ThreadHost::GitLab { host, project, token } => gitlab::post_pr_comment(host, project, pr_id, content, token).await,
            ThreadHost::Bitbucket { workspace, repo, auth } => bitbucket::post_pr_comment(workspace, repo, pr_id, content, auth).await,
        }
    }

    /// Adds `text` to an existing thread. A GitHub general comment has no reply chain, so there it is
    /// a new comment — which is also the fallback when a reply is refused, rather than losing it.
    async fn follow_up(&self, pr_id: i64, thread: i64, text: &str, general: bool) -> Result<(), String> {
        match self {
            ThreadHost::Azure { org, project, repo, pat } => ado::reply_pr_thread(org, project, repo, pr_id, thread, text, pat).await,
            ThreadHost::GitHub { host, owner, repo, token } => {
                if !general && github::reply_pr_review_comment(host, owner, repo, pr_id, thread, text, token).await.is_ok() {
                    return Ok(());
                }
                github::post_pr_comment(host, owner, repo, pr_id, text, token).await.map(|_| ())
            }
            ThreadHost::GitLab { host, project, token } => {
                if gitlab::reply_pr_comment(host, project, pr_id, thread, text, token).await.is_ok() {
                    return Ok(());
                }
                gitlab::post_pr_comment(host, project, pr_id, text, token).await.map(|_| ())
            }
            // Every Bitbucket comment can be replied to, general or inline — the fallback is only for
            // a thread that has gone.
            ThreadHost::Bitbucket { workspace, repo, auth } => {
                if bitbucket::reply_pr_comment(workspace, repo, pr_id, thread, text, auth).await.is_ok() {
                    return Ok(());
                }
                bitbucket::post_pr_comment(workspace, repo, pr_id, text, auth).await.map(|_| ())
            }
        }
    }

    /// The PR's threads, or none when the host would not say — a missing list only costs a publish
    /// its deduplication and its summary edit, never the publish itself.
    async fn threads(&self, pr_id: i64) -> Vec<ado::PrCommentThread> {
        match self {
            ThreadHost::Azure { org, project, repo, pat } => ado::list_pr_comment_threads(org, project, repo, pr_id, pat).await,
            ThreadHost::GitHub { host, owner, repo, token } => github::list_pr_comment_threads(host, owner, repo, pr_id, token).await,
            ThreadHost::GitLab { host, project, token } => gitlab::list_pr_comment_threads(host, project, pr_id, token).await,
            ThreadHost::Bitbucket { workspace, repo, auth } => bitbucket::list_pr_comment_threads(workspace, repo, pr_id, auth).await,
        }
        .unwrap_or_default()
    }

    /// Who the credential is, as a comment's author reads on this host.
    async fn me(&self) -> Option<String> {
        match self {
            ThreadHost::Azure { org, pat, .. } => ado::authenticated_user_name(org, pat).await.ok(),
            ThreadHost::GitHub { host, token, .. } => github::get_authenticated_user(host, token).await.ok(),
            ThreadHost::GitLab { host, token, .. } => gitlab::get_authenticated_user(host, token).await.ok(),
            ThreadHost::Bitbucket { auth, .. } => {
                bitbucket::get_authenticated_user(auth).await.ok().map(|u| u.display_name).filter(|n| !n.is_empty())
            }
        }
    }

    /// Rewrites a conversation comment this app posted (`open_general`'s id).
    async fn edit_general(&self, pr_id: i64, thread: i64, content: &str) -> Result<(), String> {
        match self {
            ThreadHost::Azure { org, project, repo, pat } => ado::edit_pr_thread_comment(org, project, repo, pr_id, thread, content, pat).await,
            ThreadHost::GitHub { host, owner, repo, token } => github::edit_pr_comment(host, owner, repo, thread, content, token).await,
            ThreadHost::GitLab { host, project, token } => gitlab::edit_pr_comment(host, project, pr_id, thread, content, token).await,
            ThreadHost::Bitbucket { workspace, repo, auth } => bitbucket::edit_pr_comment(workspace, repo, pr_id, thread, content, auth).await,
        }
    }

    /// Closes a thread as fixed.
    async fn close_as_fixed(&self, pr_id: i64, thread: i64) -> Result<(), String> {
        match self {
            ThreadHost::Azure { org, project, repo, pat } => {
                ado::set_pr_thread_status(org, project, repo, pr_id, thread, THREAD_FIXED, pat).await
            }
            ThreadHost::GitHub { host, owner, repo, token } => {
                github::resolve_review_thread_for_comment(host, owner, repo, pr_id, thread, token).await
            }
            ThreadHost::GitLab { host, project, token } => {
                gitlab::resolve_discussion_for_note(host, project, pr_id, thread, token).await
            }
            ThreadHost::Bitbucket { workspace, repo, auth } => {
                bitbucket::resolve_comment_thread(workspace, repo, pr_id, thread, auth).await
            }
        }
    }
}

/// The heading every review summary opens with (`formatSummaryComment` in `parseAnalysis.ts`) — how
/// a publish finds the summary it left last time, to edit it instead of posting another.
const SUMMARY_HEADING: &str = "### 📋 Revisión automatizada";

/// The summary the signed-in user already left on this PR, if any — the newest one.
///
/// Only theirs: editing somebody else's comment is either refused or, for an admin, worse. Without a
/// name to compare (`me` unknown) nothing is edited and a new summary is posted, which is what
/// happened before this existed.
fn own_summary(threads: &[ado::PrCommentThread], me: Option<&str>) -> Option<i64> {
    let me = me?;
    threads
        .iter()
        .filter(|t| t.file_path.is_none())
        .filter_map(|t| t.comments.first().map(|c| (t.id, c)))
        .filter(|(_, c)| c.author.eq_ignore_ascii_case(me) && c.content.trim_start().starts_with(SUMMARY_HEADING))
        .max_by(|(_, a), (_, b)| {
            if is_newer_than(&a.published_date, &b.published_date) {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Less
            }
        })
        .map(|(id, _)| id)
}

/// Whether a comment carrying this body is already on the PR — for a review with no memory (one
/// reached by link), the only way a second publish after a restart knows not to post it again.
///
/// Matched on the heading *and* the subtitle: a link review numbers its findings from F-001 on every
/// run, so the heading alone would take a different finding for one already posted.
fn already_on_pr(threads: &[ado::PrCommentThread], content: &str) -> bool {
    let signature: Vec<&str> = content.lines().map(str::trim).filter(|l| !l.is_empty()).take(2).collect();
    if signature.len() < 2 {
        return false;
    }
    threads.iter().filter_map(|t| t.comments.first()).any(|c| signature.iter().all(|line| c.content.contains(line)))
}

/// What a publish decided to do with one item, before doing any of it.
enum Step {
    /// Already written to in this iteration.
    Skip,
    /// A review with no memory found the same comment on the PR already.
    AlreadyOnPr,
    Open,
    FollowUp { thread: i64, general: bool },
}

/// Publishes `items` (and the summary) on one host, updating `findings` — the run's memory, empty
/// for a review reached by link — as it goes. `iter` is the run's iteration, `None` without memory.
///
/// Decides everything first and then acts, which is what allows the three things a one-by-one loop
/// could not: GitHub's new inline comments go out as **one review** (one notification for the
/// author, not one per finding), a review with no memory skips what is already on the PR, and the
/// summary **edits** the one this user left last time instead of piling up a new one per publish.
#[allow(clippy::too_many_arguments)]
async fn publish_to_host(
    host: &ThreadHost<'_>,
    pr_id: i64,
    items: &[PostFindingItem],
    findings: &mut [crate::review_memory::MemoryFinding],
    iter: Option<usize>,
    post_summary: bool,
    summary: Option<&str>,
    // The code that fixed a resolved finding, when it can be read — shown on its thread under the
    // resolution (`review_memory::resolution_note`).
    code: &(dyn Fn(&crate::review_memory::MemoryFinding) -> Option<String> + Send + Sync),
) -> PublishOutcome {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let azure = matches!(host, ThreadHost::Azure { .. });
    // GitHub anchors a comment to a commit, read fresh once per publish. Without it every anchored
    // item goes out as a general comment naming its line, which beats not going out at all.
    let github_head = match host {
        ThreadHost::GitHub { host: gh, owner, repo, token } if items.iter().any(|item| item.location.is_some()) => {
            github::head_sha_for(gh, owner, repo, pr_id, token).await.ok()
        }
        _ => None,
    };
    // What is already on the PR, read once and only when something needs it.
    let wants_summary = post_summary && summary.is_some();
    let (threads, me) = if (iter.is_none() && !items.is_empty()) || wants_summary {
        tokio::join!(host.threads(pr_id), host.me())
    } else {
        (Vec::new(), None)
    };

    // 1. Decide.
    let mut claimed = vec![false; findings.len()];
    let mut steps: Vec<(Option<usize>, Option<String>, Step)> = Vec::with_capacity(items.len());
    for item in items {
        let idx = crate::review_memory::match_publish_item(findings, &item.key(), &claimed);
        if let Some(k) = idx {
            claimed[k] = true;
        }
        let id = idx.map(|k| findings[k].id.clone()).or_else(|| item.id.clone());
        let step = if idx.is_some_and(|k| already_published(&findings[k], iter) || resolution_announced(&findings[k])) {
            Step::Skip
        } else if let Some((thread, general)) = idx.and_then(|k| findings[k].thread_id.map(|t| (t, findings[k].hilo_general))) {
            Step::FollowUp { thread, general }
        } else if iter.is_none() && already_on_pr(&threads, &item.content) {
            Step::AlreadyOnPr
        } else {
            Step::Open
        };
        steps.push((idx, id, step));
    }
    let mut results: Vec<Option<(&'static str, Result<(), String>)>> = (0..items.len()).map(|_| None).collect();

    // 2. GitHub: every new anchored comment as one review. All or nothing on GitHub's side — one line
    //    it cannot anchor refuses the lot — so a refusal falls through to one by one below, where each
    //    item gets its own fallback to a general comment.
    if let (ThreadHost::GitHub { host: gh, owner, repo, token }, Some(head)) = (host, github_head.as_deref()) {
        let batch: Vec<usize> =
            (0..items.len()).filter(|i| matches!(steps[*i].2, Step::Open) && items[*i].location.is_some()).collect();
        if batch.len() >= 2 {
            let comments: Vec<github::BatchComment> = batch
                .iter()
                .filter_map(|i| {
                    let loc = items[*i].location.as_ref()?;
                    Some(github::BatchComment { path: &loc.file, start_line: loc.start_line, end_line: loc.end_line, body: &items[*i].content })
                })
                .collect();
            match github::post_pr_review_batch(gh, owner, repo, pr_id, head, &comments, token).await {
                Ok(ids) => {
                    for (i, thread) in batch.iter().zip(ids) {
                        if let Some(k) = steps[*i].0 {
                            record_published(&mut findings[k], iter, Some((thread, false)));
                        }
                        results[*i] = Some(("opened", Ok(())));
                    }
                }
                // The review exists but its comments could not be told apart: they are on the PR, so
                // re-posting would duplicate every one. Marked as published in this iteration without a
                // thread — a later iteration opens fresh ones rather than replying into the void.
                Err(e) if e.starts_with("GitHub posted the review") => {
                    for i in &batch {
                        if let Some(k) = steps[*i].0 {
                            record_published(&mut findings[k], iter, None);
                        }
                        results[*i] = Some(("opened", Err(e.clone())));
                    }
                }
                Err(_) => {}
            }
        }
    }

    // 3. Everything else, one by one.
    let mut outcome = PublishOutcome::default();
    for (i, item) in items.iter().enumerate() {
        let (idx, id, step) = &steps[i];
        if let Some((status, result)) = results[i].take() {
            outcome.items.push(PublishedItem { id: id.clone(), status: status.to_string(), error: result.err() });
            continue;
        }
        let (status, result) = match step {
            Step::Skip => ("skipped", Ok(())),
            Step::AlreadyOnPr => ("skipped", Ok(())),
            Step::Open => {
                let opened = match &item.location {
                    Some(loc) if !(matches!(host, ThreadHost::GitHub { .. }) && github_head.is_none()) => {
                        match host.open_anchored(pr_id, &item.content, loc, github_head.as_deref()).await {
                            Ok(thread) => Ok((thread, false, "opened")),
                            Err(e) if host.refused_the_line(&e) => host
                                .open_general(pr_id, &general_fallback_body(&item.content, loc))
                                .await
                                .map(|thread| (thread, true, "fallback")),
                            Err(e) => Err(e),
                        }
                    }
                    Some(loc) => host
                        .open_general(pr_id, &general_fallback_body(&item.content, loc))
                        .await
                        .map(|thread| (thread, true, "fallback")),
                    None => host.open_general(pr_id, &item.content).await.map(|thread| (thread, true, "opened")),
                };
                match opened {
                    Ok((thread, general, status)) => {
                        if let Some(k) = idx {
                            record_published(&mut findings[*k], iter, Some((thread, general)));
                        }
                        (status, Ok(()))
                    }
                    Err(e) => ("failed", Err(e)),
                }
            }
            Step::FollowUp { thread, general } => {
                let k = idx.expect("a thread comes from a stored finding");
                let resolved = findings[k].estado == "resuelto";
                let about = (*general && !azure).then_some(findings[k].id.as_str());
                // A fix announced a run late still names the iteration that fixed it.
                let when = if resolved { findings[k].resuelto_en_iter.or(iter) } else { iter };
                let mut text = follow_up_text(azure, resolved, when.unwrap_or(1), &today, about);
                if resolved {
                    // What fixed it, and the code that does — "resuelto" alone asks the author to
                    // take the tool's word for it.
                    let snippet = code(&findings[k]);
                    text.push_str(&crate::review_memory::resolution_note(&findings[k], snippet.as_deref()));
                }
                match host.follow_up(pr_id, *thread, &text, *general).await {
                    Ok(()) => {
                        record_published(&mut findings[k], iter, None);
                        // Azure closes any thread; GitHub and GitLab cannot resolve a general comment.
                        if resolved && (azure || !general) {
                            // The reply stands either way; a thread the host won't close stays open,
                            // and the outcome says so rather than reporting it closed.
                            match host.close_as_fixed(pr_id, *thread).await {
                                Ok(()) => ("resolved", Ok(())),
                                Err(e) => ("replied", Err(e)),
                            }
                        } else {
                            ("replied", Ok(()))
                        }
                    }
                    Err(e) => ("failed", Err(e)),
                }
            }
        };
        outcome.items.push(PublishedItem { id: id.clone(), status: status.to_string(), error: result.err() });
    }

    // 4. The summary: the one this user left last time, rewritten — or a new one.
    if wants_summary {
        let text = summary.unwrap_or_default();
        // Only a review summary replaces a review summary — a decision note or a flow's own text is
        // a comment of its own.
        let existing = if text.trim_start().starts_with(SUMMARY_HEADING) { own_summary(&threads, me.as_deref()) } else { None };
        let edited = match existing {
            Some(thread) => host.edit_general(pr_id, thread, text).await.is_ok(),
            None => false,
        };
        if edited {
            outcome.summary_posted = Some(true);
            outcome.summary_updated = true;
        } else {
            match host.open_general(pr_id, text).await {
                Ok(_) => outcome.summary_posted = Some(true),
                Err(e) => {
                    outcome.summary_posted = Some(false);
                    outcome.summary_error = Some(e);
                }
            }
        }
    }
    outcome
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
        LinkedRepo::GitLab { host, project: path } => {
            let token = gitlab_token(&host)?;
            gitlab::viewer_decision(&host, &path, pr_id, &token).await
        }
        LinkedRepo::Bitbucket { workspace, repo } => {
            let auth = bitbucket_auth(&workspace)?;
            bitbucket::viewer_decision(&workspace, &repo, pr_id, &auth).await
        }
    }
}

/// A decision on a Bitbucket pull request — the one mapping both `act_on_pull_request` and its
/// link-only twin use, so the two cannot drift: approve, request changes (with the same default
/// comment GitHub's review gets when none is typed), or decline, which is Bitbucket's close.
async fn bitbucket_decide(
    workspace: &str,
    repo: &str,
    pr_id: i64,
    action: &str,
    comment: &str,
    auth: &bitbucket::BitbucketAuth,
) -> Result<(), String> {
    match action {
        "approve" => bitbucket::submit_pr_review(workspace, repo, pr_id, "APPROVE", comment, auth).await,
        "request_changes" => {
            let text = if comment.trim().is_empty() { "Cambios solicitados desde CodeFlow." } else { comment };
            bitbucket::submit_pr_review(workspace, repo, pr_id, "REQUEST_CHANGES", text, auth).await
        }
        "close" => bitbucket::decline_pull_request(workspace, repo, pr_id, auth).await,
        other => Err(format!("unknown PR action: {other}")),
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
/// here (GitHub review events / state vs Azure reviewer vote / abandon vs GitLab
/// approve / unapprove / `state_event`). `body` is an optional comment carried on a GitHub review
/// and on a GitLab decision — both need a non-empty body to request changes, so a default is
/// substituted when blank; Azure votes carry no message.
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
        // The same mapping the link-only twin uses; both go through `gitlab::submit_pr_review`
        // rather than spelling out approve/unapprove here, so the two cannot drift.
        LinkedRepo::GitLab { host, project: path } => {
            let token = gitlab_token(host)?;
            match action.as_str() {
                "approve" => gitlab::submit_pr_review(host, path, pr_id, "APPROVE", &comment, &token).await,
                "request_changes" => {
                    let text = if comment.trim().is_empty() { "Cambios solicitados desde CodeFlow." } else { &comment };
                    gitlab::submit_pr_review(host, path, pr_id, "REQUEST_CHANGES", text, &token).await
                }
                "close" => gitlab::close_merge_request(host, path, pr_id, &token).await,
                other => Err(format!("unknown PR action: {other}")),
            }?;
            gitlab::get_merge_request(host, path, pr_id, &token).await?
        }
        LinkedRepo::Bitbucket { workspace, repo } => {
            let auth = bitbucket_auth(workspace)?;
            bitbucket_decide(workspace, repo, pr_id, &action, &comment, &auth).await?;
            bitbucket::get_pull_request(workspace, repo, pr_id, &auth).await?
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

// ---------------------------------------------------------------------------
// Approving on the strength of a review
// ---------------------------------------------------------------------------

/// Who the host will record a decision taken from here as — the account behind the credential.
///
/// What the approval's confirmation names before anything is sent: approving is an act in someone's
/// name, and "approve as whoever this token happens to be" is not a question a person can answer
/// yes to. `None` only on Bitbucket, whose access tokens are not a person and cannot say who they
/// are; every other host failing to answer is an error, since the approval would fail the same way.
async fn approver_on(host: &ThreadHost<'_>) -> Result<Option<String>, String> {
    match host {
        ThreadHost::Azure { org, pat, .. } => ado::authenticated_identity(org, pat).await.map(Some),
        ThreadHost::GitHub { host, token, .. } => {
            github::get_authenticated_user(host, token).await.map(|login| Some(format!("@{login}")))
        }
        ThreadHost::GitLab { host, token, .. } => {
            gitlab::get_authenticated_user(host, token).await.map(|user| Some(format!("@{user}")))
        }
        ThreadHost::Bitbucket { auth, .. } => Ok(bitbucket::get_authenticated_user(auth)
            .await
            .ok()
            .map(|user| user.display_name)
            .filter(|name| !name.trim().is_empty())),
    }
}

/// The account an approval of this pull request would be cast as — a project's PR by
/// `project_id`, a PR reached by link by `url`. Asked by the approval's confirmation, right before
/// it is shown.
#[tauri::command]
pub async fn pr_approval_account(
    db: State<'_, Db>,
    project_id: Option<String>,
    url: Option<String>,
) -> Result<Option<String>, String> {
    if let Some(project_id) = project_id.filter(|id| !id.is_empty()) {
        let project = load_project(&db, &project_id)?;
        let link = linked_repo(&project)?;
        let credential = link_credential(&link)?;
        return approver_on(&linked_host(&link, &credential)).await;
    }
    let url = url.filter(|u| !u.is_empty()).ok_or_else(|| "no pull request to approve".to_string())?;
    let (target, credential) = link_credentials(&db, &url)?;
    let (host, _) = link_host(&target, &credential);
    approver_on(&host).await
}

/// What approving from a review left behind: the PR as the host reports it now, the Activity row
/// the decision was filed as (a project's `job_history` row or a workspace's — the two decision
/// commands' own), the account it was cast as, and whether the run's memory now records it.
#[derive(Serialize)]
pub struct PrApprovalOutcome {
    pub pr: ado::PullRequestSummary,
    pub activity: serde_json::Value,
    pub account: Option<String>,
    /// False when there was no saved run to write it to (a review reached by link keeps none).
    pub recorded: bool,
}

/// Approves the pull request because a review of it passed — and writes into that run's memory who
/// approved, when, and under which gate.
///
/// The same host call as the decision menu's approve (`act_on_pull_request` / `act_on_pr_link`), so
/// the per-host mapping lives in one place: Azure's reviewer vote 10, GitHub's APPROVE review,
/// GitLab's `/approve`, Bitbucket's `/approve`. What this adds is the two ends around it:
///
/// - **a guard**: when the run is saved, its gate is re-derived from its findings as they stand now
///   (a human may have rejected the one that failed it) and the approval is refused unless it passed,
///   conclusively, on a complete review. The panel only offers the action then; this is what keeps a
///   stale screen from approving on a gate that no longer holds.
/// - **the record**: `meta.approval` on the run. The memory has to say that a person approved this
///   pull request — the reviewer only informed the decision.
///
/// `account` is the account the confirmation named, recorded as the person agreed to it.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn approve_pr_from_review(
    db: State<'_, Db>,
    project_id: Option<String>,
    url: Option<String>,
    workspace_id: Option<String>,
    pr_id: i64,
    run_id: Option<String>,
    account: Option<String>,
) -> Result<PrApprovalOutcome, String> {
    // The saved run the approval rests on: the one on screen when it is a run, otherwise this PR's
    // newest run in its memory scope — a link review's, which no project owns, included.
    let run_id = approval_run_id(&db, project_id.as_deref(), url.as_deref(), workspace_id.as_deref(), pr_id, run_id).await?;
    let stored = match &run_id {
        Some(id) => {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            queries::review_run_meta_findings(&conn, id).map_err(|e| e.to_string())?
        }
        None => None,
    };
    let verdict = stored.as_ref().map(|(meta, findings)| {
        let meta: serde_json::Value = serde_json::from_str(meta).unwrap_or(serde_json::Value::Null);
        let findings: Vec<crate::review_memory::MemoryFinding> = serde_json::from_str(findings).unwrap_or_default();
        crate::review_approval::gate_verdict(&meta, &findings)
    });
    if let Some(verdict) = verdict.as_ref().filter(|v| !v.approvable()) {
        return Err(format!("No se aprobó el PR: {}.", verdict.refusal().unwrap_or_default()));
    }

    let (pr, activity) = match project_id.filter(|id| !id.is_empty()) {
        Some(project_id) => {
            let done = act_on_pull_request(db.clone(), project_id, pr_id, "approve".to_string(), None).await?;
            (done.pr, serde_json::to_value(done.activity).unwrap_or_default())
        }
        None => {
            let url = url.filter(|u| !u.is_empty()).ok_or_else(|| "no pull request to approve".to_string())?;
            let workspace_id = workspace_id.unwrap_or_default();
            let done = act_on_pr_link(db.clone(), url, workspace_id, "approve".to_string(), None).await?;
            (done.pr, serde_json::to_value(done.activity).unwrap_or_default())
        }
    };

    // The approval is on the host by now and cannot be taken back from here, so failing to write
    // the record is reported as "not recorded", never as a failed approval.
    let recorded = match (&run_id, &stored, &verdict) {
        (Some(id), Some((meta, _)), Some(verdict)) => {
            let at = chrono::Utc::now().to_rfc3339();
            let next = crate::review_approval::with_approval(meta, account.as_deref(), &pr.provider, &at, verdict);
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            queries::set_review_run_meta(&conn, id, &next).unwrap_or(false)
        }
        _ => false,
    };

    Ok(PrApprovalOutcome { pr, activity, account, recorded })
}


// ---------------------------------------------------------------------------
// Merging and checks
// ---------------------------------------------------------------------------

/// How the user asked for a pull request to be merged.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeChoice {
    /// One of `MergeOptions::methods`.
    pub method: String,
    #[serde(default)]
    pub delete_source_branch: bool,
    /// GitLab only; `None` leaves it to the project.
    #[serde(default)]
    pub squash: Option<bool>,
    /// Azure DevOps only.
    #[serde(default)]
    pub transition_work_items: Option<bool>,
}

/// A merge the host accepted, before it is filed anywhere.
struct HostMerge {
    pr: ado::PullRequestSummary,
    /// False on Azure while a completion it accepted is still merging — requested, not refused.
    merged: bool,
    warning: Option<String>,
}

/// What a merge left behind: the pull request as the host now reports it, whether it is merged yet,
/// anything that half-worked (a branch that couldn't be deleted), and the Activity row it was filed
/// under.
#[derive(Serialize)]
pub struct PrMergeOutcome {
    pub pr: ado::PullRequestSummary,
    pub merged: bool,
    pub warning: Option<String>,
    pub activity: crate::db::models::JobHistoryEntry,
}

/// The same, for a pull request reached by link — its Activity row belongs to the workspace.
#[derive(Serialize)]
pub struct PrLinkMergeOutcome {
    pub pr: ado::PullRequestSummary,
    pub merged: bool,
    pub warning: Option<String>,
    pub activity: crate::db::models::WorkspaceActivityEntry,
}

async fn merge_options_on(host: &ThreadHost<'_>, pr_id: i64) -> Result<ado::MergeOptions, String> {
    match host {
        ThreadHost::Azure { org, project, repo, pat } => ado::merge_options(org, project, repo, pr_id, pat).await,
        ThreadHost::GitHub { host, owner, repo, token } => github::merge_options(host, owner, repo, pr_id, token).await,
        ThreadHost::GitLab { host, project, token } => gitlab::merge_options(host, project, pr_id, token).await,
        ThreadHost::Bitbucket { workspace, repo, auth } => bitbucket::merge_options(workspace, repo, pr_id, auth).await,
    }
}

/// Merges on the host. A refusal comes back as `ado::MERGE_BLOCKED_MARKER` + its kind, which the
/// panel turns into a sentence about what to do.
async fn merge_on(host: &ThreadHost<'_>, pr_id: i64, choice: &MergeChoice) -> Result<HostMerge, String> {
    match host {
        ThreadHost::Azure { org, project, repo, pat } => {
            let done = ado::complete_pull_request(
                org,
                project,
                repo,
                pr_id,
                &choice.method,
                choice.delete_source_branch,
                choice.transition_work_items.unwrap_or(true),
                pat,
            )
            .await?;
            Ok(HostMerge { pr: done.summary, merged: done.merged, warning: None })
        }
        ThreadHost::GitHub { host, owner, repo, token } => {
            let done =
                github::merge_pull_request(host, owner, repo, pr_id, &choice.method, choice.delete_source_branch, token)
                    .await?;
            Ok(HostMerge { merged: done.summary.status == "merged", pr: done.summary, warning: done.warning })
        }
        ThreadHost::GitLab { host, project, token } => {
            let done =
                gitlab::merge_merge_request(host, project, pr_id, choice.squash, choice.delete_source_branch, token).await?;
            Ok(HostMerge { pr: done.summary, merged: done.merged, warning: None })
        }
        ThreadHost::Bitbucket { workspace, repo, auth } => {
            let done =
                bitbucket::merge_pull_request(workspace, repo, pr_id, &choice.method, choice.delete_source_branch, auth)
                    .await?;
            Ok(HostMerge { pr: done.summary, merged: done.merged, warning: None })
        }
    }
}

/// Which saved run an approval from a review is recorded on. The id the panel sent when it names a
/// run of this pull request; otherwise the newest run of the PR in its memory scope — by project,
/// or, for a review by link, by the repository key the link review saved its runs under (Azure's
/// canonical project/repo names read back from the host, as the review itself does). `None` when the
/// PR has no saved run at all.
async fn approval_run_id(
    db: &State<'_, Db>,
    project_id: Option<&str>,
    url: Option<&str>,
    workspace_id: Option<&str>,
    pr_id: i64,
    run_id: Option<String>,
) -> Result<Option<String>, String> {
    let named = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        run_id
            .filter(|id| !id.is_empty())
            .filter(|id| queries::get_review_run(&conn, id).ok().flatten().is_some_and(|run| run.pr_id == pr_id))
    };
    if named.is_some() {
        return Ok(named);
    }
    if let Some(project_id) = project_id.filter(|p| !p.is_empty()) {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        return Ok(queries::latest_review_run_id(&conn, project_id, pr_id).ok().flatten());
    }
    let (Some(url), Some(workspace_id)) = (url.filter(|u| !u.is_empty()), workspace_id.filter(|w| !w.is_empty())) else {
        return Ok(None);
    };
    let Ok((target, credential)) = link_credentials(db, url) else { return Ok(None) };
    let repo_key = match &target {
        crate::pr_link::PrLinkTarget::Azure { org, project, repo, number } => {
            match ado::get_pull_request(org, project, repo, *number, &credential).await {
                Ok(detail) => link_repo_key(&target, Some((detail.project_name.as_str(), detail.repo_name.as_str()))),
                Err(_) => link_repo_key(&target, None),
            }
        }
        _ => link_repo_key(&target, None),
    };
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let scope = queries::MemoryScope { project_id: None, workspace_id, repo_key: &repo_key };
    Ok(queries::latest_review_run_id_in(&conn, &scope, pr_id).ok().flatten())
}

/// The line coverage the pull request's CI published, as a percentage — `None` when its host has
/// none to give, which the review reads as "say nothing".
///
/// Azure DevOps: the coverage summary of the builds the PR's checks point at (its latest iteration's
/// policy builds). GitLab: the head pipeline's parsed coverage, which its own MR widget shows.
/// GitHub and Bitbucket publish no coverage of their own — it lives in third-party services — so
/// they are not asked.
async fn coverage_on(link: &LinkedRepo, credential: Option<&str>, pr_id: i64, checks: Option<&ado::PrChecks>) -> Option<f64> {
    let credential = credential?;
    match link {
        LinkedRepo::Azure { org, project, .. } => {
            let builds: Vec<String> = checks?.checks.iter().filter_map(|c| c.pipeline_run_id.clone()).collect();
            ado::pr_code_coverage(org, project, &builds, credential).await.map(|c| c.pct())
        }
        LinkedRepo::GitLab { host, project } => gitlab::pr_code_coverage(host, project, pr_id, credential).await,
        _ => None,
    }
}

/// [`coverage_on`] for a pull request reached by link: the same host numbers, read through the link's
/// own coordinates (Azure DevOps' via the PR's checks, GitLab's head pipeline).
async fn coverage_on_link(target: &crate::pr_link::PrLinkTarget, credential: &str) -> Option<f64> {
    match target {
        crate::pr_link::PrLinkTarget::Azure { org, project, .. } => {
            let (host, number) = link_host(target, credential);
            let checks = checks_on(&host, number).await.ok()?;
            let builds: Vec<String> = checks.checks.iter().filter_map(|c| c.pipeline_run_id.clone()).collect();
            ado::pr_code_coverage(org, project, &builds, credential).await.map(|c| c.pct())
        }
        crate::pr_link::PrLinkTarget::GitLab { host, project, number } => {
            gitlab::pr_code_coverage(host, project, *number, credential).await
        }
        _ => None,
    }
}

async fn checks_on(host: &ThreadHost<'_>, pr_id: i64) -> Result<ado::PrChecks, String> {
    match host {
        ThreadHost::Azure { org, project, repo, pat } => ado::pr_checks(org, project, repo, pr_id, pat).await,
        ThreadHost::GitHub { host, owner, repo, token } => github::pr_checks(host, owner, repo, pr_id, token).await,
        ThreadHost::GitLab { host, project, token } => gitlab::pr_checks(host, project, pr_id, token).await,
        ThreadHost::Bitbucket { workspace, repo, auth } => bitbucket::pr_checks(workspace, repo, pr_id, auth).await,
    }
}

/// The meta a merge's Activity row carries — the decision rows' shape plus how it was merged.
fn merge_activity_meta(pr: &ado::PullRequestSummary, choice: &MergeChoice, merged: bool) -> serde_json::Value {
    serde_json::json!({
        "prId": pr.id,
        "prTitle": pr.title,
        "action": "merge",
        "method": choice.method,
        "deleteSourceBranch": choice.delete_source_branch,
        // Azure completes in the background: the row says "requested" until the host says merged.
        "queued": !merged,
    })
}

/// How a pull request can be merged from here: the methods its host and repository allow, the
/// branch and squash switches, and what the host says about merging it right now. Read when the user
/// opens the merge step, never before — it is two requests nobody needs until then.
#[tauri::command]
pub async fn pr_merge_options(db: State<'_, Db>, project_id: String, pr_id: i64) -> Result<ado::MergeOptions, String> {
    let project = load_project(&db, &project_id)?;
    let link = linked_repo(&project)?;
    let credential = link_credential(&link)?;
    merge_options_on(&linked_host(&link, &credential), pr_id).await
}

/// Merges (on Azure DevOps: completes) a pull request and files it in Activity like any decision.
#[tauri::command]
pub async fn merge_pull_request(
    db: State<'_, Db>,
    project_id: String,
    pr_id: i64,
    choice: MergeChoice,
) -> Result<PrMergeOutcome, String> {
    let project = load_project(&db, &project_id)?;
    let link = linked_repo(&project)?;
    let credential = link_credential(&link)?;
    let done = merge_on(&linked_host(&link, &credential), pr_id, &choice).await?;

    let label = format!("#{} {}", done.pr.id, done.pr.title);
    let meta = merge_activity_meta(&done.pr, &choice, done.merged).to_string();
    let activity = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::add_job_history(
            &conn,
            &uuid::Uuid::new_v4().to_string(),
            &project_id,
            "pr-action",
            &label,
            "done",
            Some(&done.pr.url),
            None,
            &meta,
        )
        .map_err(|e| e.to_string())?
    };
    Ok(PrMergeOutcome { pr: done.pr, merged: done.merged, warning: done.warning, activity })
}

/// [`pr_merge_options`] for a pull request reached by link.
#[tauri::command]
pub async fn pr_link_merge_options(db: State<'_, Db>, url: String) -> Result<ado::MergeOptions, String> {
    let (target, credential) = link_credentials(&db, &url)?;
    let (host, number) = link_host(&target, &credential);
    merge_options_on(&host, number).await
}

/// [`merge_pull_request`] for a pull request reached by link — filed in the workspace's Activity.
#[tauri::command]
pub async fn merge_pr_link(
    db: State<'_, Db>,
    url: String,
    workspace_id: String,
    choice: MergeChoice,
) -> Result<PrLinkMergeOutcome, String> {
    let (target, credential) = link_credentials(&db, &url)?;
    let (host, number) = link_host(&target, &credential);
    let done = merge_on(&host, number, &choice).await?;

    // Azure hands back canonical names on the pull request's own URL only, so the label uses the
    // coordinates the link carried — the same thing every other row of this session shows.
    let (repo_label, clone_url) = link_repo_coords(&target, None);
    let label = link_activity_label(&done.pr, &repo_label);
    let meta = link_activity_meta(&url, &done.pr, &repo_label, &clone_url, merge_activity_meta(&done.pr, &choice, done.merged));
    let activity = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::add_workspace_activity(
            &conn,
            &uuid::Uuid::new_v4().to_string(),
            &workspace_id,
            "pr-action",
            &label,
            "done",
            Some(&done.pr.url),
            None,
            &meta,
        )
        .map_err(|e| e.to_string())?
    };
    Ok(PrLinkMergeOutcome { pr: done.pr, merged: done.merged, warning: done.warning, activity })
}

/// The checks on a pull request's head commit — GitHub check runs and statuses, GitLab's head
/// pipeline and its jobs, Azure's PR statuses and branch-policy evaluations — in one shape.
#[tauri::command]
pub async fn pr_checks(db: State<'_, Db>, project_id: String, pr_id: i64) -> Result<ado::PrChecks, String> {
    let project = load_project(&db, &project_id)?;
    let link = linked_repo(&project)?;
    let credential = link_credential(&link)?;
    checks_on(&linked_host(&link, &credential), pr_id).await
}

/// [`pr_checks`] for a pull request reached by link.
#[tauri::command]
pub async fn pr_link_checks(db: State<'_, Db>, url: String) -> Result<ado::PrChecks, String> {
    let (target, credential) = link_credentials(&db, &url)?;
    let (host, number) = link_host(&target, &credential);
    checks_on(&host, number).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The same failure the commit box had, in the PR form: engines that print the model's
    /// deliberation alongside its answer filled the description with it. The format puts the title
    /// first, so nothing before it is description.
    #[test]
    fn the_draft_starts_at_the_title_not_at_whatever_the_model_said_first() {
        let raw = "Analizando el diff entre las ramas…\n\nTITLE: feat: agregar túnel SSH\n\n## Qué cambia\n- soporte MSSQL";
        let draft = parse_pr_draft(raw);
        assert_eq!(draft.title, "feat: agregar túnel SSH");
        assert_eq!(draft.body, "## Qué cambia\n- soporte MSSQL");
    }

    /// No marker at all: the whole reply is the description, as before.
    #[test]
    fn a_reply_without_a_title_marker_is_all_body() {
        let draft = parse_pr_draft("  ## Qué cambia\n- soporte MSSQL  ");
        assert_eq!(draft.title, "");
        assert_eq!(draft.body, "## Qué cambia\n- soporte MSSQL");
    }

    fn thread(id: i64, comments: &[(&str, &str)]) -> ado::PrCommentThread {
        ado::PrCommentThread {
            id,
            file_path: None,
            start_line: None,
            end_line: None,
            comments: comments
                .iter()
                .map(|(author, published)| ado::PrThreadComment {
                    author: (*author).to_string(),
                    content: "…".to_string(),
                    published_date: (*published).to_string(),
                })
                .collect(),
            resolved: false,
        }
    }

    fn ids(ids: &[i64]) -> std::collections::HashSet<i64> {
        ids.iter().copied().collect()
    }

    /// The whole point of the count: a reviewer wrote something and no code moved. Without this the
    /// "same head commit" check would skip the run and the comment would never reach the model.
    #[test]
    fn a_reviewer_commenting_after_the_last_run_counts_as_new_input() {
        let threads = [thread(1, &[("Ana", "2026-07-31T12:00:00Z")])];
        assert_eq!(comments_since(&threads, Some("2026-07-31T10:00:00+00:00"), &ids(&[]), None), 1);
    }

    /// Both spellings of UTC appear in practice — the hosts write `Z`, this app's own clock writes
    /// `+00:00` — and comparing them as strings gets the order wrong.
    #[test]
    fn timestamps_are_compared_as_instants_not_as_text() {
        let threads = [thread(1, &[("Ana", "2026-07-31T09:00:00Z")])];
        assert_eq!(comments_since(&threads, Some("2026-07-31T10:00:00+00:00"), &ids(&[]), None), 0);
    }

    /// CodeFlow publishes its own findings as threads on the pull request, seconds after the run
    /// that produced them. Counting those would make every re-review re-analyse a diff nobody
    /// touched.
    #[test]
    fn this_apps_own_finding_threads_are_not_somebody_answering() {
        let threads = [thread(7, &[("Sebastián", "2026-07-31T12:00:00Z")])];
        assert_eq!(comments_since(&threads, Some("2026-07-31T10:00:00Z"), &ids(&[7]), None), 0);
    }

    /// The summary comment and the decision note are written as the signed-in user and belong to no
    /// finding thread — the author is the only thing that tells them apart from a reviewer's words.
    #[test]
    fn the_signed_in_users_own_comments_are_not_new_input() {
        let threads = [thread(9, &[("Sebastián", "2026-07-31T12:00:00Z"), ("Ana", "2026-07-31T12:30:00Z")])];
        assert_eq!(comments_since(&threads, Some("2026-07-31T10:00:00Z"), &ids(&[]), Some("sebastián")), 1);
    }

    /// A pull request never reviewed here has nothing to be newer than — every comment on it is
    /// simply part of the first review's context.
    #[test]
    fn nothing_is_new_when_there_is_no_previous_run() {
        let threads = [thread(1, &[("Ana", "2026-07-31T12:00:00Z")])];
        assert_eq!(comments_since(&threads, None, &ids(&[]), None), 0);
    }

    /// A timestamp nothing can parse is not evidence that something happened: guessing "newer"
    /// would re-run the review on every click, forever.
    #[test]
    fn an_unreadable_timestamp_does_not_trigger_a_review() {
        let threads = [thread(1, &[("Ana", "ayer por la tarde")])];
        assert_eq!(comments_since(&threads, Some("2026-07-31T10:00:00Z"), &ids(&[]), None), 0);
    }

    fn stored(id: &str, estado: &str, thread: Option<i64>) -> crate::review_memory::MemoryFinding {
        serde_json::from_value(serde_json::json!({
            "id": id, "severity": "critical", "tipo": "Bug", "categoria": "npe", "subtitulo": "s",
            "archivo": "src/a.ts", "lineas": "10", "confianza": 80, "estado": estado,
            "thread_id": thread, "introducido_en_iter": 1
        }))
        .expect("a stored finding")
    }

    /// The phone sends items without an id; they still deserialize, and match by file and line.
    #[test]
    fn an_item_without_an_id_still_reads_and_keys_on_its_location() {
        let item: PostFindingItem = serde_json::from_value(serde_json::json!({
            "file": null, "category": "npe", "content": "…",
            "location": { "file": "src/a.ts", "startLine": 480, "endLine": 470 }
        }))
        .expect("an item");
        let key = item.key();
        assert_eq!(key.id, None);
        assert_eq!(key.file, Some("src/a.ts"), "the location's file stands in for a missing one");
        assert_eq!(key.lines, Some((480, 480)), "a range written backwards is one line, not a negative span");
    }

    /// A line the host refused still reaches the pull request — as a general comment that says which
    /// line it is about.
    #[test]
    fn the_general_fallback_names_the_line() {
        let loc = CommentLocation { file: "/src/a.ts".into(), start_line: 42, end_line: 50 };
        let body = general_fallback_body("### 🚨 [Bug] npe · F-003", &loc);
        assert!(body.starts_with("📍 `src/a.ts:42-50`"), "{body}");
        assert!(body.ends_with("### 🚨 [Bug] npe · F-003"));
        let single = CommentLocation { file: "a.ts".into(), start_line: 7, end_line: 7 };
        assert!(general_fallback_body("x", &single).starts_with("📍 `a.ts:7`"));
    }

    #[test]
    fn a_follow_up_on_a_general_comment_names_its_finding() {
        assert_eq!(follow_up_text(false, false, 3, "2026-09-28", None), "➡️ Sigue presente en la iteración 3 — 2026-09-28.");
        assert_eq!(
            follow_up_text(false, true, 3, "2026-09-28", Some("F-004")),
            "✔️ **F-004** — Resuelto en la iteración 3 — 2026-09-28."
        );
        assert!(follow_up_text(true, true, 2, "d", None).contains("Marcado como fixed"));
    }

    /// The re-publish bug: a finding opened seconds ago in this iteration must not get a "sigue
    /// presente" reply on its own brand-new thread when the user publishes again.
    #[test]
    fn what_was_published_in_this_iteration_is_not_published_again() {
        let mut finding = stored("F-001", "abierto", None);
        assert!(!already_published(&finding, Some(2)));
        record_published(&mut finding, Some(2), Some((77, false)));
        assert_eq!(finding.thread_id, Some(77));
        assert_eq!(finding.estado, "posteado");
        assert!(already_published(&finding, Some(2)));
        assert!(!already_published(&finding, Some(3)), "the next iteration may speak again");
        assert!(!already_published(&finding, None), "a link review has no memory to consult");

        // A general comment is remembered as one, so a later follow-up doesn't try to reply to it.
        let mut general = stored("F-002", "abierto", None);
        record_published(&mut general, Some(1), Some((9, true)));
        assert!(general.hilo_general);
        // A reply keeps the thread and the state, and only moves the publish mark.
        let mut resolved = stored("F-003", "resuelto", Some(5));
        record_published(&mut resolved, Some(4), None);
        assert_eq!((resolved.thread_id, resolved.estado.as_str(), resolved.publicado_en_iter), (Some(5), "resuelto", Some(4)));
    }

    /// The phone's all-or-nothing answer still says what landed.
    #[test]
    fn the_legacy_answer_reports_a_partial_publish_honestly() {
        let item = |status: &str, error: Option<&str>| PublishedItem {
            id: None,
            status: status.to_string(),
            error: error.map(str::to_string),
        };
        let clean = PublishOutcome { items: vec![item("opened", None), item("skipped", None)], ..Default::default() };
        assert!(clean.into_legacy().is_ok());

        let partial = PublishOutcome {
            items: vec![item("opened", None), item("failed", Some("GitHub returned 500")), item("fallback", None)],
            summary_posted: Some(false),
            summary_error: Some("timeout".into()),
            ..Default::default()
        };
        let error = partial.into_legacy().unwrap_err();
        assert_eq!(error, "2 comment(s) failed to post (2 posted) — #2: GitHub returned 500; summary: timeout");
    }

    fn general(id: i64, author: &str, content: &str, at: &str) -> ado::PrCommentThread {
        ado::PrCommentThread {
            id,
            file_path: None,
            start_line: None,
            end_line: None,
            comments: vec![ado::PrThreadComment { author: author.into(), content: content.into(), published_date: at.into() }],
            resolved: false,
        }
    }

    /// A publish edits the newest summary *this user* left — never somebody else's, never a decision.
    #[test]
    fn the_summary_to_edit_is_my_newest_one() {
        let threads = vec![
            general(1, "me", "### 📋 Revisión automatizada (pr-review) — 2026-10-01", "2026-10-01T10:00:00Z"),
            general(2, "me", "### 📋 Revisión automatizada (pr-review) — 2026-10-03", "2026-10-03T10:00:00Z"),
            general(3, "ana", "### 📋 Revisión automatizada (pr-review) — 2026-10-04", "2026-10-04T10:00:00Z"),
            general(4, "me", "### ✅ **Aprobado** — 2026-10-05", "2026-10-05T10:00:00Z"),
        ];
        assert_eq!(own_summary(&threads, Some("ME")), Some(2));
        assert_eq!(own_summary(&threads, None), None, "without knowing who we are, edit nothing");
    }

    /// A review with no memory recognises a comment already on the PR by heading *and* subtitle — the
    /// heading alone repeats across runs (F-001 every time).
    #[test]
    fn a_comment_already_on_the_pr_is_recognised_by_its_first_two_lines() {
        let threads = vec![general(9, "me", "📍 `a.ts:3` _(fuera del diff)_\n\n### 🚨 [Bug] npe · F-001\n\nSe lee saldo sin validar.\n\n💭 x", "2026-10-01T10:00:00Z")];
        assert!(already_on_pr(&threads, "### 🚨 [Bug] npe · F-001\n\nSe lee saldo sin validar.\n\n💭 y"));
        assert!(!already_on_pr(&threads, "### 🚨 [Bug] npe · F-001\n\nOtra cosa distinta."));
    }

    /// Closing the threads of resolved findings never sends one twice — a second copy would be matched
    /// to another finding of the same kind.
    #[test]
    fn resolved_threads_are_closed_once_and_only_theirs() {
        let mut gone = stored("F-001", "resuelto", Some(11));
        gone.publicado_en_iter = Some(1);
        let findings = vec![gone, stored("F-002", "resuelto", Some(12)), stored("F-003", "resuelto", None), stored("F-004", "posteado", Some(14))];
        let closures = resolved_closures(&findings, 2, &[]);
        assert_eq!(closures.iter().filter_map(|c| c.id.clone()).collect::<Vec<_>>(), vec!["F-001", "F-002"]);
        assert!(resolved_closures(&findings, 1, &[]).iter().all(|c| c.id.as_deref() != Some("F-001")), "already written this iteration");
        let explicit = vec![PostFindingItem { id: Some("F-002".into()), file: None, category: String::new(), content: String::new(), location: None }];
        assert_eq!(resolved_closures(&findings, 2, &explicit).len(), 1, "the caller already sent F-002");
    }

    /// A fix is announced on its thread once: every later run carries the resolved finding forward,
    /// and each later publish used to post "resuelto en la iteración N" on it again.
    #[test]
    fn a_resolution_is_announced_once_for_the_life_of_the_pull_request() {
        let resolved_in = |iter: usize, written: Option<usize>| {
            let mut f = stored("F-001", "resuelto", Some(11));
            f.resuelto_en_iter = Some(iter);
            f.publicado_en_iter = written;
            f
        };
        // Announced in the iteration that fixed it: no later iteration speaks again.
        let announced = vec![resolved_in(2, Some(2))];
        assert!(resolution_announced(&announced[0]));
        assert!(resolved_closures(&announced, 3, &[]).is_empty());
        assert!(resolved_closures(&announced, 7, &[]).is_empty());
        // Fixed in 2 but its thread last heard from us in 1 (nobody published in 2): still owed.
        let owed = vec![resolved_in(2, Some(1))];
        assert!(!resolution_announced(&owed[0]));
        assert_eq!(resolved_closures(&owed, 3, &[]).len(), 1);
        // Runs saved before the iteration was tracked keep the old behaviour rather than going silent.
        assert!(!resolution_announced(&stored("F-002", "resuelto", Some(12))));
        // Only a resolved finding can have been announced as one.
        let mut open = stored("F-003", "posteado", Some(13));
        open.resuelto_en_iter = Some(1);
        open.publicado_en_iter = Some(2);
        assert!(!resolution_announced(&open));
    }

    fn project_with(columns: &[(&str, &str)]) -> Project {
        let get = |name: &str| columns.iter().find(|(key, _)| *key == name).map(|(_, value)| value.to_string());
        Project {
            id: "p".into(),
            workspace_id: "w".into(),
            name: "example-repo".into(),
            local_path: "/tmp/example-repo".into(),
            remote_url: None,
            color: "#fff".into(),
            icon: "folder".into(),
            ado_org: get("ado_org"),
            ado_project: get("ado_project"),
            ado_repo_id: get("ado_repo_id"),
            github_owner: get("github_owner"),
            github_repo: get("github_repo"),
            github_host: get("github_host"),
            gitlab_project: get("gitlab_project"),
            gitlab_host: get("gitlab_host"),
            sort_order: 0,
            created_at: String::new(),
            bitbucket_workspace: get("bitbucket_workspace"),
            bitbucket_repo: get("bitbucket_repo"),
        }
    }

    /// Bitbucket sits between GitLab and Azure in the precedence — the order `linkedProvider` in the
    /// frontend mirrors and the "already linked" guards of `resolve_pr_link` assume.
    #[test]
    fn a_bitbucket_link_ranks_after_gitlab_and_before_azure() {
        let bitbucket = [("bitbucket_workspace", "example-workspace"), ("bitbucket_repo", "example-repo")];
        match linked_repo(&project_with(&bitbucket)).unwrap() {
            LinkedRepo::Bitbucket { workspace, repo } => assert_eq!((workspace.as_str(), repo.as_str()), ("example-workspace", "example-repo")),
            _ => panic!("expected Bitbucket"),
        }
        let with_azure = [bitbucket[0], bitbucket[1], ("ado_org", "o"), ("ado_project", "p"), ("ado_repo_id", "r")];
        assert!(matches!(linked_repo(&project_with(&with_azure)).unwrap(), LinkedRepo::Bitbucket { .. }));
        let with_gitlab = [bitbucket[0], bitbucket[1], ("gitlab_project", "group/app")];
        assert!(matches!(linked_repo(&project_with(&with_gitlab)).unwrap(), LinkedRepo::GitLab { .. }));
        // A workspace alone names no repository.
        let half = [("bitbucket_workspace", "example-workspace"), ("bitbucket_repo", "  ")];
        assert!(linked_repo(&project_with(&half)).is_err());
    }

    #[test]
    fn a_bitbucket_repository_has_its_own_memory_key() {
        let project = project_with(&[("bitbucket_workspace", "Example-Workspace"), ("bitbucket_repo", "Example-Repo")]);
        assert_eq!(project_repo_key(&project).as_deref(), Some("bitbucket:example-workspace/example-repo"));
    }

    /// The credential travels as the keychain's string between `link_credential` and `linked_host`;
    /// both kinds have to come out the other side as they went in.
    #[test]
    fn a_bitbucket_credential_survives_the_trip_through_a_string() {
        let api = bitbucket::BitbucketAuth::ApiToken { email: "dev@example.test".into(), token: "placeholder".into() };
        assert_eq!(bitbucket_link_auth(&api.to_secret()), api);
        let access = bitbucket::BitbucketAuth::AccessToken { token: "placeholder".into() };
        assert_eq!(bitbucket_link_auth(&access.to_secret()), access);
    }

    /// Nothing in the publish mapping may ever route two items to one finding.
    #[test]
    fn two_items_of_one_kind_land_on_two_findings() {
        let findings = vec![stored("F-001", "abierto", None), stored("F-002", "abierto", None)];
        let items: Vec<PostFindingItem> = serde_json::from_value(serde_json::json!([
            { "id": "F-002", "file": "src/a.ts", "category": "npe", "content": "b", "location": null },
            { "id": "F-001", "file": "src/a.ts", "category": "npe", "content": "a", "location": null }
        ]))
        .unwrap();
        let mut claimed = vec![false; findings.len()];
        let mut landed = Vec::new();
        for item in &items {
            let k = crate::review_memory::match_publish_item(&findings, &item.key(), &claimed).unwrap();
            claimed[k] = true;
            landed.push(findings[k].id.clone());
        }
        assert_eq!(landed, vec!["F-002", "F-001"]);
    }
}
