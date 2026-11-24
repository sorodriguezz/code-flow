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
//!
//! **A third tool, `app_run`** (`crate::app_script`): a script over the same commands, for a task of
//! many calls — a loop, a filter over a large answer, one call feeding the next. Each `app.call` in
//! it goes through [`admit`] and [`invoke`], the very gates `app_call` goes through, and only what the
//! script returns comes back to the model. Destructive commands stay out of it: they need the user's
//! yes, one at a time, through `app_call`.

use std::sync::LazyLock;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

/// The most of one answer a model is handed — the map server's cap on every tool's text
/// (`codemap::mcp::text_result`), so the two cannot disagree.
pub(crate) const MAX_ANSWER: usize = 40_000;
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
/// The script — see `crate::app_script`. Offered only where the run's provider has scripts on
/// ([`crate::app_script::enabled_for`]); whoever lists the tools leaves it out otherwise.
pub const RUN_TOOL: &str = "app_run";

pub fn is_tool(name: &str) -> bool {
    name == LIST_TOOL || name == CALL_TOOL || name == RUN_TOOL
}

/// The tools' definitions. Short: they ride along on every turn. `acts`: a turn that may act —
/// otherwise `app_call` and `app_run` run reads only, and say so.
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
        json!({
            "name": RUN_TOOL,
            "description": crate::app_script::DESCRIPTION,
            "inputSchema": {"type": "object", "properties": {
                "title": {"type": "string", "description": "What the script does, in a few words of the user's language — shown to the user as the step's name"},
                "code": {"type": "string", "description": "The body of an async JavaScript function: use app.call(command, args), return what the user needs"}
            }, "required": ["title", "code"]},
            "annotations": {"readOnlyHint": !acts, "destructiveHint": false, "idempotentHint": false, "openWorldHint": true}
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
    /// `app_run` is on for this run's provider: `app_call` may point a model at it when a task is
    /// turning into many calls ([`script_hint`]).
    pub scripts: bool,
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
    // Plurals too, for the lists the nested walk now reaches: `hostPaths`, `extraDirs`, `files`.
    let key = key.strip_suffix('s').filter(|k| !k.is_empty()).unwrap_or(&key);
    ["path", "dir", "directory", "folder", "cwd", "root", "repopath", "localpath", "file"].iter().any(|k| key == *k || key.ends_with(k))
}

/// Why `args` reach outside the run's workspace, or `None`.
///
/// **Every level, not only the top one.** Plenty of commands take their arguments as one struct —
/// `reviewer_run(request: RunRequest)`, `containers_run(spec)`, `approve_hybrid_plan(checks)` — and
/// a check that read only the top-level strings let a nested `request.repoPath` name any folder on
/// the machine (2026-11-18). Objects and arrays are walked, and each string is judged by the key it
/// sits under.
///
/// `area` is the command's (`remote`, `db`…): it decides what a bare `id` names, and whether a
/// `path` is this machine's at all — a remote host's `/etc/x` is not.
fn outside(scope: &Scope, area: &str, args: &serde_json::Map<String, Value>, roots: &[String]) -> Option<String> {
    for (key, value) in args {
        let text = match value {
            Value::Object(nested) => {
                if let Some(why) = outside(scope, area, nested, roots) {
                    return Some(why);
                }
                continue;
            }
            Value::Array(items) => {
                for item in items {
                    match item {
                        Value::Object(nested) => {
                            if let Some(why) = outside(scope, area, nested, roots) {
                                return Some(why);
                            }
                        }
                        // A list of plain strings is judged by the key that holds it: `paths: [...]`.
                        Value::String(_) => {
                            let mut one = serde_json::Map::new();
                            one.insert(key.clone(), item.clone());
                            if let Some(why) = outside(scope, area, &one, roots) {
                                return Some(why);
                            }
                        }
                        _ => {}
                    }
                }
                continue;
            }
            Value::String(text) => text.as_str(),
            _ => continue,
        };
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
            // A remote host, by the name most remote commands give it. In `remote_upload_file` the
            // `id` is the transfer's and the host is `hostId`, so a bare `id` beside one is not it.
            "hostId" | "host_id" => {
                if let Some(why) = foreign_host(scope, text) {
                    return Some(why);
                }
            }
            "id" if area == "remote" && !args.contains_key("hostId") => {
                if let Some(why) = foreign_host(scope, text) {
                    return Some(why);
                }
            }
            "connectionId" | "connection_id" => {
                if let Some(ws) = &scope.workspace_id {
                    let row = crate::ai_usage::with_conn(|conn| crate::db::datasource_queries::get_connection(conn, text).ok().flatten()).flatten();
                    if let Some(row) = row {
                        if !connection_belongs(&row.workspace_id, &row.scope, ws) {
                            return Some(format!("{key} {text} is a database connection of another workspace"));
                        }
                    }
                }
            }
            _ if area != "remote" && is_path_key(key) && std::path::Path::new(text).is_absolute() => {
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

/// Why remote host `id` is not this run's workspace's, or `None` — also when there is no workspace
/// to hold it to, or the database will not answer (the command then fails on its own).
fn foreign_host(scope: &Scope, id: &str) -> Option<String> {
    let ws = scope.workspace_id.as_ref()?;
    let known = crate::ai_usage::with_conn(|conn| crate::db::remote_queries::host_ids(conn, ws).ok())??;
    (!belongs(&known, id)).then(|| format!("remote host {id} is not one of this workspace's"))
}

fn belongs(ids: &[String], id: &str) -> bool {
    ids.iter().any(|known| known == id)
}

/// A connection is this workspace's when it sits on its shelf or on every shelf — the same rule
/// the database tree is loaded by (`datasource_queries::load_tree`).
fn connection_belongs(row_workspace: &str, row_scope: &str, workspace: &str) -> bool {
    row_workspace == workspace || row_scope == "global"
}

/// Whether a database command may run on a connection the user opened to models at `access`.
///
/// The connection's own switch (`ai_access` in its spec, «Sin acceso» / read / write) is what the
/// `db_read` and `db_write` tools answer to; without this the same connection was reachable through
/// `app_call` whatever it said, `db_execute` included (2026-11-18). What changes data needs write —
/// and is `destructive` in the catalogue, so the user still sees each one — and everything else
/// needs at least read.
fn db_gate(access: crate::agentcli::AiAccess, changes_data: bool) -> Result<(), String> {
    use crate::agentcli::AiAccess;
    match (access, changes_data) {
        (AiAccess::None, _) => Err("this connection is not open to models («Sin acceso»): the user can open it in its settings".into()),
        (AiAccess::Read, true) => Err("this connection is open to models for reading only".into()),
        _ => Ok(()),
    }
}

/// A command a run may make, with its arguments, once every gate but the user's yes has passed.
#[derive(Debug)]
pub(crate) struct Admitted {
    pub name: String,
    pub risk: String,
    pub args: serde_json::Map<String, Value>,
    signature: String,
}

impl Admitted {
    pub fn destructive(&self) -> bool {
        self.risk == "destructive"
    }
}

/// Everything that bounds a call short of asking the user: the command exists and may be called by
/// a model, plan mode runs reads only, its required arguments are there, it stays in the run's
/// workspace, and a database command answers to that connection's switch. `raw_args` is the call's
/// `args` as the model sent them — an object, or that object as JSON text.
pub(crate) fn admit(scope: &Scope, name: &str, raw_args: Option<&Value>) -> Result<Admitted, String> {
    let name = name.trim();
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
    let call_args = match raw_args {
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
    if let Some(why) = outside(scope, &command.area, &call_args, &roots) {
        return Err(format!("Not called: {why}."));
    }
    if command.area == "db" {
        if let Some(id) = call_args.get("connectionId").and_then(Value::as_str) {
            let spec = crate::ai_usage::with_conn(|conn| crate::db::datasource_queries::get_connection(conn, id).ok().flatten().map(|row| row.spec)).flatten();
            if let Some(spec) = spec {
                db_gate(crate::agentcli::AiAccess::of_spec(&spec), command.risk == "destructive").map_err(|why| format!("Not called: {why}."))?;
            }
        }
    }
    Ok(Admitted { name: name.to_string(), risk: command.risk.clone(), args: call_args, signature: signature(command) })
}

/// The call itself: the window's own `invoke` (`flows::bridge`), its answer as the window got it —
/// not yet scrubbed (see [`scrub`] and [`scrub_value`]).
pub(crate) async fn invoke(app: &AppHandle, admitted: &Admitted) -> Result<Value, String> {
    let payload = json!({ "command": admitted.name, "args": Value::Object(admitted.args.clone()) });
    crate::flows::bridge::ask(app, "app.invoke", payload, std::time::Duration::from_secs(180), tokio_util::sync::CancellationToken::new()).await
}

/// `app_call`: one command, with everything this module's header says bounds it.
pub async fn call(app: &AppHandle, scope: &Scope<'_>, args: &Value) -> Result<String, String> {
    let name = args.get("command").and_then(Value::as_str).unwrap_or_default().trim().to_string();
    let admitted = admit(scope, &name, args.get("args"))?;
    if admitted.destructive() {
        let detail = format!("{}\n{}", admitted.signature, serde_json::to_string_pretty(&Value::Object(admitted.args.clone())).unwrap_or_default());
        crate::agentcli::approve_tool_use(app, scope.root, scope.session, &format!("CodeFlow · {name}"), &detail)
            .await
            .map_err(|said| if said.trim().is_empty() { format!("The user did not approve {name}.") } else { format!("The user did not approve {name}: {said}") })?;
    }
    let answer = invoke(app, &admitted).await?;
    let text = match answer {
        Value::Null => "done".to_string(),
        Value::String(text) => text,
        other => serde_json::to_string_pretty(&other).unwrap_or_default(),
    };
    let text = scrub(app, &text);
    let cut = text.len() > MAX_ANSWER;
    let mut text = clip(text);
    if let Some(hint) = script_hint(scope, cut) {
        text.push_str(hint);
    }
    Ok(text)
}

/// `app_call`s per run, while they keep coming: when the last one was, and how many in a row.
static STREAKS: LazyLock<std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, u32)>>> =
    LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));
/// A pause longer than this ends a streak: the model is on to something else.
const STREAK_GAP: std::time::Duration = std::time::Duration::from_secs(90);
/// The call of a streak that suggests a script — once a streak, so it is a nudge and not a nag.
const STREAK_HINT_AT: u32 = 3;

/// A line after `app_call`'s answer pointing at `app_run`, when the run has it and this is where a
/// script would have been cheaper: the answer was cut, or calls are piling up one after another.
/// Said by the app, on evidence, rather than left to the model's reading of a tool description.
fn script_hint(scope: &Scope, cut: bool) -> Option<&'static str> {
    if !scope.scripts {
        return None;
    }
    let count = {
        let mut streaks = STREAKS.lock().ok()?;
        let now = std::time::Instant::now();
        streaks.retain(|_, (at, _)| now.duration_since(*at) < STREAK_GAP);
        let entry = streaks.entry(scope.session.to_string()).or_insert((now, 0));
        entry.0 = now;
        entry.1 += 1;
        entry.1
    };
    hint_for(cut, count)
}

fn hint_for(cut: bool, count: u32) -> Option<&'static str> {
    if cut {
        Some("\n[Tip: app_run can make this call and filter its answer in a script, so only what you need comes back.]")
    } else if count == STREAK_HINT_AT {
        Some("\n[Tip: several app_call in a row — if more are coming, app_run does them in one script and hands you only what it returns.]")
    } else {
        None
    }
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

/// [`scrub`] over a JSON answer, for a script to keep working with: the same secrets taken out of
/// its text, read back as JSON — or as the scrubbed text, should taking a secret out have left
/// something that no longer parses.
pub(crate) fn scrub_value(app: &AppHandle, value: Value) -> Value {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) => value,
        Value::String(text) => Value::String(scrub(app, &text)),
        other => {
            let text = scrub(app, &other.to_string());
            serde_json::from_str(&text).unwrap_or(Value::String(text))
        }
    }
}

