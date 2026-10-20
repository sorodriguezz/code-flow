//! The verbs about what is running and what the user sees: a service's log, a restart, waiting for
//! one to come up, another terminal's output, a file opened in the editor, the agent's own card, and
//! a task handed to the task tree.
//!
//! Services are the workspace's (the supervisor runs them, not the agent's shell — which is why an
//! agent could not see its server die), terminals are the agents panel's bench (the dock's tabs are
//! not recorded anywhere but the window), and both are found from the folder `cf` ran in.

use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::{pick, place, raise, Reply, Request};
use crate::db::models::{Service, WorkspaceTerminal};
use crate::services::supervisor::{self, Status};

/// Lines `cf logs` and `cf term` print when not told.
const DEFAULT_TAIL: usize = 100;
const MAX_TAIL: usize = 5_000;

// ------------------------------------------------------------------------------------------- open

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OpenEvent {
    project_id: String,
    /// Relative to the project's folder, `/`-separated: what the editor opens.
    path: String,
    line: Option<u32>,
}

/// `cf open <file>[:line]`: the file in the app's editor, at the line.
///
/// The editor opens a project's own folder and nothing else. A file in a task's worktree has no
/// editor to open in — opening the main checkout's copy of the same path would show the user other
/// content under the right name — so that case shows the task's changes instead, and says so.
pub fn open(request: &Request, app: &AppHandle) -> Reply {
    let Some(spec) = request.args.first().filter(|a| !a.trim().is_empty()) else {
        return Reply::no("usage: cf open <file>[:line]");
    };
    let (file, line) = split_line(spec.trim());
    let path = std::path::Path::new(&request.cwd).join(file);
    if !path.is_file() {
        return Reply::no(format!("no such file: {}", path.display()));
    }
    let full = crate::repo_identity::canonical_path(&path.to_string_lossy());
    let place = place::of(app, &request.cwd, &request.session);
    let Some(project) = place.project else {
        return Reply::no("this file is not in any of the app's projects");
    };
    let folder = crate::repo_identity::canonical_path(&project.local_path);
    if !place::within(&full, &folder) {
        // A worktree: the review of its task is the view that shows its files.
        raise(app);
        let _ = app.emit("agentcli:review", request.cwd.trim().to_string());
        return Reply::ok("this file is in a worktree, which the editor does not open; showing its task's changes instead (cf review)");
    }
    // The project-relative path, spelled the way the project's own folder spells it on disk.
    let relative = full[folder.len()..].trim_start_matches('/').to_string();
    let relative = actual_spelling(&project.local_path, &relative).unwrap_or(relative);
    raise(app);
    let _ = app.emit("agentcli:open", OpenEvent { project_id: project.id, path: relative, line });
    Reply::ok("")
}

/// `src/a.ts:12` → (`src/a.ts`, 12). Only a trailing `:<digits>` is a line (a column after it is
/// accepted and ignored), so a Windows drive letter is never mistaken for one.
fn split_line(spec: &str) -> (&str, Option<u32>) {
    let mut file = spec;
    let mut numbers = Vec::new();
    for _ in 0..2 {
        match file.rsplit_once(':') {
            Some((head, tail)) if !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()) && !head.is_empty() => {
                numbers.push(tail.parse::<u32>().ok());
                file = head;
            }
            _ => break,
        }
    }
    // `file:12:3` read right to left: the column first, then the line.
    let line = numbers.last().copied().flatten().filter(|n| *n > 0);
    (file, line)
}

/// `relative` as it is written under `root` — canonical paths are lowercased on macOS and Windows,
/// and the editor's tab should carry the file's real name.
fn actual_spelling(root: &str, relative: &str) -> Option<String> {
    let mut current = std::path::PathBuf::from(root);
    let mut parts = Vec::new();
    for wanted in relative.split('/').filter(|p| !p.is_empty()) {
        let found = std::fs::read_dir(&current)
            .ok()?
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .find(|name| name.eq_ignore_ascii_case(wanted))?;
        current.push(&found);
        parts.push(found);
    }
    Some(parts.join("/"))
}

// --------------------------------------------------------------------------------------- services

