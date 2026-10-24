//! Repositorios de referencia: code bases the user keeps beside their own — the team's template, a
//! shared library, the service another one calls — cloned by the app and made searchable by every AI
//! surface without being a project of any workspace.
//!
//! **Global, switched on per workspace.** A reference repository belongs to the user, not to a
//! workspace: it applies to every workspace (`all_workspaces`) or to the ones listed for it. Where
//! it applies, the knowledge scopes carry it (`knowledge::scope_for_repo`/`scope_for_workspace`), so
//! `search_knowledge` — over MCP for the CLI agents, in-process for the local model, Codi's fast
//! answer, the prompt notes of the engines without tools — finds its passages with no surface knowing
//! it exists. The map's tools reach it by name (`repo`), and `read_reference_file` reads one file.
//!
//! **Pulled, never pushed into a prompt.** What a reference repository costs a model is one line
//! saying it exists and the passages it asks for. Nothing is pre-injected beyond what the knowledge
//! search already returned for the question, because a block of somebody else's code in every
//! prompt is noise a large model reads past and a small one drowns in.
//!
//! **A mirror, not a checkout.** The clone is shallow, of one branch, with hooks off and LFS left
//! unfetched; an update fetches that branch and resets the working tree to it, discarding anything
//! written there. Nothing ever commits or pushes in it, so there is nothing to lose — and its index
//! changes only when its commit does (`knowledge::refresh_repo` trusts it until then).
//!
//! **Private clones authenticate with an account already connected** (`auth` names it), through an
//! `http.<host>.extraHeader` passed in the environment — never on the command line, never in the
//! clone's config — the same way the first push of a published repository does.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// Emitted whenever a reference repository changes — added, cloned, updated, busy or idle — with its
/// id, so the settings pane reloads the one list instead of polling it.
pub const CHANGED_EVENT: &str = "refrepos:changed";
/// The reference repositories are searchable by the AI surfaces (knowledge and map tools). On unless
/// set to `false`.
pub const KEY_KNOWLEDGE: &str = "refrepos_knowledge";
/// The PR reviewer is told about them and looks for their uses of what a PR changes. On unless set
/// to `false`.
pub const KEY_REVIEW: &str = "refrepos_review";

/// How a reference repository's knowledge collection is named, beside the projects' ids — what
/// `knowledge::alive_ids` keeps alive and `knowledge::repo_key` prefixes.
pub const KNOWLEDGE_PREFIX: &str = "ref:";

const CLONE_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const FETCH_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const LIST_TIMEOUT: Duration = Duration::from_secs(90);
/// How often the schedule looks for a repository due an update. The interval itself is per
/// repository and counted in hours; this only bounds how late one can be.
const TICK: Duration = Duration::from_secs(5 * 60);
/// What `read_reference_file` returns at most: the local agent's own reading caps.
const READ_LINES: usize = 300;
const READ_CHARS: usize = 24_000;
const READ_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// One reference repository.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RefRepo {
    pub id: String,
    pub name: String,
    pub url: String,
    /// The branch kept checked out. Empty until the first clone says which one the remote's default is.
    pub branch: String,
    /// What it is for, in the user's words — the one line a model reads about it.
    pub purpose: String,
    pub all_workspaces: bool,
    pub workspaces: Vec<String>,
    /// Never shown to a cloud engine: only the local model searches it.
    pub local_only: bool,
    pub enabled: bool,
    /// Update it every this many hours; 0 = only when asked.
    pub auto_pull_hours: i64,
    /// `provider:account` of the connected account a private clone authenticates with, or empty.
    pub auth: String,
    /// The commit checked out, empty before the first clone.
    pub head: String,
    /// When it was last cloned or updated (ms), successfully.
    pub pulled_at: Option<i64>,
    pub size_bytes: i64,
    /// Why the last clone or update failed, as `remote::failure_message` words it; empty after one
    /// that worked.
    pub last_error: String,
    pub created_at: i64,
    pub updated_at: i64,
}

impl RefRepo {
    pub fn path(&self) -> PathBuf {
        dir_of(&self.id)
    }

    /// The clone is on disk. A repository restored from a backup on another machine is listed but
    /// not cloned until it is.
    pub fn cloned(&self) -> bool {
        self.path().join(".git").exists()
    }

    pub fn applies_to(&self, workspace_id: &str) -> bool {
        self.enabled && (self.all_workspaces || self.workspaces.iter().any(|w| w == workspace_id))
    }

    /// Its id in the knowledge index (`repo:ref:<id>`) — see [`KNOWLEDGE_PREFIX`].
    pub fn knowledge_id(&self) -> String {
        format!("{KNOWLEDGE_PREFIX}{}", self.id)
    }

    /// How a passage from it is labelled for a model: its name, said to be a reference.
    pub fn label(&self) -> String {
        format!("{} (referencia)", self.name)
    }
}

/// Where a reference repository's clone lives.
pub fn dir_of(id: &str) -> PathBuf {
    base_dir().join(id)
}

/// The folder every clone lives in. Tests clone throwaway repositories: theirs go to the temp
/// folder, never the user's.
fn base_dir() -> PathBuf {
    if cfg!(test) { std::env::temp_dir().join("codeflow-refrepos-tests") } else { crate::paths::reference_repos_dir() }
}

// ---------------------------------------------------------------------------------------- storage

const COLUMNS: &str = "id, name, url, branch, purpose, all_workspaces, local_only, enabled, auto_pull_hours, auth, head, pulled_at, size_bytes, last_error, created_at, updated_at";

fn read_row(row: &rusqlite::Row) -> rusqlite::Result<RefRepo> {
    Ok(RefRepo {
        id: row.get(0)?,
        name: row.get(1)?,
        url: row.get(2)?,
        branch: row.get(3)?,
        purpose: row.get(4)?,
        all_workspaces: row.get(5)?,
        local_only: row.get(6)?,
        enabled: row.get(7)?,
        auto_pull_hours: row.get(8)?,
        auth: row.get(9)?,
        head: row.get(10)?,
        pulled_at: row.get(11)?,
        size_bytes: row.get(12)?,
        last_error: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
        workspaces: Vec::new(),
    })
}

/// Every reference repository, by name, with the workspaces each is switched on for.
pub fn list(conn: &Connection) -> rusqlite::Result<Vec<RefRepo>> {
    let mut stmt = conn.prepare(&format!("SELECT {COLUMNS} FROM reference_repos ORDER BY name COLLATE NOCASE"))?;
    let mut repos = stmt.query_map([], read_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut stmt = conn.prepare("SELECT repo_id, workspace_id FROM reference_repo_workspaces ORDER BY workspace_id")?;
    let mut by_repo: HashMap<String, Vec<String>> = HashMap::new();
    for pair in stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
        let (repo, workspace) = pair?;
        by_repo.entry(repo).or_default().push(workspace);
    }
    for repo in repos.iter_mut() {
        repo.workspaces = by_repo.remove(&repo.id).unwrap_or_default();
    }
    Ok(repos)
}

