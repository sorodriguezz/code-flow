//! Several accounts per AI CLI, and which one a run uses.
//!
//! # What an account is
//!
//! **A directory the official CLI manages, and the one environment variable that points it
//! there.** Nothing else. This app never holds a token, never copies a credential file and never
//! swaps one in: each CLI signs in by itself (its own login command, in a terminal the user
//! watches), keeps its own credentials inside that directory — or in a keychain item it derives
//! from it — and refreshes them there. Anthropic's terms for Claude Code say third-party apps must
//! not collect or store claude.ai tokens and must leave sign-in to Anthropic's own flow; building
//! it this way is what keeps that true for every provider, not just the one that wrote it down.
//!
//! | CLI      | Variable           | Isolates                                                       |
//! |----------|--------------------|----------------------------------------------------------------|
//! | claude   | `CLAUDE_CONFIG_DIR` | credentials (keychain item suffixed per dir), settings, MCP, transcripts |
//! | codex    | `CODEX_HOME`        | `auth.json` / keyring entry, config, sessions                   |
//! | grok     | `GROK_AUTH_PATH`    | the login only — config and sessions stay shared                |
//! | opencode | `XDG_DATA_HOME`     | `auth.json`, the session database, logs — config stays shared   |
//!
//! Gemini's `agy` has no such variable (its keychain item has a fixed name) and Cline keeps its
//! state at a hardcoded path, so both run as the system account only. See [`supports_accounts`].
//!
//! # The system account
//!
//! The CLI's default location — `~/.claude`, `~/.codex`, … — is always an account, the one the
//! user's own terminal uses. It has no row and no id: `account_id = None` everywhere means it.
//! Every install that has never added an account keeps running exactly as it did.
//!
//! # Which account a run uses
//!
//! Most specific first, in [`resolve`]: an explicit choice (a conversation, an agent), then the
//! task's own pin (`ai_account_{task}`), then the workspace's default for that provider, then the
//! provider's default (`ai_account_default_{provider}`), then the system account. A pin naming an
//! account that no longer exists, or one of another provider, is skipped rather than obeyed.
//!
//! # Sessions belong to accounts
//!
//! A CLI keeps its resumable sessions inside its state directory, so a session one account opened
//! cannot be resumed by another. Every place that stores a resume token stores the account beside
//! it, and the rule that drops a token when the provider changes also drops it when the account
//! does — see `chat_queries::set_engine` and `claude_cmd::session_for_engine`.

use std::cell::RefCell;
use std::path::PathBuf;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use uuid::Uuid;

use crate::db::queries;

/// The stored spelling of "the system account", where a preference has to be able to say it
/// explicitly — a workspace that wants the CLI's own login even though the provider's default is
/// another account. An *absent* preference means "automatic", which is different.
pub const SYSTEM: &str = "system";

/// Whether this provider's CLI can hold several accounts side by side. See the module table.
pub fn supports_accounts(provider: &str) -> bool {
    matches!(provider, "claude" | "codex" | "grok" | "opencode")
}

/// One account the user added. The system account is not one of these — see the module note.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAccount {
    pub id: String,
    pub provider: String,
    /// What the user called it — "Personal", "Trabajo". Never derived from the email: the email is
    /// the CLI's to report and may not be known until the first sign-in.
    pub label: String,
    pub created_at: String,
}

/// Where an account's CLI keeps its state.
///
/// Derived, never stored, and it must never change for an existing account: Claude Code names its
/// keychain item after a hash of this exact string, so a different spelling of the same folder — a
/// trailing slash, a moved state root — is a different item, and the account reads as signed out.
pub fn account_dir(provider: &str, id: &str) -> PathBuf {
    crate::paths::state_dir().join("ai-accounts").join(provider).join(id)
}

// ---------------------------------------------------------------------------------------------
// The environment a run is started with
// ---------------------------------------------------------------------------------------------

/// What makes a process run as one account: the variables to set, and the ones to take away.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AccountEnv {
    pub provider: String,
    /// `None` is the system account, which needs no environment at all.
    pub account_id: Option<String>,
    pub set: Vec<(String, String)>,
    pub remove: Vec<String>,
}

impl AccountEnv {
    /// The CLI's own default location — inherit everything, change nothing.
    pub fn system(provider: &str) -> Self {
        Self { provider: provider.to_string(), ..Self::default() }
    }

    /// The environment for an added account of `provider`.
    ///
    /// For Claude the credential variables are *removed* as well as the directory set: in `-p`
    /// mode an inherited `ANTHROPIC_API_KEY` wins over the account's own login, so a key exported
    /// for something else would quietly bill every run of every account to it.
    pub fn for_account(provider: &str, id: &str) -> Self {
        let dir = account_dir(provider, id);
        let dir_text = dir.to_string_lossy().into_owned();
        let (set, remove): (Vec<(&str, String)>, Vec<&str>) = match provider {
            "claude" => (
                vec![("CLAUDE_CONFIG_DIR", dir_text)],
                vec!["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"],
            ),
            // `CODEX_API_KEY` takes precedence over the stored login for `exec`, so it goes too.
            "codex" => (vec![("CODEX_HOME", dir_text)], vec!["CODEX_API_KEY"]),
            // The login file only: config, sessions, MCP servers and the auto-updater stay the
            // user's one install, which is the point of choosing this variable over `GROK_HOME`.
            // Leader mode (`--leader`, `[cli] use_leader = true`; off by default) is the one thing
            // this cannot separate: every client then shares one process and its sign-in.
            "grok" => (
                vec![("GROK_AUTH_PATH", dir.join("auth.json").to_string_lossy().into_owned())],
                vec!["GROK_AUTH"],
            ),
            "opencode" => (vec![("XDG_DATA_HOME", dir_text)], vec![]),
            _ => (vec![], vec![]),
        };
        Self {
            provider: provider.to_string(),
            account_id: Some(id.to_string()),
            set: set.into_iter().map(|(k, v)| (k.to_string(), v)).collect(),
            remove: remove.into_iter().map(str::to_string).collect(),
        }
    }

