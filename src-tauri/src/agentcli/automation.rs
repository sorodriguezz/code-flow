//! `cf` from **outside** CodeFlow: a script, a CI job, a shortcut starting a saved plan and waiting for
//! how it ended.
//!
//! # Why it is a separate door
//!
//! The endpoint's token says "you were started by this app" (see `agentcli`), and every verb behind it
//! — secrets used with an approval, SQL on saved connections, the app's own interface — leans on that.
//! A process the app did not start has no such token, so this does not weaken it: it adds a **second
//! token**, written to a file, that opens exactly three verbs and nothing else.
//!
//! - `templates` — the saved plans there are to run;
//! - `run <template> [--repo <path>] [--goal <text>]` — starts one in a repository the app already knows;
//! - `status <chain>` — how it is going, in a form `cf` turns into an exit code.
//!
//! It is **off until the person turns it on** (Ajustes › Herramientas de IA), and turning it off removes
//! the file. The file is readable by the user that owns it and nobody else.
//!
//! # What it can and cannot do
//!
//! It starts a plan someone already authored, in a repository someone already added, with the agents of
//! that workspace. It cannot create agents, change a plan, answer a gate or read a secret. A plan that
//! needs a person parks exactly as it would have if started by hand — and `status` says so, so the
//! caller can tell "failed" from "waiting for you".

use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::{Reply, Request};
use crate::db::models::{ChainDetail, ChainTemplate, NewChainStep};
use crate::db::queries;

/// The verbs the automation token opens. Anything else is refused before it is looked at.
pub const VERBS: [&str; 3] = ["templates", "run", "status"];

/// The setting that switches the whole thing on.
pub const ENABLED_KEY: &str = "automation_enabled";

/// Where the connection file is written. The directory is the app's own; `cf` looks for the same
/// folder name on each platform (see `cf/src/main.rs`).
pub fn directory() -> std::path::PathBuf {
    crate::paths::state_dir().join("automation")
}

/// `connection.json` for `port` and `token`, readable by the owner only. Atomic: written beside the
/// real name and renamed over it, so a `cf` that reads while this runs never sees half a file.
pub fn write_connection(port: u16, token: &str) -> std::io::Result<()> {
    let dir = directory();
    std::fs::create_dir_all(&dir)?;
    let text = serde_json::json!({ "port": port, "token": token }).to_string();
    let temp = dir.join("connection.json.tmp");
    write_private(&temp, text.as_bytes())?;
    std::fs::rename(&temp, dir.join("connection.json"))
}

/// Removes it. Idempotent.
pub fn remove_connection() {
    let _ = std::fs::remove_file(directory().join("connection.json"));
}

#[cfg(unix)]
fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(path)?;
    file.write_all(bytes)
}

#[cfg(not(unix))]
fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    // The app's state folder is already the user's own on Windows; there is no mode to set.
    std::fs::write(path, bytes)
}

/// One verb from a process holding the automation token.
pub async fn serve(request: &Request, app: &AppHandle) -> Reply {
    if !VERBS.contains(&request.verb.as_str()) {
        return Reply::no(format!("{} is not available from outside CodeFlow", request.verb));
    }
    let db = app.state::<crate::db::Db>();
    let Ok(conn) = db.0.lock() else { return Reply::no("the database is busy") };
    match request.verb.as_str() {
        "templates" => match list_templates(&conn) {
            Ok(rows) => Reply::ok(serde_json::to_string(&rows).unwrap_or_default()),
            Err(error) => Reply::no(error),
        },
        "run" => match run(&conn, &request.args, &request.cwd) {
            Ok(detail) => {
                let workspace = workspace_of_chain(&conn, &detail.chain.id).unwrap_or_default();
                drop(conn);
                // The window is what drives a chain, so it is told, the way a phone's action tells it.
                let _ = app.emit(
                    crate::remotectl::bridge::INVALIDATE_EVENT,
                    serde_json::json!({ "domain": "chains", "workspace": workspace, "chain": detail.chain.id, "origin": "automation" }),
                );
                Reply::ok(serde_json::json!({ "chain": detail.chain.id, "title": detail.chain.title }).to_string())
            }
            Err(error) => Reply::no(error),
        },
        _ => match status(&conn, request.args.first().map(String::as_str).unwrap_or("")) {
            Ok(status) => Reply::ok(serde_json::to_string(&status).unwrap_or_default()),
            Err(error) => Reply::no(error),
        },
    }
}