pub fn get(conn: &Connection, id: &str) -> rusqlite::Result<Option<RefRepo>> {
    Ok(list(conn)?.into_iter().find(|r| r.id == id))
}

/// What a new reference repository is made of — the rest is learned by cloning it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewRef {
    pub url: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub branch: String,
    #[serde(default)]
    pub purpose: String,
    #[serde(default = "yes")]
    pub all_workspaces: bool,
    #[serde(default)]
    pub workspaces: Vec<String>,
    #[serde(default)]
    pub local_only: bool,
    #[serde(default = "a_day")]
    pub auto_pull_hours: i64,
}

fn yes() -> bool {
    true
}

fn a_day() -> i64 {
    24
}

/// Adds a repository to the list — not yet cloned. Refused when the same remote is already there,
/// however its URL is spelled.
pub fn insert(conn: &Connection, new: &NewRef, auth: &str) -> Result<RefRepo, String> {
    let url = new.url.trim().to_string();
    if url.is_empty() {
        return Err("Escribe la URL del repositorio".into());
    }
    if url.starts_with('-') {
        return Err("Esa URL no es válida".into());
    }
    check_branch(&new.branch)?;
    let wanted = crate::repo_identity::canonical_remote(&url).unwrap_or_else(|| url.to_lowercase());
    for existing in list(conn).map_err(|e| e.to_string())? {
        let theirs = crate::repo_identity::canonical_remote(&existing.url).unwrap_or_else(|| existing.url.to_lowercase());
        if theirs == wanted {
            return Err(format!("Ese repositorio ya está agregado como «{}»", existing.name));
        }
    }
    let name = match new.name.trim() {
        "" => name_from_url(&url),
        name => name.to_string(),
    };
    let now = chrono::Utc::now().timestamp_millis();
    let id = uuid::Uuid::new_v4().simple().to_string();
    conn.execute(
        "INSERT INTO reference_repos (id, name, url, branch, purpose, all_workspaces, local_only, enabled, auto_pull_hours, auth, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?9, ?10, ?10)",
        params![id, name, url, new.branch.trim(), new.purpose.trim(), new.all_workspaces, new.local_only, new.auto_pull_hours.max(0), auth, now],
    )
    .map_err(|e| e.to_string())?;
    set_workspaces(conn, &id, &new.workspaces)?;
    get(conn, &id).map_err(|e| e.to_string())?.ok_or_else(|| "the reference repository vanished".into())
}

/// What a person may change on a reference repository from the settings — every field optional.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Patch {
    pub name: Option<String>,
    pub purpose: Option<String>,
    pub all_workspaces: Option<bool>,
    pub workspaces: Option<Vec<String>>,
    pub local_only: Option<bool>,
    pub enabled: Option<bool>,
    pub auto_pull_hours: Option<i64>,
}

pub fn update(conn: &Connection, id: &str, patch: &Patch) -> Result<RefRepo, String> {
    let current = get(conn, id).map_err(|e| e.to_string())?.ok_or("Ese repositorio de referencia ya no existe")?;
    let name = patch.name.as_deref().map(str::trim).filter(|n| !n.is_empty()).unwrap_or(&current.name).to_string();
    let purpose = patch.purpose.as_deref().map(str::trim).unwrap_or(&current.purpose).to_string();
    let all = patch.all_workspaces.unwrap_or(current.all_workspaces);
    conn.execute(
        "UPDATE reference_repos SET name = ?2, purpose = ?3, all_workspaces = ?4, local_only = ?5, enabled = ?6, auto_pull_hours = ?7, updated_at = ?8 WHERE id = ?1",
        params![
            id,
            name,
            purpose,
            all,
            patch.local_only.unwrap_or(current.local_only),
            patch.enabled.unwrap_or(current.enabled),
            patch.auto_pull_hours.unwrap_or(current.auto_pull_hours).max(0),
            chrono::Utc::now().timestamp_millis(),
        ],
    )
    .map_err(|e| e.to_string())?;
    if let Some(workspaces) = &patch.workspaces {
        set_workspaces(conn, id, workspaces)?;
    }
    get(conn, id).map_err(|e| e.to_string())?.ok_or_else(|| "the reference repository vanished".into())
}