    pub fn is_system(&self) -> bool {
        self.account_id.is_none()
    }

    /// A stable key for caches and meters: `claude` for the system account, `claude|<id>` for an
    /// added one.
    pub fn key(&self) -> String {
        match &self.account_id {
            Some(id) => format!("{}|{id}", self.provider),
            None => self.provider.clone(),
        }
    }

    /// The value this environment gives a variable, if it sets one.
    pub fn var(&self, name: &str) -> Option<&str> {
        self.set.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }

    /// Recreates the account's folder when it is missing — the case after a backup is restored on
    /// another machine, which brings the row and not the folder. Codex refuses to start on a
    /// `CODEX_HOME` that does not exist; the others would sign in somewhere the app does not look.
    /// A stat when the folder is there, which is every other time.
    pub fn ensure_dirs(&self) {
        let Some(id) = self.account_id.as_deref() else { return };
        let dir = account_dir(&self.provider, id);
        if dir.is_dir() {
            return;
        }
        // A fresh folder is a fresh account: prepared the way a new one is, minus the copy — the
        // user's configuration may have moved on since, and a restore is not the moment to guess.
        let _ = prepare_dir(&self.provider, id, false);
    }

    pub fn apply(&self, cmd: &mut tokio::process::Command) {
        self.ensure_dirs();
        for name in &self.remove {
            cmd.env_remove(name);
        }
        for (name, value) in &self.set {
            cmd.env(name, value);
        }
    }
}

thread_local! {
    /// The account the engine call on this thread is running as — see [`with_account`].
    static CURRENT: RefCell<Option<AccountEnv>> = const { RefCell::new(None) };
}

/// Runs `f` with `account` as the current account on this thread.
///
/// For the few engine methods that read the CLI's state directory *in this process* rather than by
/// starting it — Codex's model catalogue, Claude's per-run report — and so cannot see a child's
/// environment. [`crate::ai::AccountEngine`] wraps every call it forwards in this. Synchronous on
/// purpose: nothing inside may await, so the value can never leak onto another task.
pub fn with_account<T>(account: &AccountEnv, f: impl FnOnce() -> T) -> T {
    let previous = CURRENT.with(|cell| cell.replace(Some(account.clone())));
    let out = f();
    CURRENT.with(|cell| *cell.borrow_mut() = previous);
    out
}

/// The account set by the innermost [`with_account`] on this thread, if any.
pub fn current() -> Option<AccountEnv> {
    CURRENT.with(|cell| cell.borrow().clone())
}

/// The directory `name` points at for the current account of `provider`, when one is set.
pub fn current_var(provider: &str, name: &str) -> Option<String> {
    current().filter(|env| env.provider == provider).and_then(|env| env.var(name).map(str::to_string))
}

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

fn map_account(row: &rusqlite::Row) -> rusqlite::Result<AiAccount> {
    Ok(AiAccount { id: row.get(0)?, provider: row.get(1)?, label: row.get(2)?, created_at: row.get(3)? })
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<AiAccount>> {
    let mut stmt = conn.prepare(
        "SELECT id, provider, label, created_at FROM ai_accounts ORDER BY provider, created_at",
    )?;
    let rows = stmt.query_map([], map_account)?;
    rows.collect()
}

pub fn get(conn: &Connection, id: &str) -> rusqlite::Result<Option<AiAccount>> {
    conn.query_row(
        "SELECT id, provider, label, created_at FROM ai_accounts WHERE id = ?1",
        params![id],
        map_account,
    )
    .optional()
}

pub fn insert(conn: &Connection, provider: &str, label: &str) -> rusqlite::Result<AiAccount> {
    let account = AiAccount {
        id: Uuid::new_v4().to_string(),
        provider: provider.to_string(),
        label: label.to_string(),
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    conn.execute(
        "INSERT INTO ai_accounts (id, provider, label, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![account.id, account.provider, account.label, account.created_at],
    )?;
    Ok(account)
}

pub fn rename(conn: &Connection, id: &str, label: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE ai_accounts SET label = ?2 WHERE id = ?1", params![id, label])?;
    Ok(())
}

/// Removes the row and every preference that named it, so nothing is left pointing at an account
/// that is gone. Runs that stamped it (a conversation, a usage row) keep the stamp: history says
/// what happened, and a conversation pinned to a deleted account falls back to resolution on its
/// next turn with a fresh session.
pub fn delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM ai_accounts WHERE id = ?1", params![id])?;
    conn.execute("DELETE FROM workspace_ai_accounts WHERE account = ?1", params![id])?;
    conn.execute(
        "DELETE FROM app_settings WHERE key LIKE 'ai\\_account\\_%' ESCAPE '\\' AND value = ?1",
        params![id],
    )?;
    conn.execute("UPDATE workspace_agents SET account_id = NULL WHERE account_id = ?1", params![id])?;
    Ok(())
}

/// Every added account some preference points at — a provider default, a task pin or a workspace
/// default — as `provider|id`, sorted.
///
/// The quota pill's "is anybody spending this plan?" test, the same one `routed_providers` answers
/// for providers: an account that nothing routes to can sit at 96% of its week without it being a
/// thing the status bar should turn red over. A conversation that picked the account by hand is not
/// counted — that is one chat, and asking for its window by name in the pill still works.
pub fn referenced(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT a.provider || '|' || a.id FROM ai_accounts a
         WHERE a.id IN (SELECT value FROM app_settings WHERE key LIKE 'ai\\_account\\_%' ESCAPE '\\')
            OR a.id IN (SELECT account FROM workspace_ai_accounts)
         ORDER BY 1",
    )?;
    let rows = stmt.query_map([], |row| row.get(0))?;
    rows.collect()
}

/// One workspace's default for one provider — an account id or [`SYSTEM`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceAccount {
    pub workspace_id: String,
    pub provider: String,
    pub account: String,
}

