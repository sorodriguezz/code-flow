//! What the local agent can do to a working copy, and the fences around it.
//!
//! Every path the model names is resolved through the same guards the editor's saves and the hybrid
//! executor go through (`fsops::resolve_existing_for_write`, `fsops::resolve_path_for_create`):
//! `..` is refused before anything is looked up, and a link must lead somewhere inside the root.
//! A model cannot be talked into reading `~/.ssh` or writing outside the repository any more than a
//! click in the file tree can.
//!
//! **What is on offer is the permission.** A read-only run is given the read tools and nothing else
//! — not "asked not to write": the write tools do not exist in its request, and [`Toolbox::call`]
//! refuses them by name as well, for a model that invents a call it was never offered. That is why
//! `CodeFlowEngine::enforces_read_only` can honestly answer yes, which no CLI that merely takes a
//! "please don't" flag can.
//!
//! Output is sized for a small model's window: a file comes back a few hundred lines at a time with
//! line numbers, a search a few dozen hits, a command its last few kilobytes. Each says what it left
//! out, so the model can ask for the next part instead of assuming it saw everything.
//!
//! # The same reach as Claude Code's, offered by need
//!
//! What a CLI agent gets over the app's MCP server (`codemap::mcp`) this agent gets here, answered
//! by the same code: the map's queries, `search_knowledge`, `recall` and `read_note`, the app's read
//! tools (a service's log, its readiness, another terminal's output) and — for a run that may act —
//! its action tools (restart a service, open a file for the user, notify them, propose a memory or
//! a task, and *use* a saved database connection, API request or keyring entry). The app tools go
//! through `agentcli::run_verb`, the very door `cf` and the MCP server use, so every approval the
//! user gives Claude Code's runs in the window is asked for this one too, and a credential is used
//! by the app and never returned to the model.
//!
//! A small model pays for every tool on offer — its schema takes the window, and each extra name is
//! one more to pick wrongly — so what is offered follows the run ([`Reach`]) and what is there to
//! reach ([`Inventory`]): no `db_query` on a workspace with no saved connection, no `recall` when
//! every approved memory is already in the message, no app tool at all for a run judging material
//! someone else wrote. See [`offered`].
//!
//! # A destructive command waits for the user
//!
//! `run_command` checks every line against `cf guard`'s rules (`crate::shell_rules`, the file Claude
//! Code's `PreToolUse` hook is built from) and holds a match for the user's approval in the same
//! modal; a refusal comes back to the model with the user's words.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::{fsops, search};

/// Lines `read_file` returns when the model names no range.
const READ_LINES: usize = 300;
/// …and the characters, whichever runs out first — a minified file is one enormous line.
const READ_CHARS: usize = 24_000;
/// Hits `search` returns.
const SEARCH_HITS: usize = 60;
/// Names `find_files` returns.
const FIND_RESULTS: usize = 200;
/// Entries `list_files` returns.
const LIST_ENTRIES: usize = 300;
/// The tail of a command's output that goes back to the model.
const COMMAND_OUTPUT_CHARS: usize = 8_000;
/// How long a command may run.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
/// What one app tool's answer may take of the window: a log tail, a result table, a response.
const APP_OUTPUT_CHARS: usize = 12_000;
/// Files a non-git folder is walked for, at most — a chat's own folder, not a whole disk.
const PLAIN_WALK_LIMIT: usize = 5_000;
/// Names in the plain file list a run falls back to when the repository map cannot be built.
const MAP_FALLBACK_FILES: usize = 200;
/// Folders never walked in a non-git folder; a repository's own ignore rules cover the git case.
const SKIPPED_DIRS: &[&str] = &[".git", "node_modules", "target", "dist", "build", ".next", ".venv", "__pycache__"];

/// What a run may do, decided once from the invocation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Grants {
    pub write: bool,
    pub run: bool,
    pub reach: Reach,
}

/// How far past the working copy a run reaches — decided from the invocation (`Mode::of`), never
/// from what the model asks.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Reach {
    /// The project alone: its files, its map, its knowledge and the memories the user approved. A
    /// run that judges material someone else wrote — a review, a CI log, a story (the MCP server's
    /// *grounding* runs, whose text is where an injected instruction would reach for the app) — or
    /// a single-purpose job such as a fix, which needs nothing of the app around it.
    Project,
    /// …and what the app shows: a service's log, its readiness, another terminal's output. A
    /// conversation that may not act.
    Observe,
    /// …and what the app does for the run, each use of something the user keeps approved by them in
    /// the window: a conversation that may act (not read-only).
    Act,
}

/// What the run's place has for the app's tools to reach. A tool with nothing to act on is not
/// offered: a `db_query` on a workspace with no saved connection can only fail, and costs a small
/// model its schema's share of the window on every step all the same.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Inventory {
    /// The folder belongs to a project (`add_task` files into its tree).
    pub project: bool,
    pub services: bool,
    pub terminals: bool,
    pub databases: bool,
    pub requests: bool,
    pub secrets: bool,
    /// Notes the knowledge search can cite (`read_note` opens one whole).
    pub notes: bool,
    /// Approved memories for this place, in all — `recall` is offered only while there are more of
    /// them than the run was already handed ([`Toolbox::with_given_memories`]).
    pub memories: usize,
}

/// One request to the app on the run's behalf.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AppCall {
    /// `cf guard`'s question: a destructive command, held until the user says yes.
    Guard { command: String, reason: &'static str },
    /// A `cf` verb, with its arguments as `codemap::mcp` builds them.
    Verb { verb: &'static str, args: Vec<String>, stdin: String },
}

/// Where an [`AppCall`] goes: the window, through `agentcli::run_verb` — or a stub in a test.
pub type Door = Arc<dyn Fn(AppCall) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send>> + Send + Sync>;

/// The app's read tools — the `cf` verbs that change nothing.
const OBSERVE_TOOLS: &[&str] = &["service_logs", "service_wait", "terminal_output"];
/// The app's action tools, offered only to a run that may act.
const ACT_TOOLS: &[&str] =
    &["service_restart", "open_in_editor", "notify", "propose_memory", "add_task", "db_query", "http_request", "run_with_secret"];

/// The tools a run is offered, in the order the model reads them: what the project is (the map,
/// the knowledge, the memories, the notes), then its files, then what may change them, then the app.
///
/// `map`: the repository map's tools are on (`codemap::mcp::enabled`). `checks`: the repository has
/// trusted checks for `run_check`. `given_memories`: the approved memories already in the run's
/// message, so `recall` only when there are more.
pub fn offered(grants: Grants, map: bool, checks: bool, inventory: &Inventory, given_memories: usize) -> Vec<&'static str> {
    let mut names: Vec<&'static str> = Vec::new();
    if map {
        names.extend(["find_symbol", "find_usages", "outline"]);
    }
    names.push("search_knowledge");
    if inventory.memories > given_memories {
        names.push("recall");
    }
    // A note is cited by its id in a passage; the run judging someone's material quotes passages
    // but has no business opening a whole notebook (the MCP server's grounding set has no reader).
    if inventory.notes && grants.reach > Reach::Project {
        names.push("read_note");
    }
    names.extend(["list_files", "find_files", "read_file", "search"]);
    if grants.write {
        names.extend(["edit_file", "write_file"]);
        if checks {
            names.push("run_check");
        }
    }
    if grants.run {
        names.push("run_command");
    }
    if grants.reach >= Reach::Observe {
        if inventory.services {
            names.extend(["service_logs", "service_wait"]);
        }
        if inventory.terminals {
            names.push("terminal_output");
        }
    }
    if grants.reach == Reach::Act {
        if inventory.services {
            names.push("service_restart");
        }
        names.extend(["open_in_editor", "notify", "propose_memory"]);
        if inventory.project {
            names.push("add_task");
        }
        if inventory.databases {
            names.push("db_query");
        }
        if inventory.requests {
            names.push("http_request");
        }
        if inventory.secrets {
            names.push("run_with_secret");
        }
    }
    names
}

pub struct Toolbox {
    root: PathBuf,
    root_str: String,
    git: bool,
    grants: Grants,
    /// Files `read_file` has shown this run. An existing file can only be edited or rewritten once
    /// it is in here — Claude Code's rule, and for the same reason: a model that has not looked at
    /// a file rewrites it from imagination. Seen live: a 7B replaced a README it had never opened.
    read: std::sync::Mutex<std::collections::HashSet<String>>,
    /// Whether the repository map's tools are offered (`find_symbol`, `find_usages`, `outline`).
    /// Off when the user switched the map off for every agent (`codemap::mcp::enabled`), and to
    /// measure what the map is worth (the live test's `CODEFLOW_LIVE_NO_MAP`).
    map: bool,
    /// Declarations this run renamed or removed — checked again before it may finish
    /// ([`Toolbox::dangling`]).
    renamed: std::sync::Mutex<std::collections::BTreeSet<String>>,
    /// Files open in the editor with unsaved changes, by repository-relative path: read from here
    /// instead of the disk, and never edited — the user is still typing in them
    /// (`crate::context::with_unsaved`).
    unsaved: std::collections::HashMap<String, String>,
    /// The repository's trusted checks (`hybrid_checks:<project>`): what `run_check` may run, by
    /// name — level L3 of `crate::tool_gateway`, without the free shell.
    checks: Vec<String>,
    /// The model driving the run, for the audit log.
    model: String,
    /// The project and the workspace the folder belongs to, for `read_note` and the inventory.
    workspace_id: Option<String>,
    inventory: Inventory,
    /// Approved memories already in the run's message — see [`offered`].
    given_memories: usize,
    /// Where the app tools and the guard's question go.
    door: Door,
}

/// One tool call's result: the text the model reads, and a short line for the run log.
pub struct Outcome {
    pub content: String,
    pub summary: String,
    pub ok: bool,
    /// Lines added and removed, for a call that wrote.
    pub changed: Option<(i64, i64)>,
}

impl Outcome {
    fn ok(content: String, summary: String) -> Self {
        Self { content, summary, ok: true, changed: None }
    }

    fn err(message: impl Into<String>) -> Self {
        let message = message.into();
        Self { content: format!("Error: {message}"), summary: message, ok: false, changed: None }
    }
}