/// The workspaces a repository applies to when it is not all of them. Kept while it applies to
/// every workspace too: switching "every workspace" off again brings back the choice that was there.
fn set_workspaces(conn: &Connection, id: &str, workspaces: &[String]) -> Result<(), String> {
    conn.execute("DELETE FROM reference_repo_workspaces WHERE repo_id = ?1", params![id]).map_err(|e| e.to_string())?;
    let mut seen = HashSet::new();
    for workspace in workspaces.iter().map(|w| w.trim()).filter(|w| !w.is_empty()) {
        if seen.insert(workspace.to_string()) {
            conn.execute(
                "INSERT OR IGNORE INTO reference_repo_workspaces (repo_id, workspace_id) SELECT ?1, id FROM workspaces WHERE id = ?2",
                params![id, workspace],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// What a clone or an update left: the commit and branch it is at, or why it failed — the previous
/// commit stays recorded then, because the clone on disk is still that one.
fn record(conn: &Connection, id: &str, outcome: &Result<Checked, String>) -> rusqlite::Result<()> {
    let now = chrono::Utc::now().timestamp_millis();
    match outcome {
        Ok(checked) => conn.execute(
            "UPDATE reference_repos SET head = ?2, branch = ?3, size_bytes = ?4, pulled_at = ?5, last_error = '', updated_at = ?5 WHERE id = ?1",
            params![id, checked.head, checked.branch, checked.size_bytes, now],
        ),
        Err(error) => conn.execute("UPDATE reference_repos SET last_error = ?2, updated_at = ?3 WHERE id = ?1", params![id, error, now]),
    }
    .map(|_| ())
}

/// Removes a repository: its row, its clone and — on the next prune — its index.
pub fn remove(conn: &Connection, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM reference_repo_workspaces WHERE repo_id = ?1", params![id]).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM reference_repos WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
    discard_clone(id);
    Ok(())
}

/// Deletes a clone folder — only ever one inside [`base_dir`], whatever the
/// id says.
fn discard_clone(id: &str) {
    let base = base_dir();
    let dir = dir_of(id);
    let inside = !id.is_empty() && !id.contains(['/', '\\', '.']) && dir.parent() == Some(base.as_path());
    if inside && dir.exists() {
        if let Err(e) = std::fs::remove_dir_all(&dir) {
            crate::applog::warn(&format!("refrepos: could not delete {}: {e}", dir.display()));
        }
    }
}

// ------------------------------------------------------------------------------------ who sees it

/// The searches may include reference repositories at all (Settings › Repositorios de referencia).
pub fn searchable(conn: &Connection) -> bool {
    crate::db::queries::get_setting(conn, KEY_KNOWLEDGE).ok().flatten().as_deref() != Some("false")
}

/// The PR reviewer may use them.
pub fn for_review(conn: &Connection) -> bool {
    crate::db::queries::get_setting(conn, KEY_REVIEW).ok().flatten().as_deref() != Some("false")
}

/// The reference repositories a run in `workspace_id` may use: switched on for it, cloned, and —
/// for a cloud engine (`cloud`) — not kept for the local model only.
pub fn enabled_for(conn: &Connection, workspace_id: &str, cloud: bool) -> Vec<RefRepo> {
    if workspace_id.is_empty() || !searchable(conn) {
        return Vec::new();
    }
    list(conn).unwrap_or_default().into_iter().filter(|r| r.applies_to(workspace_id) && !(cloud && r.local_only) && r.cloned()).collect()
}

/// [`enabled_for`] as knowledge scope entries: `(ref:<id>, "<name> (referencia)", clone)`.
pub fn scope_entries(conn: &Connection, workspace_id: &str, cloud: bool) -> Vec<(String, String, PathBuf)> {
    enabled_for(conn, workspace_id, cloud).into_iter().map(|r| (r.knowledge_id(), r.label(), r.path())).collect()
}

/// The workspace a run at `root` belongs to: its project's, or the workspace chat's whose folder it is.
pub fn workspace_of_root(conn: &Connection, root: &str) -> Option<String> {
    crate::knowledge::owning_project(conn, root)
        .map(|p| p.workspace_id)
        .filter(|ws| !ws.is_empty())
        .or_else(|| crate::workspace_chat::workspace_of_dir(conn, root))
}

/// The reference repositories a run at `root` may use.
pub fn for_root(conn: &Connection, root: &str, cloud: bool) -> Vec<RefRepo> {
    workspace_of_root(conn, root).map(|ws| enabled_for(conn, &ws, cloud)).unwrap_or_default()
}

/// The one a tool call names — by name (any case) or by id — among those the run may use.
pub fn find(repos: &[RefRepo], wanted: &str) -> Result<RefRepo, String> {
    let wanted = wanted.trim();
    let folded = wanted.to_lowercase();
    repos
        .iter()
        .find(|r| r.name.to_lowercase() == folded || r.id == wanted)
        .or_else(|| repos.iter().find(|r| r.name.to_lowercase().replace([' ', '_'], "-") == folded.replace([' ', '_'], "-")))
        .cloned()
        .ok_or_else(|| match repos.is_empty() {
            true => "No reference repositories are enabled here.".to_string(),
            false => format!(
                "No reference repository called {wanted:?} is enabled here. Available: {}.",
                repos.iter().map(|r| r.name.as_str()).collect::<Vec<_>>().join(", ")
            ),
        })
}

/// The list a model reads (`reference_repos`): name, branch and commit, how fresh, and what for.
pub fn describe(repos: &[RefRepo]) -> String {
    if repos.is_empty() {
        return "No reference repositories are enabled here.".to_string();
    }
    let now = chrono::Utc::now().timestamp_millis();
    let mut out = String::from(
        "Reference repositories (read-only code bases the user keeps for consultation — not part of the project you work on):\n",
    );
    for repo in repos {
        let commit = repo.head.get(..10).unwrap_or(&repo.head);
        let age = repo.pulled_at.map(|at| format!(" · updated {}", ago(now - at))).unwrap_or_default();
        let purpose = if repo.purpose.is_empty() { String::new() } else { format!(" — {}", repo.purpose) };
        out.push_str(&format!("- {} (branch {} @ {commit}{age}){purpose}\n", repo.name, if repo.branch.is_empty() { "?" } else { &repo.branch }));
    }
    out.push_str(
        "search_knowledge already searches them. Pass repo=\"<name>\" to find_symbol, find_usages, file_outline or project_map \
         to explore one, and read_reference_file to read a file of one. Compare with them; never edit them.",
    );
    out
}

fn ago(ms: i64) -> String {
    let minutes = (ms / 60_000).max(0);
    match minutes {
        0 => "just now".to_string(),
        m if m < 60 => format!("{m} min ago"),
        m if m < 48 * 60 => format!("{} h ago", m / 60),
        m => format!("{} days ago", m / (24 * 60)),
    }
}

/// A file no reference repository hands out, to anyone: what holds credentials by its name. The
/// knowledge index leaves them out of a reference repository too (`knowledge::refresh_repo`).
pub fn sensitive(rel: &str) -> bool {
    let name = rel.rsplit(['/', '\\']).next().unwrap_or(rel).to_lowercase();
    name.starts_with(".env")
        || name.ends_with(".pem")
        || name.ends_with(".key")
        || name.ends_with(".p12")
        || name.ends_with(".pfx")
        || name.ends_with(".keystore")
        || name.ends_with(".jks")
        || matches!(name.as_str(), "id_rsa" | "id_ed25519" | "id_ecdsa" | "id_dsa" | ".npmrc" | ".pypirc" | ".netrc" | "credentials" | "secrets.json")
}

/// One file of a reference repository, numbered, at most [`READ_LINES`] lines from `start` — the
/// way the local agent reads its own project's files. Secrets are redacted, a credential file is
/// refused, and nothing outside the clone (or inside its `.git`) can be named.
pub fn read_file(repo: &RefRepo, rel: &str, start: Option<usize>, end: Option<usize>) -> Result<String, String> {
    let rel = rel.trim().trim_start_matches(['/', '\\']).replace('\\', "/");
    if rel.is_empty() {
        return Err("path is empty".to_string());
    }
    if sensitive(&rel) {
        return Err(format!("{rel} is not shared: files like it hold credentials"));
    }
    let base = repo.path().canonicalize().map_err(|_| format!("{} is not cloned on this machine yet", repo.name))?;
    let full = base.join(&rel).canonicalize().map_err(|_| format!("{rel} does not exist in {}", repo.name))?;
    let inside = full.strip_prefix(&base).ok().is_some_and(|tail| !tail.components().any(|c| c.as_os_str() == ".git"));
    if !inside {
        return Err(format!("{rel} is outside {}", repo.name));
    }
    if full.is_dir() {
        return Err(format!("{rel} is a folder — project_map with repo=\"{}\" lists its files", repo.name));
    }
    let size = std::fs::metadata(&full).map(|m| m.len()).unwrap_or(0);
    if size > READ_MAX_BYTES {
        return Err(format!("{rel} is too large to read ({} KB)", size / 1024));
    }
    let bytes = std::fs::read(&full).map_err(|e| e.to_string())?;
    if crate::search::looks_binary(&bytes) {
        return Err(format!("{rel} is a binary file"));
    }
    let text = String::from_utf8_lossy(&bytes);
    let lines: Vec<&str> = text.lines().collect();
    let total = lines.len();
    let first = start.unwrap_or(1).max(1);
    if total > 0 && first > total {
        return Err(format!("{rel} has {total} lines"));
    }
    let last = end.unwrap_or(first + READ_LINES - 1).min(first + READ_LINES - 1).min(total);
    let mut out = format!("{} @ {} — {rel} (lines {first}-{last} of {total})\n", repo.name, if repo.branch.is_empty() { "?" } else { &repo.branch });
    for (n, line) in lines.iter().enumerate().take(last).skip(first - 1) {
        out.push_str(&format!("{:>5} | {line}\n", n + 1));
        if out.len() > READ_CHARS {
            out.push_str("… (cut: ask for a later start)\n");
            break;
        }
    }
    if last < total && out.len() <= READ_CHARS {
        out.push_str(&format!("… {} more line(s): read again with start_line {}\n", total - last, last + 1));
    }
    Ok(crate::secret_scan::redact(&out).0)
}

// ------------------------------------------------------------------------------------------ git

/// A branch name safe to put on git's command line: no option, no range, no whitespace.
fn check_branch(branch: &str) -> Result<(), String> {
    let branch = branch.trim();
    if branch.starts_with('-') || branch.contains("..") || branch.contains(char::is_whitespace) || branch.contains(':') {
        return Err(format!("«{branch}» no es un nombre de rama válido"));
    }
    Ok(())
}

/// The repository's name, from its URL: the last path segment without `.git`.
pub fn name_from_url(url: &str) -> String {
    let trimmed = url.trim().trim_end_matches('/').trim_end_matches(".git");
    let last = trimmed.rsplit(['/', ':']).next().unwrap_or(trimmed);
    if last.is_empty() { "repositorio".to_string() } else { last.to_string() }
}

/// The host and path of an `http(s)` URL, without the user name some hosts put in it. `None` for an
/// SSH remote, which authenticates through the user's own agent.
fn https_parts(url: &str) -> Option<(String, String)> {
    let rest = url.trim().strip_prefix("https://").or_else(|| url.trim().strip_prefix("http://"))?;
    let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
    let host = authority.rsplit_once('@').map(|(_, h)| h).unwrap_or(authority).to_lowercase();
    Some((host, path.to_string()))
}

/// The connected account a clone of `url` authenticates with (`provider:account`), or empty for a
/// remote none of them is for. Reads only the connection lists — never the keychain.
pub fn auth_for(conn: &Connection, url: &str) -> String {
    let Some((host, path)) = https_parts(url) else { return String::new() };
    let setting = |key: &str| crate::db::queries::get_setting(conn, key).ok().flatten().unwrap_or_default();
    let listed = |key: &str, field: &str| -> Vec<String> {
        serde_json::from_str::<Vec<serde_json::Value>>(&setting(key))
            .unwrap_or_default()
            .iter()
            .filter_map(|v| v.get(field).and_then(serde_json::Value::as_str).map(|s| s.trim().to_lowercase()))
            .collect()
    };
    let first = path.split('/').next().unwrap_or_default().to_lowercase();
    if listed("github_connections", "host").contains(&host) {
        return format!("github:{host}");
    }
    if listed("gitlab_connections", "host").contains(&host) {
        return format!("gitlab:{host}");
    }
    if host == "bitbucket.org" && listed("bitbucket_connections", "workspace").contains(&first) {
        return format!("bitbucket:{first}");
    }
    let org = if host == "dev.azure.com" { Some(first.clone()) } else { host.strip_suffix(".visualstudio.com").map(str::to_string) };
    if let Some(org) = org.filter(|o| !o.is_empty()) {
        let mut orgs = listed("ado_connections", "org");
        orgs.extend(setting("ado_default_org").split(',').map(|o| o.trim().to_lowercase()).filter(|o| !o.is_empty()));
        if orgs.contains(&org) {
            return format!("azure:{org}");
        }
    }
    String::new()
}

/// The environment of a network run: no prompt of any kind, ssh in batch mode, no LFS downloads,
/// and — for a private remote — the account's credential as an `extraHeader` git reads from the
/// environment, never from its command line or config.
fn network_env(auth: &str) -> Result<Vec<(String, String)>, String> {
    let mut env: Vec<(String, String)> = crate::remote::network_env(None).into_iter().map(|(k, v)| (k.to_string(), v)).collect();
    env.push(("GIT_LFS_SKIP_SMUDGE".into(), "1".into()));
    if let Some((provider, account)) = auth.split_once(':') {
        let (prefix, header) = crate::commands::publish_cmd::push_credential(provider, account)?;
        env.push(("GIT_CONFIG_COUNT".into(), "1".into()));
        env.push(("GIT_CONFIG_KEY_0".into(), format!("http.{prefix}.extraHeader")));
        env.push(("GIT_CONFIG_VALUE_0".into(), format!("Authorization: {header}")));
    }
    Ok(env)
}

fn git(cwd: &Path, args: &[&str], env: &[(String, String)], timeout: Duration) -> Result<crate::git::cli::Output, String> {
    let env: Vec<(&str, &str)> = env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
    crate::git::cli::run(cwd, args, &env, timeout)
}

/// `-c core.hooksPath=<an empty folder>`: a clone of somebody else's code never runs a hook of theirs.
fn hooks_off() -> String {
    let empty = base_dir().join(".no-hooks");
    let _ = std::fs::create_dir_all(&empty);
    format!("core.hooksPath={}", empty.display())
}

fn failed(op: &str, out: &crate::git::cli::Output) -> String {
    if out.timed_out {
        return format!("git {op} did not finish in time");
    }
    crate::remote::failure_message(op, &out.combined(), &out.detail())
}

/// A remote's branches, and the one its `HEAD` points at.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBranches {
    pub default_branch: Option<String>,
    pub branches: Vec<String>,
}

/// `git ls-remote --symref` read back: `ref: refs/heads/main\tHEAD` names the default, every
/// `<sha>\trefs/heads/<name>` a branch.
fn parse_ls_remote(text: &str) -> RemoteBranches {
    let mut out = RemoteBranches::default();
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("ref: ") {
            if let Some((target, "HEAD")) = rest.split_once('\t') {
                out.default_branch = target.strip_prefix("refs/heads/").map(str::to_string);
            }
            continue;
        }
        if let Some((_, refname)) = line.split_once('\t') {
            if let Some(branch) = refname.strip_prefix("refs/heads/") {
                out.branches.push(branch.to_string());
            }
        }
    }
    out.branches.sort_by_key(|b| b.to_lowercase());
    out.branches.dedup();
    out
}

/// The branches of the remote at `url`, asked with the account `auth` names.
pub fn remote_branches(url: &str, auth: &str) -> Result<RemoteBranches, String> {
    let url = url.trim();
    if url.is_empty() || url.starts_with('-') {
        return Err("Esa URL no es válida".into());
    }
    let env = network_env(auth)?;
    let out = git(&std::env::temp_dir(), &["ls-remote", "--symref", "--", url], &env, LIST_TIMEOUT)?;
    if !out.success {
        return Err(failed("ls-remote", &out));
    }
    Ok(parse_ls_remote(&out.stdout))
}

/// Where a clone ended up after a clone or an update.
#[derive(Debug, Clone, PartialEq)]
struct Checked {
    head: String,
    branch: String,
    size_bytes: i64,
}

fn checked(dir: &Path) -> Result<Checked, String> {
    let read = |args: &[&str]| -> Result<String, String> {
        let out = git(dir, args, &[], crate::git::cli::LOCAL_TIMEOUT)?;
        if out.success { Ok(out.stdout.trim().to_string()) } else { Err(out.detail()) }
    };
    let head = read(&["rev-parse", "HEAD"])?;
    let branch = read(&["rev-parse", "--abbrev-ref", "HEAD"]).unwrap_or_default();
    let (bytes, _) = crate::npm::directory_size(dir, 0);
    Ok(Checked { head, branch, size_bytes: bytes as i64 })
}

/// A fresh clone: shallow, of the one branch (the remote's default when none was picked), no tags,
/// hooks off. Whatever was in the folder before goes first — it can only be a clone that failed.
fn clone_fresh(repo: &RefRepo) -> Result<Checked, String> {
    check_branch(&repo.branch)?;
    let dir = repo.path();
    discard_clone(&repo.id);
    let base = base_dir();
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let env = network_env(&repo.auth)?;
    let hooks = hooks_off();
    let target = dir.to_string_lossy().to_string();
    let mut args: Vec<&str> = vec!["-c", &hooks, "clone", "--depth", "1", "--single-branch", "--no-tags"];
    let branch = repo.branch.trim();
    if !branch.is_empty() {
        args.extend(["--branch", branch]);
    }
    args.extend(["--", repo.url.as_str(), target.as_str()]);
    let out = git(&base, &args, &env, CLONE_TIMEOUT)?;
    if !out.success {
        discard_clone(&repo.id);
        return Err(failed("clone", &out));
    }
    checked(&dir)
}

/// An update: the branch fetched again (shallow) and the working tree reset to it — `branch` when a
/// different one was picked. Nothing written in the clone survives, which is the point of a mirror.
fn fetch_branch(repo: &RefRepo, branch: &str) -> Result<Checked, String> {
    let dir = repo.path();
    if !repo.cloned() {
        return clone_fresh(&RefRepo { branch: branch.to_string(), ..repo.clone() });
    }
    let branch = match branch.trim() {
        "" => checked(&dir).map(|c| c.branch).unwrap_or_default(),
        b => b.to_string(),
    };
    if branch.is_empty() || branch == "HEAD" {
        return Err("No se sabe qué rama actualizar: elige una".into());
    }
    check_branch(&branch)?;
    let env = network_env(&repo.auth)?;
    let hooks = hooks_off();
    let refspec = format!("+refs/heads/{branch}:refs/remotes/origin/{branch}");
    let out = git(&dir, &["-c", &hooks, "fetch", "--depth", "1", "--no-tags", "origin", &refspec], &env, FETCH_TIMEOUT)?;
    if !out.success {
        return Err(failed("fetch", &out));
    }
    let tracking = format!("refs/remotes/origin/{branch}");
    let local = [("GIT_LFS_SKIP_SMUDGE".to_string(), "1".to_string())];
    let out = git(&dir, &["-c", &hooks, "checkout", "--force", "-B", &branch, &tracking], &local, crate::git::cli::LOCAL_TIMEOUT)?;
    if !out.success {
        return Err(failed("checkout", &out));
    }
    let _ = git(&dir, &["clean", "-fdq"], &[], crate::git::cli::LOCAL_TIMEOUT);
    checked(&dir)
}

// ----------------------------------------------------------------------------------- operations

/// What can be asked of a reference repository.
#[derive(Debug, Clone, PartialEq)]
pub enum Op {
    /// Clone it (again).
    Clone,
    /// Fetch its branch and reset to it.
    Pull,
    /// Switch to another branch.
    Branch(String),
    /// Rebuild its index and its map from the clone as it is.
    Reindex,
}

impl Op {
    fn label(&self) -> &'static str {
        match self {
            Op::Clone => "cloning",
            Op::Pull => "pulling",
            Op::Branch(_) => "switching",
            Op::Reindex => "indexing",
        }
    }
}

/// What each repository is busy with now. One operation per repository at a time.
static BUSY: LazyLock<Mutex<HashMap<String, &'static str>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// What `id` is doing right now — `cloning` · `pulling` · `switching` · `indexing` — if anything.
pub fn busy_with(id: &str) -> Option<&'static str> {
    BUSY.lock().ok().and_then(|busy| busy.get(id).copied())
}