pub fn list_workspace_defaults(conn: &Connection) -> rusqlite::Result<Vec<WorkspaceAccount>> {
    let mut stmt =
        conn.prepare("SELECT workspace_id, provider, account FROM workspace_ai_accounts ORDER BY workspace_id")?;
    let rows = stmt.query_map([], |row| {
        Ok(WorkspaceAccount { workspace_id: row.get(0)?, provider: row.get(1)?, account: row.get(2)? })
    })?;
    rows.collect()
}

/// Sets (or, with an empty `account`, clears back to "inherit") a workspace's default.
pub fn set_workspace_default(
    conn: &Connection,
    workspace_id: &str,
    provider: &str,
    account: &str,
) -> rusqlite::Result<()> {
    if account.trim().is_empty() {
        conn.execute(
            "DELETE FROM workspace_ai_accounts WHERE workspace_id = ?1 AND provider = ?2",
            params![workspace_id, provider],
        )?;
    } else {
        conn.execute(
            "INSERT INTO workspace_ai_accounts (workspace_id, provider, account) VALUES (?1, ?2, ?3)
             ON CONFLICT(workspace_id, provider) DO UPDATE SET account = excluded.account",
            params![workspace_id, provider, account],
        )?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------------------------

/// What a caller asks for. Parsed from the stored/sent spelling by [`Choice::parse`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Choice {
    /// Resolve it: task pin → workspace → provider default → system.
    Auto,
    System,
    Account(String),
}

impl Choice {
    /// `None` / `""` → automatic, [`SYSTEM`] → the system account, anything else → that id.
    pub fn parse(raw: Option<&str>) -> Self {
        match raw.map(str::trim) {
            None | Some("") => Choice::Auto,
            Some(SYSTEM) => Choice::System,
            Some(id) => Choice::Account(id.to_string()),
        }
    }
}

/// The settings key a task's own pin lives under.
pub fn task_key(task: &str) -> String {
    format!("ai_account_{task}")
}

/// The settings key a provider's default lives under.
pub fn default_key(provider: &str) -> String {
    format!("ai_account_default_{provider}")
}

/// The workspace a repository belongs to, from its path — what the repository commands that have
/// no project row at hand are handed.
pub fn workspace_of_repo(conn: &Connection, repo_path: &str) -> Option<String> {
    conn.query_row(
        "SELECT workspace_id FROM projects WHERE local_path = ?1 LIMIT 1",
        params![repo_path],
        |row| row.get(0),
    )
    .optional()
    .ok()
    .flatten()
}

/// Which account a run of `provider` uses. See the module note for the order.
///
/// Never fails: every step that cannot be read or names something that is gone falls through to
/// the next, and the last one — the system account — always exists. A run is never refused over
/// which account to use.
pub fn resolve(
    conn: &Connection,
    provider: &str,
    task: Option<&str>,
    workspace_id: Option<&str>,
    choice: Choice,
) -> AccountEnv {
    if !supports_accounts(provider) {
        return AccountEnv::system(provider);
    }
    // `Some(env)` for a choice that settles it, `None` for "keep looking".
    let settle = |choice: Choice| -> Option<AccountEnv> {
        match choice {
            Choice::Auto => None,
            Choice::System => Some(AccountEnv::system(provider)),
            Choice::Account(id) => match get(conn, &id) {
                Ok(Some(account)) if account.provider == provider => {
                    Some(AccountEnv::for_account(provider, &account.id))
                }
                _ => None,
            },
        }
    };
    let setting = |key: &str| queries::get_setting(conn, key).ok().flatten();

    if let Some(env) = settle(choice) {
        return env;
    }
    if let Some(task) = task {
        if let Some(env) = settle(Choice::parse(setting(&task_key(task)).as_deref())) {
            return env;
        }
    }
    if let Some(workspace_id) = workspace_id {
        let stored: Option<String> = conn
            .query_row(
                "SELECT account FROM workspace_ai_accounts WHERE workspace_id = ?1 AND provider = ?2",
                params![workspace_id, provider],
                |row| row.get(0),
            )
            .optional()
            .ok()
            .flatten();
        if let Some(env) = settle(Choice::parse(stored.as_deref())) {
            return env;
        }
    }
    if let Some(env) = settle(Choice::parse(setting(&default_key(provider)).as_deref())) {
        return env;
    }
    AccountEnv::system(provider)
}

// ---------------------------------------------------------------------------------------------
// Creating an account's directory
// ---------------------------------------------------------------------------------------------

/// Creates the account's directory, and — when asked — gives it a copy of the user's own
/// configuration so a new account does not start blank.
///
/// **Configuration only, never credentials.** For Claude that is the settings, the global
/// `CLAUDE.md`, agents, commands, skills and output styles, plus the user-level MCP servers lifted
/// out of `.claude.json` — which also holds the signed-in identity and, on old installs, an API
/// key, so the file itself is never copied. For Codex it is `config.toml`, `AGENTS.md` and prompts.
/// Grok and opencode need nothing: their variables move only the login, and the configuration the
/// user already has keeps applying.
///
/// Codex always gets `mcp_oauth_credentials_store = "file"`: its MCP OAuth tokens otherwise live in
/// one keyring entry shared by every `CODEX_HOME`, which would hand one account's MCP logins to
/// another.
pub fn prepare_dir(provider: &str, id: &str, copy_config: bool) -> std::io::Result<PathBuf> {
    let dir = account_dir(provider, id);
    std::fs::create_dir_all(&dir)?;
    match provider {
        "claude" if copy_config => {
            if let Some(source) = system_claude_dir() {
                for name in ["settings.json", "CLAUDE.md", "keybindings.json"] {
                    copy_if_present(&source.join(name), &dir.join(name))?;
                }
                for name in ["agents", "commands", "skills", "output-styles"] {
                    copy_tree_if_present(&source.join(name), &dir.join(name))?;
                }
            }
            if let Some(servers) = system_claude_mcp_servers() {
                let seed = serde_json::json!({ "mcpServers": servers });
                std::fs::write(dir.join(".claude.json"), serde_json::to_vec_pretty(&seed)?)?;
            }
        }
        "codex" => {
            if copy_config {
                if let Some(source) = system_codex_home() {
                    copy_if_present(&source.join("config.toml"), &dir.join("config.toml"))?;
                    copy_if_present(&source.join("AGENTS.md"), &dir.join("AGENTS.md"))?;
                    copy_tree_if_present(&source.join("prompts"), &dir.join("prompts"))?;
                }
            }
            ensure_codex_file_mcp_store(&dir.join("config.toml"))?;
        }
        _ => {}
    }
    Ok(dir)
}

/// Where the system account's Claude Code state lives: the app's own `CLAUDE_CONFIG_DIR` when it
/// was launched with one, else `~/.claude`.
fn system_claude_dir() -> Option<PathBuf> {
    match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(dir) if !dir.is_empty() => Some(PathBuf::from(dir)),
        _ => Some(dirs::home_dir()?.join(".claude")),
    }
}

