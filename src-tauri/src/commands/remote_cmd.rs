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

/// The body of the host's "run on connect" snippet, if it has one that still exists.
///
/// **Why the snippet travels in the remote command rather than being typed into the pty.** Writing
/// it in after connecting means guessing when the far shell is ready to read it, and every guess is
/// wrong somewhere — a slow login, a banner, a `.bashrc` that takes a second. Carrying it in the
/// command `ssh` already sends makes it deterministic: the shell runs it because it was asked to, in
/// the order it was asked — and then carries on into the login shell, or into the host's own
/// `command`. How it is carried, intact, is [`remotes::session::remote_command`]'s business.
///
/// Its own function over a plain connection, so what the snippet resolves to can be tested against
/// a real schema without a Tauri `State`.
fn startup_script(conn: &rusqlite::Connection, spec: &RemoteHostSpec) -> Result<Option<String>, String> {
    let snippet_id = spec.startup_snippet_id.trim();
    if snippet_id.is_empty() {
        return Ok(None);
    }
    let body = remote_queries::get_snippet(conn, snippet_id)
        .map_err(|e| e.to_string())?
        .map(|snippet| snippet.body);
    // A snippet that has been deleted since it was chosen is not an error worth refusing to
    // connect over — the session is what the user asked for, and the missing snippet is visible in
    // the host's own settings.
    Ok(body.filter(|body| !body.trim().is_empty()))
}

/// The spec a *session* should run, and its startup script.
fn session_spec(db: &State<'_, Db>, id: &str) -> Result<(RemoteHostSpec, Option<String>), String> {
    let (_, spec) = load(db, id)?;
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    let script = startup_script(&conn, &spec)?;
    Ok((spec, script))
}