struct Busy {
    id: String,
    app: Option<AppHandle>,
}

impl Busy {
    fn claim(app: Option<&AppHandle>, id: &str, what: &'static str) -> Option<Self> {
        let mut busy = BUSY.lock().ok()?;
        if busy.contains_key(id) {
            return None;
        }
        busy.insert(id.to_string(), what);
        drop(busy);
        let guard = Busy { id: id.to_string(), app: app.cloned() };
        guard.changed();
        Some(guard)
    }

    fn set(&self, what: &'static str) {
        if let Ok(mut busy) = BUSY.lock() {
            busy.insert(self.id.clone(), what);
        }
        self.changed();
    }

    fn changed(&self) {
        if let Some(app) = &self.app {
            let _ = app.emit(CHANGED_EVENT, &self.id);
        }
    }
}

impl Drop for Busy {
    fn drop(&mut self) {
        if let Ok(mut busy) = BUSY.lock() {
            busy.remove(&self.id);
        }
        self.changed();
    }
}

/// Starts `op` on `id` in the background — at low priority, one at a time per repository. `false`
/// when the repository is already busy.
pub fn start(app: &AppHandle, id: &str, op: Op) -> bool {
    let Some(guard) = Busy::claim(Some(app), id, op.label()) else { return false };
    let id = id.to_string();
    std::thread::spawn(move || {
        crate::meetings::lower_priority();
        run(&guard, &id, &op);
    });
    true
}

