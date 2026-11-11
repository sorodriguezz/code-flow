//! The whole app, for a chat's model: every command the window can call, behind two tools of the
//! map server (`codemap::mcp`) — `app_commands` (what there is) and `app_call` (calling one).
//!
//! The user's call (2026-11-11): "cuando te digo que quiero que vea toda la app, pueda usar toda la
//! app y hacer cosas en toda la app me refiero realmente a toda la app… TODO". The curated tools
//! (`kubernetes`, `db_read`, `azure_devops`…) stay — they are shorter and sharper for what they do —
//! and this is the door to everything else: the boards, every provider's pull requests, the remote
//! hosts and buckets, the reviewer's findings, the dependency alerts, the flows, the notes…
//!
//! **The catalogue is generated** from the source (`scripts/app-catalog.mjs` → `app_catalog.json`,
//! kept current by `src/appCatalog.test.ts`): name, area, arguments as the window sends them, the
//! doc's first sentence, and a risk read off the name. The call itself is the window's own
//! (`flows::bridge` → `invoke`), so a command runs exactly as when the user clicks it.
//!
//! What bounds it:
//! - **`blocked`** commands are never called: the ones that hand back or take a secret, and the
//!   doors the model is itself held at (answering its own approval, the window's replies).
//! - **A plan turn** calls `read` commands only.
//! - **`destructive`** ones — deleting, resetting, quitting, and anything that changes what a model
//!   may do (settings, access, trust) — run only after the user's yes in the window.
//! - **The run's workspace**: a `workspaceId` must be the run's, a `projectId` one of its
//!   repositories, an absolute path inside one of them (or the temporary folder).
//! - **What comes back** is scrubbed of every secret the app keeps and what the secret scan knows,
//!   and cut at [`MAX_ANSWER`].

use std::sync::LazyLock;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// The most of one answer a model is handed.
const MAX_ANSWER: usize = 80_000;
/// How many commands one listing shows.
const MAX_LISTED: usize = 40;

#[derive(Debug, Deserialize)]
struct Arg {
    name: String,
    #[serde(rename = "type")]
    ty: String,
    #[serde(default)]
    optional: bool,
}

#[derive(Debug, Deserialize)]
struct Command {
    name: String,
    area: String,
    risk: String,
    #[serde(default)]
    args: Vec<Arg>,
    #[serde(default)]
    returns: String,
    #[serde(default)]
    doc: String,
}

static CATALOG: LazyLock<Vec<Command>> = LazyLock::new(|| serde_json::from_str(include_str!("app_catalog.json")).unwrap_or_default());

pub const LIST_TOOL: &str = "app_commands";
pub const CALL_TOOL: &str = "app_call";

pub fn is_tool(name: &str) -> bool {
    name == LIST_TOOL || name == CALL_TOOL
}

/// The two tools' definitions. Short: they ride along on every turn. `acts`: a turn that may act —
/// otherwise `app_call` runs reads only, and says so.
pub fn tools(acts: bool) -> Vec<Value> {
    vec![
        json!({
            "name": LIST_TOOL,
            "description": "Everything CodeFlow can do, as commands you can call with app_call: boards (Azure, Jira, Linear, Monday), pull requests of every provider, remote hosts and buckets, the code reviewer and its findings, dependency alerts, flows, notes, services, containers, databases, the API client, settings… Search by words; without a query, the areas. Use it when no other tool covers what you need.",
            "inputSchema": {"type": "object", "properties": {
                "query": {"type": "string", "description": "Words of what you want, e.g. \"jira issue\", \"remote files\", \"review findings\""},
                "area": {"type": "string", "description": "Only this area (as listed)"}
            }},
            "annotations": {"readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false}
        }),
        json!({
            "name": CALL_TOOL,
            "description": "Call one of CodeFlow's commands (app_commands lists them, with their arguments), as the app's window calls it. Reads run at once; a destructive command waits for the user's yes; in plan mode only reads run. Stay in this run's workspace: app_commands says its ids and path.",
            "inputSchema": {"type": "object", "properties": {
                "command": {"type": "string"},
                "args": {"type": "object", "description": "The command's arguments by name, as app_commands lists them"}
            }, "required": ["command"]},
            "annotations": {"readOnlyHint": !acts, "destructiveHint": acts, "idempotentHint": !acts, "openWorldHint": true}
        }),
    ]
}

/// Where a run is: what `app_call` keeps it to.
pub struct Scope<'a> {
    pub root: &'a str,
    pub session: &'a str,
    pub acts: bool,
    pub workspace_id: Option<String>,
    pub project: Option<crate::db::models::Project>,
}

fn signature(command: &Command) -> String {
    let args: Vec<String> = command.args.iter().map(|a| format!("{}{}: {}", a.name, if a.optional { "?" } else { "" }, a.ty)).collect();
    format!("{}({}) [{}] → {}", command.name, args.join(", "), command.risk, command.returns)
}