/// The user-level MCP servers of the system account, and nothing else from that file.
fn system_claude_mcp_servers() -> Option<serde_json::Value> {
    let file = match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir).join(".claude.json"),
        _ => dirs::home_dir()?.join(".claude.json"),
    };
    let raw = std::fs::read_to_string(file).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let servers = parsed.get("mcpServers")?;
    (servers.as_object().is_some_and(|s| !s.is_empty())).then(|| servers.clone())
}

fn system_codex_home() -> Option<PathBuf> {
    match std::env::var_os("CODEX_HOME") {
        Some(dir) if !dir.is_empty() => Some(PathBuf::from(dir)),
        _ => Some(dirs::home_dir()?.join(".codex")),
    }
}

fn copy_if_present(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    if from.is_file() {
        std::fs::copy(from, to)?;
    }
    Ok(())
}

fn copy_tree_if_present(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    if !from.is_dir() {
        return Ok(());
    }
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_tree_if_present(&entry.path(), &target)?;
        } else if kind.is_file() {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

/// Puts `mcp_oauth_credentials_store = "file"` at the top of a Codex `config.toml`, unless the file
/// already chooses a store. At the top because a TOML key after the first `[table]` header belongs
/// to that table.
fn ensure_codex_file_mcp_store(config: &std::path::Path) -> std::io::Result<()> {
    let existing = std::fs::read_to_string(config).unwrap_or_default();
    if existing.lines().any(|line| line.trim_start().starts_with("mcp_oauth_credentials_store")) {
        return Ok(());
    }
    let line = "# Added by CodeFlow: keep this account's MCP logins out of the keyring entry every\n\
                # CODEX_HOME shares.\nmcp_oauth_credentials_store = \"file\"\n";
    let joined = if existing.is_empty() { line.to_string() } else { format!("{line}\n{existing}") };
    std::fs::write(config, joined)
}

// ---------------------------------------------------------------------------------------------
// Asking a CLI who it is signed in as
// ---------------------------------------------------------------------------------------------

/// What an account's CLI says about its login, read by running the CLI's own status command — no
/// credential is opened, no model is called, no token is spent.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub provider: String,
    pub account_id: Option<String>,
    /// `None` when the CLI could not be asked (not installed, timed out) — distinct from `false`.
    pub signed_in: Option<bool>,
    pub email: String,
    /// The plan or login method the CLI named: `max`, `team`, `ChatGPT`, `API key`, `grok.com`…
    pub plan: String,
    pub error: String,
    pub checked_at: String,
}

/// The binary a run of `provider` would use: the configured path, else the engine's default name.
pub fn binary_for(conn: &Connection, provider: &str) -> String {
    queries::get_setting(conn, &format!("{provider}_binary_path"))
        .ok()
        .flatten()
        .filter(|path| !path.trim().is_empty())
        .unwrap_or_else(|| crate::ai::engine_for(provider).default_binary().to_string())
}

/// The status command for each CLI, and how long it may take.
fn status_args(provider: &str) -> Option<Vec<&'static str>> {
    match provider {
        "claude" => Some(vec!["auth", "status", "--json"]),
        "codex" => Some(vec!["login", "status"]),
        // The first line of `grok models` names the login and spends nothing.
        "grok" => Some(vec!["models"]),
        "opencode" => Some(vec!["providers", "list"]),
        _ => None,
    }
}

pub async fn probe(binary: &str, env: &AccountEnv) -> AccountStatus {
    let mut status = AccountStatus {
        provider: env.provider.clone(),
        account_id: env.account_id.clone(),
        checked_at: chrono::Utc::now().to_rfc3339(),
        ..AccountStatus::default()
    };
    // agy has no status command, and it keeps one login for the whole machine — whose address it
    // writes beside the credential. Reading that answers "who" without starting the CLI (which, asked
    // anything it does not know as a command, sends it to the model and spends a turn).
    if env.provider == "gemini" {
        let active = dirs::home_dir()
            .and_then(|home| std::fs::read_to_string(home.join(".gemini").join("google_accounts.json")).ok())
            .and_then(|text| gemini_active_account(&text));
        status.signed_in = Some(active.is_some());
        status.email = active.unwrap_or_default();
        return status;
    }
    let Some(args) = status_args(&env.provider) else {
        status.error = "unsupported".into();
        return status;
    };
    if crate::ai::find_on_path(binary).is_none() {
        status.error = "not_installed".into();
        return status;
    }
    // Grok reports "not authenticated" for the one call that finds its token expired, refreshing
    // it behind the answer — so a second ask is the honest reading.
    let attempts = if env.provider == "grok" { 2 } else { 1 };
    for attempt in 0..attempts {
        let mut cmd = crate::ai::aux_command(binary);
        cmd.args(&args);
        env.apply(&mut cmd);
        cmd.stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let output = match tokio::time::timeout(std::time::Duration::from_secs(25), cmd.output()).await {
            Ok(Ok(output)) => output,
            Ok(Err(e)) => {
                status.error = e.to_string();
                return status;
            }
            Err(_) => {
                status.error = "timeout".into();
                return status;
            }
        };
        // Colour codes out first: opencode paints the login type grey (`\x1b[90mapi`), and a word
        // glued to an escape sequence matches nothing.
        let stdout = crate::ai::strip_ansi(&String::from_utf8_lossy(&output.stdout));
        let stderr = crate::ai::strip_ansi(&String::from_utf8_lossy(&output.stderr));
        parse_status(&env.provider, output.status.success(), &stdout, &stderr, &mut status);
        if status.signed_in == Some(true) || attempt + 1 == attempts {
            break;
        }
    }
    identity_from_files(env, &mut status);
    status
}