impl Toolbox {
    pub fn new(root: &str, grants: Grants) -> Result<Self, String> {
        let root_path = Path::new(root).canonicalize().map_err(|e| format!("invalid working folder {root}: {e}"))?;
        let git = git2::Repository::open(&root_path).ok().and_then(|repo| repo.workdir().map(Path::to_path_buf)).is_some_and(|workdir| {
            workdir.canonicalize().is_ok_and(|workdir| workdir == root_path)
        });
        let root_str = root_path.to_string_lossy().to_string();
        let (workspace_id, inventory, workspace_chat) =
            crate::ai_usage::with_conn(|conn| take_inventory(conn, &root_str, grants.reach)).unwrap_or_default();
        // A workspace chat's folder is not a repository: the MCP server gives such a run the
        // workspace's knowledge and memories and none of the app's tools — "no one place for them to
        // act in" — and so does this. Its own files stay its to read and write.
        let grants = if workspace_chat { Grants { reach: grants.reach.min(Reach::Observe), ..grants } } else { grants };
        // "Allow in this terminal" for this run's approvals is keyed by the run, as the MCP server
        // keys a chat's: an allowance lasts the turn it was given in.
        let session = format!("codeflow:{}", crate::ai_runs::current().map(|ctx| ctx.run_id).unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string()));
        Ok(Self {
            door: app_door(root_str.clone(), session),
            root_str,
            root: root_path,
            git,
            grants,
            read: Default::default(),
            map: true,
            renamed: Default::default(),
            unsaved: crate::context::current_unsaved().into_iter().map(|b| (b.path, b.content)).collect(),
            checks: crate::ai_usage::with_conn(|conn| {
                crate::experiences::project_for_path(conn, root)
                    .map(|(project, _)| crate::db::hybrid_queries::trusted_checks(conn, &project))
                    .unwrap_or_default()
            })
            .unwrap_or_default(),
            model: String::new(),
            workspace_id,
            inventory,
            given_memories: 0,
        })
    }

    /// How many approved memories the run's message already carries — `recall` is offered only for
    /// the rest ([`offered`]).
    pub fn with_given_memories(mut self, count: usize) -> Self {
        self.given_memories = count;
        self
    }

    /// Another door for the app tools and the guard — a test's stub.
    #[cfg(test)]
    pub fn with_door(mut self, door: Door) -> Self {
        self.door = door;
        self
    }

    /// Another inventory — a test's, which has no database to take one from.
    #[cfg(test)]
    pub fn with_inventory(mut self, inventory: Inventory) -> Self {
        self.inventory = inventory;
        self
    }

    /// The names of the tools on offer — [`offered`] for this run.
    pub fn offered(&self) -> Vec<&'static str> {
        offered(self.grants, self.map, !self.checks.is_empty(), &self.inventory, self.given_memories)
    }

    /// The model driving the run, for the audit log.
    pub fn with_model(mut self, model: &str) -> Self {
        self.model = model.to_string();
        self
    }

    /// The access level this run has — see `crate::tool_gateway`.
    pub fn level(&self) -> crate::tool_gateway::Level {
        crate::tool_gateway::Level::of(self.grants.write, !self.checks.is_empty(), self.grants.run)
    }

    /// The refusal for a write to a file the editor holds unsaved changes in.
    fn unsaved_refusal(&self, rel: &str) -> Option<Outcome> {
        self.unsaved.contains_key(rel).then(|| {
            Outcome::err(format!(
                "{rel} has unsaved changes in the editor. Don't edit it: describe the change and let the user save first."
            ))
        })
    }

    /// The same toolbox without the repository map: the plain file list before the first step, and
    /// no `find_symbol` / `find_usages` / `outline`.
    pub fn without_map(mut self) -> Self {
        self.map = false;
        self
    }

    /// What the model reads before its first step: every file of the project, each code file with
    /// what it declares — or, past `budget` characters, the folders and the most-used declarations
    /// (`codemap::summary`). Built from the repository map, which this also brings up to date.
    /// Falls back to the plain file list when the map cannot be built.
    pub async fn project_map(&self, budget: usize) -> (String, Option<crate::codemap::BuildInfo>) {
        let files = self.files().unwrap_or_default();
        if !self.map {
            return (format!("Project files:\n{}", self.file_map(MAP_FALLBACK_FILES)), None);
        }
        let root = self.root_str.clone();
        let built = tokio::task::spawn_blocking(move || crate::codemap::snapshot(&root)).await.ok().and_then(Result::ok);
        match built {
            Some((map, info)) if !files.is_empty() => {
                let mut text = crate::codemap::summary::project_map(&map, &files, budget);
                // The map is of code. Documentation is where "why" and "what was decided" live, and a
                // model that cannot see `docs/adr/` never opens it (measured: Qwen3 4B answered "not
                // specified" about a decision written there, without a single tool call).
                let docs: Vec<&str> = files
                    .iter()
                    .map(String::as_str)
                    .filter(|f| matches!(crate::knowledge::chunker::kind_of(f), crate::knowledge::chunker::Kind::Markdown | crate::knowledge::chunker::Kind::Text))
                    .take(40)
                    .collect();
                if !docs.is_empty() {
                    text.push_str(&format!("\n\nDocumentation files:\n{}", docs.join("\n")));
                }
                (text, Some(info))
            }
            _ => (format!("Project files:\n{}", self.file_map(MAP_FALLBACK_FILES)), None),
        }
    }

    pub fn grants(&self) -> Grants {
        self.grants
    }

    /// The project's files, as a list the model reads before its first step — a small model that
    /// can *see* `src/cart.js` opens it, where one that has to discover it searches for prose. Cut
    /// at `max` names, and says so.
    pub fn file_map(&self, max: usize) -> String {
        let files = self.files().unwrap_or_default();
        if files.is_empty() {
            return "(no files)".to_string();
        }
        let mut map = files.iter().take(max).map(String::as_str).collect::<Vec<_>>().join("\n");
        if files.len() > max {
            map.push_str(&format!("\n… and {} more files (use find_files)", files.len() - max));
        }
        map
    }

    /// The tool schemas, OpenAI-shaped, for what this run may do — [`Toolbox::offered`], each named
    /// and described as the MCP server describes it to a CLI agent, shortened where that text talks
    /// about a shell this agent does not have.
    pub fn schemas(&self) -> Vec<Value> {
        self.offered().into_iter().filter_map(|name| self.schema(name)).collect()
    }

    fn schema(&self, name: &str) -> Option<Value> {
        let string = |description: &str| json!({ "type": "string", "description": description });
        let integer = |description: &str| json!({ "type": "integer", "description": description });
        Some(match name {
            "find_symbol" => tool(
                "find_symbol",
                "Find where a function, method, class or type is declared, by name. Returns path:start-end for each. Use it instead of search to locate a definition.",
                json!({ "name": string("The name, e.g. applyDiscount or Cart.total") }),
                &["name"],
            ),
            "find_usages" => tool(
                "find_usages",
                "List the files that use a function or class (and the line), leaving out files that only have a different thing with the same name. Use it before changing a function's parameters, or to see where a value comes from.",
                json!({
                    "name": string("The function or class name."),
                    "path": string("The file that declares it, if the name is declared in several files. Optional.")
                }),
                &["name"],
            ),
            "outline" => tool(
                "outline",
                "List what a file declares with line numbers (so read_file can start at the right line), plus the files it imports and the files that import it.",
                json!({ "path": string("File path relative to the project root.") }),
                &["path"],
            ),
            "search_knowledge" => tool(
                "search_knowledge",
                "Search the project's knowledge for a question: its documentation (READMEs, docs/, architecture decisions), the document folders the user added and their notes, plus the code. Returns passages with path:lines. Use it for questions about why or how the project does something, or what was decided.",
                json!({ "query": string("The question, or the words to look for.") }),
                &["query"],
            ),
            "recall" => tool(
                "recall",
                "The memories the user approved in CodeFlow for this project: decisions, conventions and preferences to respect. The ones that bear on this request are already above; call this with a topic to look up others.",
                json!({ "topic": string("What to recall memories about. Optional.") }),
                &[],
            ),
            "read_note" => tool(
                "read_note",
                "Read one of the user's notes whole, by the id search_knowledge cites it with (note:…), when its passage is not enough.",
                json!({ "note": string("The note's id, e.g. note:4f2a…") }),
                &["note"],
            ),
            "list_files" => tool(
                "list_files",
                "List the files and folders in one folder of the project (one level). Folders end with '/'.",
                json!({ "path": string("Folder relative to the project root; empty for the root.") }),
                &[],
            ),
            "find_files" => tool(
                "find_files",
                "Find files by name or glob anywhere in the project, e.g. '*.ts', 'src/**/*.rs', 'package.json'.",
                json!({ "pattern": string("A file name or glob.") }),
                &["pattern"],
            ),
            "read_file" => tool(
                "read_file",
                "Read a text file, with line numbers. Long files come back in parts: use start_line to read further.",
                json!({
                    "path": string("File path relative to the project root."),
                    "start_line": integer("First line to read, 1-based. Optional."),
                    "end_line": integer("Last line to read. Optional.")
                }),
                &["path"],
            ),
            "search" => tool(
                "search",
                "Search the text of every file in the project. Returns path:line: text for each match.",
                json!({
                    "query": string("Text to look for (or a regular expression when regex is true)."),
                    "regex": { "type": "boolean", "description": "Treat query as a regular expression." },
                    "include": string("Comma-separated globs limiting the files searched, e.g. 'src/**, *.ts'.")
                }),
                &["query"],
            ),
            "edit_file" => tool(
                "edit_file",
                "Replace text in an existing file. old_text must match the file exactly (whitespace included) and be unique unless replace_all is true. Read the file first.",
                json!({
                    "path": string("File path relative to the project root."),
                    "old_text": string("The exact text to replace."),
                    "new_text": string("What to put instead."),
                    "replace_all": { "type": "boolean", "description": "Replace every occurrence." }
                }),
                &["path", "old_text", "new_text"],
            ),
            "write_file" => tool(
                "write_file",
                "Create a file, or replace a whole file, with the given content. Prefer edit_file for small changes to an existing file.",
                json!({
                    "path": string("File path relative to the project root."),
                    "content": string("The complete new content of the file.")
                }),
                &["path", "content"],
            ),
            "run_check" => {
                let list = self.checks.iter().enumerate().map(|(i, c)| format!("{}: {c}", i + 1)).collect::<Vec<_>>().join("; ");
                tool(
                    "run_check",
                    &format!("Run one of this repository's approved checks (tests, build, lint) and get its exit code and the end of its output. Available: {list}."),
                    json!({ "check": string("The check's number or its exact command.") }),
                    &["check"],
                )
            }
            "run_command" => tool(
                "run_command",
                "Run a shell command in the project root (tests, builds, git status…). Returns its exit code and the end of its output. A command that deletes or overwrites something waits for the user's approval. Do not run interactive or never-ending commands.",
                json!({ "command": string("The command line.") }),
                &["command"],
            ),
            "service_logs" => tool(
                "service_logs",
                "The recent output of a service CodeFlow runs for this workspace (a dev server, a worker). Without a name: the workspace's services, their state and ports.",
                json!({ "service": string("The service's name as the Services dock shows it. Optional."), "tail": integer("How many of the last lines (default 100).") }),
                &[],
            ),
            "service_wait" => tool(
                "service_wait",
                "Wait until a service CodeFlow runs is ready, and say so — or that it failed or stopped, with its last lines. Use it after a restart.",
                json!({ "service": string("The service's name."), "timeout_seconds": integer("How long to wait (default 120).") }),
                &["service"],
            ),
            "terminal_output" => tool(
                "terminal_output",
                "The recent output of a terminal in CodeFlow's agents panel — a test watcher, a build, another agent. Without a name: the workspace's terminals.",
                json!({ "terminal": string("The terminal's title, or its number from the list. Optional."), "tail": integer("How many of the last lines (default 100).") }),
                &[],
            ),
            "service_restart" => tool(
                "service_restart",
                "Restart a service CodeFlow runs (its dependents first, as the Services dock does). Follow it with service_wait.",
                json!({ "service": string("The service's name.") }),
                &["service"],
            ),
            "open_in_editor" => tool(
                "open_in_editor",
                "Open a file of this project in CodeFlow's editor, at a line, in front of the user — to show them what you are talking about.",
                json!({ "path": string("Path relative to the project root."), "line": integer("The line to show. Optional.") }),
                &["path"],
            ),
            "notify" => tool(
                "notify",
                "Put one short line in front of the user in CodeFlow, wherever they are in the app.",
                json!({ "text": string("One short line.") }),
                &["text"],
            ),
            "propose_memory" => tool(
                "propose_memory",
                "Propose a memory for this project — a decision, convention or preference worth keeping. It is a candidate: models read it only after the user approves it. Only what will still be true next month; never a secret.",
                json!({
                    "fact": string("The fact, first line as its title."),
                    "kind": { "type": "string", "enum": ["decision", "convention", "fact", "preference"], "description": "Optional: fact." }
                }),
                &["fact"],
            ),
            "add_task" => tool(
                "add_task",
                "Add a draft task to this project's task tree in CodeFlow. Nothing starts it: the user does.",
                json!({
                    "title": string("What the task is, in a line."),
                    "prompt": string("What to do, in full. Optional."),
                    "agent": string("The roster agent's name. Optional.")
                }),
                &["title"],
            ),
            "db_query" => tool(
                "db_query",
                "Run SQL on a database connection the user saved in CodeFlow and get the rows as a table. The app connects with the saved password, which you never see; the user approves every statement first.",
                json!({
                    "connection": string("The saved connection's name."),
                    "sql": string("The statement(s)."),
                    "max_rows": integer("At most this many rows (default 200).")
                }),
                &["connection", "sql"],
            ),
            "http_request" => tool(
                "http_request",
                "Send a request saved in CodeFlow's API client, with its environment and auth, and get the answer with every credential removed. The user approves it first.",
                json!({
                    "request": string("Collection/Folder/Request, or the request's name."),
                    "environment": string("The environment's name. Optional: the active one.")
                }),
                &["request"],
            ),
            "run_with_secret" => tool(
                "run_with_secret",
                "Run a shell command in this project with an entry of the user's CodeFlow keyring in an environment variable named after it (GitHub token → $GITHUB_TOKEN). CodeFlow runs it after the user approves the exact command; the output comes back with the secret removed, and its value never reaches you.",
                json!({
                    "entry": string("The keyring entry's title."),
                    "command": string("The shell command, using the variable."),
                    "field": string("Which field of the entry. Optional."),
                    "env": string("Another variable name. Optional.")
                }),
                &["entry", "command"],
            ),
            _ => return None,
        })
    }

    /// Runs one call. Never panics and never returns `Err`: a failure is an answer the model reads
    /// and can correct, exactly like a CLI agent's tool error.
    pub async fn call(&self, name: &str, args: &Value, cancel: &mut Option<tokio::sync::watch::Receiver<bool>>) -> Outcome {
        let started = std::time::Instant::now();
        let mut outcome = self.dispatch(name, args, cancel).await;
        // Content from the project — or from what the app runs and reaches — that talks to an AI is
        // marked as data before the model reads it.
        if is_outside_text(name) && outcome.ok {
            if let Some(warning) = crate::tool_gateway::injection_warning(&outcome.content) {
                outcome.content = format!("{warning}{}", outcome.content);
            }
        }
        if matches!(name, "edit_file" | "write_file" | "run_command" | "run_check") || ACT_TOOLS.contains(&name) {
            crate::tool_gateway::audit(crate::tool_gateway::Action {
                root: &self.root_str,
                run_ref: crate::ai_runs::current().map(|ctx| ctx.run_id),
                model: (!self.model.is_empty()).then_some(self.model.as_str()),
                tool: name,
                level: self.level(),
                args: args.clone(),
                outcome: if outcome.ok { "ok" } else { "error" },
                exit_code: None,
                duration_ms: started.elapsed().as_millis() as u64,
                detail: &outcome.summary,
            });
        }
        outcome
    }

    async fn dispatch(&self, name: &str, args: &Value, cancel: &mut Option<tokio::sync::watch::Receiver<bool>>) -> Outcome {
        let text = |key: &str| args.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
        // What was never offered does not exist — the same answer for a tool this run may not have
        // as for one nobody has, so a model that invents a call learns nothing it was not shown.
        // The file and command tools keep their own refusals below, which say why.
        let gated = matches!(name, "recall" | "read_note") || OBSERVE_TOOLS.contains(&name) || ACT_TOOLS.contains(&name);
        if gated && !self.offered().contains(&name) {
            return Outcome::err(format!("there is no tool named {name:?}"));
        }
        if let Some(call) = app_verb(name, args) {
            return match call {
                Ok(call) => self.app(name, call, cancel).await,
                Err(error) => Outcome::err(error),
            };
        }
        match name {
            "recall" => match crate::codemap::mcp::call_tool_as(&self.root_str, "recall", args, false).await {
                Ok(text) => Outcome::ok(text, args.get("topic").and_then(Value::as_str).unwrap_or("memories").to_string()),
                Err(error) => Outcome::err(error),
            },
            "read_note" => self.read_note(&text("note")).await,
            "list_files" => self.list_files(&text("path")),
            "find_files" => self.find_files(&text("pattern")),
            "read_file" => self.read_file(&text("path"), line_arg(args, "start_line"), line_arg(args, "end_line")),
            "search" => self.search(&text("query"), args.get("regex").and_then(Value::as_bool).unwrap_or(false), &text("include")),
            "find_symbol" | "find_usages" | "outline" if self.map => self.map_tool(name, args).await,
            "search_knowledge" => self.search_knowledge(&text("query")).await,
            "edit_file" | "write_file" if !self.grants.write => {
                Outcome::err("this conversation is read-only: files cannot be changed here")
            }
            "edit_file" => self.edit_file(
                &text("path"),
                &text("old_text"),
                &text("new_text"),
                args.get("replace_all").and_then(Value::as_bool).unwrap_or(false),
            ),
            "write_file" => self.write_file(&text("path"), &text("content")),
            "run_command" if !self.grants.run => Outcome::err("commands cannot be run in this conversation"),
            "run_command" => match self.guard(text("command").trim(), cancel).await {
                Some(refusal) => refusal,
                None => self.run_command(&text("command"), true, cancel).await,
            },
            "run_check" if !self.grants.write => Outcome::err("checks cannot be run in this conversation"),
            "run_check" => match self.check_named(&text("check")) {
                Some(check) => self.run_command(&check, false, cancel).await,
                None => Outcome::err(format!(
                    "there is no approved check called {:?}. Approved: {}",
                    text("check"),
                    self.checks.iter().enumerate().map(|(i, c)| format!("{}: {c}", i + 1)).collect::<Vec<_>>().join("; ")
                )),
            },
            other => Outcome::err(format!("there is no tool named {other:?}")),
        }
    }

    /// `cf guard`'s rules for `command`, and the user's approval when one matches: `None` to run it,
    /// the refusal the model reads otherwise. Stop ends the wait like any other.
    async fn guard(&self, command: &str, cancel: &mut Option<tokio::sync::watch::Receiver<bool>>) -> Option<Outcome> {
        let reason = crate::shell_rules::dangerous(command)?;
        let asked = (self.door)(AppCall::Guard { command: command.to_string(), reason });
        let answer = tokio::select! {
            answer = asked => answer,
            _ = crate::ai_runs::cancelled(cancel) => return Some(Outcome::err("stopped")),
        };
        match answer {
            Ok(_) => None,
            Err(said) => {
                // The same sentence `cf guard` hands Claude Code, so both agents learn the same thing.
                let said = said.trim();
                let said = if said.is_empty() || said == "no" || said == "no answer" { String::new() } else { format!(" They said: {said}") };
                let mut outcome = Outcome::err(format!("The user did not approve this command ({reason}).{said}"));
                outcome.summary = format!("{command} · not approved");
                Some(outcome)
            }
        }
    }

    /// One app tool, through the door: the verb's answer, or its refusal — the user's words when the
    /// approval was what said no. Never the credential it used: `agentcli`'s vault verbs scrub it.
    async fn app(&self, name: &str, call: AppCall, cancel: &mut Option<tokio::sync::watch::Receiver<bool>>) -> Outcome {
        let asked = (self.door)(call);
        let answer = tokio::select! {
            answer = asked => answer,
            _ = crate::ai_runs::cancelled(cancel) => return Outcome::err("stopped"),
        };
        // The run card's line names the subject from the call's own arguments; this is its outcome.
        let first_line = |text: &str| text.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or_default().chars().take(80).collect::<String>();
        match answer {
            Ok(text) if text.trim().is_empty() => Outcome::ok("Done.".to_string(), "done".to_string()),
            Ok(text) => Outcome::ok(clip_middle(&text, APP_OUTPUT_CHARS), first_line(&text)),
            Err(error) => {
                let mut outcome = Outcome::err(format!("{name}: {error}"));
                outcome.summary = first_line(&error);
                outcome
            }
        }
    }

    /// One note whole (`knowledge::read_note`), as a local engine may see it: a local-only book is
    /// this machine's own, so it is not held back.
    async fn read_note(&self, note: &str) -> Outcome {
        let note = note.trim().to_string();
        if note.is_empty() {
            return Outcome::err("note is empty");
        }
        let workspace = self.workspace_id.clone();
        let id = note.clone();
        let read = tokio::task::spawn_blocking(move || {
            crate::ai_usage::with_conn(|conn| crate::knowledge::read_note(conn, workspace.as_deref(), &id, false))
                .unwrap_or_else(|| Err("Notes are not available here.".to_string()))
        })
        .await
        .unwrap_or_else(|error| Err(error.to_string()));
        match read {
            Ok(text) => Outcome::ok(clip_middle(&text, READ_CHARS), note),
            Err(error) => Outcome::err(error),
        }
    }

    /// The knowledge search, with everything a local model may see (`crate::knowledge`).
    async fn search_knowledge(&self, query: &str) -> Outcome {
        if query.trim().is_empty() {
            return Outcome::err("query is empty");
        }
        match crate::knowledge::tool_answer(&self.root_str, query, 6, false).await {
            Ok(text) => {
                let count = text.lines().filter(|line| line.split_once(". ").is_some_and(|(n, _)| n.parse::<u32>().is_ok())).count();
                Outcome::ok(text, format!("{query} · {count}"))
            }
            Err(error) => Outcome::err(error),
        }
    }

    fn list_files(&self, path: &str) -> Outcome {
        let rel = clean_rel(path);
        let sub = (!rel.is_empty()).then(|| rel.clone());
        match fsops::list_dir(&self.root_str, sub) {
            Err(error) => Outcome::err(error),
            Ok(entries) => {
                let total = entries.len();
                let lines: Vec<String> = entries
                    .iter()
                    .take(LIST_ENTRIES)
                    .map(|entry| if entry.is_dir { format!("{}/", entry.path) } else { entry.path.clone() })
                    .collect();
                let mut content = if lines.is_empty() { "(empty folder)".to_string() } else { lines.join("\n") };
                if total > LIST_ENTRIES {
                    content.push_str(&format!("\n… and {} more entries", total - LIST_ENTRIES));
                }
                let shown = if rel.is_empty() { ".".to_string() } else { rel };
                Outcome::ok(content, format!("{shown} · {total}"))
            }
        }
    }

    fn files(&self) -> Result<Vec<String>, String> {
        if self.git {
            search::list_files(&self.root_str)
        } else {
            Ok(plain_walk(&self.root, PLAIN_WALK_LIMIT))
        }
    }

    fn find_files(&self, pattern: &str) -> Outcome {
        let pattern = pattern.trim().trim_start_matches("./");
        if pattern.is_empty() {
            return Outcome::err("pattern is empty");
        }
        let glob = if pattern.contains('/') { pattern.to_string() } else { format!("**/{pattern}") };
        let matcher = match globset::GlobBuilder::new(&glob).case_insensitive(true).literal_separator(false).build() {
            Ok(glob) => glob.compile_matcher(),
            Err(error) => return Outcome::err(format!("invalid pattern: {error}")),
        };
        // A bare name with no wildcard also matches as a substring — `button` finds `Button.tsx`.
        let loose = (!pattern.contains(['*', '?', '[', '/'])).then(|| pattern.to_lowercase());
        let files = match self.files() {
            Ok(files) => files,
            Err(error) => return Outcome::err(error),
        };
        let hits: Vec<&String> = files
            .iter()
            .filter(|file| {
                matcher.is_match(file.as_str())
                    || loose.as_deref().is_some_and(|needle| {
                        file.rsplit('/').next().is_some_and(|name| name.to_lowercase().contains(needle))
                    })
            })
            .collect();
        let total = hits.len();
        let mut content = hits.iter().take(FIND_RESULTS).map(|s| s.as_str()).collect::<Vec<_>>().join("\n");
        if total == 0 {
            content = "No files match.".to_string();
        } else if total > FIND_RESULTS {
            content.push_str(&format!("\n… and {} more", total - FIND_RESULTS));
        }
        Outcome::ok(content, format!("{pattern} · {total}"))
    }

    fn read_file(&self, path: &str, start: Option<usize>, end: Option<usize>) -> Outcome {
        let rel = clean_rel(path);
        if rel.is_empty() {
            return Outcome::err("path is empty");
        }
        let full = match fsops::resolve_existing_for_write(&self.root_str, &rel) {
            Ok(full) => full,
            Err(error) => return Outcome::err(error),
        };
        if full.is_dir() {
            return Outcome::err(format!("{rel} is a folder — use list_files"));
        }
        // The editor's version when the user has unsaved changes in it: that is the file they mean.
        let bytes = match self.unsaved.get(&rel) {
            Some(text) => text.clone().into_bytes(),
            None => match std::fs::read(&full) {
                Ok(bytes) => bytes,
                Err(error) => return Outcome::err(format!("{rel}: {error}")),
            },
        };
        if search::looks_binary(&bytes) {
            return Outcome::err(format!("{rel} is a binary file"));
        }
        let text = String::from_utf8_lossy(&bytes);
        let lines: Vec<&str> = text.lines().collect();
        let total = lines.len();
        let first = start.unwrap_or(1).max(1);
        if total > 0 && first > total {
            return Outcome::err(format!("{rel} has only {total} lines"));
        }
        let last = end.unwrap_or(first + READ_LINES - 1).min(total).max(first.min(total));
        let mut out = String::new();
        let mut shown_last = first.saturating_sub(1);
        for (index, line) in lines.iter().enumerate().take(last).skip(first - 1) {
            let row = format!("{:>5}\t{line}\n", index + 1);
            if out.len() + row.len() > READ_CHARS && !out.is_empty() {
                break;
            }
            out.push_str(&row);
            shown_last = index + 1;
        }
        if total == 0 {
            out = "(empty file)".to_string();
        } else if shown_last < total {
            out.push_str(&format!("… {} more lines — read_file with start_line {} to continue\n", total - shown_last, shown_last + 1));
        }
        if let Ok(mut read) = self.read.lock() {
            read.insert(rel.clone());
        }
        let range = if total == 0 { "0".to_string() } else { format!("{first}–{shown_last}/{total}") };
        Outcome::ok(out, format!("{rel} · {range}"))
    }

    fn search(&self, query: &str, regex: bool, include: &str) -> Outcome {
        let query = query.trim();
        if query.is_empty() {
            return Outcome::err("query is empty");
        }
        // `a|b` from a model that did not say regex is an alternation it meant, not a literal bar —
        // the first live run searched for "cart total|calculate total" as text and found nothing.
        let regex = regex || (query.contains('|') && regex::Regex::new(query).is_ok());
        let hits = if self.git {
            let options = search::SearchOptions { regex, include: include.to_string(), ..Default::default() };
            match search::search(&self.root_str, query, &options, SEARCH_HITS) {
                Ok(outcome) => (outcome.hits.into_iter().map(|hit| format!("{}:{}: {}", hit.path, hit.line_no, hit.line.trim())).collect::<Vec<_>>(), outcome.truncated),
                Err(error) => return Outcome::err(error),
            }
        } else {
            match plain_search(&self.root, query, regex, SEARCH_HITS) {
                Ok(found) => found,
                Err(error) => return Outcome::err(error),
            }
        };
        let (lines, truncated) = hits;
        let count = lines.len();
        let mut content = if lines.is_empty() { "No matches.".to_string() } else { lines.join("\n") };
        if truncated {
            content.push_str(&format!("\n… more matches not shown; narrow the query or use include"));
        }
        Outcome::ok(content, format!("{query} · {count}{}", if truncated { "+" } else { "" }))
    }

    fn edit_file(&self, path: &str, old: &str, new: &str, all: bool) -> Outcome {
        let rel = clean_rel(path);
        if old.is_empty() {
            return Outcome::err("old_text is empty — use write_file to create a file");
        }
        if let Some(refusal) = self.unsaved_refusal(&rel) {
            return refusal;
        }
        let full = match fsops::resolve_existing_for_write(&self.root_str, &rel) {
            Ok(full) => full,
            Err(error) => return Outcome::err(error),
        };
        let original = match std::fs::read_to_string(&full) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Outcome::err(format!("{rel} does not exist — use write_file to create it"))
            }
            Err(error) => return Outcome::err(format!("{rel}: {error}")),
        };
        // A file written with CRLF reads back with them, while a model writes `\n`: match on the
        // file's own line endings so an exact copy of what `read_file` showed is found.
        let crlf = original.contains("\r\n");
        let (old, new) = if crlf {
            (old.replace("\r\n", "\n").replace('\n', "\r\n"), new.replace("\r\n", "\n").replace('\n', "\r\n"))
        } else {
            (old.to_string(), new.to_string())
        };
        // Not read yet: nothing is changed, and the file is shown as read_file would — so the next
        // call can copy old_text from it instead of failing again. A live 7B sent edit_file to every
        // file of the project at once, unread, and looped on the bare refusal to its last step.
        if !self.was_read(&rel) {
            let shown = self.read_file(&rel, None, None);
            let present = original.contains(old.as_str()) || (has_line_numbers(&old) && original.contains(strip_line_numbers(&old).as_str()));
            let verdict = if present {
                "The text you want to replace is in it: call edit_file again with old_text copied from these lines."
            } else {
                "The text you want to replace does not appear in this file — it probably needs no change."
            };
            let mut outcome = Outcome::err(format!("{rel} had not been read, so nothing was changed."));
            outcome.content = format!("{rel} had not been read yet, so nothing was changed. Here it is:\n{}\n{verdict}", shown.content);
            return outcome;
        }
        // The model copied `read_file`'s output line numbers along with the code (qwen3:8b did, ten
        // times in a row, on a live run): when the text as sent is not there, try it without them.
        let (old, new) = if !original.contains(old.as_str()) && has_line_numbers(&old) {
            (strip_line_numbers(&old), if has_line_numbers(&new) { strip_line_numbers(&new) } else { new })
        } else {
            (old, new)
        };
        let count = original.matches(old.as_str()).count();
        // Not there as written, but there line for line once indentation is ignored — the other way
        // a small model copies code (the line numbers stripped above usually take the indentation with
        // them). Applied only when exactly one block matches, keeping the file's own indentation.
        if count == 0 {
            if let Some(updated) = flexible_replace(&original, &old, &new) {
                return self.finish_edit(&rel, &full, &original, &updated, 1);
            }
        }
        if count == 0 {
            // The lines as they really are, around the one the model meant: a small model that
            // misremembers a line (qwen3:8b turned a `}` into a blank line, eight times running) cannot
            // fix that from "copy the text exactly", and is not allowed a third identical re-read.
            let hint = closest_line(&original, &old)
                .map(|(no, _)| {
                    let lines: Vec<&str> = original.lines().collect();
                    let from = no.saturating_sub(3);
                    let to = (no + 2).min(lines.len());
                    format!(
                        " Lines {}–{to} of the file are exactly:\n{}\nCopy old_text from these lines, without line numbers. One line is enough when it is unique.",
                        from + 1,
                        lines[from..to].join("\n")
                    )
                })
                .unwrap_or_else(|| " Read the file again and copy the text exactly.".to_string());
            let mut outcome = Outcome::err(format!("old_text was not found in {rel}."));
            outcome.content.push_str(&hint);
            return outcome;
        }
        if count > 1 && !all {
            return Outcome::err(format!(
                "old_text appears {count} times in {rel} — include more surrounding lines so it is unique, or set replace_all"
            ));
        }
        let updated = if all { original.replace(old.as_str(), &new) } else { original.replacen(old.as_str(), &new, 1) };
        self.finish_edit(&rel, &full, &original, &updated, count)
    }

    /// The repository map's three tools, answered as `codemap::mcp` answers Claude Code and Codex.
    async fn map_tool(&self, name: &str, args: &Value) -> Outcome {
        let tool = if name == "outline" { "file_outline" } else { name };
        let key = if name == "outline" { "path" } else { "name" };
        let subject = args.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string();
        if subject.is_empty() {
            return Outcome::err(format!("{key} is empty"));
        }
        match crate::codemap::mcp::call_tool(&self.root_str, tool, args).await {
            Ok(content) => {
                let count = if name == "outline" { None } else { Some(content.lines().filter(|l| l.contains(':')).count()) };
                Outcome::ok(content, count.map(|n| format!("{subject} · {n}")).unwrap_or(subject))
            }
            Err(error) => Outcome::err(error),
        }
    }

    fn finish_edit(&self, rel: &str, full: &Path, original: &str, updated: &str, count: usize) -> Outcome {
        if let Err(error) = crate::hybrid::apply::write_atomic(full, updated) {
            return Outcome::err(format!("could not write {rel}: {error}"));
        }
        crate::codemap::touch(&self.root_str, rel);
        let (added, removed) = crate::hybrid::apply::line_stats(original, updated);
        let mut outcome = Outcome::ok(
            format!(
                "Edited {rel}: {count} replacement{} (+{added} −{removed} lines).{}",
                if count == 1 { "" } else { "s" },
                self.dangling_note(rel, original, updated)
            ),
            format!("{rel} · +{added} −{removed}"),
        );
        outcome.changed = Some((added, removed));
        outcome
    }

    fn write_file(&self, path: &str, content: &str) -> Outcome {
        let rel = clean_rel(path);
        if rel.is_empty() {
            return Outcome::err("path is empty");
        }
        if let Some(refusal) = self.unsaved_refusal(&rel) {
            return refusal;
        }
        let existing = fsops::resolve_existing_for_write(&self.root_str, &rel).ok().filter(|full| full.is_file());
        let (full, original) = match existing {
            Some(full) => {
                let original = std::fs::read_to_string(&full).ok();
                (full, original)
            }
            None => match fsops::resolve_path_for_create(&self.root_str, &rel) {
                Ok(full) => (full, None),
                Err(error) => return Outcome::err(error),
            },
        };
        if full.is_dir() {
            return Outcome::err(format!("{rel} is a folder"));
        }
        if original.is_some() && !self.was_read(&rel) {
            return Outcome::err(format!("{rel} already exists: read it with read_file first, then change it with edit_file"));
        }
        let text = crate::hybrid::apply::conform(original.as_deref(), content);
        if let Err(error) = crate::hybrid::apply::write_atomic(&full, &text) {
            return Outcome::err(format!("could not write {rel}: {error}"));
        }
        crate::codemap::touch(&self.root_str, &rel);
        let (added, removed) = crate::hybrid::apply::line_stats(original.as_deref().unwrap_or(""), &text);
        let verb = if original.is_some() { "Rewrote" } else { "Created" };
        let note = original.as_deref().map(|before| self.dangling_note(&rel, before, &text)).unwrap_or_default();
        let mut outcome = Outcome::ok(format!("{verb} {rel} (+{added} −{removed} lines).{note}"), format!("{rel} · +{added} −{removed}"));
        outcome.changed = Some((added, removed));
        outcome
    }

    /// After an edit that renamed or removed a declaration: where the old name is still written,
    /// as a note on the edit's result — what an IDE's rename would have updated, and what a small
    /// model forgets (a live 7B renamed `cartTotal` in its declaration, then answered "done" with the
    /// export and the caller in another file still on the old name).
    fn dangling_note(&self, rel: &str, original: &str, updated: &str) -> String {
        let before = crate::codemap::extract::extract(rel, original);
        let after = crate::codemap::extract::extract(rel, updated);
        let gone: Vec<String> = before
            .symbols
            .iter()
            .map(|s| s.name.clone())
            .filter(|name| crate::codemap::index::specific(name) && !after.symbols.iter().any(|s| &s.name == name))
            .collect();
        let mut out = String::new();
        for name in gone {
            let places = self.occurrences(&name);
            if let Ok(mut renamed) = self.renamed.lock() {
                renamed.insert(name.clone());
            }
            if !places.is_empty() {
                out.push_str(&format!(
                    "\n`{name}` no longer exists here, but it is still used at:\n{}\nUpdate each of those too (read the file first), unless they mean something else.",
                    places.join("\n")
                ));
            }
        }
        out
    }

    /// Where `name` is written as a whole word in the project, as `path:line: text`.
    fn occurrences(&self, name: &str) -> Vec<String> {
        let pattern = format!(r"\b{}\b", regex::escape(name));
        let found = if self.git {
            let options = search::SearchOptions { whole_word: true, case_sensitive: true, ..Default::default() };
            search::search(&self.root_str, name, &options, 20)
                .map(|outcome| outcome.hits.into_iter().map(|hit| format!("{}:{}: {}", hit.path, hit.line_no, hit.line.trim())).collect())
                .unwrap_or_default()
        } else {
            plain_search(&self.root, &pattern, true, 20).map(|(hits, _)| hits).unwrap_or_default()
        };
        found
    }

    /// Declarations this run renamed or removed that are still written somewhere, with where.
    pub fn dangling(&self) -> Vec<(String, Vec<String>)> {
        let names: Vec<String> = self.renamed.lock().map(|set| set.iter().cloned().collect()).unwrap_or_default();
        names
            .into_iter()
            .filter_map(|name| {
                let places = self.occurrences(&name);
                (!places.is_empty()).then_some((name, places))
            })
            .collect()
    }

    fn was_read(&self, rel: &str) -> bool {
        self.read.lock().is_ok_and(|read| read.contains(rel))
    }

    /// A trusted check by its number (1-based) or its exact command.
    fn check_named(&self, wanted: &str) -> Option<String> {
        let wanted = wanted.trim();
        if let Ok(n) = wanted.parse::<usize>() {
            return self.checks.get(n.checked_sub(1)?).cloned();
        }
        self.checks.iter().find(|c| c.trim() == wanted).cloned()
    }

    /// Runs `command` in the project root through `crate::tool_gateway`: no secrets in its
    /// environment, its output read with a ceiling, and — for a free command (`sandbox`) on macOS —
    /// under Seatbelt, writing only inside the repository with no network but localhost.
    async fn run_command(&self, command: &str, sandbox: bool, cancel: &mut Option<tokio::sync::watch::Receiver<bool>>) -> Outcome {
        let command = command.trim();
        if command.is_empty() {
            return Outcome::err("command is empty");
        }
        let mut cmd = crate::tool_gateway::shell_command(command, &self.root, sandbox);
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        crate::ai::apply_command_path(&mut cmd);
        crate::proc::hide_console(&mut cmd);
        crate::proc::own_process_group(&mut cmd);
        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(error) => return Outcome::err(format!("could not start the command: {error}")),
        };
        let run_id = crate::ai_runs::current().map(|ctx| ctx.run_id);
        let _live = child.id().map(|pid| crate::ai_runs::register_process(pid, run_id.as_deref()));
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        // Four times what the model is shown, so the tail it gets is whole lines of the real end.
        let ceiling = COMMAND_OUTPUT_CHARS * 4;
        let out_task = tokio::spawn(async move {
            match stdout {
                Some(pipe) => crate::tool_gateway::read_tail(pipe, ceiling).await,
                None => Vec::new(),
            }
        });
        let err_task = tokio::spawn(async move {
            match stderr {
                Some(pipe) => crate::tool_gateway::read_tail(pipe, ceiling).await,
                None => Vec::new(),
            }
        });
        let status = tokio::select! {
            status = child.wait() => status.ok(),
            _ = crate::ai_runs::cancelled(cancel) => {
                crate::ai_runs::kill_tree(&mut child).await;
                return Outcome::err("stopped");
            }
            _ = tokio::time::sleep(COMMAND_TIMEOUT) => {
                crate::ai_runs::kill_tree(&mut child).await;
                None
            }
        };
        let out = out_task.await.unwrap_or_default();
        let err = err_task.await.unwrap_or_default();
        let mut text = String::from_utf8_lossy(&out).to_string();
        let err = String::from_utf8_lossy(&err);
        if !err.trim().is_empty() {
            if !text.is_empty() && !text.ends_with('\n') {
                text.push('\n');
            }
            text.push_str(&err);
        }
        let text = crate::ai::strip_ansi(&text);
        let tail = tail_chars(&text, COMMAND_OUTPUT_CHARS);
        let shown = if tail.len() < text.len() { format!("… (earlier output cut)\n{tail}") } else { text.clone() };
        match status {
            None => Outcome {
                content: format!("The command did not finish within {} s and was stopped.\n{shown}", COMMAND_TIMEOUT.as_secs()),
                summary: format!("{command} · timeout"),
                ok: false,
                changed: None,
            },
            Some(status) => {
                let code = status.code().map_or("signal".to_string(), |code| code.to_string());
                Outcome {
                    content: format!("Exit code {code}.\n{}", if shown.trim().is_empty() { "(no output)".to_string() } else { shown }),
                    summary: format!("{command} · {code}"),
                    ok: status.success(),
                    changed: None,
                }
            }
        }
    }
}