/// Whether an edit changed how the host is *reached* — which is when a held file session is stale.
///
/// Compared on everything but what cannot matter to a connection: labels, notes, the shell's
/// command and directory, the screen, the forwards list. A field added to the spec later counts as
/// a connection setting until it is listed here, because keeping a session connected with the old
/// settings is the failure being fixed, and dropping one that was fine only costs a reconnect.
fn connection_changed(before: &str, after: &str) -> bool {
    const COSMETIC: &[&str] =
        &["tags", "notes", "os", "command", "directory", "startup_snippet_id", "screen", "forwards"];
    let reach = |text: &str| -> Option<serde_json::Value> {
        let spec: RemoteHostSpec = serde_json::from_str(text).ok()?;
        let mut value = serde_json::to_value(spec).ok()?;
        let object = value.as_object_mut()?;
        for key in COSMETIC {
            object.remove(*key);
        }
        Some(value)
    };
    match (reach(before), reach(after)) {
        (Some(before), Some(after)) => before != after,
        _ => true,
    }
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

/// Saves a host. Returns whether the edit changed how it is reached — in which case its held file
/// session, opened with the old settings, has been closed, and the browser should list again.
///
/// Closed here rather than by the caller because every writer of a host row comes through this
/// command, and a session connected to the address a host *used* to have is wrong whoever edited it.
#[tauri::command]
pub async fn remote_update_host(db: State<'_, Db>, row: RemoteHostRow) -> Result<bool, String> {
    let before = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        let before = remote_queries::get_host(&conn, &row.id).map_err(|e| e.to_string())?;
        remote_queries::update_host(&conn, &row).map_err(|e| e.to_string())?;
        before
    };
    let changed = before.is_some_and(|before| connection_changed(&before.spec, &row.spec));
    if changed {
        remotes::files::close(&row.id).await;
    }
    Ok(changed)
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
/// `ssh` refuses to read a password from anywhere a program could supply it, deliberately, so this
/// is not an unattended login. What uses it: a session types it into its own prompt on request
/// ([`remote_type_password`]), a background `ssh` is handed it once through `SSH_ASKPASS`
/// ([`remotes::askpass`]), and FTP/SMB log in with it directly.
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

/// Types the host's saved password into one of its sessions, and Enter — only at a prompt that is
/// asking for one, unless `force`. The password is read and written here and never crosses into
/// the webview; see [`remotes::session::type_password`].
#[tauri::command]
pub fn remote_type_password(
    registry: State<TerminalRegistry>,
    host_id: String,
    session_id: String,
    force: Option<bool>,
) -> Result<(), String> {
    remotes::session::type_password(&registry, &session_id, &host_id, force.unwrap_or(false))
}

/// Whether a background `ssh` on this machine can be handed a saved password. The host editor asks
/// before offering a password to a kind whose only transport is a background `ssh` (SFTP): where the
/// answer is no, that option could never work.
#[tauri::command]
pub async fn remote_askpass_supported() -> bool {
    tokio::task::spawn_blocking(remotes::askpass::supported).await.unwrap_or(false)
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
    let (spec, startup) = session_spec(&db, &id)?;
    let detail = spec.destination();
    let opened = remotes::session::open(app, &registry, &spec, startup.as_deref(), Some(&id));
    logged(&db, &row, "session", &detail, opened)
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
    remotes::session::open(app, &registry, &spec, None, None)
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
// Connections held open
// ---------------------------------------------------------------------------
//
// Two commands rather than one taking a verb, because the UI has two different questions — "may I
// honestly offer Disconnect on this row" and "let go of this one".
//
// Note what neither of them releases: a shell. A remote session is a terminal session (see the
// module header), so `close_terminal` is what ends one, and the tab that owns its id is the only
// thing that knows which host it belongs to.

/// What every host is holding open right now.
///
/// Polled on the same tick as [`remote_list_forwards`], and for the same reason: an `ssh` that dies
/// pushes no event. A host holding nothing is absent rather than present with zeros.
#[tauri::command]
pub async fn remote_host_holds() -> Vec<remotes::hold::HostHold> {
    remotes::hold::all().await
}

/// Lets go of everything one host is holding: its forwards, its screen's tunnel and bridge route,
/// and its file session.
///
/// Not logged, unlike opening any of them. The log records what was *opened* against a host and how
/// it went; a release has no outcome, and it must work for a host whose row has already been
/// deleted — which is exactly when `load` could not find a name to log against.
#[tauri::command]
pub async fn remote_disconnect_host(host_id: String) {
    remotes::hold::release(&host_id).await;
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

/// The depths of a batch of queues. Separate from the listing so the names can be drawn before the
/// numbers exist — see `remotes::cloud::queue::queues`. The caller asks in batches so that a panel
/// can count up as they land rather than waiting for all of them.
#[tauri::command]
pub async fn remote_queue_depths(
    db: State<'_, Db>,
    id: String,
    queues: Vec<String>,
) -> Result<Vec<i64>, String> {
    let (_, spec) = load(&db, &id)?;
    remotes::cloud::queue::depths(&id, &spec, &queues).await
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

/// Checks that a cloud account answers, and says how much is at its root.
///
/// The Connect button's honest verb for a kind that has no session to open — see
/// [`remotes::cloud::check`]. Logged like every other thing opened against a host, because "the key
/// was rejected at 14:02" is exactly the kind of fact the log exists to outlive the toast.
#[tauri::command]
pub async fn remote_check_cloud(db: State<'_, Db>, id: String) -> Result<usize, String> {
    let (row, spec) = load(&db, &id)?;
    let result = remotes::cloud::check(&id, &spec).await;
    logged(&db, &row, "cloud-check", spec.kind.label(), result)
}

/// What an Azure Storage connection string was understood to mean.
///
/// The secret rides in its own field and never in `spec`, which is the whole point of the split:
/// `spec` is what gets written to the workspace database as JSON, and an account key belongs in the
/// keychain. The caller stores it with `remote_set_password` once the row it belongs to exists.
#[derive(serde::Serialize)]
pub struct ParsedAzureConnection {
    pub spec: RemoteHostSpec,
    /// What to call the row — the account name.
    pub name: String,
    /// The account key or SAS token, for the keychain. Empty for a string that carried neither.
    pub secret: String,
    /// Which credential the string turned out to carry, so the preview can say so before anything
    /// is saved.
    pub auth: remotes::AzureAuth,
}

/// Reads one pasted connection string — the `AccountName=…;AccountKey=…` line, a SAS string, or a
/// SAS URL. `None` when it names no account, which is the normal state of a field being typed into.
///
/// In Rust for the same reason the `ssh` parser is: it is a parser, that is where the tests are, and
/// the three shapes people paste are not obvious enough to re-derive in the UI. See
/// [`remotes::cloud::azure::parse_connection_string`].
#[tauri::command]
pub fn remote_parse_azure_connection(text: String) -> Option<ParsedAzureConnection> {
    let parsed = remotes::cloud::azure::parse_connection_string(&text)?;
    let auth = if parsed.sas.is_empty() {
        remotes::AzureAuth::AccountKey
    } else {
        remotes::AzureAuth::Sas
    };
    let secret = if parsed.sas.is_empty() { parsed.key.clone() } else { parsed.sas.clone() };

    let mut spec = RemoteHostSpec { kind: remotes::RemoteKind::Azure, ..Default::default() };
    spec.azure.auth = auth;
    spec.azure.account = parsed.account.clone();
    spec.azure.endpoint_suffix = parsed.suffix;
    spec.azure.endpoint = parsed.endpoint;

    let name = if parsed.account.is_empty() { "Azure Storage".to_string() } else { parsed.account };
    Some(ParsedAzureConnection { spec, name, secret, auth })
}

/// The identities this machine already has — keys in `~/.ssh` plus whatever the agent holds.
/// Discovered, never stored; see [`remotes::keys`].
#[tauri::command]
pub fn remote_list_keys() -> Vec<remotes::keys::SshKey> {
    remotes::keys::list()
}

/// Makes a new ed25519 key at `~/.ssh/<name>` with `ssh-keygen`, refusing any name that exists.
/// The key is the user's, in `~/.ssh`, like one they made in a terminal — see [`remotes::keys`].
#[tauri::command]
pub async fn remote_generate_key(
    name: String,
    passphrase: String,
    comment: String,
) -> Result<remotes::keys::SshKey, String> {
    tokio::task::spawn_blocking(move || remotes::keys::generate(&name, &passphrase, &comment))
        .await
        .map_err(|e| e.to_string())?
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

/// Lists one page of a directory on the far side. An empty `path` means the login directory.
///
/// `page` carries the prefix and the continuation marker. Omitting it lists from the beginning with
/// no filter, which is what every caller that is not the object browser wants.
#[tauri::command]
pub async fn remote_list_files(
    db: State<'_, Db>,
    host_id: String,
    path: String,
    page: Option<remotes::files::ListPage>,
) -> Result<remotes::files::RemoteListing, String> {
    let (row, spec) = load(&db, &host_id)?;
    let page = page.unwrap_or_default();
    let outcome = remotes::files::list(&host_id, &spec, &path, &page).await;
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

/// Asks a running transfer to stop. It stops at its next chunk, removes the partial file it was
/// writing, and answers [`remotes::files::TRANSFER_CANCELLED`]. A no-op for one that has ended.
#[tauri::command]
pub fn remote_cancel_transfer(id: String) {
    remotes::files::cancel(&id);
}

/// Which of `paths` already exist — on the host, or on this machine when `local` is set. What the
/// browser asks before a transfer that would overwrite; see [`remotes::files::exist`].
#[tauri::command]
pub async fn remote_paths_exist(
    db: State<'_, Db>,
    host_id: String,
    paths: Vec<String>,
    local: bool,
) -> Result<Vec<bool>, String> {
    if local {
        return remotes::files::exist(&host_id, &RemoteHostSpec::default(), &paths, true).await;
    }
    let (_, spec) = load(&db, &host_id)?;
    remotes::files::exist(&host_id, &spec, &paths, false).await
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

// ---------------------------------------------------------------------------
// Blob storage beyond the seven verbs
// ---------------------------------------------------------------------------

/// Which module answers for a path, given the host's kind.
///
/// The five commands below are Azure Blob's alone — S3 has no snapshots, SFTP has no access tier —
/// so rather than five copies of the same refusal they share one gate, and it names the kind that
/// arrived instead of failing somewhere deeper with a signature error.
fn blob_path(spec: &RemoteHostSpec, path: &str) -> Result<String, String> {
    if !spec.kind.is_azure() {
        return Err(spec.kind.refuses("do this"));
    }
    remotes::cloud::account::blob_leg(path)
}

/// Deletes a whole top-level namespace and everything in it — a container, a share or a bucket.
///
/// **One command for the three names because it is one idea**: the thing the root of a store holds,
/// which every service spells differently and which none of them lets you delete by accident. Its
/// own command rather than a flag on `remote_remove_file`, because the difference is not a
/// parameter: the ordinary delete is what a selected row and a keypress reach, and this takes
/// everything under a name with it. The UI asks the user to type that name first; the split here is
/// what makes that more than a UI convention.
///
/// The two services do differ in one way worth knowing: Azure's delete is recursive and takes every
/// blob with it, while S3 refuses a bucket that still has objects in it. Neither is emulated here —
/// each service's own rule is the one that applies.
#[tauri::command]
pub async fn remote_delete_container(
    db: State<'_, Db>,
    host_id: String,
    path: String,
) -> Result<(), String> {
    let (row, spec) = load(&db, &host_id)?;
    let outcome = if spec.kind.is_azure() {
        remotes::cloud::account::remove_top(&host_id, &spec, &path).await
    } else if spec.kind == remotes::RemoteKind::S3 {
        remotes::cloud::s3::remove_bucket(&host_id, &spec, &path).await
    } else {
        Err(spec.kind.refuses("delete a container"))
    };
    // Logged whatever happens, unlike an ordinary delete: this is the one irreversible thing the
    // browser can do, and "who removed that container" is a question that gets asked later.
    log(&db, &row, "files", &format!("delete container {path}"), outcome.as_ref().err().map(String::as_str).unwrap_or_default());
    outcome
}

/// Copies a blob to another path, server-side — the bytes never come through this machine.
#[tauri::command]
pub async fn remote_blob_copy(
    db: State<'_, Db>,
    host_id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let (_, spec) = load(&db, &host_id)?;
    let from = blob_path(&spec, &from)?;
    let to = blob_path(&spec, &to)?;
    remotes::cloud::blob::copy(&host_id, &spec, &from, &to).await
}

/// Everything the service will say about one blob or container.
#[tauri::command]
pub async fn remote_blob_properties(
    db: State<'_, Db>,
    host_id: String,
    path: String,
) -> Result<remotes::cloud::blob::Properties, String> {
    let (_, spec) = load(&db, &host_id)?;
    let inner = blob_path(&spec, &path)?;
    let mut properties = remotes::cloud::blob::properties(&host_id, &spec, &inner).await?;
    // Back into the browser's own vocabulary, where the service is the first segment.
    properties.path = path;
    Ok(properties)
}

/// Freezes the blob as it is now. Returns the stamp that identifies the snapshot.
#[tauri::command]
pub async fn remote_blob_snapshot(
    db: State<'_, Db>,
    host_id: String,
    path: String,
) -> Result<String, String> {
    let (_, spec) = load(&db, &host_id)?;
    let inner = blob_path(&spec, &path)?;
    remotes::cloud::blob::snapshot(&host_id, &spec, &inner).await
}

/// Every snapshot of one blob, newest first.
#[tauri::command]
pub async fn remote_blob_snapshots(
    db: State<'_, Db>,
    host_id: String,
    path: String,
) -> Result<Vec<remotes::cloud::blob::Snapshot>, String> {
    let (_, spec) = load(&db, &host_id)?;
    let inner = blob_path(&spec, &path)?;
    remotes::cloud::blob::snapshots(&host_id, &spec, &inner).await
}

/// Deletes one snapshot, leaving the blob and the rest of its history alone.
#[tauri::command]
pub async fn remote_blob_delete_snapshot(
    db: State<'_, Db>,
    host_id: String,
    path: String,
    stamp: String,
) -> Result<(), String> {
    let (_, spec) = load(&db, &host_id)?;
    let inner = blob_path(&spec, &path)?;
    remotes::cloud::blob::delete_snapshot(&host_id, &spec, &inner, &stamp).await
}

/// Puts a snapshot's bytes back over the blob it came from.
#[tauri::command]
pub async fn remote_blob_restore_snapshot(
    db: State<'_, Db>,
    host_id: String,
    path: String,
    stamp: String,
) -> Result<(), String> {
    let (_, spec) = load(&db, &host_id)?;
    let inner = blob_path(&spec, &path)?;
    remotes::cloud::blob::restore_snapshot(&host_id, &spec, &inner, &stamp).await
}

// ---------------------------------------------------------------------------
// Signing in with a Microsoft account
// ---------------------------------------------------------------------------

/// One storage account the signed-in identity can see, ready to become a host row.
#[derive(serde::Serialize)]
pub struct DiscoveredHost {
    pub account: remotes::cloud::arm::DiscoveredAccount,
    /// The row this would create, so the picker can show exactly what it is about to save and the
    /// caller can hand it straight to `remote_create_host` without rebuilding it.
    pub spec: RemoteHostSpec,
}

/// Every storage account the Azure CLI's session can reach, across every enabled subscription.
///
/// No key is fetched and none is stored: the rows come back configured for Entra, so the identity
/// that listed the accounts is the identity that will read them. See [`remotes::cloud::arm`] for why
/// the sign-in is the CLI's rather than one of our own.
#[tauri::command]
pub async fn remote_discover_azure(tenant: String) -> Result<Vec<DiscoveredHost>, String> {
    let accounts = remotes::cloud::arm::discover(tenant.trim()).await?;
    Ok(accounts
        .into_iter()
        .map(|account| DiscoveredHost { spec: account.spec(), account })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remotes::{RemoteKind, RemoteOs};

    fn db() -> rusqlite::Connection {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrations::run(&conn).unwrap();
        conn.execute(
            "INSERT INTO workspaces (id, name, created_at, sort_order) VALUES ('w1', 'W', 't', 0)",
            [],
        )
        .unwrap();
        conn
    }

    fn host(snippet: &str) -> RemoteHostSpec {
        RemoteHostSpec {
            host: "web-01.example.com".into(),
            user: "deploy".into(),
            startup_snippet_id: snippet.into(),
            ..Default::default()
        }
    }

    /// What a session on this host would send as its remote command — the two halves the command
    /// layer puts together, the snippet from the database and the form from `session`.
    fn session_command(conn: &rusqlite::Connection, spec: &RemoteHostSpec) -> Option<String> {
        let script = startup_script(conn, spec).unwrap();
        remotes::session::remote_command(spec, script.as_deref())
    }

    #[test]
    fn a_host_without_a_snippet_opens_a_plain_login_shell() {
        let conn = db();
        assert_eq!(startup_script(&conn, &host("")).unwrap(), None);
        assert_eq!(session_command(&conn, &host("")), None);
    }

    /// The reported bug, end to end: "run on connect" used to *be* the remote command, so the
    /// session ended with the snippet — and its newlines were flattened into `; `.
    #[test]
    fn a_startup_snippet_arrives_whole_and_is_followed_by_the_login_shell() {
        let conn = db();
        let body = "# first line is a comment\nif true; then\n  echo ready\nfi";
        let snippet = remote_queries::create_snippet(&conn, "w1", "boot", body).unwrap();
        let spec = host(&snippet.id);

        assert_eq!(startup_script(&conn, &spec).unwrap().as_deref(), Some(body));
        let command = session_command(&conn, &spec).unwrap();
        assert!(command.starts_with("eval \"$(printf '"), "{command}");
        assert!(command.ends_with("')\"; exec $SHELL -l"), "the session carries on: {command}");
        assert!(!command.contains("; if"), "the lines were not joined into one: {command}");
    }

    #[test]
    fn a_windows_host_runs_its_snippet_as_a_batch_file_and_keeps_the_prompt() {
        let conn = db();
        let snippet = remote_queries::create_snippet(&conn, "w1", "boot", "cd /d D:\\app\nset A=1").unwrap();
        let mut spec = host(&snippet.id);
        spec.os = RemoteOs::Windows;
        let command = session_command(&conn, &spec).unwrap();
        assert!(command.starts_with("powershell -NoProfile -NonInteractive -EncodedCommand "), "{command}");
        assert!(command.contains(" && cmd /d /k \"%TEMP%\\codeflow-startup-"), "{command}");
    }

    #[test]
    fn a_deleted_or_blank_snippet_connects_as_if_there_were_none() {
        let conn = db();
        assert_eq!(startup_script(&conn, &host("gone")).unwrap(), None);
        let blank = remote_queries::create_snippet(&conn, "w1", "blank", "  \n").unwrap();
        assert_eq!(startup_script(&conn, &host(&blank.id)).unwrap(), None);
    }

    #[test]
    fn a_saved_command_still_runs_after_the_snippet() {
        let conn = db();
        let snippet = remote_queries::create_snippet(&conn, "w1", "boot", "cd /srv").unwrap();
        let mut spec = host(&snippet.id);
        spec.command = "docker compose logs -f".into();
        let command = session_command(&conn, &spec).unwrap();
        assert!(command.ends_with("')\"; docker compose logs -f"), "{command}");
    }

    #[test]
    fn only_an_edit_to_how_a_host_is_reached_closes_its_file_session() {
        let before = serde_json::to_string(&host("")).unwrap();
        let mut spec = host("");
        spec.tags = vec!["prod".into()];
        spec.notes = "rebooted on Friday".into();
        spec.command = "htop".into();
        assert!(!connection_changed(&before, &serde_json::to_string(&spec).unwrap()));

        for change in [
            |s: &mut RemoteHostSpec| s.host = "web-02.example.com".into(),
            |s: &mut RemoteHostSpec| s.port = 2222,
            |s: &mut RemoteHostSpec| s.user = "root".into(),
            |s: &mut RemoteHostSpec| s.kind = RemoteKind::Ftp,
            |s: &mut RemoteHostSpec| s.jump = "bastion".into(),
            |s: &mut RemoteHostSpec| s.ftp.passive = false,
        ] {
            let mut spec = host("");
            change(&mut spec);
            assert!(connection_changed(&before, &serde_json::to_string(&spec).unwrap()));
        }
        assert!(connection_changed("{not json", &before), "unreadable counts as changed");
    }

    #[test]
    fn a_blob_only_command_takes_an_azure_blob_path_and_refuses_everything_else() {
        let mut azure = RemoteHostSpec { kind: RemoteKind::Azure, ..Default::default() };
        azure.azure.account = "contoso".into();
        assert_eq!(blob_path(&azure, "/blob/photos/cat.jpg").unwrap(), "/photos/cat.jpg");
        assert!(blob_path(&azure, "/files/share/report.xlsx").unwrap_err().contains("file share"));
        assert!(blob_path(&azure, "/elsewhere").is_err());

        let s3 = RemoteHostSpec { kind: RemoteKind::S3, ..Default::default() };
        assert_eq!(blob_path(&s3, "/blob/photos").unwrap_err(), RemoteKind::S3.refuses("do this"));
    }

    /// The secret rides beside the spec, never inside it — the spec is JSON in the workspace
    /// database, the secret goes to the keychain.
    #[test]
    fn a_pasted_connection_string_becomes_an_account_whose_secret_is_kept_apart() {
        let parsed = remote_parse_azure_connection(
            "DefaultEndpointsProtocol=https;AccountName=contoso;AccountKey=a2V5LWJ5dGVz;EndpointSuffix=core.windows.net"
                .into(),
        )
        .unwrap();
        assert_eq!(parsed.name, "contoso");
        assert_eq!(parsed.auth, remotes::AzureAuth::AccountKey);
        assert_eq!(parsed.secret, "a2V5LWJ5dGVz");
        assert_eq!(parsed.spec.kind, RemoteKind::Azure);
        assert_eq!(parsed.spec.azure.account, "contoso");
        assert!(!serde_json::to_string(&parsed.spec).unwrap().contains("a2V5LWJ5dGVz"));

        let sas = remote_parse_azure_connection(
            "https://contoso.blob.core.windows.net/photos?sv=2021-08-06&sig=abc".into(),
        )
        .unwrap();
        assert_eq!(sas.auth, remotes::AzureAuth::Sas);
        assert_eq!(sas.secret, "sv=2021-08-06&sig=abc");
        assert_eq!(sas.spec.azure.auth, remotes::AzureAuth::Sas);

        assert!(remote_parse_azure_connection("ssh deploy@web-01".into()).is_none());
    }
}