/// `cf logs [service] [--tail N]`: the service's recent output, or the workspace's services.
pub fn logs(request: &Request, app: &AppHandle) -> Reply {
    let (positional, tail) = match options(&request.args, &["--tail", "-n"]) {
        Ok(found) => found,
        Err(reply) => return reply,
    };
    let tail = tail.unwrap_or(DEFAULT_TAIL).min(MAX_TAIL);
    let place = place::of(app, &request.cwd, &request.session);
    let Some(workspace) = place.workspace_id else { return Reply::no(NO_WORKSPACE) };
    let supervisor = supervisor::Supervisor::of(app);
    let Some(name) = positional.first() else { return list_services(app, &workspace) };
    let service = match find_service(&workspace, name) {
        Ok(service) => service,
        Err(reply) => return reply,
    };
    let text = readable(&supervisor.log(&service.id).text);
    let shown = last_lines(&text, tail);
    if shown.trim().is_empty() {
        return Reply::ok(format!("{} has printed nothing yet", service.name));
    }
    Reply::ok(shown)
}

/// `cf restart <service>`: stopped (its dependents first) and started again, as the dock's button.
pub async fn restart(request: &Request, app: &AppHandle) -> Reply {
    let Some(name) = request.args.first() else { return Reply::no("usage: cf restart <service>") };
    let place = place::of(app, &request.cwd, &request.session);
    let Some(workspace) = place.workspace_id else { return Reply::no(NO_WORKSPACE) };
    let service = match find_service(&workspace, name) {
        Ok(service) => service,
        Err(reply) => return reply,
    };
    match supervisor::Supervisor::of(app).restart(app, &workspace, std::slice::from_ref(&service.id)).await {
        Ok(()) => Reply::ok(format!("restarting {} — cf wait {} blocks until it is ready", service.name, quote_arg(&service.name))),
        Err(error) => Reply::no(error),
    }
}