fn workspace_of_chain(conn: &Connection, chain_id: &str) -> Option<String> {
    conn.query_row(
        "SELECT p.workspace_id FROM agent_chains c JOIN projects p ON p.id = c.project_id WHERE c.id = ?1",
        rusqlite::params![chain_id],
        |row| row.get(0),
    )
    .ok()
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct TemplateRow {
    pub id: String,
    pub name: String,
    pub workspace: String,
    pub steps: usize,
}

/// Every saved plan template, in every workspace. Only plans (`kind = chain`): a hybrid run's setup is
/// not something a script can start without the planning gate a person answers.
pub fn list_templates(conn: &Connection) -> Result<Vec<TemplateRow>, String> {
    let mut out = Vec::new();
    for workspace in queries::list_workspaces(conn).map_err(|e| e.to_string())? {
        for template in queries::list_chain_templates(conn, &workspace.id).map_err(|e| e.to_string())? {
            if template.kind == "chain" {
                out.push(TemplateRow { id: template.id, name: template.name, workspace: workspace.name.clone(), steps: template.steps.len() });
            }
        }
    }
    Ok(out)
}

/// A template by id, or by name when the name names exactly one.
fn find_template(conn: &Connection, ident: &str) -> Result<ChainTemplate, String> {
    let ident = ident.trim();
    if ident.is_empty() {
        return Err("usage: cf run <template> [--repo <path>] [--goal <text>]".into());
    }
    let mut matches = Vec::new();
    for workspace in queries::list_workspaces(conn).map_err(|e| e.to_string())? {
        for template in queries::list_chain_templates(conn, &workspace.id).map_err(|e| e.to_string())? {
            if template.kind == "chain" && (template.id == ident || template.name.eq_ignore_ascii_case(ident)) {
                matches.push(template);
            }
        }
    }
    match matches.len() {
        0 => Err(format!("no saved plan named {ident}")),
        1 => Ok(matches.remove(0)),
        n => Err(format!("{n} saved plans are named {ident}: use the id from `cf templates`")),
    }
}

/// The repository a run is for: `--repo`'s path, else the folder `cf` ran in. It must be one the app
/// already has, in the template's own workspace — the template names agents, and agents belong to a
/// workspace.
fn find_repo(conn: &Connection, workspace_id: &str, repo: &str) -> Result<String, String> {
    let wanted = std::fs::canonicalize(repo).unwrap_or_else(|_| std::path::PathBuf::from(repo));
    for project in queries::list_projects(conn, workspace_id).map_err(|e| e.to_string())? {
        let path = std::fs::canonicalize(&project.local_path).unwrap_or_else(|_| std::path::PathBuf::from(&project.local_path));
        // The folder itself or anywhere inside it: `cf` is often run from a subfolder.
        if !project.local_path.is_empty() && wanted.starts_with(&path) {
            return Ok(project.id);
        }
    }
    Err(format!("{repo} is not a repository CodeFlow has in that plan's workspace"))
}

/// Splits `run`'s arguments: the template (everything before the first flag, joined), `--repo`, `--goal`.
fn parse_run(args: &[String]) -> (String, Option<String>, Option<String>) {
    let mut template = Vec::new();
    let (mut repo, mut goal) = (None, None);
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--repo" => repo = iter.next().cloned(),
            "--goal" => goal = iter.next().cloned(),
            other => template.push(other.to_string()),
        }
    }
    (template.join(" "), repo, goal)
}

