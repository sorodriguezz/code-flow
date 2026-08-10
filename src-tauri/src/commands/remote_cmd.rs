//! The Remote workspace's command surface.
//!
//! Thin on purpose. Inventory goes straight to [`crate::db::remote_queries`]; sessions, forwards
//! and screens go straight to [`crate::remotes`]. What this layer owns is the one thing neither
//! side should: turning a stored `spec` string into a [`RemoteHostSpec`], and saying something
//! useful when that fails.
//!
//! Note what is *not* here: no `write_remote`, `resize_remote` or `close_remote`. A remote session
//! is registered in the terminal registry, so the existing `write_terminal` / `resize_terminal` /
//! `close_terminal` drive it — see [`crate::remotes::session`].

use tauri::{AppHandle, State};

use crate::db::models::{RemoteHostRow, RemoteSnippet, RemoteWorkspaceTree};
use crate::db::{remote_queries, Db};
use crate::remotes::forward::ActiveForward;
use crate::remotes::screen::ScreenLaunch;
use crate::remotes::sshconfig::ImportedHost;
use crate::remotes::{self, ForwardSpec, RemoteHostSpec};
use crate::terminal::TerminalRegistry;

/// The stored blob, as a spec.
///
/// A row whose JSON no longer parses is a real possibility — a hand-edited database, a partial
/// restore — and the useful answer names the host, because "expected value at line 1 column 1" on
/// its own leaves the user with nothing to open and fix.
fn spec_of(row: &RemoteHostRow) -> Result<RemoteHostSpec, String> {
    serde_json::from_str(&row.spec)
        .map_err(|e| format!("The saved settings for “{}” couldn't be read: {e}", row.name))
}

fn load(db: &State<'_, Db>, id: &str) -> Result<(RemoteHostRow, RemoteHostSpec), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let row = remote_queries::get_host(&conn, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "That host no longer exists.".to_string())?;
    drop(conn);
    let spec = spec_of(&row)?;
    Ok((row, spec))
}

