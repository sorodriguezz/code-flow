//! «Tickets» in Agentes › Tareas: the work assigned to you on every connected board, and the path
//! from one of those tickets to a merged pull request.
//!
//! (user, 2026-10-23: «Tickets conectados al código … sobre los conectores que ya existen».) No new
//! connection type: the boards are the ones «Especificación» publishes to, with the same saved
//! credentials (`stories_cmd::board_auth`) — Azure DevOps organisations, Jira sites, Linear and
//! monday.com accounts — plus the GitHub/GitLab hosts the pull-request side is connected to, whose
//! issues are tickets too.
//!
//! **Moves CodeFlow makes on its own** are exactly two, and only for a ticket started here (a row in
//! `ticket_links`): to the board's review state when a pull request is opened from the ticket's
//! branch, to its done state when that pull request merges. Both are behind
//! `tickets_auto_move` (on unless the user turns it off) and both are returned to the caller so the
//! toast can say what moved and offer to put it back.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::boards::tickets::{
    self, apply_body, apply_title, board_key, branch_name, fold, resolve_target, PrHost, Target, Ticket, TicketDetail,
    TicketList, TicketMove, TicketSourceError, TicketState,
};
use crate::boards::ticket_links::{self, TicketLink};
use crate::boards::{assigned, transitions, BoardProvider};
use crate::commands::ado_cmd::{ado_connected_orgs, connected_hosts, fetch_linked_pull_request, linked_repo, LinkedRepo};
use crate::commands::stories_cmd::board_auth;
use crate::db::{queries, Db};

// ---------- settings ----------

const AUTO_MOVE: &str = "tickets_auto_move";
const BRANCH_PREFIX: &str = "tickets_branch_prefix";
const BUG_PREFIX: &str = "tickets_bug_prefix";
const TARGET_STATES: &str = "tickets_target_states";

fn setting(db: &State<'_, Db>, key: &str) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::get_setting(&conn, key).map_err(|e| e.to_string())
}

fn auto_move_on(db: &State<'_, Db>) -> bool {
    !matches!(setting(db, AUTO_MOVE).ok().flatten().as_deref().map(str::trim), Some("0") | Some("false"))
}

fn prefixes(db: &State<'_, Db>) -> (String, String) {
    let feature = setting(db, BRANCH_PREFIX).ok().flatten().unwrap_or_else(|| "feature/".into());
    let bug = setting(db, BUG_PREFIX).ok().flatten().unwrap_or_else(|| "bugfix/".into());
    (feature, bug)
}

/// The state the user picked for this board and target, if any: `{"<board key>": {"review": …, "done": …}}`.
fn configured_target(db: &State<'_, Db>, ticket: &Ticket, target: Target) -> Option<String> {
    let raw = setting(db, TARGET_STATES).ok().flatten()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let field = match target {
        Target::Review => "review",
        Target::Done => "done",
    };
    parsed.get(board_key(ticket))?.get(field)?.as_str().map(str::to_string).filter(|s| !s.trim().is_empty())
}

// ---------- which connections ----------

/// Every connected board account, keychain-free: the lists Settings writes beside each credential.
fn connections(db: &State<'_, Db>) -> Result<Vec<(BoardProvider, String)>, String> {
    #[derive(Deserialize)]
    struct Site {
        site: String,
    }
    #[derive(Deserialize)]
    struct Key {
        key: String,
    }
    #[derive(Deserialize)]
    struct Slug {
        slug: String,
    }
    fn listed<T: for<'de> Deserialize<'de>>(db: &State<'_, Db>, key: &str) -> Vec<T> {
        setting(db, key).ok().flatten().and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default()
    }
    let mut out: Vec<(BoardProvider, String)> = Vec::new();
    out.extend(ado_connected_orgs(db)?.into_iter().map(|org| (BoardProvider::Azure, org)));
    out.extend(listed::<Site>(db, "jira_connections").into_iter().map(|c| (BoardProvider::Jira, c.site)));
    out.extend(listed::<Key>(db, "linear_connections").into_iter().map(|c| (BoardProvider::Linear, c.key)));
    out.extend(listed::<Slug>(db, "monday_connections").into_iter().map(|c| (BoardProvider::Monday, c.slug)));
    out.extend(connected_hosts(db, "github_connections")?.into_iter().map(|host| (BoardProvider::Github, host)));
    out.extend(connected_hosts(db, "gitlab_connections")?.into_iter().map(|host| (BoardProvider::Gitlab, host)));
    // The same account saved twice (a site with two spellings) is asked once.
    let mut seen = std::collections::HashSet::new();
    out.retain(|(provider, account)| !account.trim().is_empty() && seen.insert(format!("{}:{}", provider.as_str(), account.trim().to_ascii_lowercase())));
    Ok(out)
}