/// Runs one operation to the end, recording what it left; the index follows on success.
fn run(guard: &Busy, id: &str, op: &Op) {
    let Some(Ok(Some(repo))) = crate::ai_usage::with_conn(|conn| get(conn, id)) else { return };
    let outcome = match op {
        Op::Clone => Some(clone_fresh(&repo)),
        Op::Pull => Some(fetch_branch(&repo, &repo.branch)),
        Op::Branch(branch) => Some(fetch_branch(&repo, branch)),
        Op::Reindex => None,
    };
    let moved = match outcome {
        Some(outcome) => {
            if let Err(error) = &outcome {
                crate::applog::warn(&format!("refrepos: {} {}: {error}", op.label(), repo.name));
            }
            let moved = outcome.as_ref().is_ok_and(|c| c.head != repo.head || c.branch != repo.branch);
            let ok = outcome.is_ok();
            let _ = crate::ai_usage::with_conn(|conn| record(conn, id, &outcome));
            if !ok {
                return;
            }
            moved
        }
        None => true,
    };
    if !moved && repo.cloned() {
        return;
    }
    guard.set("indexing");
    let Some(Ok(Some(repo))) = crate::ai_usage::with_conn(|conn| get(conn, id)) else { return };
    index(&repo, matches!(op, Op::Reindex));
}