/// Starts a saved plan: creates the chain from the template's steps in the repository and queues it.
pub fn run(conn: &Connection, args: &[String], cwd: &str) -> Result<ChainDetail, String> {
    let (ident, repo, goal) = parse_run(args);
    let template = find_template(conn, &ident)?;
    let project = find_repo(conn, &template.workspace_id, repo.as_deref().unwrap_or(cwd))?;
    let steps: Vec<NewChainStep> = template
        .steps
        .iter()
        .map(|step| NewChainStep {
            agent_id: step.agent_id.clone(),
            instruction: step.instruction.clone(),
            gate: step.gate,
            check_command: step.check_command.clone(),
            on_pass: step.on_pass,
            on_fail: step.on_fail,
            ..Default::default()
        })
        .collect();
    let goal = goal.unwrap_or_else(|| template.description.clone());
    let detail = queries::create_agent_chain(conn, &[project], &template.name, &goal, &steps, "").map_err(|e| e.to_string())?;
    queries::resume_chain(conn, &detail.chain.id).map_err(|e| e.to_string())?;
    // Read again: the chain that came back from `create` is the one before it was queued.
    queries::get_chain_detail(conn, &detail.chain.id).map_err(|e| e.to_string())?.ok_or_else(|| "the chain was not saved".to_string())
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct ChainStatus {
    pub chain: String,
    pub status: String,
    pub reason: String,
    /// Whether it is waiting for a person, which is neither a failure nor still running.
    pub needs_person: bool,
    pub steps_done: usize,
    pub steps_total: usize,
}

/// Where a chain stands, in the words `cf` turns into an exit code.
pub fn status(conn: &Connection, chain_id: &str) -> Result<ChainStatus, String> {
    let detail = queries::get_chain_detail(conn, chain_id.trim())
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("no chain {chain_id}"))?;
    let needs_person = detail.chain.status == "gated"
        || (detail.chain.status == "paused" && !detail.chain.last_reason.is_empty());
    Ok(ChainStatus {
        chain: detail.chain.id,
        status: detail.chain.status,
        reason: detail.chain.last_reason,
        needs_person,
        steps_done: detail.steps.iter().filter(|s| s.status == "done" || s.status == "skipped").count(),
        steps_total: detail.steps.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;

    /// A workspace with one repository at `path`, one agent and one saved plan of two steps.
    fn fixture(path: &str) -> (Connection, String) {
        let conn = Connection::open_in_memory().unwrap();
        migrations::run(&conn).unwrap();
        let ws = queries::create_workspace(&conn, "ws", "folder", "#fff").unwrap();
        queries::create_project(
            &conn,
            crate::db::models::NewProject {
                workspace_id: ws.id.clone(),
                name: "proj".into(),
                local_path: path.into(),
                remote_url: None,
                color: "#fff".into(),
                icon: "folder".into(),
                ado_org: None,
                ado_project: None,
                ado_repo_id: None,
                github_owner: None,
                github_repo: None,
                github_host: None,
                gitlab_project: None,
                gitlab_host: None,
            },
        )
        .unwrap();
        let agent = queries::upsert_workspace_agent(&conn, None, &ws.id, "Bot", "role", "claude", "sonnet", "", true, None).unwrap();
        let steps = vec![
            NewChainStep { agent_id: agent.id.clone(), instruction: "build".into(), ..Default::default() },
            NewChainStep { agent_id: agent.id, instruction: "check".into(), gate: true, ..Default::default() },
        ];
        queries::upsert_chain_template(&conn, None, &ws.id, "Nightly", "do the nightly", &steps).unwrap();
        (conn, ws.id)
    }

    fn args(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_saved_plans_are_listed_with_their_workspace() {
        let (conn, _) = fixture("/tmp/auto-proj");
        let rows = list_templates(&conn).unwrap();
        assert_eq!(rows, vec![TemplateRow { id: rows[0].id.clone(), name: "Nightly".into(), workspace: "ws".into(), steps: 2 }]);
    }

    #[test]
    fn running_a_plan_creates_its_chain_in_the_repository_and_queues_it() {
        let (conn, _) = fixture("/tmp/auto-proj");
        let detail = run(&conn, &args(&["nightly", "--repo", "/tmp/auto-proj"]), "").unwrap();
        assert_eq!(detail.chain.status, "queued");
        assert_eq!(detail.chain.title, "Nightly");
        assert_eq!(detail.chain.goal, "do the nightly");
        assert_eq!(detail.steps.len(), 2);
        assert!(detail.steps[1].gate, "the plan's own gate travels with it");
    }

    #[test]
    fn a_goal_overrides_the_templates_and_a_subfolder_finds_its_repository() {
        let (conn, _) = fixture("/tmp/auto-proj");
        let detail = run(&conn, &args(&["Nightly", "--goal", "only the api"]), "/tmp/auto-proj/api/src").unwrap();
        assert_eq!(detail.chain.goal, "only the api");
    }

    #[test]
    fn a_repository_the_app_does_not_have_is_refused() {
        let (conn, _) = fixture("/tmp/auto-proj");
        let error = run(&conn, &args(&["Nightly", "--repo", "/tmp/somewhere-else"]), "").unwrap_err();
        assert!(error.contains("not a repository CodeFlow has"), "{error}");
    }

    #[test]
    fn an_unknown_or_ambiguous_plan_is_refused_with_a_way_forward() {
        let (conn, ws) = fixture("/tmp/auto-proj");
        assert!(run(&conn, &args(&["nope", "--repo", "/tmp/auto-proj"]), "").unwrap_err().contains("no saved plan"));
        let agent = queries::list_workspace_agents(&conn, &ws).unwrap().remove(0);
        let steps = vec![NewChainStep { agent_id: agent.id, instruction: "x".into(), ..Default::default() }];
        queries::upsert_chain_template(&conn, None, &ws, "Nightly", "again", &steps).unwrap();
        assert!(run(&conn, &args(&["Nightly", "--repo", "/tmp/auto-proj"]), "").unwrap_err().contains("cf templates"));
        assert!(run(&conn, &args(&[]), "").unwrap_err().contains("usage"));
    }

    #[test]
    fn status_says_whether_it_is_running_waiting_for_a_person_or_done() {
        let (conn, _) = fixture("/tmp/auto-proj");
        let detail = run(&conn, &args(&["Nightly", "--repo", "/tmp/auto-proj"]), "").unwrap();
        let queued = status(&conn, &detail.chain.id).unwrap();
        assert_eq!((queued.status.as_str(), queued.needs_person, queued.steps_total), ("queued", false, 2));
        // The plan's second step is a gate: once the first is done the chain parks on it.
        let first = queries::claim_next_chain_step(&conn, &detail.chain.id, "r1").unwrap().step.unwrap();
        queries::complete_chain_step(&conn, &first.id, "done", "ok", "").unwrap();
        // The window's driver claims the next step, which is where a gate parks the plan.
        queries::claim_next_chain_step(&conn, &detail.chain.id, "r2").unwrap();
        let gated = status(&conn, &detail.chain.id).unwrap();
        assert!(gated.needs_person, "a gate is a person's decision: {gated:?}");
        assert!(status(&conn, "no-such-chain").is_err());
    }

    #[test]
    fn only_three_verbs_are_open_to_the_automation_token() {
        for verb in ["secret", "db", "http", "ui", "ask", "llm", "hook"] {
            assert!(!VERBS.contains(&verb), "{verb} must stay behind the app's own token");
        }
        assert_eq!(VERBS.len(), 3);
    }

    #[cfg(unix)]
    #[test]
    fn the_connection_file_is_readable_by_its_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("cf-auto-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("connection.json");
        write_private(&path, b"{}").unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