/// `cf wait <service> [--timeout S]`: blocks until the service is ready (its gate passed, or a one-shot
/// finished cleanly). Exits 1 when it fails, stops, or the time runs out — with its last lines.
pub async fn wait(request: &Request, app: &AppHandle) -> Reply {
    let (positional, timeout) = match options(&request.args, &["--timeout", "-t"]) {
        Ok(found) => found,
        Err(reply) => return reply,
    };
    let Some(name) = positional.first() else { return Reply::no("usage: cf wait <service> [--timeout seconds]") };
    let timeout = Duration::from_secs(timeout.unwrap_or(120).clamp(1, 1_800) as u64);
    let place = place::of(app, &request.cwd, &request.session);
    let Some(workspace) = place.workspace_id else { return Reply::no(NO_WORKSPACE) };
    let service = match find_service(&workspace, name) {
        Ok(service) => service,
        Err(reply) => return reply,
    };
    let supervisor = supervisor::Supervisor::of(app);
    let started = Instant::now();
    let mut seen_running = false;
    loop {
        let view = supervisor.snapshot().into_iter().find(|view| view.id == service.id);
        let status = view.as_ref().map(|view| view.status);
        let last = || last_lines(&readable(&supervisor.log(&service.id).text), 30);
        match status {
            Some(Status::Ready) | Some(Status::Completed) => {
                let ports = view.map(|view| view.ports).unwrap_or_default();
                let at = if ports.is_empty() {
                    String::new()
                } else {
                    format!(" on port {}", ports.iter().map(u16::to_string).collect::<Vec<_>>().join(", "))
                };
                return Reply::ok(format!("{} is ready{at}", service.name));
            }
            Some(Status::Failed) => {
                let why = view.and_then(|view| view.error.or(view.detail)).unwrap_or_default();
                return Reply::no(format!("{} failed{}\n\n{}", service.name, if why.is_empty() { String::new() } else { format!(" ({why})") }, last()));
            }
            Some(Status::Stopped) | None if !seen_running => {
                return Reply::no(format!("{} is not running — cf restart {} starts it", service.name, quote_arg(&service.name)));
            }
            Some(Status::Stopped) | None => return Reply::no(format!("{} stopped\n\n{}", service.name, last())),
            Some(_) => seen_running = true,
        }
        if started.elapsed() >= timeout {
            let now = status.map(|s| format!("{s:?}").to_lowercase()).unwrap_or_default();
            return Reply::no(format!("{} is still {now} after {} s\n\n{}", service.name, timeout.as_secs(), last()));
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

const NO_WORKSPACE: &str = "this folder is not in a project of any workspace, so it has no services or terminals";

fn list_services(app: &AppHandle, workspace: &str) -> Reply {
    let services = crate::ai_usage::with_conn(|conn| crate::db::service_queries::list_services(conn, workspace)).and_then(Result::ok).unwrap_or_default();
    if services.is_empty() {
        return Reply::ok("this workspace has no services (the Services dock adds them)");
    }
    let views = supervisor::Supervisor::of(app).snapshot();
    let lines: Vec<String> = services
        .iter()
        .map(|service| {
            let view = views.iter().find(|view| view.id == service.id);
            let status = view.map(|view| format!("{:?}", view.status).to_lowercase()).unwrap_or_else(|| "stopped".into());
            let ports = view.map(|view| view.ports.iter().map(u16::to_string).collect::<Vec<_>>().join(",")).unwrap_or_default();
            if ports.is_empty() {
                format!("{}\t{status}", service.name)
            } else {
                format!("{}\t{status}\tport {ports}", service.name)
            }
        })
        .collect();
    Reply::ok(lines.join("\n"))
}

/// The service named `name` in the workspace: the exact name (any case), else the one it starts, else
/// the one it is part of. Two that match is an error that names them — guessing would restart the
/// wrong server.
fn find_service(workspace: &str, name: &str) -> Result<Service, Reply> {
    let services = crate::ai_usage::with_conn(|conn| crate::db::service_queries::list_services(conn, workspace)).and_then(Result::ok).unwrap_or_default();
    pick(services, name, |service| service.name.as_str()).map_err(|names| match names.as_slice() {
        [] => Reply::no(format!("no service named {name} in this workspace (cf logs lists them)")),
        names => Reply::no(format!("{name} matches several services: {}", names.join(", "))),
    })
}

// -------------------------------------------------------------------------------------- terminals

/// `cf term [panel] [--tail N]`: another bench terminal's recent output, or the workspace's bench.
/// A panel is named by its title (as the bench shows it) or its number in the list.
pub fn term(request: &Request, app: &AppHandle) -> Reply {
    let (positional, tail) = match options(&request.args, &["--tail", "-n"]) {
        Ok(found) => found,
        Err(reply) => return reply,
    };
    let tail = tail.unwrap_or(DEFAULT_TAIL).min(MAX_TAIL);
    let own = place::bench_row(app, &request.session);
    let workspace = place::bench_workspace(app, &request.session).or_else(|| place::of(app, &request.cwd, &request.session).workspace_id);
    let Some(workspace) = workspace else { return Reply::no(NO_WORKSPACE) };
    let rows: Vec<WorkspaceTerminal> =
        crate::ai_usage::with_conn(|conn| crate::db::queries::list_workspace_terminals(conn, &workspace)).and_then(Result::ok).unwrap_or_default();
    if rows.is_empty() {
        return Reply::ok("this workspace's bench has no terminals (cf term reads the agents panel's terminals, not the dock's)");
    }
    let live = crate::terminal::recorded_state(&app.state::<crate::terminal::TerminalRegistry>());
    let Some(wanted) = positional.first() else {
        let lines: Vec<String> = rows
            .iter()
            .enumerate()
            .map(|(i, row)| {
                let you = if own.as_deref() == Some(row.id.as_str()) { " (this terminal)" } else { "" };
                let shell = if live.contains_key(&row.id) { "" } else { " — no shell running" };
                format!("{}. {}{you}{shell}", i + 1, row.title)
            })
            .collect();
        return Reply::ok(lines.join("\n"));
    };
    let row = match wanted.parse::<usize>() {
        Ok(n) if (1..=rows.len()).contains(&n) => rows.into_iter().nth(n - 1).expect("checked range"),
        _ => match pick(rows, wanted, |row| row.title.as_str()) {
            Ok(row) => row,
            Err(names) if names.is_empty() => return Reply::no(format!("no terminal named {wanted} (cf term lists them)")),
            Err(names) => return Reply::no(format!("{wanted} matches several terminals: {} — use its number from cf term", names.join(", "))),
        },
    };
    let raw = live.get(&row.id).map(|(_, buffer)| buffer.clone()).unwrap_or(row.transcript);
    let shown = last_lines(&readable(&raw), tail);
    if shown.trim().is_empty() {
        return Reply::ok(format!("{} has printed nothing", row.title));
    }
    Reply::ok(shown)
}

// --------------------------------------------------------------------------------- the agent card

/// `cf progress <text>`: the line on this terminal's agent card.
pub fn progress(request: &Request) -> Reply {
    let text = request.text.trim();
    if text.is_empty() {
        return Reply::no("usage: cf progress <text>");
    }
    if crate::agentstatus::progress(&request.session, text) {
        Reply::ok("")
    } else {
        Reply::no("this terminal has no agent card (only the app's terminal panels have one)")
    }
}

#[derive(Serialize, Clone)]
struct DoneEvent {
    text: String,
    cwd: String,
}

/// `cf done [text]`: the work is finished — the card says so, and the user is told wherever they are.
pub fn done(request: &Request, app: &AppHandle) -> Reply {
    let text = request.text.trim().to_string();
    crate::agentstatus::done(&request.session, &text);
    let _ = app.emit("agentcli:done", DoneEvent { text, cwd: request.cwd.trim().to_string() });
    Reply::ok("")
}

// ------------------------------------------------------------------------------------------ tasks

/// How much of the title names the task — the same cut as `taskTitleFrom` in the agents store.
const TITLE_MAX: usize = 64;

/// `cf task <title> [-- <prompt>] [--agent <name>]`: a draft task in the project's task tree, for an
/// agent of the workspace's roster to do. Nothing starts it — that stays the user's click.
pub fn task(request: &Request, app: &AppHandle) -> Reply {
    let usage = || Reply::no("usage: cf task <title> [-- <what to do>] [--agent <name>]");
    let mut title = Vec::new();
    let mut prompt = Vec::new();
    let mut agent_name: Option<String> = None;
    let mut args = request.args.iter();
    let mut after = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--" if !after => after = true,
            "--agent" if !after => agent_name = args.next().cloned(),
            _ if after => prompt.push(arg.clone()),
            _ => title.push(arg.clone()),
        }
    }
    let title = title.join(" ").split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        return usage();
    }
    let goal = if prompt.is_empty() { title.clone() } else { prompt.join(" ") };
    let shown_title = if title.chars().count() > TITLE_MAX { format!("{}…", title.chars().take(TITLE_MAX).collect::<String>()) } else { title };
    let place = place::of(app, &request.cwd, &request.session);
    let Some(project) = place.project else { return Reply::no("this folder is not in any of the app's projects") };

    let created = crate::ai_usage::with_conn(|conn| -> Result<(crate::db::models::AgentTask, String), String> {
        let roster = crate::db::queries::list_workspace_agents(conn, &project.workspace_id).map_err(|e| e.to_string())?;
        let runnable: Vec<_> = roster.into_iter().filter(|a| a.enabled && !a.provider.trim().is_empty() && !a.model.trim().is_empty()).collect();
        let agent = match agent_name.as_deref() {
            Some(name) => pick(runnable, name, |a| a.name.as_str()).map_err(|names| {
                if names.is_empty() { format!("no agent named {name} in this workspace's roster") } else { format!("{name} matches several agents: {}", names.join(", ")) }
            })?,
            None => runnable.into_iter().next().ok_or("this workspace has no agent ready to take a task — add one in the agents console")?,
        };
        let task = crate::db::queries::create_agent_task(
            conn,
            &project.workspace_id,
            &project.id,
            &agent.id,
            &agent.name,
            &agent.provider,
            &agent.model,
            &agent.prompt,
            &goal,
            &shown_title,
            "",
            agent.account_id.as_deref(),
        )
        .map_err(|e| e.to_string())?;
        Ok((task, agent.name))
    });
    match created {
        Some(Ok((task, agent))) => {
            crate::remotectl::bridge::emit_desktop_change(app, "agentcli", crate::remotectl::dispatch::Invalidate::Tasks, Some(&project.id), None);
            Reply::ok(format!("added a draft task «{}» for {agent} in {}; the user starts it from the agents console", task.title, project.name))
        }
        Some(Err(error)) => Reply::no(error),
        None => Reply::no("the app's database is not available yet"),
    }
}