// ---------- reading ----------

/// The tickets assigned to you on every connected board. A board that fails is reported in
/// `errors` and the rest still list.
#[tauri::command]
pub async fn tickets_list(db: State<'_, Db>) -> Result<TicketList, String> {
    let mut list = TicketList::default();
    for (provider, account) in connections(&db)? {
        let result = match board_auth(&db, provider, &account) {
            Ok(auth) => assigned::list_assigned(provider, &account, &auth).await,
            Err(e) => Err(e),
        };
        match result {
            Ok(tickets) => list.tickets.extend(tickets),
            Err(message) => list.errors.push(TicketSourceError { provider: provider.as_str().into(), account, message }),
        }
    }
    // The links keep a copy of each ticket for the chip; the fresh read is the better one.
    if let Ok(conn) = db.0.lock() {
        for ticket in &list.tickets {
            let _ = ticket_links::refresh_ticket(&conn, ticket);
        }
    }
    Ok(list)
}

#[tauri::command]
pub async fn tickets_detail(db: State<'_, Db>, ticket: Ticket) -> Result<TicketDetail, String> {
    let auth = board_auth(&db, ticket.board(), &ticket.account)?;
    assigned::get_detail(&ticket, &auth).await
}

#[tauri::command]
pub async fn tickets_states(db: State<'_, Db>, ticket: Ticket) -> Result<Vec<TicketState>, String> {
    let auth = board_auth(&db, ticket.board(), &ticket.account)?;
    transitions::list_states(&ticket, &auth).await
}

/// «Mover a…», and undo of an automatic move: by the state's *name*.
#[tauri::command]
pub async fn tickets_move(db: State<'_, Db>, ticket: Ticket, state: String) -> Result<TicketMove, String> {
    let auth = board_auth(&db, ticket.board(), &ticket.account)?;
    let landed = transitions::move_to(&ticket, &state, &auth).await?;
    Ok(record_move(&db, &ticket, landed))
}

fn record_move(db: &State<'_, Db>, ticket: &Ticket, landed: TicketState) -> TicketMove {
    let mut moved = ticket.clone();
    moved.state = landed.name.clone();
    if !landed.category.is_empty() {
        moved.state_category = landed.category.clone();
    }
    if let Ok(conn) = db.0.lock() {
        let _ = ticket_links::refresh_ticket(&conn, &moved);
    }
    TicketMove { ticket: moved, from: ticket.state.clone(), to: landed.name }
}

/// What the links say for this workspace — DB only, so the projects panel can draw its chips
/// without a request to any board.
#[tauri::command]
pub async fn tickets_links(db: State<'_, Db>, workspace_id: String) -> Result<Vec<TicketLink>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    ticket_links::list_for_workspace(&conn, &workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tickets_unlink(db: State<'_, Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    ticket_links::delete(&conn, &id).map_err(|e| e.to_string())
}

/// The branch «Empezar» would create, for the dialog to show (and let the user edit) first.
#[tauri::command]
pub async fn tickets_branch_name(db: State<'_, Db>, ticket: Ticket) -> Result<String, String> {
    let (feature, bug) = prefixes(&db);
    Ok(branch_name(&ticket, &feature, &bug))
}

// ---------- «Empezar» ----------

#[derive(Debug, Clone, Serialize)]
pub struct TicketStart {
    pub link: TicketLink,
    pub path: String,
    pub branch: String,
    /// The agent's first prompt: the whole ticket.
    pub prompt: String,
    /// The ticket already had a worktree on this repository, and that one is opened again.
    pub reused: bool,
}