/// Whether a tool's answer is text from outside the run — the project's files, a command's output,
/// what the app reaches — and so is checked for instructions aimed at a model before it reads it.
fn is_outside_text(name: &str) -> bool {
    matches!(name, "read_file" | "search" | "run_command" | "run_check" | "search_knowledge" | "recall" | "read_note")
        || OBSERVE_TOOLS.contains(&name)
        || matches!(name, "db_query" | "http_request" | "run_with_secret")
}

/// The `cf` verb behind an app tool and its arguments, built exactly as `codemap::mcp::app_tool`
/// builds them for a CLI agent — `None` for a tool that is not one of the app's, `Err` for a call
/// missing what the verb needs. `local_llm` is left out on purpose: this run *is* the local model.
pub(crate) fn app_verb(name: &str, args: &Value) -> Option<Result<AppCall, String>> {
    let text = |key: &str| args.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string();
    let number = |key: &str| match args.get(key) {
        Some(Value::Number(n)) => n.as_u64().map(|n| n.to_string()),
        Some(Value::String(s)) => s.trim().parse::<u64>().ok().map(|n| n.to_string()),
        _ => None,
    };
    let need = |key: &str| {
        let value = text(key);
        if value.is_empty() { Err(format!("{key} is required")) } else { Ok(value) }
    };
    let mut list: Vec<String> = Vec::new();
    let verb = match name {
        "service_logs" => {
            list.extend((!text("service").is_empty()).then(|| text("service")));
            list.extend(number("tail").into_iter().flat_map(|n| ["--tail".to_string(), n]));
            "logs"
        }
        "service_wait" => {
            list.push(match need("service") { Ok(v) => v, Err(e) => return Some(Err(e)) });
            list.extend(number("timeout_seconds").into_iter().flat_map(|n| ["--timeout".to_string(), n]));
            "wait"
        }
        "terminal_output" => {
            list.extend((!text("terminal").is_empty()).then(|| text("terminal")));
            list.extend(number("tail").into_iter().flat_map(|n| ["--tail".to_string(), n]));
            "term"
        }
        "service_restart" => {
            list.push(match need("service") { Ok(v) => v, Err(e) => return Some(Err(e)) });
            "restart"
        }
        "open_in_editor" => {
            let path = match need("path") { Ok(v) => v, Err(e) => return Some(Err(e)) };
            list.push(match number("line") { Some(line) => format!("{path}:{line}"), None => path });
            "open"
        }
        "notify" => {
            list.push(match need("text") { Ok(v) => v, Err(e) => return Some(Err(e)) });
            "notify"
        }
        "propose_memory" => {
            let fact = match need("fact") { Ok(v) => v, Err(e) => return Some(Err(e)) };
            // A fact unless the model said otherwise, in words the verb knows: a proposed
            // preference, once approved, rides every question of every turn.
            let kind = text("kind").to_ascii_lowercase();
            let kind = if matches!(kind.as_str(), "decision" | "convention" | "fact" | "preference") { kind } else { "fact".to_string() };
            list.extend(["--kind".to_string(), kind, fact]);
            "remember"
        }
        "add_task" => {
            list.push(match need("title") { Ok(v) => v, Err(e) => return Some(Err(e)) });
            if !text("agent").is_empty() {
                list.extend(["--agent".to_string(), text("agent")]);
            }
            if !text("prompt").is_empty() {
                list.extend(["--".to_string(), text("prompt")]);
            }
            "task"
        }
        "db_query" => {
            list.push(match need("connection") { Ok(v) => v, Err(e) => return Some(Err(e)) });
            list.extend(number("max_rows").into_iter().flat_map(|n| ["--max-rows".to_string(), n]));
            list.push(match need("sql") { Ok(v) => v, Err(e) => return Some(Err(e)) });
            "db"
        }
        "http_request" => {
            list.push(match need("request") { Ok(v) => v, Err(e) => return Some(Err(e)) });
            if !text("environment").is_empty() {
                list.extend(["--env".to_string(), text("environment")]);
            }
            "http"
        }
        "run_with_secret" => {
            list.push(match need("entry") { Ok(v) => v, Err(e) => return Some(Err(e)) });
            for key in ["field", "env"] {
                if !text(key).is_empty() {
                    list.extend([format!("--{key}"), text(key)]);
                }
            }
            list.push("--".to_string());
            list.push(match need("command") { Ok(v) => v, Err(e) => return Some(Err(e)) });
            "secret"
        }
        _ => return None,
    };
    Some(Ok(AppCall::Verb { verb, args: list, stdin: String::new() }))
}