// ---------------------------------------------------------------------------------------- helpers

/// The arguments that are not options, and the value of the one numeric option `names` spells.
fn options(args: &[String], names: &[&str]) -> Result<(Vec<String>, Option<usize>), Reply> {
    let mut positional = Vec::new();
    let mut value = None;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        let inline = names.iter().find_map(|name| arg.strip_prefix(&format!("{name}=")));
        if names.contains(&arg.as_str()) || inline.is_some() {
            let raw = match inline {
                Some(raw) => Some(raw.to_string()),
                None => iter.next().cloned(),
            };
            match raw.as_deref().and_then(|raw| raw.parse::<usize>().ok()) {
                Some(n) => value = Some(n),
                None => return Err(Reply::no(format!("{} takes a number", names[0]))),
            }
        } else {
            positional.push(arg.clone());
        }
    }
    Ok((positional, value))
}

/// A log or a transcript as an agent reads it: no escape sequences, and no credential a program
/// happened to print — a token echoed by a login, a connection string in a stack trace. The agent
/// asked for what ran, not for the secrets that went past on the screen.
fn readable(raw: &str) -> String {
    crate::secret_scan::redact(&crate::services::log::strip_ansi(raw)).0
}

/// The last `n` lines of `text`, without the blank ones it ends on.
fn last_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.trim_end().lines().collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