/// Brings the repository's knowledge and map up to date: the walk (forced on a re-index), its prose
/// embedded when a local embedding model is there, and its map built so the first `find_symbol` on
/// it does not pay for it.
fn index(repo: &RefRepo, force: bool) {
    let root = repo.path().to_string_lossy().to_string();
    // The schedule and the user's actions are the only things that change a clone: its map trusts
    // its last check for longer, and is told when an update moved it.
    crate::codemap::set_watched(&root, true);
    crate::codemap::invalidate(&root);
    let scope = scope_of(repo);
    if let Err(e) = crate::knowledge::refresh_blocking(&scope, force) {
        crate::applog::warn(&format!("refrepos: indexing {} failed — {e}", repo.name));
    }
    let settings = crate::ai_usage::with_conn(|conn| {
        (
            crate::db::queries::get_setting(conn, crate::knowledge::embed::KEY_EMBED_MODEL).ok().flatten(),
            crate::db::queries::get_setting(conn, crate::hybrid::config::KEY_URL_OLLAMA).ok().flatten().unwrap_or_else(|| "http://127.0.0.1:11434".to_string()),
        )
    });
    if let Some((setting, url)) = settings {
        if let Some(space) = tauri::async_runtime::block_on(crate::knowledge::embed::Space::resolve(setting.as_deref(), &url)) {
            crate::knowledge::vectorize_in_background(scope, space);
        }
    }
    let _ = crate::codemap::snapshot(&root);
}

/// The knowledge scope of one reference repository alone: its files, nothing of any workspace.
pub fn scope_of(repo: &RefRepo) -> crate::knowledge::Scope {
    crate::knowledge::Scope {
        repos: vec![(repo.knowledge_id(), repo.label(), repo.path())],
        cloud: false,
        sources: crate::knowledge::Sources { global_notes: false, meetings: false, docs: false, stories: false, reviews: false, commits: false },
        ..Default::default()
    }
}

/// The schedule: every [`TICK`], the repositories whose interval has passed are updated, one after
/// the other. Clones are marked as watched first so their maps trust their last check.
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        crate::meetings::lower_priority();
        if let Some(Ok(repos)) = crate::ai_usage::with_conn(list) {
            for repo in repos.iter().filter(|r| r.cloned()) {
                crate::codemap::set_watched(&repo.path().to_string_lossy(), true);
            }
        }
        // The first look waits for the launch to settle.
        std::thread::sleep(Duration::from_secs(120));
        loop {
            // Battery saving from Fuerte: no scheduled clone or pull (and the reindex after it) —
            // the repositories catch up at the first tick after the level drops. «Actualizar» by
            // hand still runs.
            if crate::power::saving(2) {
                std::thread::sleep(TICK);
                continue;
            }
            let now = chrono::Utc::now().timestamp_millis();
            let due: Vec<RefRepo> = crate::ai_usage::with_conn(list)
                .and_then(Result::ok)
                .unwrap_or_default()
                .into_iter()
                .filter(|r| is_due(r, now))
                .collect();
            for repo in due {
                if let Some(guard) = Busy::claim(Some(&app), &repo.id, if repo.cloned() { "pulling" } else { "cloning" }) {
                    run(&guard, &repo.id, if repo.cloned() { &Op::Pull } else { &Op::Clone });
                }
            }
            std::thread::sleep(TICK);
        }
    });
}