/// `text` cut to [`MAX_ANSWER`] bytes on a character boundary, saying it was cut and how to ask for
/// less. Claude Code warns past ~10k tokens and refuses past 25k, so a log tail or a listing that
/// size would otherwise be dropped whole, or crowd out everything else in the turn.
pub(crate) fn clip(mut text: String) -> String {
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
        let scope = Scope { root: "/tmp/r", session: "s", acts: false, workspace_id: Some("w".into()), project: None, scripts: false };
        let listed = list(&scope, &json!({"query": "github token"}));
        assert!(!listed.contains("get_github_token("), "{listed}");
        assert!(listed.contains("Plan mode"), "{listed}");
    }

    #[test]
    fn a_call_stays_in_the_workspace() {
        let scope = Scope { root: "/Users/me/repo", session: "s", acts: true, workspace_id: Some("w1".into()), project: None, scripts: false };
        let roots = vec!["/Users/me/repo".to_string()];
        let args = |v: Value| v.as_object().unwrap().clone();
        assert!(outside(&scope, "git", &args(json!({"workspaceId": "w2"})), &roots).is_some());
        assert!(outside(&scope, "git", &args(json!({"workspaceId": "w1"})), &roots).is_none());
        assert!(outside(&scope, "git", &args(json!({"path": "/etc/hosts"})), &roots).is_some());
        assert!(outside(&scope, "git", &args(json!({"repoPath": "/Users/me/repo/src"})), &roots).is_none());
        assert!(outside(&scope, "git", &args(json!({"path": "src/main.rs"})), &roots).is_none());
        // Nested, as `reviewer_run(request)` takes it: the folder inside the struct is checked too.
        assert!(outside(&scope, "git", &args(json!({"request": {"repoPath": "/etc", "build": "id"}})), &roots).is_some());
        assert!(outside(&scope, "git", &args(json!({"request": {"repoPath": "/Users/me/repo", "projectId": "x"}})), &roots).is_none());
        assert!(outside(&scope, "git", &args(json!({"spec": {"mounts": [{"hostPath": "/etc"}]}})), &roots).is_some());
        assert!(outside(&scope, "git", &args(json!({"hostPaths": ["/Users/me/repo/a", "/etc/passwd"]})), &roots).is_some());
        assert!(outside(&scope, "git", &args(json!({"task": {"workspaceId": "w2"}})), &roots).is_some());
        // A remote host's own paths are not this machine's.
        assert!(outside(&scope, "remote", &args(json!({"path": "/etc/hosts"})), &roots).is_none());
    }

    #[test]
    fn a_long_answer_is_cut_on_a_character_boundary_and_says_so() {
        let long = "ñ".repeat(MAX_ANSWER);
        let cut = clip(long);
        assert!(cut.len() < MAX_ANSWER + 100, "{}", cut.len());
        assert!(cut.ends_with("one item]"), "{}", &cut[cut.len() - 40..]);
        assert_eq!(clip("corto".into()), "corto");
    }

    #[test]
    fn plan_mode_admits_reads_and_refuses_the_rest_before_anything_runs() {
        let plan = Scope { root: "/tmp/r", session: "s", acts: false, workspace_id: Some("w".into()), project: None, scripts: true };
        let read = CATALOG.iter().find(|c| c.risk == "read" && c.args.iter().all(|a| a.optional)).expect("a read command without arguments");
        assert!(admit(&plan, &read.name, None).is_ok());
        let write = CATALOG.iter().find(|c| c.risk == "write").expect("a write command");
        assert!(admit(&plan, &write.name, None).unwrap_err().contains("plan mode"));
        assert!(admit(&plan, "get_github_token", None).unwrap_err().contains("not available"));
        assert!(admit(&plan, "no_such_command", None).unwrap_err().contains("app_commands"));
        assert!(admit(&plan, &read.name, Some(&json!([1]))).unwrap_err().contains("object"));
    }

    #[test]
    fn the_script_hint_comes_once_a_streak_or_when_an_answer_was_cut() {
        assert!(hint_for(true, 1).unwrap().contains("app_run"));
        assert!(hint_for(false, 1).is_none());
        assert!(hint_for(false, 2).is_none());
        assert!(hint_for(false, STREAK_HINT_AT).unwrap().contains("app_run"));
        assert!(hint_for(false, STREAK_HINT_AT + 1).is_none());
        // A run without scripts is never pointed at one.
        let off = Scope { root: "/tmp/r", session: "hint-off", acts: true, workspace_id: None, project: None, scripts: false };
        assert!((0..5).all(|_| script_hint(&off, true).is_none()));
    }

    #[test]
    fn a_database_command_answers_to_the_connections_switch() {
        use crate::agentcli::AiAccess;
        assert!(db_gate(AiAccess::None, false).is_err());
        assert!(db_gate(AiAccess::None, true).is_err());
        assert!(db_gate(AiAccess::Read, false).is_ok());
        assert!(db_gate(AiAccess::Read, true).is_err());
        assert!(db_gate(AiAccess::Write, true).is_ok());
    }

    #[test]
    fn hosts_and_connections_belong_to_their_workspace() {
        let ids = vec!["h1".to_string(), "h2".to_string()];
        assert!(belongs(&ids, "h2"));
        assert!(!belongs(&ids, "h9"));
        assert!(connection_belongs("w1", "workspace", "w1"));
        assert!(connection_belongs("w2", "global", "w1"));
        assert!(!connection_belongs("w2", "workspace", "w1"));
    }
}