/// The door of a real run: the app's own `agentcli::run_verb`, as this run's folder and session.
fn app_door(root: String, session: String) -> Door {
    Arc::new(move |call| {
        let (root, session) = (root.clone(), session.clone());
        Box::pin(async move {
            let Some(app) = crate::ai_usage::app() else { return Err("CodeFlow is not ready yet".to_string()) };
            match call {
                // The reason as the modal's question and the command verbatim as what is approved.
                AppCall::Guard { command, reason } => crate::agentcli::guard(app, &command, reason, &root).await,
                AppCall::Verb { verb, args, stdin } => crate::agentcli::run_verb(app, verb, args, stdin, &root, &session).await,
            }
        })
    })
}

/// What the run's place has for the app tools, from the database: `(workspace, inventory, whether
/// the folder is a workspace chat's)`. Reads only what the run's [`Reach`] can use, so a fix or a
/// review pays for none of the lookups.
fn take_inventory(conn: &rusqlite::Connection, root: &str, reach: Reach) -> (Option<String>, Inventory, bool) {
    let project = crate::knowledge::owning_project(conn, root);
    let chat_workspace = if project.is_none() { crate::workspace_chat::workspace_of_dir(conn, root) } else { None };
    let workspace_chat = chat_workspace.is_some();
    let workspace = project.as_ref().map(|p| p.workspace_id.clone()).filter(|ws| !ws.is_empty()).or(chat_workspace);
    let mut inventory = Inventory { project: project.is_some(), ..Default::default() };
    inventory.memories = approved_memories(conn, workspace.as_deref(), project.as_ref().map(|p| p.id.as_str()));
    let Some(ws) = workspace.as_deref() else { return (workspace, inventory, workspace_chat) };
    inventory.notes = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM notes WHERE deleted_at = '' AND (scope = 'global' OR workspace_id = ?1))",
            rusqlite::params![ws],
            |row| row.get::<_, bool>(0),
        )
        .unwrap_or(false);
    if workspace_chat {
        return (workspace, inventory, true);
    }
    if reach >= Reach::Observe {
        inventory.services = crate::db::service_queries::list_services(conn, ws).is_ok_and(|list| !list.is_empty());
        inventory.terminals = crate::db::queries::list_workspace_terminals(conn, ws).is_ok_and(|list| !list.is_empty());
    }
    if reach == Reach::Act {
        inventory.databases = crate::db::datasource_queries::load_tree(conn, ws).is_ok_and(|tree| !tree.connections.is_empty());
        inventory.requests = crate::db::api_queries::load_tree(conn, ws).is_ok_and(|tree| !tree.requests.is_empty());
        inventory.secrets = crate::db::keyvault_queries::load_tree(conn, ws).is_ok_and(|tree| !tree.items.is_empty());
    }
    (workspace, inventory, false)
}