/// Due an automatic update: switched on, with an interval, and that long since the last one that
/// worked — or never cloned on this machine (a restore). One that failed waits its interval too,
/// rather than hammering a remote that refused it.
fn is_due(repo: &RefRepo, now: i64) -> bool {
    if !repo.enabled || repo.auto_pull_hours <= 0 || busy_with(&repo.id).is_some() {
        return false;
    }
    let last = repo.pulled_at.unwrap_or(0).max(if repo.last_error.is_empty() { 0 } else { repo.updated_at });
    now - last >= repo.auto_pull_hours * 3_600_000
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        for ws in ["w1", "w2"] {
            conn.execute(
                "INSERT INTO workspaces (id, name, icon, color, sort_order, created_at) VALUES (?1, ?1, '', '', 0, '2026-10-22')",
                params![ws],
            )
            .unwrap();
        }
        conn
    }

    fn new(url: &str) -> NewRef {
        NewRef { url: url.into(), all_workspaces: true, auto_pull_hours: 24, ..Default::default() }
    }

    #[test]
    fn a_name_comes_from_the_url() {
        assert_eq!(name_from_url("https://github.com/acme/lib-core.git"), "lib-core");
        assert_eq!(name_from_url("git@github.com:acme/lib-core.git"), "lib-core");
        assert_eq!(name_from_url("https://dev.azure.com/acme/Shop/_git/Template.Node.Nest"), "Template.Node.Nest");
        assert_eq!(name_from_url("https://gitlab.com/acme/tools/"), "tools");
    }

    #[test]
    fn the_remote_branches_and_its_default_are_read_from_ls_remote() {
        let text = "ref: refs/heads/develop\tHEAD\n1111\tHEAD\n2222\trefs/heads/main\n3333\trefs/heads/develop\n4444\trefs/tags/v1\n5555\trefs/pull/7/head\n6666\trefs/heads/Feature/x\n";
        let parsed = parse_ls_remote(text);
        assert_eq!(parsed.default_branch.as_deref(), Some("develop"));
        assert_eq!(parsed.branches, vec!["develop", "Feature/x", "main"]);
    }

    #[test]
    fn a_branch_that_could_be_an_option_or_a_range_is_refused() {
        assert!(check_branch("main").is_ok());
        assert!(check_branch("release/2026.10").is_ok());
        for bad in ["-upload-pack=x", "a..b", "with space", "a:b"] {
            assert!(check_branch(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_same_remote_is_not_added_twice_however_it_is_spelled() {
        let conn = db();
        insert(&conn, &new("https://github.com/acme/lib-core.git"), "").unwrap();
        let again = insert(&conn, &new("git@github.com:Acme/lib-core"), "");
        assert!(again.unwrap_err().contains("lib-core"));
    }

    #[test]
    fn a_repository_applies_where_it_is_switched_on() {
        let conn = db();
        let everywhere = insert(&conn, &new("https://github.com/acme/a.git"), "").unwrap();
        let only_w2 = insert(&conn, &NewRef { all_workspaces: false, workspaces: vec!["w2".into(), "nope".into()], ..new("https://github.com/acme/b.git") }, "").unwrap();
        assert!(everywhere.applies_to("w1") && everywhere.applies_to("w2"));
        assert_eq!(only_w2.workspaces, vec!["w2"], "a workspace that does not exist is not recorded");
        assert!(!only_w2.applies_to("w1") && only_w2.applies_to("w2"));

        let off = update(&conn, &everywhere.id, &Patch { enabled: Some(false), ..Default::default() }).unwrap();
        assert!(!off.applies_to("w1"));
        // Switching "every workspace" off keeps the choice that was there.
        let moved = update(&conn, &only_w2.id, &Patch { all_workspaces: Some(true), ..Default::default() }).unwrap();
        assert_eq!(moved.workspaces, vec!["w2"]);
        let back = update(&conn, &only_w2.id, &Patch { all_workspaces: Some(false), ..Default::default() }).unwrap();
        assert!(!back.applies_to("w1"));
    }

    #[test]
    fn nothing_is_offered_until_it_is_cloned_and_a_cloud_engine_never_sees_a_local_only_one() {
        let conn = db();
        let public = insert(&conn, &new("https://github.com/acme/public.git"), "").unwrap();
        let private = insert(&conn, &NewRef { local_only: true, ..new("https://github.com/acme/private.git") }, "").unwrap();
        assert!(enabled_for(&conn, "w1", false).is_empty(), "neither is cloned yet");
        for repo in [&public, &private] {
            std::fs::create_dir_all(repo.path().join(".git")).unwrap();
        }
        let names = |cloud| enabled_for(&conn, "w1", cloud).into_iter().map(|r| r.name).collect::<Vec<_>>();
        assert_eq!(names(false), vec!["private", "public"]);
        assert_eq!(names(true), vec!["public"]);
        crate::db::queries::set_setting(&conn, KEY_KNOWLEDGE, "false").unwrap();
        assert!(names(false).is_empty(), "the master switch turns them off for every search");
        for repo in [&public, &private] {
            remove(&conn, &repo.id).unwrap();
            assert!(!repo.path().exists(), "the clone goes with the row");
        }
    }

    /// Where a repository applies, the knowledge scopes carry it — labelled as a reference, with no
    /// commits or reviews collections of its own — and pruning keeps its index alive.
    #[test]
    fn the_knowledge_scopes_carry_it_where_it_applies() {
        let conn = db();
        let repo = insert(&conn, &NewRef { all_workspaces: false, workspaces: vec!["w1".into()], ..new("https://github.com/acme/scope.git") }, "").unwrap();
        std::fs::create_dir_all(repo.path().join(".git")).unwrap();
        let scope = crate::knowledge::scope_for_workspace(&conn, "w1", true).unwrap();
        let entry = scope.repos.iter().find(|(id, _, _)| id == &repo.knowledge_id()).expect("in the workspace's scope");
        assert_eq!(entry.1, "scope (referencia)");
        let keys = scope.keys();
        assert!(keys.contains(&crate::knowledge::repo_key(&repo.knowledge_id())));
        assert!(!keys.iter().any(|k| k.starts_with("commits:ref:") || k.starts_with("reviews:ref:")), "{keys:?}");
        let other = crate::knowledge::scope_for_workspace(&conn, "w2", true).unwrap();
        assert!(!other.repos.iter().any(|(id, _, _)| id == &repo.knowledge_id()), "not switched on for w2");
        assert!(crate::knowledge::alive_ids(&conn).unwrap().contains(&repo.knowledge_id()));
        remove(&conn, &repo.id).unwrap();
    }

    #[test]
    fn a_tool_names_a_repository_by_name_in_any_case_or_spelling() {
        let repo = |name: &str| RefRepo { id: format!("id-{name}"), name: name.into(), ..sample() };
        let repos = vec![repo("Template.Node.Nest"), repo("lib core")];
        assert_eq!(find(&repos, "template.node.nest").unwrap().name, "Template.Node.Nest");
        assert_eq!(find(&repos, "lib-core").unwrap().name, "lib core");
        assert_eq!(find(&repos, "id-lib core").unwrap().name, "lib core");
        let missing = find(&repos, "otro").unwrap_err();
        assert!(missing.contains("Template.Node.Nest") && missing.contains("lib core"), "{missing}");
    }

    fn sample() -> RefRepo {
        RefRepo {
            id: "x".into(),
            name: "x".into(),
            url: "https://github.com/acme/x.git".into(),
            branch: "main".into(),
            purpose: String::new(),
            all_workspaces: true,
            workspaces: Vec::new(),
            local_only: false,
            enabled: true,
            auto_pull_hours: 24,
            auth: String::new(),
            head: "0123456789abcdef".into(),
            pulled_at: None,
            size_bytes: 0,
            last_error: String::new(),
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn a_private_remote_authenticates_with_the_account_connected_for_it() {
        let conn = db();
        let set = |k: &str, v: &str| crate::db::queries::set_setting(&conn, k, v).unwrap();
        set("github_connections", r#"[{"host":"github.com"}]"#);
        set("gitlab_connections", r#"[{"host":"gitlab.acme.io"}]"#);
        set("bitbucket_connections", r#"[{"workspace":"acme"}]"#);
        set("ado_connections", r#"[{"org":"achsdev"}]"#);
        assert_eq!(auth_for(&conn, "https://github.com/acme/x.git"), "github:github.com");
        assert_eq!(auth_for(&conn, "https://ana@gitlab.acme.io/team/x.git"), "gitlab:gitlab.acme.io");
        assert_eq!(auth_for(&conn, "https://bitbucket.org/acme/x.git"), "bitbucket:acme");
        assert_eq!(auth_for(&conn, "https://bitbucket.org/otro/x.git"), "", "a workspace nobody connected");
        assert_eq!(auth_for(&conn, "https://achsdev@dev.azure.com/achsdev/Proj/_git/x"), "azure:achsdev");
        assert_eq!(auth_for(&conn, "https://achsdev.visualstudio.com/Proj/_git/x"), "azure:achsdev");
        assert_eq!(auth_for(&conn, "git@github.com:acme/x.git"), "", "ssh goes through the user's own agent");
        assert_eq!(auth_for(&conn, "https://example.com/x.git"), "");
    }

    #[test]
    fn a_credential_file_is_never_handed_out() {
        for rel in [".env", "config/.env.production", "certs/server.pem", "deploy/key.p12", ".npmrc", "home/id_ed25519"] {
            assert!(sensitive(rel), "{rel}");
        }
        for rel in ["src/env.ts", "docs/keys.md", "README.md", "environment.prod.ts"] {
            assert!(!sensitive(rel), "{rel}");
        }
    }

    #[test]
    fn reading_a_file_stays_inside_the_clone_and_hides_its_secrets() {
        let repo = RefRepo { id: format!("read-{}", uuid::Uuid::new_v4().simple()), ..sample() };
        let root = repo.path();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join("src")).unwrap();
        let body: String = (1..=400).map(|n| format!("line {n}\n")).collect();
        std::fs::write(root.join("src/big.ts"), body).unwrap();
        std::fs::write(root.join("src/conf.ts"), "const token = \"ghp_abcdefghijklmnopqrstuvwxyz0123456789\";\n").unwrap();
        std::fs::write(root.join(".git/config"), "[core]\n").unwrap();
        std::fs::write(root.join(".env"), "A=1\n").unwrap();

        let first = read_file(&repo, "src/big.ts", None, None).unwrap();
        assert!(first.contains("    1 | line 1") && first.contains("  300 | line 300") && !first.contains("| line 301"));
        assert!(first.contains("start_line 301"), "{first}");
        let later = read_file(&repo, "/src/big.ts", Some(395), Some(999)).unwrap();
        assert!(later.contains("  400 | line 400"));
        assert!(!read_file(&repo, "src/conf.ts", None, None).unwrap().contains("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
        for refused in ["../../etc/passwd", ".git/config", ".env", "src", "missing.ts"] {
            assert!(read_file(&repo, refused, None, None).is_err(), "{refused}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_update_is_due_after_its_interval_and_a_failure_waits_its_turn() {
        let hour = 3_600_000;
        let now = 100 * hour;
        let repo = |pulled: Option<i64>, hours: i64, error: &str, updated: i64| RefRepo {
            id: format!("due-{pulled:?}-{hours}-{error}"),
            pulled_at: pulled,
            auto_pull_hours: hours,
            last_error: error.into(),
            updated_at: updated,
            ..sample()
        };
        assert!(is_due(&repo(Some(now - 25 * hour), 24, "", 0), now));
        assert!(!is_due(&repo(Some(now - 2 * hour), 24, "", 0), now));
        assert!(!is_due(&repo(Some(0), 0, "", 0), now), "manual only");
        assert!(is_due(&repo(None, 24, "", 0), now), "never cloned here");
        assert!(!is_due(&repo(Some(now - 30 * hour), 24, "auth", now - hour), now), "failed an hour ago");
    }

    #[test]
    fn the_model_reads_what_each_one_is_and_how_to_reach_it() {
        let text = describe(&[RefRepo { name: "Template.Node.Nest".into(), purpose: "Plantilla NestJS del equipo".into(), ..sample() }]);
        assert!(text.contains("Template.Node.Nest (branch main @ 0123456789)"), "{text}");
        assert!(text.contains("Plantilla NestJS del equipo"));
        assert!(text.contains("repo=\"<name>\"") && text.contains("read_reference_file"));
        assert_eq!(describe(&[]), "No reference repositories are enabled here.");
    }

    /// A real clone and update against a local bare repository: shallow, the branch picked, the
    /// working tree reset to what the remote has (anything written in the clone is gone).
    #[test]
    fn a_clone_is_a_shallow_mirror_that_an_update_resets() {
        let scratch = std::env::temp_dir().join(format!("refrepos-git-{}", uuid::Uuid::new_v4().simple()));
        let origin = scratch.join("origin");
        let work = scratch.join("work");
        std::fs::create_dir_all(&work).unwrap();
        let sh = |cwd: &Path, args: &[&str]| {
            let out = git(cwd, args, &[], Duration::from_secs(60)).unwrap();
            assert!(out.success, "git {args:?}: {}", out.combined());
            out.stdout.trim().to_string()
        };
        sh(&scratch, &["init", "--bare", "-b", "main", origin.to_str().unwrap()]);
        sh(&work, &["init", "-b", "main"]);
        sh(&work, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "one"]);
        std::fs::write(work.join("a.txt"), "uno\n").unwrap();
        sh(&work, &["add", "."]);
        sh(&work, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "two"]);
        sh(&work, &["push", origin.to_str().unwrap(), "main", "main:develop"]);

        // `file://`, not a bare path: git ignores --depth on a local path clone.
        let url = format!("file://{}", origin.to_string_lossy());
        let repo = RefRepo { id: format!("clone-{}", uuid::Uuid::new_v4().simple()), url, branch: String::new(), ..sample() };
        let cloned = clone_fresh(&repo).unwrap();
        assert_eq!(cloned.branch, "main", "the remote's default branch");
        assert_eq!(sh(&repo.path(), &["rev-list", "--count", "HEAD"]), "1", "shallow");
        std::fs::write(repo.path().join("a.txt"), "editado\n").unwrap();

        std::fs::write(work.join("b.txt"), "dos\n").unwrap();
        sh(&work, &["add", "."]);
        sh(&work, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "three"]);
        sh(&work, &["push", origin.to_str().unwrap(), "main"]);
        let pulled = fetch_branch(&RefRepo { head: cloned.head.clone(), branch: cloned.branch.clone(), ..repo.clone() }, "main").unwrap();
        assert_ne!(pulled.head, cloned.head);
        assert!(repo.path().join("b.txt").exists());
        assert_eq!(std::fs::read_to_string(repo.path().join("a.txt")).unwrap(), "uno\n", "a mirror keeps nothing written in it");

        let switched = fetch_branch(&repo, "develop").unwrap();
        assert_eq!(switched.branch, "develop");
        assert!(!repo.path().join("b.txt").exists(), "develop does not have the third commit");

        discard_clone(&repo.id);
        let _ = std::fs::remove_dir_all(&scratch);
    }
}