fn callable(command: &Command) -> bool {
    command.risk != "blocked" && command.risk != "unsupported"
}

/// `app_commands`: the areas, or the commands matching `query` (every word, in the name, the area or
/// the doc), with the run's ids first — what most commands are called with.
pub fn list(scope: &Scope, args: &Value) -> String {
    let text = |key: &str| args.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_lowercase();
    let (query, area) = (text("query"), text("area"));
    let mut out = vec![here(scope)];
    if query.is_empty() && area.is_empty() {
        let mut areas: Vec<(&str, usize)> = Vec::new();
        for command in CATALOG.iter().filter(|c| callable(c)) {
            match areas.iter_mut().find(|(name, _)| *name == command.area) {
                Some((_, n)) => *n += 1,
                None => areas.push((command.area.as_str(), 1)),
            }
        }
        out.push(format!("Areas (commands): {}", areas.iter().map(|(a, n)| format!("{a} ({n})")).collect::<Vec<_>>().join(", ")));
        out.push("Search with query (words) and/or area.".into());
        return out.join("\n");
    }
    let words: Vec<String> = query.split_whitespace().map(str::to_string).collect();
    let found: Vec<&Command> = CATALOG
        .iter()
        .filter(|c| callable(c))
        .filter(|c| area.is_empty() || c.area.to_lowercase() == area || c.area.to_lowercase().ends_with(&format!("/{area}")))
        .filter(|c| {
            let hay = format!("{} {} {}", c.name.replace('_', " "), c.area, c.doc).to_lowercase();
            words.iter().all(|w| hay.contains(w.as_str()) || hay.contains(w.trim_end_matches('s')))
        })
        .collect();
    if found.is_empty() {
        out.push("No command matches. Try fewer or other words, or no query to see the areas.".into());
        return out.join("\n");
    }
    let shown = found.len().min(MAX_LISTED);
    for command in &found[..shown] {
        out.push(format!("- {} — {}", signature(command), command.doc));
    }
    if found.len() > shown {
        out.push(format!("({} more: narrow the query)", found.len() - shown));
    }
    if !scope.acts {
        out.push("Plan mode: only [read] commands run.".into());
    }
    out.join("\n")
}

fn here(scope: &Scope) -> String {
    let mut parts = Vec::new();
    if let Some(ws) = &scope.workspace_id {
        parts.push(format!("workspaceId={ws}"));
    }
    if let Some(project) = &scope.project {
        parts.push(format!("projectId={} ({}) path={}", project.id, project.name, project.local_path));
    } else {
        parts.push(format!("path={}", scope.root));
    }
    format!("This run: {}", parts.join(" · "))
}

/// The keys whose value is a filesystem path.
fn is_path_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    ["path", "dir", "directory", "folder", "cwd", "root", "repopath", "localpath", "file"].iter().any(|k| key == *k || key.ends_with(k))
}

/// Why `args` reach outside the run's workspace, or `None`.
fn outside(scope: &Scope, args: &serde_json::Map<String, Value>, roots: &[String]) -> Option<String> {
    for (key, value) in args {
        let Some(text) = value.as_str() else { continue };
        match key.as_str() {
            "workspaceId" | "workspace_id" => {
                if let Some(ws) = &scope.workspace_id {
                    if text != ws {
                        return Some(format!("{key} {text} is not this run's workspace ({ws})"));
                    }
                }
            }
            "projectId" | "project_id" => {
                if scope.workspace_id.is_some() && !roots.is_empty() {
                    let known = crate::ai_usage::with_conn(|conn| {
                        crate::db::queries::list_projects(conn, scope.workspace_id.as_deref().unwrap_or_default()).map(|all| all.iter().any(|p| p.id == text)).unwrap_or(false)
                    });
                    if known == Some(false) {
                        return Some(format!("{key} {text} is not a repository of this run's workspace"));
                    }
                }
            }
            _ if is_path_key(key) && std::path::Path::new(text).is_absolute() => {
                let temp = std::env::temp_dir();
                let inside = roots.iter().any(|root| std::path::Path::new(text).starts_with(root)) || std::path::Path::new(text).starts_with(&temp);
                if !inside {
                    return Some(format!("{key} {text} is outside this run's workspace"));
                }
            }
            _ => {}
        }
    }
    None
}