/// Creates the ticket's branch in a worktree of its own (or reopens the one it already has),
/// records the link, and returns the first prompt. The agent itself is started by the frontend,
/// with the CLI the user picked — the same `startAgentCli` «Nuevo agente» uses.
#[tauri::command]
pub async fn tickets_start(
    db: State<'_, Db>,
    workspace_id: String,
    project_id: String,
    ticket: Ticket,
    branch: Option<String>,
) -> Result<TicketStart, String> {
    let project = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::get_project(&conn, &project_id).map_err(|e| e.to_string())?.ok_or_else(|| "Project not found".to_string())?
    };
    if project.workspace_id != workspace_id {
        return Err(format!("«{}» pertenece a otro espacio de trabajo", project.name));
    }
    let auth = board_auth(&db, ticket.board(), &ticket.account)?;
    // Read before anything is created: a ticket the token cannot read is not one to branch for.
    let detail = assigned::get_detail(&ticket, &auth).await?;

    let existing = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        ticket_links::by_ticket(&conn, &project_id, &ticket.uid()).map_err(|e| e.to_string())?
    };
    if let Some(link) = existing.filter(|l| !l.worktree_path.is_empty() && std::path::Path::new(&l.worktree_path).is_dir()) {
        let prompt = tickets::ticket_prompt(&detail, &link.branch);
        return Ok(TicketStart { path: link.worktree_path.clone(), branch: link.branch.clone(), link, prompt, reused: true });
    }

    let (feature, bug) = prefixes(&db);
    let branch = branch.map(|b| b.trim().to_string()).filter(|b| !b.is_empty()).unwrap_or_else(|| branch_name(&detail.ticket, &feature, &bug));
    check_ref_name(&branch)?;
    let repo = project.local_path.clone();
    let folder = branch.replace('/', "-");
    let target = crate::paths::agent_worktree_dir(&project.name, &folder).to_string_lossy().into_owned();
    let (path, branch_out) = {
        let repo = repo.clone();
        let target = target.clone();
        let branch = branch.clone();
        tokio::task::spawn_blocking(move || -> Result<(String, String), String> {
            // A branch already checked out somewhere is worked on there: git refuses a second
            // checkout of one branch, and the existing folder is where that work is.
            if let Ok(trees) = crate::git::worktree::list(&repo) {
                if let Some(tree) = trees.iter().find(|t| t.branch.as_deref() == Some(branch.as_str()) && !t.prunable) {
                    return Ok((tree.path.clone(), branch));
                }
            }
            if let Some(parent) = std::path::Path::new(&target).parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let exists = crate::git::cli::run_in(&repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")], &[])
                .map(|out| out.success)
                .unwrap_or(false);
            crate::git::worktree::add(&repo, &target, &branch, !exists, None)?;
            Ok((target, branch))
        })
        .await
        .map_err(|e| e.to_string())??
    };

    let link = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        ticket_links::upsert(&conn, &workspace_id, &project_id, &detail.ticket, &branch_out, &path).map_err(|e| e.to_string())?
    };
    let prompt = tickets::ticket_prompt(&detail, &branch_out);
    Ok(TicketStart { link, path, branch: branch_out, prompt, reused: false })
}

/// Refuses what git would refuse, in words: the dialog lets the branch name be edited.
fn check_ref_name(branch: &str) -> Result<(), String> {
    let bad = branch.is_empty()
        || branch.starts_with('/')
        || branch.ends_with('/')
        || branch.ends_with('.')
        || branch.ends_with(".lock")
        || branch.contains("..")
        || branch.contains("//")
        || branch.contains("@{")
        || branch.chars().any(|c| c.is_whitespace() || c.is_control() || "~^:?*[\\".contains(c));
    match bad {
        true => Err(format!("«{branch}» no es un nombre de rama válido")),
        false => Ok(()),
    }
}

// ---------- the pull request ----------