/// Reads each CLI's status output. Pure, so the shapes are pinned by tests.
fn parse_status(provider: &str, success: bool, stdout: &str, stderr: &str, out: &mut AccountStatus) {
    match provider {
        "claude" => {
            let parsed: Option<serde_json::Value> = serde_json::from_str(stdout.trim()).ok();
            let Some(value) = parsed else {
                out.signed_in = Some(false);
                out.error = first_line(stderr).unwrap_or_default();
                return;
            };
            out.signed_in = Some(value.get("loggedIn").and_then(|v| v.as_bool()).unwrap_or(false));
            out.email = string_at(&value, "email");
            out.plan = match string_at(&value, "subscriptionType") {
                plan if !plan.is_empty() => plan,
                _ => match string_at(&value, "authMethod").as_str() {
                    "api_key" | "api_key_helper" => "API key".into(),
                    "oauth_token" => "token".into(),
                    _ => String::new(),
                },
            };
        }
        "codex" => {
            // Prints to stderr, exits 0 when signed in: "Logged in using ChatGPT", "Logged in using
            // an API key - sk-…", "Not logged in".
            let text = format!("{stdout}\n{stderr}");
            let line = text.lines().map(str::trim).find(|l| l.starts_with("Logged in") || l.starts_with("Not logged"));
            out.signed_in = Some(success && line.is_some_and(|l| l.starts_with("Logged in")));
            if let Some(line) = line.filter(|l| l.starts_with("Logged in using ")) {
                let method = line.trim_start_matches("Logged in using ");
                out.plan = if method.starts_with("an API key") { "API key".into() } else { method.trim().to_string() };
            }
        }
        "grok" => {
            let line = stdout.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or_default();
            out.signed_in = Some(line.starts_with("You are logged in"));
            if let Some(rest) = line.strip_prefix("You are logged in with ") {
                out.plan = rest.trim_end_matches('.').to_string();
            }
        }
        "opencode" => {
            // `providers list` names each stored login on its own `●` line — `● OpenCode Zen api`,
            // `● Google oauth` — and ends with a count. The trailing word is the login type.
            let logins: Vec<String> = stdout
                .lines()
                .map(str::trim)
                .filter_map(|l| l.strip_prefix('●').map(str::trim))
                .map(|l| {
                    let mut words: Vec<&str> = l.split_whitespace().collect();
                    if words.len() > 1 && matches!(words.last().copied(), Some("api" | "oauth" | "wellknown")) {
                        words.pop();
                    }
                    words.join(" ")
                })
                .filter(|l| !l.is_empty())
                .collect();
            out.signed_in = Some(success && !logins.is_empty());
            out.plan = logins.join(", ");
        }
        _ => {}
    }
}

fn string_at(value: &serde_json::Value, key: &str) -> String {
    value.get(key).and_then(|v| v.as_str()).unwrap_or_default().to_string()
}

fn first_line(text: &str) -> Option<String> {
    text.lines().map(str::trim).find(|l| !l.is_empty()).map(str::to_string)
}

// ---------------------------------------------------------------------------------------------
// Who a login belongs to, from the CLI's own files
// ---------------------------------------------------------------------------------------------

/// Fills in what a CLI's status command leaves out — the address, and the plan where the CLI keeps
/// one — from the file that CLI wrote when it signed in. Read-only and local: no request is made and
/// no token is used, refreshed or kept. What is read is who the login belongs to, which each CLI
/// stores beside it: Grok and opencode in plain fields, Codex in its ID token's claims — the same
/// claims its own `/status` shows.
///
/// Only for a login the CLI has just confirmed: a file left behind by a CLI that is signed out would
/// name someone who no longer is.
fn identity_from_files(env: &AccountEnv, out: &mut AccountStatus) {
    if out.signed_in != Some(true) {
        return;
    }
    let read = |path: Option<PathBuf>| path.and_then(|path| std::fs::read_to_string(path).ok());
    match env.provider.as_str() {
        "codex" => {
            let home = env.var("CODEX_HOME").map(PathBuf::from).or_else(crate::codex::codex_home);
            if let Some((email, plan)) = read(home.map(|home| home.join("auth.json"))).and_then(|text| codex_identity(&text)) {
                out.email = email;
                if let Some(plan) = plan {
                    out.plan = plan;
                }
            }
        }
        "grok" => {
            if let Some(email) = read(grok_auth_path(env)).and_then(|text| grok_email(&text)) {
                out.email = email;
            }
        }
        "opencode" => {
            if let Some(text) = read(opencode_auth_path(env)) {
                out.plan = opencode_with_emails(&out.plan, &text);
            }
        }
        _ => {}
    }
}

/// Grok's login file: the account's own (`GROK_AUTH_PATH`), else wherever the user moved Grok's,
/// else `~/.grok/auth.json`.
fn grok_auth_path(env: &AccountEnv) -> Option<PathBuf> {
    if let Some(path) = env.var("GROK_AUTH_PATH") {
        return Some(PathBuf::from(path));
    }
    let set = |name: &str| std::env::var_os(name).filter(|value| !value.is_empty()).map(PathBuf::from);
    set("GROK_AUTH_PATH")
        .or_else(|| set("GROK_HOME").map(|home| home.join("auth.json")))
        .or_else(|| dirs::home_dir().map(|home| home.join(".grok").join("auth.json")))
}