/// The spec a *session* should run, with the host's startup snippet folded in.
///
/// **Why the snippet becomes part of the remote command rather than being typed into the pty.**
/// Writing it in after connecting means guessing when the far shell is ready to read it, and every
/// guess is wrong somewhere — a slow login, a banner, a `.bashrc` that takes a second. Splicing it
/// into the command `ssh` already carries makes it deterministic: the shell runs it because it was
/// asked to, in the order it was asked.
///
/// It is appended to any `command` the host already has rather than replacing it, and the login
/// shell is what follows, so a host with a startup snippet still lands you at a prompt.
fn session_spec(db: &State<'_, Db>, id: &str) -> Result<RemoteHostSpec, String> {
    let (_, mut spec) = load(db, id)?;
    let snippet_id = spec.startup_snippet_id.trim().to_string();
    if snippet_id.is_empty() {
        return Ok(spec);
    }

    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let body = remote_queries::get_snippet(&conn, &snippet_id)
        .map_err(|e| e.to_string())?
        .map(|snippet| snippet.body);
    drop(conn);

    // A snippet that has been deleted since it was chosen is not an error worth refusing to
    // connect over — the session is what the user asked for, and the missing snippet is visible in
    // the host's own settings.
    let Some(body) = body.filter(|body| !body.trim().is_empty()) else {
        return Ok(spec);
    };
    let body = body.trim().replace('\n', "; ");

    spec.command = match spec.command.trim() {
        "" => body,
        existing => format!("{body}; {existing}"),
    };
    Ok(spec)
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn remote_load_tree(db: State<Db>, workspace_id: String) -> Result<RemoteWorkspaceTree, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    remote_queries::load_tree(&conn, &workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remote_create_host(
    db: State<Db>,
    workspace_id: String,
    name: String,
    group_name: String,
    spec: String,
    color: String,
) -> Result<RemoteHostRow, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    remote_queries::create_host(&conn, &workspace_id, &name, &group_name, &spec, &color)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remote_update_host(db: State<Db>, row: RemoteHostRow) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    remote_queries::update_host(&conn, &row).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remote_delete_host(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    remote_queries::delete_host(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remote_duplicate_host(db: State<Db>, id: String) -> Result<RemoteHostRow, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    remote_queries::duplicate_host(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remote_reorder_hosts(db: State<Db>, ids: Vec<String>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    remote_queries::reorder_hosts(&conn, &ids).map_err(|e| e.to_string())
}

/// Creates an empty group. Idempotent — the name it returns is the group that now exists, whether
/// this call made it or found it.
#[tauri::command]
pub fn remote_create_group(
    db: State<Db>,
    workspace_id: String,
    name: String,
) -> Result<crate::db::models::RemoteGroupRow, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    remote_queries::create_group(&conn, &workspace_id, name.trim()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remote_rename_group(
    db: State<Db>,
    workspace_id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    remote_queries::rename_group(&conn, &workspace_id, &from, to.trim()).map_err(|e| e.to_string())
}

/// Deletes a group. Its hosts move to ungrouped — see [`remote_queries::delete_group`] for why they
/// are never deleted with it.
#[tauri::command]
pub fn remote_delete_group(
    db: State<Db>,
    workspace_id: String,
    name: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    remote_queries::delete_group(&conn, &workspace_id, &name).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/// Saves (or clears, with an empty value) the host's password or key passphrase.
///
/// Worth being clear about what this *is not*: `ssh` refuses to read a password from anywhere a
/// program could supply it, deliberately, so nothing here can log the user in unattended. This is a
/// vault entry the user copies from when the prompt appears — which is the honest version of what
/// every SSH client that "saves passwords" without an agent is doing.
#[tauri::command]
pub fn remote_set_password(id: String, password: String) -> Result<(), String> {
    let key = remotes::password_key(&id);
    if password.is_empty() {
        crate::secrets::delete_secret(&key)
    } else {
        crate::secrets::set_secret(&key, &password)
    }
}

#[tauri::command]
pub fn remote_get_password(id: String) -> Result<Option<String>, String> {
    crate::secrets::get_secret(&remotes::password_key(&id))
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

/// Records what was opened and how it went.
///
/// Best-effort by design: a log write that failed must never be the reason a connection is
/// reported as failed. Nothing here returns a `Result` to its caller for that reason.
fn log(db: &State<'_, Db>, row: &RemoteHostRow, kind: &str, detail: &str, error: &str) {
    if let Ok(conn) = db.0.lock() {
        let _ = remote_queries::add_log(
            &conn,
            &row.workspace_id,
            &row.id,
            &row.name,
            kind,
            detail,
            error,
        );
    }
}

/// Records the outcome of an operation and passes it straight through, so the call site stays one
/// expression instead of a match that exists only to log.
fn logged<T>(
    db: &State<'_, Db>,
    row: &RemoteHostRow,
    kind: &str,
    detail: &str,
    outcome: Result<T, String>,
) -> Result<T, String> {
    match &outcome {
        Ok(_) => log(db, row, kind, detail, ""),
        Err(error) => log(db, row, kind, detail, error),
    }
    outcome
}

#[tauri::command]
pub fn remote_list_logs(
    db: State<Db>,
    workspace_id: String,
    limit: i64,
) -> Result<Vec<crate::db::models::RemoteLogEntry>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    remote_queries::list_logs(&conn, &workspace_id, limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remote_clear_logs(db: State<Db>, workspace_id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    remote_queries::clear_logs(&conn, &workspace_id).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/// Opens a shell on a host. The reply is a terminal session id — drive it with `write_terminal`,
/// `resize_terminal` and `close_terminal`.
#[tauri::command]
pub fn remote_open_session(
    app: AppHandle,
    registry: State<TerminalRegistry>,
    db: State<Db>,
    id: String,
) -> Result<String, String> {
    let (row, _) = load(&db, &id)?;
    let spec = session_spec(&db, &id)?;
    let detail = spec.destination();
    logged(&db, &row, "session", &detail, remotes::session::open(app, &registry, &spec))
}

/// A one-off session against a spec that hasn't been saved yet — the "Test" button in the host
/// editor. Deliberately takes the spec rather than an id, so testing an edit tests the edit rather
/// than what is still on disk.
#[tauri::command]
pub fn remote_open_draft_session(
    app: AppHandle,
    registry: State<TerminalRegistry>,
    spec: RemoteHostSpec,
) -> Result<String, String> {
    remotes::session::open(app, &registry, &spec)
}

// ---------------------------------------------------------------------------
// Forwards
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn remote_open_forward(
    db: State<'_, Db>,
    host_id: String,
    forward: ForwardSpec,
) -> Result<ActiveForward, String> {
    let (row, spec) = load(&db, &host_id)?;
    let detail = format!("{:?} :{}", forward.kind, forward.listen_port);
    logged(&db, &row, "forward", &detail, remotes::forward::open(&host_id, &spec, &forward).await)
}

#[tauri::command]
pub fn remote_close_forward(id: String) {
    remotes::forward::close(&id);
}

#[tauri::command]
pub fn remote_close_host_forwards(host_id: String) {
    remotes::forward::close_host(&host_id);
}

/// Every live forward, across every host.
///
/// Polled by the status bar rather than pushed, because the interesting change — the far end
/// dying — produces no event to push: it is noticed by [`remotes::forward::list`] finding the child
/// gone, which only happens when something asks.
#[tauri::command]
pub fn remote_list_forwards() -> Vec<ActiveForward> {
    remotes::forward::list()
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn remote_open_screen(db: State<'_, Db>, id: String) -> Result<ScreenLaunch, String> {
    let (row, spec) = load(&db, &id)?;
    let detail = spec.kind.label().to_string();
    logged(&db, &row, "screen", &detail, remotes::screen::open(&id, &spec).await)
}

/// Closes the screen's tunnel. Not the viewer — that is the user's own window.
#[tauri::command]
pub fn remote_close_screen(id: String) {
    remotes::screen::close(&id);
}

// ---------------------------------------------------------------------------
// Azure Queue storage
// ---------------------------------------------------------------------------
//
// One command per verb rather than one that takes an action string, so the argument each needs is
// in its own signature — a `delete` that requires a pop receipt and a `peek` that must not have one
// are not the same call with a flag.

#[tauri::command]
pub async fn remote_queues(db: State<'_, Db>, id: String) -> Result<Vec<remotes::cloud::queue::QueueSummary>, String> {
    let (_, spec) = load(&db, &id)?;
    remotes::cloud::queue::queues(&id, &spec).await
}

/// Reads the front of a queue **without consuming anything** — see `remotes::cloud::queue`.
#[tauri::command]
pub async fn remote_queue_peek(
    db: State<'_, Db>,
    id: String,
    queue: String,
    count: usize,
) -> Result<Vec<remotes::cloud::queue::QueueMessage>, String> {
    let (_, spec) = load(&db, &id)?;
    remotes::cloud::queue::peek(&id, &spec, &queue, count).await
}

/// The destructive read. Logged, unlike a peek, because it changes what the next reader sees.
#[tauri::command]
pub async fn remote_queue_receive(
    db: State<'_, Db>,
    id: String,
    queue: String,
    count: usize,
    visibility: u32,
) -> Result<Vec<remotes::cloud::queue::QueueMessage>, String> {
    let (row, spec) = load(&db, &id)?;
    let result = remotes::cloud::queue::receive(&id, &spec, &queue, count, visibility).await;
    logged(&db, &row, "queue-receive", &queue, result)
}

#[tauri::command]
pub async fn remote_queue_put(
    db: State<'_, Db>,
    id: String,
    queue: String,
    text: String,
) -> Result<(), String> {
    let (row, spec) = load(&db, &id)?;
    let result = remotes::cloud::queue::put(&id, &spec, &queue, &text).await;
    logged(&db, &row, "queue-put", &queue, result)
}

#[tauri::command]
pub async fn remote_queue_delete_message(
    db: State<'_, Db>,
    id: String,
    queue: String,
    message_id: String,
    pop_receipt: String,
) -> Result<(), String> {
    let (row, spec) = load(&db, &id)?;
    let result =
        remotes::cloud::queue::delete(&id, &spec, &queue, &message_id, &pop_receipt).await;
    logged(&db, &row, "queue-delete", &queue, result)
}

#[tauri::command]
pub async fn remote_queue_clear(db: State<'_, Db>, id: String, queue: String) -> Result<(), String> {
    let (row, spec) = load(&db, &id)?;
    let result = remotes::cloud::queue::clear(&id, &spec, &queue).await;
    logged(&db, &row, "queue-clear", &queue, result)
}

#[tauri::command]
pub async fn remote_queue_create(db: State<'_, Db>, id: String, queue: String) -> Result<(), String> {
    let (row, spec) = load(&db, &id)?;
    let result = remotes::cloud::queue::create(&id, &spec, &queue).await;
    logged(&db, &row, "queue-create", &queue, result)
}

#[tauri::command]
pub async fn remote_queue_remove(db: State<'_, Db>, id: String, queue: String) -> Result<(), String> {
    let (row, spec) = load(&db, &id)?;
    let result = remotes::cloud::queue::remove(&id, &spec, &queue).await;
    logged(&db, &row, "queue-remove", &queue, result)
}

// ---------------------------------------------------------------------------
// Azure Table storage
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn remote_tables(db: State<'_, Db>, id: String) -> Result<Vec<remotes::cloud::table::TableSummary>, String> {
    let (_, spec) = load(&db, &id)?;
    remotes::cloud::table::tables(&id, &spec).await
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn remote_table_query(
    db: State<'_, Db>,
    id: String,
    table: String,
    filter: String,
    select: String,
    from_partition: String,
    from_row: String,
) -> Result<remotes::cloud::table::TablePage, String> {
    let (_, spec) = load(&db, &id)?;
    remotes::cloud::table::query(&id, &spec, &table, &filter, &select, &from_partition, &from_row).await
}

#[tauri::command]
pub async fn remote_table_upsert(
    db: State<'_, Db>,
    id: String,
    table: String,
    entity: serde_json::Value,
) -> Result<(), String> {
    let (row, spec) = load(&db, &id)?;
    let result = remotes::cloud::table::upsert(&id, &spec, &table, entity).await;
    logged(&db, &row, "table-upsert", &table, result)
}

#[tauri::command]
pub async fn remote_table_delete_entity(
    db: State<'_, Db>,
    id: String,
    table: String,
    partition: String,
    row_key: String,
) -> Result<(), String> {
    let (row, spec) = load(&db, &id)?;
    let result = remotes::cloud::table::delete_entity(&id, &spec, &table, &partition, &row_key).await;
    logged(&db, &row, "table-delete", &table, result)
}

#[tauri::command]
pub async fn remote_table_create(db: State<'_, Db>, id: String, table: String) -> Result<(), String> {
    let (row, spec) = load(&db, &id)?;
    let result = remotes::cloud::table::create(&id, &spec, &table).await;
    logged(&db, &row, "table-create", &table, result)
}

#[tauri::command]
pub async fn remote_table_remove(db: State<'_, Db>, id: String, table: String) -> Result<(), String> {
    let (row, spec) = load(&db, &id)?;
    let result = remotes::cloud::table::remove(&id, &spec, &table).await;
    logged(&db, &row, "table-remove", &table, result)
}

/// Parses a typed or pasted `ssh` command line. `None` when it names no destination — which is the
/// normal state of a field being typed into, not an error.
#[tauri::command]
pub fn remote_parse_ssh_command(line: String) -> Option<remotes::parse::ParsedCommand> {
    remotes::parse::parse_ssh_command(&line)
}

/// The identities this machine already has — keys in `~/.ssh` plus whatever the agent holds.
/// Read-only by design; see [`remotes::keys`].
#[tauri::command]
pub fn remote_list_keys() -> Vec<remotes::keys::SshKey> {
    remotes::keys::list()
}

/// Round-trip time to a host's SSH port, or `null` when there is no direct route from here.
/// See [`remotes::ping`] for what that measures and why it is often nothing.
#[tauri::command]
pub async fn remote_ping(db: State<'_, Db>, id: String) -> Result<Option<u32>, String> {
    let (_, spec) = load(&db, &id)?;
    Ok(remotes::ping::measure(&spec).await)
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/// Lists a directory on the far side. An empty `path` means the login directory.
#[tauri::command]
pub async fn remote_list_files(
    db: State<'_, Db>,
    host_id: String,
    path: String,
) -> Result<remotes::files::RemoteListing, String> {
    let (row, spec) = load(&db, &host_id)?;
    let outcome = remotes::files::list(&host_id, &spec, &path).await;
    // Only the *first* listing of a session is logged — every directory the user clicks into would
    // otherwise be a row, and the interesting event is whether the file session opened at all.
    if outcome.is_err() || path.trim().is_empty() {
        let error = outcome.as_ref().err().cloned().unwrap_or_default();
        log(&db, &row, "files", &path, &error);
    }
    outcome
}

/// The local half of the dual pane. Takes no host: it is this machine.
#[tauri::command]
pub fn remote_list_local_files(path: String) -> Result<remotes::files::RemoteListing, String> {
    remotes::files::list_local(&path)
}

/// Downloads a file, or a whole directory when `remote_path` is one.
///
/// `id` is the caller's handle on this transfer: `remote:transfer` events carry it back, so a
/// progress bar can tell its own events from a previous transfer's arriving late.
#[tauri::command]
pub async fn remote_download_file(
    app: AppHandle,
    db: State<'_, Db>,
    id: String,
    host_id: String,
    remote_path: String,
    local_path: String,
) -> Result<(), String> {
    let (_, spec) = load(&db, &host_id)?;
    remotes::files::download(&app, &id, &host_id, &spec, &remote_path, &local_path).await
}

/// Uploads a file, or a whole directory when `local_path` is one. See [`remote_download_file`]
/// for what `id` is.
#[tauri::command]
pub async fn remote_upload_file(
    app: AppHandle,
    db: State<'_, Db>,
    id: String,
    host_id: String,
    local_path: String,
    remote_path: String,
) -> Result<(), String> {
    let (_, spec) = load(&db, &host_id)?;
    remotes::files::upload(&app, &id, &host_id, &spec, &local_path, &remote_path).await
}

#[tauri::command]
pub async fn remote_make_dir(
    db: State<'_, Db>,
    host_id: String,
    path: String,
) -> Result<(), String> {
    let (_, spec) = load(&db, &host_id)?;
    remotes::files::make_dir(&host_id, &spec, &path).await
}

/// Deletes one file or one empty directory. Never recursive — see [`remotes::files::remove`].
#[tauri::command]
pub async fn remote_remove_file(
    db: State<'_, Db>,
    host_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let (_, spec) = load(&db, &host_id)?;
    remotes::files::remove(&host_id, &spec, &path, is_dir).await
}

#[tauri::command]
pub async fn remote_rename_file(
    db: State<'_, Db>,
    host_id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let (_, spec) = load(&db, &host_id)?;
    remotes::files::rename(&host_id, &spec, &from, &to).await
}

#[tauri::command]
pub async fn remote_close_files(host_id: String) {
    remotes::files::close(&host_id).await;
}

// ---------------------------------------------------------------------------
// `~/.ssh/config`
// ---------------------------------------------------------------------------

/// What the user's SSH config holds, without importing any of it — so the import dialog can list
/// what it would create and let the user choose.
/// Where this machine's SSH config lives, spelled out.
///
/// Not a constant on the frontend: `~/.ssh/config` is a lie on Windows, where it is
/// `C:\Users\<you>\.ssh\config` — and the import dialog naming the wrong path is exactly the
/// thing that sends someone looking in the wrong place.
#[tauri::command]
pub fn remote_ssh_config_path() -> String {
    remotes::sshconfig::config_path()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_default()
}

#[tauri::command]
pub fn remote_scan_ssh_config() -> Result<Vec<ImportedHost>, String> {
    remotes::sshconfig::scan()
}

/// How an import went. Skipped names are reported rather than counted, because "3 skipped" invites
/// the question this answers.
#[derive(serde::Serialize)]
pub struct ImportResult {
    pub created: Vec<RemoteHostRow>,
    pub skipped: Vec<String>,
}

/// Imports the named hosts from `~/.ssh/config`, skipping any whose name this workspace already
/// uses — so running it again after adding a machine to the config adds only the new machine,
/// rather than a second copy of everything.
#[tauri::command]
pub fn remote_import_ssh_config(
    db: State<Db>,
    workspace_id: String,
    names: Vec<String>,
    group_name: String,
) -> Result<ImportResult, String> {
    let available = remotes::sshconfig::scan()?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let mut created = Vec::new();
    let mut skipped = Vec::new();

    for name in &names {
        let Some(host) = available.iter().find(|h| &h.name == name) else {
            skipped.push(name.clone());
            continue;
        };
        if remote_queries::host_name_taken(&conn, &workspace_id, name).map_err(|e| e.to_string())? {
            skipped.push(name.clone());
            continue;
        }
        let spec = serde_json::to_string(&host.spec).map_err(|e| e.to_string())?;
        created.push(
            remote_queries::create_host(&conn, &workspace_id, name, &group_name, &spec, "")
                .map_err(|e| e.to_string())?,
        );
    }

    Ok(ImportResult { created, skipped })
}

// ---------------------------------------------------------------------------
// Snippets
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn remote_create_snippet(
    db: State<Db>,
    workspace_id: String,
    name: String,
    body: String,
) -> Result<RemoteSnippet, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    remote_queries::create_snippet(&conn, &workspace_id, &name, &body).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remote_update_snippet(db: State<Db>, snippet: RemoteSnippet) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    remote_queries::update_snippet(&conn, &snippet).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remote_delete_snippet(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    remote_queries::delete_snippet(&conn, &id).map_err(|e| e.to_string())
}