fn pr_host(project: &crate::db::models::Project) -> PrHost {
    match linked_repo(project) {
        Ok(LinkedRepo::Azure { org, .. }) => PrHost { provider: "azure".into(), account: org, repo: String::new() },
        Ok(LinkedRepo::GitHub { host, owner, repo }) => PrHost { provider: "github".into(), account: host, repo: format!("{owner}/{repo}") },
        Ok(LinkedRepo::GitLab { host, project }) => PrHost { provider: "gitlab".into(), account: host, repo: project },
        Ok(LinkedRepo::Bitbucket { workspace, repo }) => PrHost { provider: "bitbucket".into(), account: workspace, repo },
        Err(_) => PrHost::default(),
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct TicketPrReference {
    pub ticket: Ticket,
    pub title_prefix: String,
    pub body_line: String,
    pub work_item_ids: Vec<i64>,
}

fn link_for(db: &State<'_, Db>, project_id: &str, branch: &str) -> Result<Option<(TicketLink, crate::db::models::Project)>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let Some(link) = ticket_links::by_branch(&conn, project_id, branch).map_err(|e| e.to_string())? else { return Ok(None) };
    let Some(project) = queries::get_project(&conn, project_id).map_err(|e| e.to_string())? else { return Ok(None) };
    Ok(Some((link, project)))
}

/// What the PR form adds for a branch started from a ticket — `None` for any other branch.
#[tauri::command]
pub async fn tickets_pr_reference(db: State<'_, Db>, project_id: String, branch: String) -> Result<Option<TicketPrReference>, String> {
    let Some((link, project)) = link_for(&db, &project_id, &branch)? else { return Ok(None) };
    let reference = tickets::pr_reference(&link.ticket, &pr_host(&project));
    Ok(Some(TicketPrReference {
        ticket: link.ticket,
        title_prefix: reference.title_prefix,
        body_line: reference.body_line,
        work_item_ids: reference.work_item_ids,
    }))
}

/// The title and body with the reference applied — exposed for the form's "already there" check
/// to be the same one the backend tests.
#[tauri::command]
pub async fn tickets_apply_reference(title: String, body: String, title_prefix: String, body_line: String) -> Result<(String, String), String> {
    let reference = tickets::PrReference { title_prefix, body_line, work_item_ids: Vec::new() };
    Ok((apply_title(&title, &reference), apply_body(&body, &reference)))
}

/// The outcome of a hook: what moved, or why nothing did when the user should know.
#[derive(Debug, Clone, Default, Serialize)]
pub struct TicketAuto {
    pub moved: Option<TicketMove>,
    /// A failed move — shown, never thrown: the pull request itself succeeded.
    pub error: String,
}

async fn auto_move(db: &State<'_, Db>, link: &TicketLink, target: Target) -> TicketAuto {
    if !auto_move_on(db) {
        return TicketAuto::default();
    }
    let ticket = &link.ticket;
    let run = async {
        let auth = board_auth(db, ticket.board(), &ticket.account)?;
        let states = transitions::list_states(ticket, &auth).await?;
        let Some(state) = resolve_target(&states, configured_target(db, ticket, target).as_deref(), target) else { return Ok(None) };
        if fold(&state.name) == fold(&ticket.state) {
            return Ok(None);
        }
        transitions::apply(ticket, &state, &auth).await?;
        Ok::<_, String>(Some(record_move(db, ticket, state)))
    };
    match run.await {
        Ok(moved) => TicketAuto { moved, error: String::new() },
        Err(error) => TicketAuto { moved: None, error },
    }
}

/// A pull request was opened from `branch`: record it on the link, and move the ticket to review.
#[tauri::command]
pub async fn tickets_on_pr_created(
    db: State<'_, Db>,
    project_id: String,
    branch: String,
    pr_id: i64,
    pr_url: String,
) -> Result<TicketAuto, String> {
    let Some((link, _)) = link_for(&db, &project_id, &branch)? else { return Ok(TicketAuto::default()) };
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        ticket_links::set_pr(&conn, &link.id, pr_id, &pr_url).map_err(|e| e.to_string())?;
    }
    if link.stage == "done" {
        return Ok(TicketAuto::default());
    }
    Ok(auto_move(&db, &link, Target::Review).await)
}

/// The pull request from `branch` merged (seen by the app's own merge): move the ticket to done.
#[tauri::command]
pub async fn tickets_on_pr_merged(db: State<'_, Db>, project_id: String, branch: String) -> Result<TicketAuto, String> {
    let Some((link, _)) = link_for(&db, &project_id, &branch)? else { return Ok(TicketAuto::default()) };
    if link.stage == "done" {
        return Ok(TicketAuto::default());
    }
    {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        ticket_links::set_stage(&conn, &link.id, "done").map_err(|e| e.to_string())?;
    }
    Ok(auto_move(&db, &link, Target::Done).await)
}

/// Asks each linked pull request still open whether it merged meanwhile — on the host's website,
/// from another machine — and moves its ticket to done if so. Run when the ticket list refreshes;
/// one request per open link, never per row of the projects panel.
#[tauri::command]
pub async fn tickets_sync(db: State<'_, Db>, workspace_id: String) -> Result<Vec<TicketAuto>, String> {
    let links = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        ticket_links::list_for_workspace(&conn, &workspace_id).map_err(|e| e.to_string())?
    };
    let mut out = Vec::new();
    for link in links.into_iter().filter(|l| l.pr_id > 0 && l.stage != "done") {
        let project = {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            queries::get_project(&conn, &link.project_id).map_err(|e| e.to_string())?
        };
        let Some(project) = project else { continue };
        let Ok(repo) = linked_repo(&project) else { continue };
        let Ok(pr) = fetch_linked_pull_request(&repo, link.pr_id).await else { continue };
        if pr.status != "merged" {
            continue;
        }
        {
            let conn = db.0.lock().map_err(|e| e.to_string())?;
            ticket_links::set_stage(&conn, &link.id, "done").map_err(|e| e.to_string())?;
        }
        let outcome = auto_move(&db, &link, Target::Done).await;
        if outcome.moved.is_some() || !outcome.error.is_empty() {
            out.push(outcome);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ref_names_git_would_refuse_are_refused() {
        assert!(check_ref_name("feature/ABC-1-x").is_ok());
        for bad in ["", "feature/", "a..b", "a b", "x.lock", "a~1", "a:b", "/x", "a//b", "a@{1}"] {
            assert!(check_ref_name(bad).is_err(), "{bad}");
        }
    }
}