/// How many approved memories apply to this place — `ai_memory::relevant`'s scope rule, counted
/// without marking any of them used. A table this cannot read counts as one, so `recall` stays on
/// offer rather than vanishing over a schema it did not expect.
fn approved_memories(conn: &rusqlite::Connection, workspace: Option<&str>, project: Option<&str>) -> usize {
    conn.query_row(
        "SELECT COUNT(*) FROM ai_memories WHERE status = 'approved'
           AND (scope = 'global'
                OR (scope = 'workspace' AND workspace_id IS ?1)
                OR (scope IN ('project', 'task') AND project_id IS ?2))",
        rusqlite::params![workspace, project],
        |row| row.get::<_, i64>(0),
    )
    .map(|n| n.max(0) as usize)
    .unwrap_or(1)
}

/// `text` cut to `max` characters, the head and the tail kept, saying how much of the middle went.
fn clip_middle(text: &str, max: usize) -> String {
    let total = text.chars().count();
    if total <= max {
        return text.to_string();
    }
    let head: String = text.chars().take(max / 3).collect();
    let tail: String = text.chars().skip(total - (max - max / 3)).collect();
    format!("{head}\n[… {} characters cut from the middle …]\n{tail}", total - max)
}

/// `old` matched against `original` line by line with leading and trailing whitespace ignored; when
/// exactly one run of lines matches, it is replaced by `new`, each new line given the indentation of
/// the original line in its position (the last one's past the end) plus whatever indentation the
/// model's line has beyond its first line's — so a nested line stays nested.
fn flexible_replace(original: &str, old: &str, new: &str) -> Option<String> {
    let wanted: Vec<&str> = old.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
    if wanted.is_empty() {
        return None;
    }
    let newline = if original.contains("\r\n") { "\r\n" } else { "\n" };
    let lines: Vec<&str> = original.lines().collect();
    let matches: Vec<usize> = (0..lines.len().saturating_sub(wanted.len() - 1))
        .filter(|&start| wanted.iter().enumerate().all(|(offset, want)| lines[start + offset].trim() == *want))
        .collect();
    let [start] = matches.as_slice() else { return None };
    let indent_of = |line: &str| line[..line.len() - line.trim_start().len()].to_string();
    let new_lines: Vec<&str> = new.lines().collect();
    let base = new_lines.iter().find(|line| !line.trim().is_empty()).map(|line| indent_of(line).len()).unwrap_or(0);
    let replaced: Vec<String> = new_lines
        .iter()
        .enumerate()
        .map(|(offset, line)| {
            if line.trim().is_empty() {
                return String::new();
            }
            let anchor = lines[(start + offset).min(start + wanted.len() - 1)];
            let extra = indent_of(line).len().saturating_sub(base);
            format!("{}{}{}", indent_of(anchor), " ".repeat(extra), line.trim())
        })
        .collect();
    let mut out: Vec<String> = lines[..*start].iter().map(|line| line.to_string()).collect();
    out.extend(replaced);
    out.extend(lines[start + wanted.len()..].iter().map(|line| line.to_string()));
    let mut text = out.join(newline);
    if original.ends_with('\n') {
        text.push_str(newline);
    }
    Some(text)
}