/// opencode's login file under its XDG data directory — the account's own, else the user's, else
/// `~/.local/share` (on Windows too, as opencode itself does; see `ai_quota`'s reader).
fn opencode_auth_path(env: &AccountEnv) -> Option<PathBuf> {
    let base = match env.var("XDG_DATA_HOME").map(str::to_string).or_else(|| std::env::var("XDG_DATA_HOME").ok()) {
        Some(dir) if !dir.trim().is_empty() => PathBuf::from(dir),
        _ => dirs::home_dir()?.join(".local").join("share"),
    };
    Some(base.join("opencode").join("auth.json"))
}

/// The address and plan in a Codex `auth.json`: its ChatGPT login's ID token carries both, as the
/// `email` claim and `chatgpt_plan_type` under OpenAI's namespace. The token's payload is decoded,
/// never verified or sent anywhere — this is a label, not an authorisation. An API-key login has no
/// token and answers `None`, which keeps the status command's "API key".
fn codex_identity(auth_json: &str) -> Option<(String, Option<String>)> {
    use base64::Engine;
    let value: serde_json::Value = serde_json::from_str(auth_json).ok()?;
    let token = value.get("tokens")?.get("id_token")?.as_str()?;
    let payload = token.split('.').nth(1)?.trim_end_matches('=');
    let claims: serde_json::Value =
        serde_json::from_slice(&base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload).ok()?).ok()?;
    let email = claims.get("email")?.as_str()?.trim().to_string();
    if email.is_empty() {
        return None;
    }
    let plan = claims
        .get("https://api.openai.com/auth")
        .and_then(|auth| auth.get("chatgpt_plan_type"))
        .and_then(|plan| plan.as_str())
        .map(str::trim)
        .filter(|plan| !plan.is_empty())
        .map(|plan| {
            let mut letters = plan.chars();
            let title: String = letters.next().map(|first| first.to_uppercase().chain(letters).collect()).unwrap_or_default();
            format!("ChatGPT {title}")
        });
    Some((email, plan))
}

/// The address in Grok's `auth.json`: one entry per login, keyed by issuer and client, each with an
/// `email` field. The most recent login wins when there are several.
fn grok_email(auth_json: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(auth_json).ok()?;
    value
        .as_object()?
        .values()
        .filter_map(|entry| {
            let email = entry.get("email")?.as_str()?.trim();
            (!email.is_empty()).then(|| (entry.get("create_time").and_then(|t| t.as_str()).unwrap_or(""), email.to_string()))
        })
        .max_by(|a, b| a.0.cmp(b.0))
        .map(|(_, email)| email)
}