/// A name as a shell would need it typed.
fn quote_arg(name: &str) -> String {
    if name.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)) {
        name.to_string()
    } else {
        format!("'{}'", name.replace('\'', "'\\''"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_is_only_a_trailing_number() {
        assert_eq!(split_line("src/a.ts:12"), ("src/a.ts", Some(12)));
        assert_eq!(split_line("src/a.ts:12:4"), ("src/a.ts", Some(12)));
        assert_eq!(split_line("src/a.ts"), ("src/a.ts", None));
        assert_eq!(split_line(r"C:\repo\a.ts"), (r"C:\repo\a.ts", None));
        assert_eq!(split_line(r"C:\repo\a.ts:7"), (r"C:\repo\a.ts", Some(7)));
    }

    #[test]
    fn a_name_matches_exactly_then_by_prefix_then_inside_and_never_guesses() {
        let names = || vec!["api", "api-worker", "web"];
        assert_eq!(pick(names(), "API", |n| n), Ok("api"));
        assert_eq!(pick(names(), "we", |n| n), Ok("web"));
        assert_eq!(pick(names(), "work", |n| n), Ok("api-worker"));
        assert_eq!(pick(vec!["api-a", "api-b"], "api", |n| n), Err(vec!["api-a".to_string(), "api-b".to_string()]));
        assert_eq!(pick(names(), "db", |n| n), Err(Vec::new()));
    }

    #[test]
    fn options_are_read_in_either_spelling_and_the_rest_is_positional() {
        let args = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let (rest, n) = options(&args(&["api", "--tail", "20"]), &["--tail", "-n"]).ok().unwrap();
        assert_eq!((rest, n), (args(&["api"]), Some(20)));
        let (rest, n) = options(&args(&["-n=5", "web"]), &["--tail", "-n"]).ok().unwrap();
        assert_eq!((rest, n), (args(&["web"]), Some(5)));
        assert!(options(&args(&["--tail", "x"]), &["--tail"]).is_err());
    }

    #[test]
    fn the_tail_drops_the_blank_end() {
        assert_eq!(last_lines("a\nb\nc\n\n", 2), "b\nc");
        assert_eq!(last_lines("a", 10), "a");
    }
}