/// Whether every non-empty line starts with the `   12\t` prefix `read_file` adds.
fn has_line_numbers(text: &str) -> bool {
    let mut lines = text.lines().filter(|line| !line.trim().is_empty()).peekable();
    lines.peek().is_some() && lines.all(|line| line_number_prefix(line).is_some())
}

/// The length of a line's `read_file` prefix: spaces, digits, then a tab — or what models write in its
/// place: `→`, `|`, or `:` and a space (qwen3:8b sent `    5: total -= item.price;` eight times).
fn line_number_prefix(line: &str) -> Option<usize> {
    let digits_start = line.len() - line.trim_start_matches(' ').len();
    let rest = &line[digits_start..];
    let digits = rest.len() - rest.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    if digits == 0 {
        return None;
    }
    let after = &rest[digits..];
    let sep = ['\t', '→', '|', ':'].into_iter().find(|sep| after.starts_with(*sep))?;
    let mut cut = digits_start + digits + sep.len_utf8();
    if sep != '\t' && line[cut..].starts_with(' ') {
        cut += 1;
    }
    Some(cut)
}

fn strip_line_numbers(text: &str) -> String {
    text.split('\n')
        .map(|line| match line_number_prefix(line) {
            Some(cut) => &line[cut..],
            None => line,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": { "type": "object", "properties": properties, "required": required },
        }
    })
}

/// A 1-based line argument, whether the model sent a number or a numeric string.
fn line_arg(args: &Value, key: &str) -> Option<usize> {
    match args.get(key)? {
        Value::Number(n) => n.as_u64().map(|n| n as usize),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
    .filter(|&n| n > 0)
}

/// A path as models write it — `./src/a.ts`, `/src/a.ts`, `src\a.ts` — as the repository-relative,
/// `/`-separated form the guards take. A leading `/` is read as "from the project root", which is
/// what a model means by it; the guards still refuse `..` and anything absolute that remains.
fn clean_rel(path: &str) -> String {
    let path = path.trim().replace('\\', "/");
    let path = path.trim_start_matches("./").trim_start_matches('/');
    let path = path.trim_end_matches('/');
    if path == "." {
        String::new()
    } else {
        path.to_string()
    }
}

/// The line of `text` most like the first line of `wanted`, for an edit that did not match — the
/// usual cause is indentation or a line the model remembered wrong, and naming the real line fixes
/// both on the next try.
fn closest_line(text: &str, wanted: &str) -> Option<(usize, String)> {
    let first = wanted.lines().map(str::trim).find(|line| !line.is_empty())?;
    if first.len() < 3 {
        return None;
    }
    text.lines()
        .enumerate()
        .filter(|(_, line)| line.trim() == first || line.contains(first) || first.contains(line.trim()) && line.trim().len() > 8)
        .map(|(index, line)| (index + 1, line.trim().chars().take(160).collect::<String>()))
        .next()
}

fn tail_chars(text: &str, max: usize) -> &str {
    if text.len() <= max {
        return text;
    }
    let mut start = text.len() - max;
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

/// Every file under a folder that is not a git working copy, relative and `/`-separated, skipping
/// hidden and dependency folders.
pub(crate) fn plain_walk(root: &Path, limit: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                if !name.starts_with('.') && !SKIPPED_DIRS.contains(&name.as_str()) {
                    stack.push(entry.path());
                }
            } else if kind.is_file() {
                if let Ok(rel) = entry.path().strip_prefix(root) {
                    out.push(rel.to_string_lossy().replace('\\', "/"));
                }
                if out.len() >= limit {
                    out.sort();
                    return out;
                }
            }
        }
    }
    out.sort();
    out
}