/// opencode holds one login per provider — keys for its own Zen and Go, OAuth for some others — so
/// there is no single address to show. The ones a login does carry go beside that provider's name in
/// the list `providers list` produced: `OpenCode Zen, Google (ana@example.com), OpenCode Go`.
///
/// Names and keys are matched letters-only (`google` ↔ `Google`, `github-copilot` ↔ `GitHub Copilot`),
/// and a name nothing matches is left as it was.
fn opencode_with_emails(list: &str, auth_json: &str) -> String {
    let Ok(serde_json::Value::Object(logins)) = serde_json::from_str::<serde_json::Value>(auth_json) else {
        return list.to_string();
    };
    let letters = |text: &str| text.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase();
    let emails: Vec<(String, String)> = logins
        .iter()
        .filter_map(|(key, entry)| {
            let email = entry.get("email")?.as_str()?.trim();
            (!email.is_empty()).then(|| (letters(key), email.to_string()))
        })
        .collect();
    if emails.is_empty() {
        return list.to_string();
    }
    list.split(", ")
        .map(|name| match emails.iter().find(|(key, _)| *key == letters(name)) {
            Some((_, email)) => format!("{name} ({email})"),
            None => name.to_string(),
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// The account agy is signed in as: `active` in `~/.gemini/google_accounts.json`, the file the Gemini
/// CLIs write when a Google login completes.
fn gemini_active_account(json: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let active = value.get("active")?.as_str()?.trim();
    (!active.is_empty()).then(|| active.to_string())
}

/// Signs an account's CLI out with its own logout command — the system account's too, which is the
/// same login the user's terminal uses. Codex revokes the tokens on the server, Claude removes the
/// keychain item it named after the directory, Grok clears its cached credentials: all of which
/// deleting a folder alone would leave behind, which is why removing an account calls this first.
///
/// Opencode is not handled here: it signs out one provider at a time and asks which, so the screen
/// runs `opencode auth logout` in a terminal the user can answer instead.
pub async fn logout(binary: &str, env: &AccountEnv) -> Result<(), String> {
    let args: &[&str] = match env.provider.as_str() {
        "claude" => &["auth", "logout"],
        "codex" => &["logout"],
        "grok" => &["logout"],
        other => return Err(format!("{other} cierra sesión desde su propia terminal")),
    };
    if crate::ai::find_on_path(binary).is_none() {
        return Err("not_installed".into());
    }
    let mut cmd = crate::ai::aux_command(binary);
    cmd.args(args);
    env.apply(&mut cmd);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    match tokio::time::timeout(std::time::Duration::from_secs(20), cmd.output()).await {
        Ok(Ok(output)) if output.status.success() => Ok(()),
        // The CLI's own sentence when it has one ("not logged in"), rather than an exit code.
        Ok(Ok(output)) => Err(first_line(&crate::ai::strip_ansi(&String::from_utf8_lossy(&output.stderr)))
            .unwrap_or_else(|| format!("{binary} {}", output.status))),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err("timeout".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An unsigned JWT with `claims` as its payload — all `codex_identity` ever reads of one.
    fn id_token(claims: serde_json::Value) -> String {
        use base64::Engine;
        let encode = |text: String| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(text);
        format!("{}.{}.sig", encode(r#"{"alg":"none"}"#.to_string()), encode(claims.to_string()))
    }

    #[test]
    fn codex_names_the_address_and_plan_its_token_carries() {
        let auth = serde_json::json!({
            "auth_mode": "chatgpt",
            "tokens": { "id_token": id_token(serde_json::json!({
                "email": "ana@example.com",
                "https://api.openai.com/auth": { "chatgpt_plan_type": "plus" }
            })) }
        });
        assert_eq!(
            codex_identity(&auth.to_string()),
            Some(("ana@example.com".to_string(), Some("ChatGPT Plus".to_string())))
        );
        // A login with no plan claim keeps the status command's own word for it.
        let bare = serde_json::json!({ "tokens": { "id_token": id_token(serde_json::json!({ "email": "ana@example.com" })) } });
        assert_eq!(codex_identity(&bare.to_string()), Some(("ana@example.com".to_string(), None)));
        // An API-key login has no token at all.
        assert_eq!(codex_identity(r#"{"auth_mode":"apikey","OPENAI_API_KEY":"sk-x"}"#), None);
    }

    #[test]
    fn grok_takes_the_newest_login_address() {
        let auth = serde_json::json!({
            "https://auth.x.ai::a": { "email": "old@example.com", "create_time": "2026-01-01T00:00:00Z" },
            "https://auth.x.ai::b": { "email": "new@example.com", "create_time": "2026-09-01T00:00:00Z" }
        });
        assert_eq!(grok_email(&auth.to_string()), Some("new@example.com".to_string()));
        assert_eq!(grok_email("{}"), None);
    }

    #[test]
    fn opencode_puts_each_address_beside_its_provider() {
        let auth = serde_json::json!({
            "opencode": { "type": "api", "key": "k" },
            "google": { "type": "oauth", "email": "ana@example.com" },
            "opencode-go": { "type": "api", "key": "k" }
        });
        assert_eq!(
            opencode_with_emails("OpenCode Zen, Google, OpenCode Go", &auth.to_string()),
            "OpenCode Zen, Google (ana@example.com), OpenCode Go"
        );
        assert_eq!(opencode_with_emails("OpenCode Zen", "not json"), "OpenCode Zen");
    }

    #[test]
    fn gemini_reads_the_active_google_login() {
        assert_eq!(gemini_active_account(r#"{"active":"ana@example.com","old":[]}"#), Some("ana@example.com".to_string()));
        assert_eq!(gemini_active_account(r#"{"active":null,"old":["ana@example.com"]}"#), None);
    }

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn
    }

    #[test]
    fn only_the_four_isolatable_clis_take_accounts() {
        for provider in ["claude", "codex", "grok", "opencode"] {
            assert!(supports_accounts(provider), "{provider}");
        }
        for provider in ["gemini", "cline", "unknown"] {
            assert!(!supports_accounts(provider), "{provider}");
        }
    }

    #[test]
    fn each_cli_gets_its_own_variable_and_claude_loses_inherited_keys() {
        let claude = AccountEnv::for_account("claude", "a1");
        assert!(claude.var("CLAUDE_CONFIG_DIR").unwrap().ends_with("a1"));
        assert!(claude.remove.contains(&"ANTHROPIC_API_KEY".to_string()));
        assert!(AccountEnv::for_account("codex", "a1").var("CODEX_HOME").is_some());
        assert!(AccountEnv::for_account("grok", "a1").var("GROK_AUTH_PATH").unwrap().ends_with("auth.json"));
        assert!(AccountEnv::for_account("opencode", "a1").var("XDG_DATA_HOME").is_some());
        assert_eq!(AccountEnv::system("claude").key(), "claude");
        assert_eq!(claude.key(), "claude|a1");
    }

    /// The whole precedence chain, one step at a time: explicit, task, workspace, default, system.
    #[test]
    fn resolution_goes_explicit_task_workspace_default_system() {
        let conn = conn();
        conn.execute_batch(
            "INSERT INTO workspaces (id, name, icon, color, sort_order, created_at)
                 VALUES ('w1', 'ACME', 'folder', '#111', 0, '2026-01-01T00:00:00+00:00');",
        )
        .unwrap();
        let personal = insert(&conn, "claude", "Personal").unwrap();
        let work = insert(&conn, "claude", "Trabajo").unwrap();
        let codex = insert(&conn, "codex", "Personal").unwrap();

        let id = |env: AccountEnv| env.account_id;
        // Nothing set anywhere: the system account.
        assert_eq!(id(resolve(&conn, "claude", Some("chat"), Some("w1"), Choice::Auto)), None);

        queries::set_setting(&conn, &default_key("claude"), &personal.id).unwrap();
        assert_eq!(id(resolve(&conn, "claude", Some("chat"), Some("w1"), Choice::Auto)), Some(personal.id.clone()));

        set_workspace_default(&conn, "w1", "claude", &work.id).unwrap();
        assert_eq!(id(resolve(&conn, "claude", Some("chat"), Some("w1"), Choice::Auto)), Some(work.id.clone()));
        // Another workspace still gets the provider default.
        assert_eq!(id(resolve(&conn, "claude", Some("chat"), Some("w2"), Choice::Auto)), Some(personal.id.clone()));

        queries::set_setting(&conn, &task_key("review"), SYSTEM).unwrap();
        assert_eq!(id(resolve(&conn, "claude", Some("review"), Some("w1"), Choice::Auto)), None);

        // Explicit beats everything.
        assert_eq!(
            id(resolve(&conn, "claude", Some("review"), Some("w1"), Choice::Account(personal.id.clone()))),
            Some(personal.id.clone())
        );
        // An account of another provider, or one that is gone, is skipped rather than obeyed.
        assert_eq!(
            id(resolve(&conn, "claude", None, Some("w1"), Choice::Account(codex.id.clone()))),
            Some(work.id.clone())
        );
        assert_eq!(id(resolve(&conn, "claude", None, Some("w1"), Choice::Account("gone".into()))), Some(work.id));
        // And a CLI that cannot hold several accounts is always the system one.
        assert_eq!(id(resolve(&conn, "gemini", None, Some("w1"), Choice::Account(personal.id))), None);
    }

    #[test]
    fn only_accounts_a_preference_points_at_count_as_routed() {
        let conn = conn();
        conn.execute_batch(
            "INSERT INTO workspaces (id, name, icon, color, sort_order, created_at)
                 VALUES ('w1', 'ACME', 'folder', '#111', 0, '2026-01-01T00:00:00+00:00');",
        )
        .unwrap();
        let work = insert(&conn, "claude", "Trabajo").unwrap();
        let spare = insert(&conn, "claude", "Personal").unwrap();
        let codex = insert(&conn, "codex", "Cliente").unwrap();
        assert!(referenced(&conn).unwrap().is_empty());

        queries::set_setting(&conn, &default_key("claude"), &work.id).unwrap();
        // "system" is a preference too, but it names no added account.
        queries::set_setting(&conn, &task_key("commit"), SYSTEM).unwrap();
        set_workspace_default(&conn, "w1", "codex", &codex.id).unwrap();

        let routed = referenced(&conn).unwrap();
        assert_eq!(routed.len(), 2);
        assert!(routed.contains(&format!("claude|{}", work.id)));
        assert!(routed.contains(&format!("codex|{}", codex.id)));
        assert!(!routed.iter().any(|key| key.ends_with(&spare.id)));
    }

    #[test]
    fn deleting_an_account_clears_every_preference_that_named_it() {
        let conn = conn();
        conn.execute_batch(
            "INSERT INTO workspaces (id, name, icon, color, sort_order, created_at)
                 VALUES ('w1', 'ACME', 'folder', '#111', 0, '2026-01-01T00:00:00+00:00');",
        )
        .unwrap();
        let account = insert(&conn, "codex", "Cliente").unwrap();
        queries::set_setting(&conn, &default_key("codex"), &account.id).unwrap();
        queries::set_setting(&conn, &task_key("review"), &account.id).unwrap();
        set_workspace_default(&conn, "w1", "codex", &account.id).unwrap();

        delete(&conn, &account.id).unwrap();

        assert!(get(&conn, &account.id).unwrap().is_none());
        assert!(list_workspace_defaults(&conn).unwrap().is_empty());
        assert_eq!(queries::get_setting(&conn, &default_key("codex")).unwrap(), None);
        assert_eq!(queries::get_setting(&conn, &task_key("review")).unwrap(), None);
    }

    #[test]
    fn status_outputs_are_read_the_way_each_cli_prints_them() {
        let mut out = AccountStatus::default();
        parse_status(
            "claude",
            true,
            r#"{"loggedIn":true,"authMethod":"claude.ai","email":"yo@example.com","subscriptionType":"max"}"#,
            "",
            &mut out,
        );
        assert_eq!((out.signed_in, out.email.as_str(), out.plan.as_str()), (Some(true), "yo@example.com", "max"));

        let mut out = AccountStatus::default();
        parse_status("claude", false, r#"{"loggedIn":false,"authMethod":"none"}"#, "", &mut out);
        assert_eq!(out.signed_in, Some(false));

        let mut out = AccountStatus::default();
        parse_status("codex", true, "", "Logged in using ChatGPT\n", &mut out);
        assert_eq!((out.signed_in, out.plan.as_str()), (Some(true), "ChatGPT"));
        let mut out = AccountStatus::default();
        parse_status("codex", false, "", "Not logged in\n", &mut out);
        assert_eq!(out.signed_in, Some(false));

        let mut out = AccountStatus::default();
        parse_status("grok", true, "You are logged in with grok.com.\ngrok-4\n", "", &mut out);
        assert_eq!((out.signed_in, out.plan.as_str()), (Some(true), "grok.com"));
        let mut out = AccountStatus::default();
        parse_status("grok", true, "You are not authenticated.\n", "", &mut out);
        assert_eq!(out.signed_in, Some(false));
    }

    #[test]
    fn opencode_logins_are_read_without_their_type_or_colour() {
        let mut out = AccountStatus::default();
        let listing = "┌  Credentials ~/.local/share/opencode/auth.json\n│\n●  OpenCode Zen api\n│\n●  Google oauth\n│\n└  2 credentials\n";
        parse_status("opencode", true, listing, "", &mut out);
        assert_eq!((out.signed_in, out.plan.as_str()), (Some(true), "OpenCode Zen, Google"));
        let mut out = AccountStatus::default();
        parse_status("opencode", true, "┌  Credentials\n│\n└  0 credentials\n", "", &mut out);
        assert_eq!(out.signed_in, Some(false));
    }

    #[test]
    fn codex_gets_a_file_mcp_store_above_any_table() {
        let dir = std::env::temp_dir().join(format!("cf-accounts-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = dir.join("config.toml");
        std::fs::write(&config, "[mcp_servers.docs]\ncommand = \"docs\"\n").unwrap();
        ensure_codex_file_mcp_store(&config).unwrap();
        let text = std::fs::read_to_string(&config).unwrap();
        let store = text.find("mcp_oauth_credentials_store").unwrap();
        assert!(store < text.find("[mcp_servers.docs]").unwrap(), "the key must precede the first table");
        // Idempotent.
        ensure_codex_file_mcp_store(&config).unwrap();
        assert_eq!(std::fs::read_to_string(&config).unwrap().matches("mcp_oauth_credentials_store").count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn with_account_is_scoped_to_the_call() {
        assert!(current().is_none());
        let env = AccountEnv::for_account("codex", "a1");
        let seen = with_account(&env, || current_var("codex", "CODEX_HOME"));
        assert!(seen.unwrap().ends_with("a1"));
        assert!(current().is_none(), "restored afterwards");
        assert!(with_account(&env, || current_var("claude", "CLAUDE_CONFIG_DIR")).is_none());
    }
}