/// `app_call`: one command, with everything this module's header says bounds it.
pub async fn call(app: &AppHandle, scope: &Scope<'_>, args: &Value) -> Result<String, String> {
    let name = args.get("command").and_then(Value::as_str).unwrap_or_default().trim().to_string();
    let Some(command) = CATALOG.iter().find(|c| c.name == name) else {
        return Err(format!("no command named {name:?} — app_commands lists them"));
    };
    match command.risk.as_str() {
        "blocked" => return Err(format!("{name} is not available to a model: it handles secrets or the approvals you are held to")),
        "unsupported" => return Err(format!("{name} streams to the window and cannot be called from here")),
        "read" => {}
        _ if !scope.acts => return Err(format!("{name} changes something ({}), and this is plan mode: only [read] commands run", command.risk)),
        _ => {}
    }
    let call_args = match args.get("args") {
        None | Some(Value::Null) => serde_json::Map::new(),
        Some(Value::Object(map)) => map.clone(),
        Some(Value::String(raw)) => match serde_json::from_str::<Value>(raw) {
            Ok(Value::Object(map)) => map,
            _ => return Err("args must be an object".into()),
        },
        Some(_) => return Err("args must be an object".into()),
    };
    let missing: Vec<&str> = command.args.iter().filter(|a| !a.optional && !call_args.contains_key(&a.name)).map(|a| a.name.as_str()).collect();
    if !missing.is_empty() {
        return Err(format!("missing arguments: {} — {}", missing.join(", "), signature(command)));
    }
    let roots: Vec<String> = {
        let mut roots = vec![scope.root.to_string()];
        if let Some(ws) = &scope.workspace_id {
            if let Some(Ok(projects)) = crate::ai_usage::with_conn(|conn| crate::db::queries::list_projects(conn, ws)) {
                roots.extend(projects.into_iter().map(|p| p.local_path).filter(|p| !p.is_empty()));
            }
        }
        roots
    };
    if let Some(why) = outside(scope, &call_args, &roots) {
        return Err(format!("Not called: {why}."));
    }
    if command.risk == "destructive" {
        let detail = format!("{}\n{}", signature(command), serde_json::to_string_pretty(&Value::Object(call_args.clone())).unwrap_or_default());
        crate::agentcli::approve_tool_use(app, scope.root, scope.session, &format!("CodeFlow · {name}"), &detail)
            .await
            .map_err(|said| if said.trim().is_empty() { format!("The user did not approve {name}.") } else { format!("The user did not approve {name}: {said}") })?;
    }
    let payload = json!({ "command": name, "args": Value::Object(call_args) });
    let answer = crate::flows::bridge::ask(app, "app.invoke", payload, std::time::Duration::from_secs(180), tokio_util::sync::CancellationToken::new()).await?;
    let text = match answer {
        Value::Null => "done".to_string(),
        Value::String(text) => text,
        other => serde_json::to_string_pretty(&other).unwrap_or_default(),
    };
    Ok(clip(scrub(app, &text)))
}

/// Every value the app keeps as a secret, and what the secret scan recognises, out of `text`.
fn scrub(app: &AppHandle, text: &str) -> String {
    let mut out = text.to_string();
    if let Some(db) = app.try_state::<crate::db::Db>() {
        let mut secrets = crate::db::api_secrets::stored_secrets(&db);
        secrets.retain(|s| s.chars().count() >= 4);
        secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
        for secret in secrets {
            out = out.replace(secret.as_str(), "[secret]");
        }
    }
    crate::secret_scan::redact(&out).0
}

fn clip(mut text: String) -> String {
    if text.len() > MAX_ANSWER {
        let mut cut = MAX_ANSWER;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push_str("\n[… answer cut: ask for less — a filter, a page, one item]");
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_catalogue_loads_and_hides_what_cannot_be_called() {
        assert!(CATALOG.len() > 1000, "{}", CATALOG.len());
        assert!(CATALOG.iter().any(|c| c.name == "get_github_token" && c.risk == "blocked"));
        let scope = Scope { root: "/tmp/r", session: "s", acts: false, workspace_id: Some("w".into()), project: None };
        let listed = list(&scope, &json!({"query": "github token"}));
        assert!(!listed.contains("get_github_token("), "{listed}");
        assert!(listed.contains("Plan mode"), "{listed}");
    }

    #[test]
    fn a_call_stays_in_the_workspace() {
        let scope = Scope { root: "/Users/me/repo", session: "s", acts: true, workspace_id: Some("w1".into()), project: None };
        let roots = vec!["/Users/me/repo".to_string()];
        let args = |v: Value| v.as_object().unwrap().clone();
        assert!(outside(&scope, &args(json!({"workspaceId": "w2"})), &roots).is_some());
        assert!(outside(&scope, &args(json!({"workspaceId": "w1"})), &roots).is_none());
        assert!(outside(&scope, &args(json!({"path": "/etc/hosts"})), &roots).is_some());
        assert!(outside(&scope, &args(json!({"repoPath": "/Users/me/repo/src"})), &roots).is_none());
        assert!(outside(&scope, &args(json!({"path": "src/main.rs"})), &roots).is_none());
    }
}