fn plain_search(root: &Path, query: &str, regex: bool, max: usize) -> Result<(Vec<String>, bool), String> {
    let body = if regex { query.to_string() } else { regex::escape(query) };
    let matcher = regex::Regex::new(&format!("(?i){body}")).map_err(|e| format!("invalid regular expression: {e}"))?;
    let mut hits = Vec::new();
    for rel in plain_walk(root, PLAIN_WALK_LIMIT) {
        let path = root.join(&rel);
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        if meta.len() > 1024 * 1024 {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else { continue };
        if search::looks_binary(&bytes) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        for (index, line) in text.lines().enumerate() {
            if matcher.is_match(line) {
                if hits.len() >= max {
                    return Ok((hits, true));
                }
                hits.push(format!("{rel}:{}: {}", index + 1, line.trim().chars().take(300).collect::<String>()));
            }
        }
    }
    Ok((hits, false))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A folder under the system temp dir, removed when dropped.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("codeflow-local-agent-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).expect("temp dir");
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn temp_repo() -> TempDir {
        let dir = TempDir::new();
        git2::Repository::init(dir.path()).expect("git init");
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/app.ts"), "export function total(items) {\n  return 0;\n}\n").unwrap();
        std::fs::write(dir.path().join("README.md"), "# Demo\n").unwrap();
        dir
    }

    fn toolbox(dir: &TempDir, grants: Grants) -> Toolbox {
        Toolbox::new(dir.path().to_str().unwrap(), grants).expect("toolbox")
    }

    const READ: Grants = Grants { write: false, run: false, reach: Reach::Project };
    const WRITE: Grants = Grants { write: true, run: false, reach: Reach::Project };

    /// Everything a workspace can have for the app tools.
    const FULL: Inventory =
        Inventory { project: true, services: true, terminals: true, databases: true, requests: true, secrets: true, notes: true, memories: 3 };

    /// A door that answers `reply` to everything and keeps what it was asked.
    fn stub_door(reply: Result<String, String>) -> (Door, Arc<std::sync::Mutex<Vec<AppCall>>>) {
        let calls: Arc<std::sync::Mutex<Vec<AppCall>>> = Default::default();
        let seen = calls.clone();
        let door: Door = Arc::new(move |call| {
            seen.lock().unwrap().push(call);
            let reply = reply.clone();
            Box::pin(async move { reply })
        });
        (door, calls)
    }

    fn names(tools: &Toolbox) -> Vec<String> {
        tools.schemas().iter().map(|t| t["function"]["name"].as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn a_run_judging_someone_elses_material_gets_the_project_and_nothing_of_the_app() {
        let offered = offered(READ, true, false, &FULL, 0);
        assert_eq!(
            offered,
            vec!["find_symbol", "find_usages", "outline", "search_knowledge", "recall", "list_files", "find_files", "read_file", "search"]
        );
    }

    #[test]
    fn a_read_only_conversation_looks_at_the_app_but_never_acts() {
        let observe = Grants { write: false, run: false, reach: Reach::Observe };
        let offered = offered(observe, true, false, &FULL, 0);
        for name in ["service_logs", "service_wait", "terminal_output", "read_note", "recall"] {
            assert!(offered.contains(&name), "{name}: {offered:?}");
        }
        for name in ACT_TOOLS.iter().chain(["edit_file", "write_file", "run_command"].iter()) {
            assert!(!offered.contains(name), "{name} in a read-only run: {offered:?}");
        }
    }

    #[test]
    fn an_acting_conversation_gets_only_the_tools_with_something_to_act_on() {
        let act = Grants { write: true, run: true, reach: Reach::Act };
        let all = offered(act, true, true, &FULL, 0);
        for name in ACT_TOOLS.iter().chain(OBSERVE_TOOLS).chain(["run_check", "run_command", "edit_file"].iter()) {
            assert!(all.contains(name), "{name}: {all:?}");
        }
        // A workspace with nothing saved: no db_query, http_request, run_with_secret, no services.
        let bare = offered(act, false, false, &Inventory::default(), 0);
        for name in ["db_query", "http_request", "run_with_secret", "service_logs", "service_restart", "terminal_output", "add_task", "recall", "read_note", "run_check", "find_symbol"] {
            assert!(!bare.contains(&name), "{name} with nothing to reach: {bare:?}");
        }
        for name in ["open_in_editor", "notify", "propose_memory"] {
            assert!(bare.contains(&name), "{name}: {bare:?}");
        }
    }

    #[test]
    fn recall_is_offered_only_for_memories_the_message_does_not_already_carry() {
        let inventory = Inventory { memories: 2, ..Default::default() };
        assert!(offered(READ, false, false, &inventory, 1).contains(&"recall"));
        assert!(!offered(READ, false, false, &inventory, 2).contains(&"recall"), "both are already in the message");
    }

    #[tokio::test]
    async fn a_tool_that_was_not_offered_does_not_exist() {
        let dir = temp_repo();
        let (door, calls) = stub_door(Ok("rows".into()));
        let tools = toolbox(&dir, Grants { write: false, run: false, reach: Reach::Observe }).with_inventory(FULL).with_door(door);
        let out = tools.call("db_query", &json!({ "connection": "prod", "sql": "select 1" }), &mut None).await;
        assert!(!out.ok && out.content.contains("no tool named"), "{}", out.content);
        assert!(calls.lock().unwrap().is_empty(), "nothing reached the app");
    }

    #[tokio::test]
    async fn the_app_tools_reach_the_app_as_cf_does_and_say_what_the_user_said() {
        let dir = temp_repo();
        let (door, calls) = stub_door(Ok("| id |\n| 1 |".into()));
        let tools = toolbox(&dir, Grants { write: false, run: false, reach: Reach::Act }).with_inventory(FULL).with_door(door);
        assert!(names(&tools).contains(&"db_query".to_string()));
        let out = tools.call("db_query", &json!({ "connection": "local pg", "sql": "select 1", "max_rows": 5 }), &mut None).await;
        assert!(out.ok, "{}", out.content);
        assert!(out.content.contains("| 1 |"));
        let out = tools.call("propose_memory", &json!({ "fact": "Amounts are stored in cents" }), &mut None).await;
        assert!(out.ok);
        let calls = calls.lock().unwrap().clone();
        assert_eq!(
            calls[0],
            AppCall::Verb { verb: "db", args: vec!["local pg".into(), "--max-rows".into(), "5".into(), "select 1".into()], stdin: String::new() }
        );
        assert_eq!(
            calls[1],
            AppCall::Verb { verb: "remember", args: vec!["--kind".into(), "fact".into(), "Amounts are stored in cents".into()], stdin: String::new() },
            "a fact unless the model says which kind"
        );

        let (door, _) = stub_door(Err("not against production".into()));
        let tools = toolbox(&dir, Grants { write: false, run: false, reach: Reach::Act }).with_inventory(FULL).with_door(door);
        let out = tools.call("http_request", &json!({ "request": "Orders/Create" }), &mut None).await;
        assert!(!out.ok && out.content.contains("not against production"), "{}", out.content);
    }

    #[test]
    fn app_tool_arguments_are_built_like_the_mcp_servers() {
        let call = app_verb("run_with_secret", &json!({ "entry": "GitHub token", "command": "gh api user", "env": "GH_TOKEN" })).unwrap().unwrap();
        assert_eq!(
            call,
            AppCall::Verb { verb: "secret", args: vec!["GitHub token".into(), "--env".into(), "GH_TOKEN".into(), "--".into(), "gh api user".into()], stdin: String::new() }
        );
        assert!(app_verb("service_wait", &json!({})).unwrap().is_err(), "a service is required");
        assert_eq!(
            app_verb("open_in_editor", &json!({ "path": "src/a.ts", "line": "12" })).unwrap().unwrap(),
            AppCall::Verb { verb: "open", args: vec!["src/a.ts:12".into()], stdin: String::new() }
        );
        assert!(app_verb("read_file", &json!({})).is_none(), "not an app tool");
        assert!(app_verb("local_llm", &json!({ "instruction": "x" })).is_none(), "this run is the local model");
    }

    #[tokio::test]
    async fn a_destructive_command_waits_for_the_user_and_a_no_keeps_it_from_running() {
        let dir = temp_repo();
        std::fs::create_dir_all(dir.path().join("build/out")).unwrap();
        let run = Grants { write: true, run: true, reach: Reach::Project };
        let (door, calls) = stub_door(Err("keep the build, I need it".into()));
        let tools = toolbox(&dir, run).with_door(door);
        let out = tools.call("run_command", &json!({ "command": "rm -rf build" }), &mut None).await;
        assert!(!out.ok);
        assert!(out.content.contains("did not approve") && out.content.contains("keep the build, I need it"), "{}", out.content);
        assert!(dir.path().join("build/out").is_dir(), "refused, so nothing was deleted");
        assert!(matches!(calls.lock().unwrap().as_slice(), [AppCall::Guard { command, .. }] if command == "rm -rf build"));

        let (door, _) = stub_door(Ok(String::new()));
        let tools = toolbox(&dir, run).with_door(door);
        let out = tools.call("run_command", &json!({ "command": "rm -rf build" }), &mut None).await;
        assert!(out.ok, "approved: {}", out.content);
        assert!(!dir.path().join("build").exists());

        let (door, calls) = stub_door(Err("never asked".into()));
        let tools = toolbox(&dir, run).with_door(door);
        let out = tools.call("run_command", &json!({ "command": "echo hi" }), &mut None).await;
        assert!(out.ok && out.content.contains("hi"));
        assert!(calls.lock().unwrap().is_empty(), "an ordinary command asks nobody");
    }

    #[tokio::test]
    async fn a_skill_the_run_was_told_about_can_be_opened() {
        let dir = temp_repo();
        std::fs::create_dir_all(dir.path().join(".claude/skills/release")).unwrap();
        std::fs::write(dir.path().join(".claude/skills/release/SKILL.md"), "---\nname: release\n---\nBump the version first.\n").unwrap();
        let tools = toolbox(&dir, READ);
        let out = tools.call("read_file", &json!({ "path": ".claude/skills/release/SKILL.md" }), &mut None).await;
        assert!(out.ok && out.content.contains("Bump the version first."), "{}", out.content);
    }

    #[tokio::test]
    async fn read_only_offers_and_runs_no_write_tool() {
        let dir = temp_repo();
        let tools = toolbox(&dir, READ);
        let names: Vec<String> =
            tools.schemas().iter().map(|t| t["function"]["name"].as_str().unwrap().to_string()).collect();
        assert!(!names.iter().any(|n| n == "edit_file" || n == "write_file" || n == "run_command"));
        let outcome = tools.call("write_file", &json!({ "path": "x.txt", "content": "hi" }), &mut None).await;
        assert!(!outcome.ok);
        assert!(!dir.path().join("x.txt").exists(), "a read-only run must not write");
    }

    #[tokio::test]
    async fn paths_cannot_leave_the_root() {
        let dir = temp_repo();
        let tools = toolbox(&dir, WRITE);
        for path in ["../escaped.txt", "src/../../escaped.txt"] {
            let outcome = tools.call("write_file", &json!({ "path": path, "content": "x" }), &mut None).await;
            assert!(!outcome.ok, "{path} must be refused");
        }
        assert!(!dir.path().parent().unwrap().join("escaped.txt").exists());
        let outcome = tools.call("read_file", &json!({ "path": "../../etc/passwd" }), &mut None).await;
        assert!(!outcome.ok);
    }

    #[tokio::test]
    async fn unsaved_buffers_are_read_and_never_edited() {
        let dir = std::env::temp_dir().join(format!("codeflow-unsaved-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), "on disk\n").unwrap();
        let buffers = vec![crate::context::UnsavedBuffer { path: "a.txt".into(), content: "in the editor\n".into() }];
        let root = dir.to_string_lossy().to_string();
        crate::context::with_unsaved(buffers, async {
            let toolbox = Toolbox::new(&root, Grants { write: true, run: false, reach: Reach::Project }).unwrap();
            let read = toolbox.read_file("a.txt", None, None);
            assert!(read.content.contains("in the editor"), "{}", read.content);
            let edit = toolbox.edit_file("a.txt", "in the editor", "changed", false);
            assert!(!edit.ok && edit.content.contains("unsaved"), "{}", edit.content);
            let write = toolbox.write_file("a.txt", "replaced");
            assert!(!write.ok);
        })
        .await;
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "on disk\n");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn read_file_numbers_lines_and_reads_ranges() {
        let dir = temp_repo();
        let tools = toolbox(&dir, READ);
        let outcome = tools.call("read_file", &json!({ "path": "./src/app.ts" }), &mut None).await;
        assert!(outcome.ok);
        assert!(outcome.content.contains("    2\t  return 0;"), "{}", outcome.content);
        let outcome = tools.call("read_file", &json!({ "path": "src/app.ts", "start_line": "2", "end_line": 2 }), &mut None).await;
        assert!(outcome.content.trim_start().starts_with("2\t  return 0;\n"), "{}", outcome.content);
        assert!(!outcome.content.contains("export function"), "line 1 is outside the range");
    }

    #[tokio::test]
    async fn edit_file_needs_an_exact_unique_match() {
        let dir = temp_repo();
        let tools = toolbox(&dir, WRITE);
        let unread = tools
            .call("edit_file", &json!({ "path": "src/app.ts", "old_text": "  return 0;", "new_text": "x" }), &mut None)
            .await;
        assert!(!unread.ok, "an edit to a file never read this run is refused");
        tools.call("read_file", &json!({ "path": "src/app.ts" }), &mut None).await;
        let missing = tools
            .call("edit_file", &json!({ "path": "src/app.ts", "old_text": "return 1;", "new_text": "x" }), &mut None)
            .await;
        assert!(!missing.ok);
        let edited = tools
            .call(
                "edit_file",
                &json!({ "path": "src/app.ts", "old_text": "  return 0;", "new_text": "  return items.length;" }),
                &mut None,
            )
            .await;
        assert!(edited.ok, "{}", edited.content);
        assert_eq!(edited.changed, Some((1, 1)));
        let text = std::fs::read_to_string(dir.path().join("src/app.ts")).unwrap();
        assert!(text.contains("return items.length;"));
    }

    #[tokio::test]
    async fn write_file_creates_folders_inside_the_root() {
        let dir = temp_repo();
        let tools = toolbox(&dir, WRITE);
        let outcome = tools
            .call("write_file", &json!({ "path": "src/lib/new.ts", "content": "export const a = 1;" }), &mut None)
            .await;
        assert!(outcome.ok, "{}", outcome.content);
        assert_eq!(std::fs::read_to_string(dir.path().join("src/lib/new.ts")).unwrap(), "export const a = 1;\n");
        let blind = tools.call("write_file", &json!({ "path": "README.md", "content": "gone" }), &mut None).await;
        assert!(!blind.ok, "an existing file is not rewritten unread");
        assert_eq!(std::fs::read_to_string(dir.path().join("README.md")).unwrap(), "# Demo\n");
    }

    #[tokio::test]
    async fn find_and_search_cover_git_and_plain_folders() {
        let dir = temp_repo();
        let tools = toolbox(&dir, READ);
        let found = tools.call("find_files", &json!({ "pattern": "app" }), &mut None).await;
        assert!(found.content.contains("src/app.ts"), "{}", found.content);
        let hits = tools.call("search", &json!({ "query": "return 0" }), &mut None).await;
        assert!(hits.content.contains("src/app.ts:2:"), "{}", hits.content);

        let plain = TempDir::new();
        std::fs::write(plain.path().join("notes.txt"), "alpha\nbeta\n").unwrap();
        let tools = Toolbox::new(plain.path().to_str().unwrap(), READ).unwrap();
        let hits = tools.call("search", &json!({ "query": "BETA" }), &mut None).await;
        assert!(hits.content.contains("notes.txt:2:"), "{}", hits.content);
    }

    #[tokio::test]
    async fn an_edit_copied_with_line_numbers_still_applies() {
        let dir = temp_repo();
        let tools = toolbox(&dir, WRITE);
        tools.call("read_file", &json!({ "path": "src/app.ts" }), &mut None).await;
        let edited = tools
            .call(
                "edit_file",
                &json!({ "path": "src/app.ts", "old_text": "    2\t  return 0;", "new_text": "    2\t  return 1;" }),
                &mut None,
            )
            .await;
        assert!(edited.ok, "{}", edited.content);
        assert!(std::fs::read_to_string(dir.path().join("src/app.ts")).unwrap().contains("  return 1;\n"));
        // The colon form, indentation lost with it — still a unique substring of the file.
        let colon = tools
            .call(
                "edit_file",
                &json!({ "path": "src/app.ts", "old_text": "    2: return 1;", "new_text": "    2: return 2;" }),
                &mut None,
            )
            .await;
        assert!(colon.ok, "{}", colon.content);
        assert!(std::fs::read_to_string(dir.path().join("src/app.ts")).unwrap().contains("  return 2;\n"));
    }

    #[tokio::test]
    async fn an_unread_edit_changes_nothing_but_shows_the_file() {
        let dir = temp_repo();
        let tools = toolbox(&dir, WRITE);
        let args = json!({ "path": "src/app.ts", "old_text": "return 0;", "new_text": "return 1;" });
        let first = tools.call("edit_file", &args, &mut None).await;
        assert!(!first.ok);
        assert!(first.content.contains("export function total(items)"), "the file is shown: {}", first.content);
        assert!(first.content.contains("is in it"));
        assert!(std::fs::read_to_string(dir.path().join("src/app.ts")).unwrap().contains("return 0;"), "nothing changed");
        let second = tools.call("edit_file", &args, &mut None).await;
        assert!(second.ok, "now it has been read: {}", second.content);
        let elsewhere = tools.call("edit_file", &json!({ "path": "README.md", "old_text": "cartTotal()", "new_text": "x" }), &mut None).await;
        assert!(elsewhere.content.contains("does not appear"), "{}", elsewhere.content);
    }

    #[tokio::test]
    async fn a_rename_names_the_places_still_on_the_old_name() {
        let dir = temp_repo();
        std::fs::write(dir.path().join("src/use.ts"), "import { total } from './app';\nexport const t = total([]);\n").unwrap();
        std::fs::write(dir.path().join("src/app.ts"), "export function totalize(items) {\n  return 0;\n}\n").unwrap();
        let tools = toolbox(&dir, WRITE);
        tools.call("read_file", &json!({ "path": "src/app.ts" }), &mut None).await;
        let out = tools
            .call("edit_file", &json!({ "path": "src/app.ts", "old_text": "function totalize(", "new_text": "function computeTotal(" }), &mut None)
            .await;
        assert!(out.ok);
        assert!(!out.content.contains("still used"), "nothing else wrote totalize: {}", out.content);

        std::fs::write(dir.path().join("src/app.ts"), "export function total(items) {\n  return 0;\n}\n").unwrap();
        tools.call("read_file", &json!({ "path": "src/app.ts" }), &mut None).await;
        let out = tools
            .call("edit_file", &json!({ "path": "src/app.ts", "old_text": "function total(", "new_text": "function sumAll(" }), &mut None)
            .await;
        assert!(out.content.contains("`total` no longer exists here"), "{}", out.content);
        assert!(out.content.contains("src/use.ts:1"), "{}", out.content);
        assert_eq!(tools.dangling().len(), 1);
        std::fs::write(dir.path().join("src/use.ts"), "import { sumAll } from './app';\nexport const t = sumAll([]);\n").unwrap();
        assert!(tools.dangling().is_empty(), "fixed everywhere");
    }

    #[test]
    fn flexible_replace_keeps_the_files_indentation() {
        let file = "function f(items) {\n  for (const item of items) {\n    total -= item.price;\n  }\n}\n";
        let updated = flexible_replace(file, "total -= item.price;\n}", "total += item.price;\n}").unwrap();
        assert_eq!(updated, "function f(items) {\n  for (const item of items) {\n    total += item.price;\n  }\n}\n");
        // Ambiguous: two identical lines, so nothing is guessed.
        assert!(flexible_replace("a();\na();\n", "a();", "b();").is_none());
    }

    #[test]
    fn model_paths_are_cleaned() {
        assert_eq!(clean_rel("./src/a.ts"), "src/a.ts");
        assert_eq!(clean_rel("/src/a.ts"), "src/a.ts");
        assert_eq!(clean_rel("src\\a.ts"), "src/a.ts");
        assert_eq!(clean_rel("."), "");
        assert_eq!(clean_rel("src/"), "src");
    }
}
