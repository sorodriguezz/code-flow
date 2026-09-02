//! IPC surface for the database workspace.
//!
//! Two kinds of command, and nothing else: thin wrappers over `db::datasource_queries`, and
//! forwarders into `datasource::*`. The one piece of logic that does live here is
//! [`resolve_config`] — turning a stored row into a driver config, which is where the keychain
//! password is attached. That has to happen on this side of the wall: the webview must never hold a
//! database password, so it hands down a connection *id* and gets back rows.
//!
//! Everything else about a statement — which schema, which limit, which filter — is decided in the
//! frontend and arrives fully resolved, the same split the API client draws.

use tauri::State;

use crate::datasource::{
    filter_children, scope_to_current_database, DbConnectionConfig, DbEditResult, DbExecContext,
    DbExecuteResult, DbForeignKey, DbNode, DbNodeKind, DbNodeRef, DbObjectInfo, DbQueryOptions,
    DbRegistry, DbRowEdit,
    DbSchemaDiagram, DbSchemaGroup, DbServerInfo, DbStatementResult, DbTableDataRequest, Session,
};
use crate::db::datasource_queries as queries;
use crate::db::{models::*, Db};
use crate::secrets;

// ---------------------------------------------------------------------------
// Stored connections
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn db_load_tree(db: State<Db>, workspace_id: String) -> Result<DbWorkspaceTree, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::load_tree(&conn, &workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_create_connection(
    db: State<Db>,
    workspace_id: String,
    name: String,
    group_name: String,
    kind: String,
    spec: String,
    color: String,
) -> Result<DbConnectionRow, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::create_connection(&conn, &workspace_id, &name, group_name.trim(), &kind, &spec, &color)
        .map_err(|e| e.to_string())
}

/// Saves a connection's settings, closing any session it already had unless told otherwise.
///
/// The close is the default because it is the safe answer: a host, port or SSL change that left the
/// old session open would keep answering from the *previous* server, which is the kind of bug that
/// ends with a statement run against the wrong database.
///
/// `keep_session` is for the edits that decide what the explorer *lists* rather than what it talks
/// to — which schemas are visible, the object filter, the connection's name. Those describe the
/// same server through the same socket, and dropping the session for them means a reconnect (and,
/// over SSH, a whole tunnel) to change a checkbox. The caller is the one that can tell the two
/// apart, because it holds the settings as they were before the edit; see `saveConnection`.
#[tauri::command]
pub fn db_update_connection(
    db: State<Db>,
    registry: State<DbRegistry>,
    connection: DbConnectionRow,
    keep_session: Option<bool>,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::update_connection(&conn, &connection).map_err(|e| e.to_string())?;
    // Absent means "close it" — an older frontend, or any caller that hasn't thought about it,
    // gets the behaviour that cannot be wrong.
    if !keep_session.unwrap_or(false) {
        registry.disconnect(&connection.id);
    }
    Ok(())
}

#[tauri::command]
pub fn db_delete_connection(
    db: State<Db>,
    registry: State<DbRegistry>,
    id: String,
) -> Result<(), String> {
    registry.disconnect(&id);
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::delete_connection(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_duplicate_connection(db: State<Db>, id: String) -> Result<DbConnectionRow, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::duplicate_connection(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_reorder_connections(db: State<Db>, ids: Vec<String>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::reorder_connections(&conn, &ids).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

/// Writes the order the folders are drawn in; `ids` is the whole list.
#[tauri::command]
pub fn db_reorder_groups(db: State<Db>, ids: Vec<String>) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::reorder_groups(&conn, &ids).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_create_group(
    db: State<Db>,
    workspace_id: String,
    name: String,
) -> Result<DbGroupRow, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::create_group(&conn, &workspace_id, name.trim()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_rename_group(
    db: State<Db>,
    workspace_id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::rename_group(&conn, &workspace_id, &from, to.trim()).map_err(|e| e.to_string())
}

/// Deletes a group. Its connections move to ungrouped — see [`queries::delete_group`] for why they
/// are never deleted with it.
#[tauri::command]
pub fn db_delete_group(
    db: State<Db>,
    workspace_id: String,
    name: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::delete_group(&conn, &workspace_id, &name).map_err(|e| e.to_string())
}

/// Files a connection under a group, or under none with an empty name.
///
/// Deliberately does not touch the registry: unlike [`db_update_connection`], this changes nothing
/// about the server the connection talks to, so a live session survives being filed.
#[tauri::command]
pub fn db_set_connection_group(
    db: State<Db>,
    id: String,
    group_name: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::set_connection_group(&conn, &id, group_name.trim()).map_err(|e| e.to_string())
}

/// Puts a connection on every workspace's shelf, or takes it back off.
///
/// Like [`db_set_connection_group`], and for the same reason, this deliberately does not touch the
/// registry: a live session and its SSH tunnel survive being re-scoped.
#[tauri::command]
pub fn db_set_connection_scope(db: State<Db>, id: String, global: bool) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::set_connection_scope(&conn, &id, global).map_err(|e| e.to_string())
}

/// Moves a connection to another workspace and files it there.
#[tauri::command]
pub fn db_move_connection_to_workspace(
    db: State<Db>,
    id: String,
    workspace_id: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::move_connection_to_workspace(&conn, &id, &workspace_id).map_err(|e| e.to_string())
}

/// Puts a group and its members on every workspace's shelf, or takes them back off.
#[tauri::command]
pub fn db_set_group_scope(
    db: State<Db>,
    workspace_id: String,
    name: String,
    global: bool,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::set_group_scope(&conn, &workspace_id, name.trim(), global).map_err(|e| e.to_string())
}

/// Moves a group and its members to another workspace.
#[tauri::command]
pub fn db_move_group_to_workspace(
    db: State<Db>,
    from: String,
    name: String,
    to: String,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::move_group_to_workspace(&conn, &from, name.trim(), &to).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

/// Stores (or clears) a connection's password in the OS keychain.
///
/// There is deliberately **no getter**. The webview never needs the value — every command that
/// connects reads it here — and a getter would be the one call that could leak it into a JS heap,
/// a devtools inspector or a crash report.
#[tauri::command]
pub fn db_set_password(
    registry: State<DbRegistry>,
    connection_id: String,
    password: String,
) -> Result<(), String> {
    let key = crate::datasource::password_key(&connection_id);
    if password.is_empty() {
        let _ = secrets::delete_secret(&key);
    } else {
        secrets::set_secret(&key, &password)?;
    }
    // The open session still holds the old credential.
    registry.disconnect(&connection_id);
    Ok(())
}

/// Whether a password is stored, so the form can show "saved" instead of an empty box that looks
/// like the credential was lost.
#[tauri::command]
pub fn db_has_password(connection_id: String) -> Result<bool, String> {
    Ok(
        secrets::get_secret(&crate::datasource::password_key(&connection_id))?
            .is_some_and(|value| !value.is_empty()),
    )
}

// ---------------------------------------------------------------------------
// Consoles
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn db_create_console(
    db: State<Db>,
    connection_id: String,
    name: String,
    body: String,
    database_name: String,
    schema_name: String,
) -> Result<DbConsole, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::create_console(
        &conn,
        &connection_id,
        &name,
        &body,
        &database_name,
        &schema_name,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_update_console(db: State<Db>, console: DbConsole) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::update_console(&conn, &console).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_delete_console(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::delete_console(&conn, &id).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn db_list_history(
    db: State<Db>,
    workspace_id: String,
    limit: i64,
) -> Result<Vec<DbQueryHistoryEntry>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::list_history(&conn, &workspace_id, limit).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_add_history(
    db: State<Db>,
    entry: DbQueryHistoryEntry,
) -> Result<DbQueryHistoryEntry, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::add_history(&conn, &entry).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_delete_history(db: State<Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::delete_history(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_clear_history(db: State<Db>, workspace_id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::clear_history(&conn, &workspace_id).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Live connections
// ---------------------------------------------------------------------------

/// The stored row, as a driver config with its keychain password attached.
///
/// The DB lock is taken and released before anything touches the network — holding it across a
/// connect would block every other query in the app behind one unreachable host.
fn resolve_config(db: &State<Db>, connection_id: &str) -> Result<DbConnectionConfig, String> {
    let row = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        queries::get_connection(&conn, connection_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("There is no saved connection with id {connection_id}."))?
    };
    let mut config: DbConnectionConfig = serde_json::from_str(&row.spec).map_err(|e| {
        format!("This connection's saved settings couldn't be read ({e}). Open its settings and save them again.")
    })?;
    // The row is authoritative for both: `spec` is a blob the frontend wrote and could have gone
    // stale against a rename or a re-typed engine.
    config.id = row.id;
    config.kind =
        serde_json::from_value(serde_json::Value::String(row.kind.clone())).map_err(|_| {
            format!(
                "`{}` isn't a database engine this build knows about.",
                row.kind
            )
        })?;
    config.resolve_password();
    Ok(config)
}

/// Opens a connection and reports what answered.
///
/// Also the "Test connection" path, which is why it takes an optional inline config: a form the user
/// hasn't saved yet has no row to read and no keychain entry, so the typed values come down with the
/// call. Nothing is persisted either way.
#[tauri::command]
pub async fn db_connect(
    db: State<'_, Db>,
    registry: State<'_, DbRegistry>,
    connection_id: String,
    config: Option<DbConnectionConfig>,
    database: Option<String>,
) -> Result<DbServerInfo, String> {
    match config {
        Some(mut inline) => {
            // An unsaved form still gets the keychain lookup when it names an existing connection —
            // that is what makes "change the port, test" work without re-typing the password.
            inline.resolve_password();
            let opened = Session::open(&inline, database.as_deref()).await;
            // A test leaves nothing running. The tunnel this may have raised belongs to the
            // attempt, not to a connection that hasn't been saved yet — and an unsaved form has no
            // id, so leaving it would park an SSH process under an empty key that nothing closes.
            //
            // Cleared on the failing path too, and that is the path that matters: a tunnelled test
            // with the database password still wrong raises the tunnel, fails at the driver, and
            // used to return before reaching this line — leaving one stranded `ssh` per attempt,
            // which is the button people press repeatedly precisely while getting it wrong.
            //
            // Through the registry rather than straight at the tunnel, because `inline.id` is often
            // a *saved* connection's id: Edit → change the port → Test carries the id of whatever is
            // already open. Closing that tunnel outright would drop the forward under the sessions
            // the explorer is using — the tree would start failing because a test failed.
            if inline.ssh_enabled {
                registry.close_tunnel_if_unused(&inline.id);
            }
            let session = opened?;
            let info = session.info();
            drop(session);
            Ok(info)
        }
        None => {
            let config = resolve_config(&db, &connection_id)?;
            let session = registry.session(&config, database.as_deref()).await?;
            Ok(session.info())
        }
    }
}

#[tauri::command]
pub fn db_disconnect(registry: State<DbRegistry>, connection_id: String) -> Result<(), String> {
    registry.disconnect(&connection_id);
    Ok(())
}

/// Which connections currently have a session open. Drives the "connected" dot in the explorer.
#[tauri::command]
pub fn db_connected(registry: State<DbRegistry>) -> Result<Vec<String>, String> {
    Ok(registry.connected())
}

/// One node's children — the explorer's only expansion call.
///
/// The node comes back verbatim from the frontend, which is what keeps the tree stateless here: the
/// backend never holds "where the user is", only "what is under this".
#[tauri::command]
pub async fn db_children(
    db: State<'_, Db>,
    registry: State<'_, DbRegistry>,
    connection_id: String,
    node: DbNodeRef,
) -> Result<Vec<DbNode>, String> {
    let config = resolve_config(&db, &connection_id)?;
    // Through `read` rather than `session`: expanding the tree is the app's own question, asked the
    // same way every time, so a session that died while the window sat idle costs a reconnect
    // instead of a red row the user has to clear by hand.
    let (children, current_database) = registry
        .read(&config, node.database.as_deref(), |session| {
            let node = node.clone();
            async move {
                let children = session.children(&node).await?;
                Ok((children, session.info().database))
            }
        })
        .await?;
    // The root is the only level that lists databases, and the only one where the connection's own
    // database means "start here" rather than "here is everything".
    if node.kind == DbNodeKind::Root && !config.show_all_databases {
        return Ok(scope_to_current_database(children, &current_database));
    }
    Ok(filter_children(&config, &node, children))
}

/// Every schema this connection can reach, database by database — what the Schemas tab chooses from.
///
/// Its own command rather than a walk over [`db_children`], for the reason that decides it:
/// `db_children` applies the connection's `visible_schemas`, so asking it would return only the
/// schemas already chosen and a schema unchecked once could never be found again. A chooser needs
/// the unfiltered set; that is what makes it a chooser and not a list of what you already picked.
///
/// `show_all_databases` is still honoured. It says which databases are this connection's business at
/// all, and a server with fifty of them shouldn't open fifty sessions because a dialog was opened.
///
/// A database that can't be read — no permission is the usual one — is skipped rather than failing
/// the call: one unreadable database shouldn't cost the other nine. The error only surfaces when
/// nothing at all could be read, where an empty list would read as "this server has no schemas".
#[tauri::command]
pub async fn db_schema_catalog(
    db: State<'_, Db>,
    registry: State<'_, DbRegistry>,
    connection_id: String,
) -> Result<Vec<DbSchemaGroup>, String> {
    let config = resolve_config(&db, &connection_id)?;
    let root = DbNodeRef {
        kind: DbNodeKind::Root,
        database: None,
        schema: None,
        name: None,
    };
    let (mut databases, current_database) = registry
        .read(&config, None, |session| {
            let root = root.clone();
            async move {
                let databases = session.children(&root).await?;
                Ok((databases, session.info().database))
            }
        })
        .await?;
    if !config.show_all_databases {
        databases = scope_to_current_database(databases, &current_database);
    }

    let mut groups: Vec<DbSchemaGroup> = Vec::new();
    let mut failure: Option<String> = None;
    for database in databases {
        let node = DbNodeRef {
            kind: DbNodeKind::Database,
            database: database.database.clone(),
            schema: None,
            name: None,
        };
        let children = registry
            .read(&config, node.database.as_deref(), |session| {
                let node = node.clone();
                async move { session.children(&node).await }
            })
            .await;
        match children {
            Ok(nodes) => groups.push(DbSchemaGroup {
                database: database.name,
                schemas: nodes
                    .into_iter()
                    .filter(|child| child.kind == DbNodeKind::Schema)
                    .map(|child| child.name)
                    .collect(),
            }),
            Err(e) => failure = failure.or(Some(e)),
        }
    }

    match failure {
        Some(e) if groups.is_empty() => Err(e),
        _ => Ok(groups),
    }
}

#[tauri::command]
pub async fn db_execute(
    db: State<'_, Db>,
    registry: State<'_, DbRegistry>,
    connection_id: String,
    sql: String,
    ctx: DbExecContext,
    run_id: String,
) -> Result<DbExecuteResult, String> {
    let config = resolve_config(&db, &connection_id)?;
    let session = registry.session(&config, ctx.database.as_deref()).await?;
    let key = DbRegistry::session_key(&connection_id, ctx.database.as_deref());
    registry
        .run(&run_id, &session, &key, session.execute(&sql, &ctx))
        .await
}

#[tauri::command]
pub async fn db_explain(
    db: State<'_, Db>,
    registry: State<'_, DbRegistry>,
    connection_id: String,
    sql: String,
    ctx: DbExecContext,
    run_id: String,
) -> Result<String, String> {
    let config = resolve_config(&db, &connection_id)?;
    let session = registry.session(&config, ctx.database.as_deref()).await?;
    let key = DbRegistry::session_key(&connection_id, ctx.database.as_deref());
    registry
        .run(&run_id, &session, &key, session.explain(&sql, &ctx))
        .await
}

/// One page of a table's rows, for the data editor.
#[tauri::command]
pub async fn db_table_data(
    db: State<'_, Db>,
    registry: State<'_, DbRegistry>,
    connection_id: String,
    request: DbTableDataRequest,
    run_id: String,
) -> Result<DbStatementResult, String> {
    let config = resolve_config(&db, &connection_id)?;
    let session = registry.session(&config, request.node.database.as_deref()).await?;
    let key = DbRegistry::session_key(&connection_id, request.node.database.as_deref());
    registry
        .run(&run_id, &session, &key, session.table_data(&request))
        .await
}

/// `COUNT(*)` under the current filter — the total the pager needs.
///
/// Its own command rather than part of `db_table_data` because it is the expensive half: on a large
/// table the count is a full scan while the page is an index read, so the UI asks for it separately
/// and can show rows before the total arrives.
#[tauri::command]
pub async fn db_row_count(
    db: State<'_, Db>,
    registry: State<'_, DbRegistry>,
    connection_id: String,
    node: DbNodeRef,
    filter: String,
    // The same options the page was read with — see `DbQueryOptions`. Optional rather than
    // required, because every SQL engine's caller has nothing to put here.
    options: Option<DbQueryOptions>,
    run_id: String,
) -> Result<i64, String> {
    let config = resolve_config(&db, &connection_id)?;
    let session = registry.session(&config, node.database.as_deref()).await?;
    let key = DbRegistry::session_key(&connection_id, node.database.as_deref());
    let options = options.unwrap_or_default();
    registry
        .run(&run_id, &session, &key, session.row_count(&node, &filter, &options))
        .await
}

/// Which columns of this table point somewhere else, so the grid can offer to follow them.
#[tauri::command]
pub async fn db_foreign_keys(
    db: State<'_, Db>,
    registry: State<'_, DbRegistry>,
    connection_id: String,
    node: DbNodeRef,
) -> Result<Vec<DbForeignKey>, String> {
    let config = resolve_config(&db, &connection_id)?;
    registry
        .read(&config, node.database.as_deref(), |session| {
            let node = node.clone();
            async move { session.foreign_keys(&node).await }
        })
        .await
}

/// A whole container's structure, for the diagram: every relation, its columns, and every
/// relationship between them.
///
/// `node` is a schema on a SQL engine and a database on Mongo — the level at which "what is in here
/// and how is it wired together" is a question worth asking.
///
/// Routed through `registry.run` so the Cancel button reaches it: on a schema with hundreds of
/// tables these catalog queries are the slowest thing the workspace sends, and a diagram that can't
/// be abandoned would hold the session until it finished.
/// Every object of one schema, with the metadata its engine keeps about it.
///
/// Cancellable through `run_id` like the diagram is, and for the same reason: on a schema with
/// hundreds of tables the size columns are the slow part, and somebody who opened the tab by
/// accident should be able to take it back.
#[tauri::command]
pub async fn db_schema_objects(
    db: State<'_, Db>,
    registry: State<'_, DbRegistry>,
    connection_id: String,
    node: DbNodeRef,
    run_id: String,
) -> Result<Vec<DbObjectInfo>, String> {
    let config = resolve_config(&db, &connection_id)?;
    let session = registry.session(&config, node.database.as_deref()).await?;
    let key = DbRegistry::session_key(&connection_id, node.database.as_deref());
    registry
        .run(&run_id, &session, &key, session.schema_objects(&node))
        .await
}

#[tauri::command]
pub async fn db_schema_diagram(
    db: State<'_, Db>,
    registry: State<'_, DbRegistry>,
    connection_id: String,
    node: DbNodeRef,
    run_id: String,
) -> Result<DbSchemaDiagram, String> {
    let config = resolve_config(&db, &connection_id)?;
    let session = registry.session(&config, node.database.as_deref()).await?;
    let key = DbRegistry::session_key(&connection_id, node.database.as_deref());
    registry
        .run(&run_id, &session, &key, session.schema_diagram(&node))
        .await
}

#[tauri::command]
pub async fn db_apply_edits(
    db: State<'_, Db>,
    registry: State<'_, DbRegistry>,
    connection_id: String,
    node: DbNodeRef,
    edits: Vec<DbRowEdit>,
) -> Result<DbEditResult, String> {
    let config = resolve_config(&db, &connection_id)?;
    let session = registry.session(&config, node.database.as_deref()).await?;
    session.apply_edits(&node, &edits).await
}

#[tauri::command]
pub async fn db_object_ddl(
    db: State<'_, Db>,
    registry: State<'_, DbRegistry>,
    connection_id: String,
    node: DbNodeRef,
) -> Result<String, String> {
    let config = resolve_config(&db, &connection_id)?;
    registry
        .read(&config, node.database.as_deref(), |session| {
            let node = node.clone();
            async move { session.object_ddl(&node).await }
        })
        .await
}

/// Stops a running statement. Unknown run ids are fine — a cancel legitimately races a query that
/// finished a moment earlier.
#[tauri::command]
pub fn db_cancel(registry: State<DbRegistry>, run_id: String) -> Result<(), String> {
    registry.cancel(&run_id);
    Ok(())
}

// ---------------------------------------------------------------------------
// Console assistant
// ---------------------------------------------------------------------------

/// What the console's AI assistant answered.
#[derive(Debug, Clone, serde::Serialize)]
pub struct DbAiAnswer {
    /// The reply, in Markdown.
    pub answer: String,
    /// The statement it proposed, if it proposed one — what the "insert" button writes into the
    /// editor. Absent for a pure explanation.
    pub query: Option<String>,
    /// How many relations of the scope were described to the model. Shown next to the answer,
    /// because "it only saw 60 of your 300 tables" is the first thing to check when the answer
    /// names something that isn't there.
    pub tables_seen: usize,
    /// Whether the schema map was cut to fit the prompt's budget.
    pub schema_truncated: bool,
}

/// A relation's kind, spelled for a reader rather than as an enum variant.
fn relation_word(kind: &DbNodeKind) -> &'static str {
    match kind {
        DbNodeKind::View => "vista",
        DbNodeKind::Collection => "colección",
        _ => "tabla",
    }
}

/// Renders a schema diagram as the text the model reads.
///
/// Deliberately not JSON. This is the bulk of the prompt, and the same facts cost roughly half as
/// many tokens laid out as aligned columns — which on a wide schema is the difference between the
/// whole thing fitting and being cut off at table forty. It also reads the way a `\d` dump does,
/// which is the shape these models have seen most.
///
/// Row estimates are included because they change the answer: which side of a join to drive from,
/// and whether a sequential scan matters, are questions about size.
fn render_schema(diagram: &DbSchemaDiagram) -> String {
    let mut out = String::new();
    for table in &diagram.tables {
        let qualified = match &table.schema {
            Some(schema) => format!("{schema}.{}", table.name),
            None => table.name.clone(),
        };
        out.push_str(&format!("{} {}", relation_word(&table.kind).to_uppercase(), qualified));
        if let Some(rows) = table.row_estimate {
            out.push_str(&format!(" (~{rows} filas)"));
        }
        out.push('\n');
        for column in &table.columns {
            // Padded rather than tab-separated: a tab is one token wherever it lands, but the
            // alignment is what makes a forty-column table skimmable for the model too.
            let mut marks = Vec::new();
            if column.primary_key {
                marks.push("PK");
            }
            if column.foreign_key {
                marks.push("FK");
            }
            if !column.nullable {
                marks.push("NOT NULL");
            }
            out.push_str(&format!(
                "  {:<28} {:<20} {}\n",
                column.name,
                column.data_type,
                marks.join(" ")
            ));
        }
    }

    if !diagram.edges.is_empty() {
        out.push_str("\nRELACIONES\n");
        for edge in &diagram.edges {
            let side = |schema: &Option<String>, table: &str, column: &str| match schema {
                Some(s) => format!("{s}.{table}.{column}"),
                None => format!("{table}.{column}"),
            };
            out.push_str(&format!(
                "  {} -> {}{}\n",
                side(&edge.from_schema, &edge.from_table, &edge.from_column),
                side(&edge.to_schema, &edge.to_table, &edge.to_column),
                // An inferred edge is a guess from a column name — Mongo has no other kind. Saying
                // so is what stops the model presenting a join it invented as a declared constraint.
                if edge.inferred { "  (inferida por el nombre, no declarada)" } else { "" }
            ));
        }
    }

    for note in &diagram.notes {
        out.push_str(&format!("\nNOTA: {note}\n"));
    }
    out
}

/// How one statement of the console's last run went.
///
/// A trimmed [`DbStatementResult`] built on the frontend, and trimmed for two reasons. The rows are
/// the user's data and the model has no use for them — what diagnoses a query is the *shape* of
/// what came back, not its contents. And a five-thousand-row grid would otherwise be serialised
/// back across the IPC boundary on every question asked about it.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct DbRunOutcome {
    pub error: Option<String>,
    pub rows: usize,
    pub rows_affected: Option<i64>,
    pub duration_ms: u64,
}

/// Summarises the console's last run for the prompt.
///
/// "No me trae datos" is two different situations — zero rows, or a statement that never ran — and
/// the console already knows which. Sending it turns a guess into a diagnosis.
fn render_outcome(results: &[DbRunOutcome]) -> String {
    results
        .iter()
        .map(|result| match &result.error {
            Some(error) => format!("ERROR: {error}"),
            None => match result.rows_affected {
                Some(affected) => format!("OK — {affected} filas afectadas"),
                None => {
                    format!("OK — {} filas devueltas en {} ms", result.rows, result.duration_ms)
                }
            },
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Answers a natural-language question about the connected database.
///
/// The schema is read *here*, by CodeFlow's own driver, and handed to the model as text — the
/// engine is never given the connection. That is the whole security shape of this feature: a
/// credential in the keychain never reaches a subprocess, the model cannot run anything, and the
/// statement it proposes is inserted into the editor for the user to read and run themselves.
///
/// The scope is the console's own database and schema rather than the whole server. A model given
/// three hundred tables answers worse than one given the thirty the question is about, and the
/// pickers in the console toolbar are already how the user says which those are.
///
/// `history` is everything already said in this console's panel, oldest first — see
/// [`crate::ai::DbAssistantTurn`]. It is what makes the panel a conversation: these engines are
/// one-shot processes with no session to resume, so a follow-up only means something if the turns
/// it refers to are sent again. Empty for the first question.
#[tauri::command]
pub async fn db_ai_assist(
    app: tauri::AppHandle,
    db: State<'_, Db>,
    registry: State<'_, DbRegistry>,
    connection_id: String,
    database: Option<String>,
    schema: Option<String>,
    question: String,
    editor_sql: String,
    last_results: Vec<DbRunOutcome>,
    history: Vec<crate::ai::DbAssistantTurn>,
    run_id: Option<String>,
) -> Result<DbAiAnswer, String> {
    let config = resolve_config(&db, &connection_id)?;
    let ai_config = {
        let conn = db.0.lock().map_err(|e| e.to_string())?;
        super::claude_cmd::load_ai_config(&conn, super::claude_cmd::AiTask::DbQuery)?
    };

    // The node the schema is read for: the schema when one is picked, the database otherwise. Mongo
    // has no schemas and resolves either to its own database, so both paths are valid there.
    let node = DbNodeRef {
        kind: if schema.is_some() { DbNodeKind::Schema } else { DbNodeKind::Database },
        database: database.clone(),
        schema: schema.clone(),
        name: schema.clone().or_else(|| database.clone()),
    };

    let outcome = render_outcome(&last_results);
    let language = config.kind.console_language();

    // The catalog read is inside the run's scope, not before it. On a wide schema it is the slow
    // part of this whole call, and a stop pressed while it is going has to be observed — otherwise
    // the button does nothing for several seconds and then a subprocess starts anyway. See
    // `ai_runs::scoped`, which arms the cancel before awaiting rather than at spawn time.
    crate::ai_runs::scoped(app, run_id, async {
        // `read` and not `session`: a console left open overnight is holding a connection the
        // server has since dropped, and this retries once against a fresh one instead of failing
        // the first question of the morning.
        let (diagram, info) = registry
            .read(&config, node.database.as_deref(), |session| {
                let node = node.clone();
                async move { Ok((session.schema_diagram(&node).await?, session.info())) }
            })
            .await?;

        let rendered = render_schema(&diagram);
        let schema_truncated = rendered.chars().count() > crate::ai::MAX_DB_SCHEMA_CHARS;

        let dialect = format!("{} {}", config.kind.label(), info.version);
        // Taken from the diagram and not from the request, because they can differ: a Postgres
        // console with no schema picked is read as `public`, and telling the model "base «x»" while
        // showing it one schema's tables is how it ends up writing unqualified names for a scope it
        // was never told about — or assuming the thirty tables it saw are the whole database.
        let scope = match (
            diagram.database.as_deref().unwrap_or(&info.database),
            diagram.schema.as_deref(),
        ) {
            (db, Some(s)) => format!("base «{db}», esquema «{s}» (solo se te muestra este esquema)"),
            (db, None) => format!("base «{db}»"),
        };

        let answer = crate::ai::db_assistant(
            &*ai_config.engine,
            &ai_config.binary,
            &ai_config.model,
            language,
            crate::ai::DbAssistantContext {
                dialect: &dialect,
                scope: &scope,
                schema: &rendered,
                editor: &editor_sql,
                outcome: &outcome,
                history: &history,
                question: &question,
            },
        )
        .await?;

        Ok(DbAiAnswer {
            answer: answer.answer,
            query: answer.query,
            tables_seen: diagram.tables.len(),
            schema_truncated,
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::datasource::{DbDiagramColumn, DbDiagramEdge, DbDiagramTable};

    fn column(name: &str, ty: &str, pk: bool, fk: bool, nullable: bool) -> DbDiagramColumn {
        DbDiagramColumn {
            name: name.into(),
            data_type: ty.into(),
            nullable,
            primary_key: pk,
            foreign_key: fk,
        }
    }

    fn diagram() -> DbSchemaDiagram {
        DbSchemaDiagram {
            database: Some("tienda".into()),
            schema: Some("public".into()),
            tables: vec![
                DbDiagramTable {
                    schema: Some("public".into()),
                    name: "usuarios".into(),
                    kind: DbNodeKind::Table,
                    columns: vec![
                        column("id", "integer", true, false, false),
                        column("email", "text", false, false, false),
                    ],
                    row_estimate: Some(12_400),
                },
                DbDiagramTable {
                    schema: Some("public".into()),
                    name: "pagos".into(),
                    kind: DbNodeKind::Table,
                    columns: vec![column("usuario_id", "integer", false, true, false)],
                    row_estimate: None,
                },
            ],
            edges: vec![DbDiagramEdge {
                constraint: "fk_pagos_usuario".into(),
                from_schema: Some("public".into()),
                from_table: "pagos".into(),
                from_column: "usuario_id".into(),
                to_schema: Some("public".into()),
                to_table: "usuarios".into(),
                to_column: "id".into(),
                inferred: false,
            }],
            notes: vec!["Muestra de 100 documentos por colección.".into()],
        }
    }

    /// The schema map is most of the prompt, so what it does and does not say is the feature. Keys
    /// and nullability decide whether a proposed join is right; the row estimate decides which side
    /// to drive it from; the note is the caveat that stops the model over-claiming.
    #[test]
    fn renders_a_schema_the_way_the_model_reads_it() {
        let text = render_schema(&diagram());
        assert!(text.contains("TABLA public.usuarios (~12400 filas)"), "{text}");
        assert!(text.contains("id") && text.contains("PK NOT NULL"), "{text}");
        // No estimate is left unsaid rather than reported as zero, which would read as an empty
        // table and is the sort of thing a model plans a full scan around.
        assert!(text.contains("TABLA public.pagos\n"), "{text}");
        assert!(
            text.contains("public.pagos.usuario_id -> public.usuarios.id"),
            "{text}"
        );
        assert!(text.contains("NOTA: Muestra de 100 documentos"), "{text}");
    }

    /// An inferred edge is a guess from a column name — the only kind Mongo can have. Presenting it
    /// as a declared constraint is how a model asserts a relationship that does not exist.
    #[test]
    fn marks_an_inferred_relationship_as_a_guess() {
        let mut d = diagram();
        d.edges[0].inferred = true;
        assert!(render_schema(&d).contains("(inferida por el nombre, no declarada)"));
    }

    /// The distinction the whole "por qué no me trae datos" case turns on: a statement that ran and
    /// found nothing is not a statement that failed.
    #[test]
    fn tells_zero_rows_apart_from_a_failure() {
        let ran = DbRunOutcome { error: None, rows: 0, rows_affected: None, duration_ms: 12 };
        assert_eq!(render_outcome(&[ran]), "OK — 0 filas devueltas en 12 ms");

        let failed = DbRunOutcome {
            error: Some("relation \"usuario\" does not exist".into()),
            rows: 0,
            rows_affected: None,
            duration_ms: 3,
        };
        assert_eq!(
            render_outcome(&[failed]),
            "ERROR: relation \"usuario\" does not exist"
        );
    }

    /// A console with no result yet says nothing at all — the caller omits the whole section rather
    /// than sending a heading a model would read as "the query returned nothing".
    #[test]
    fn says_nothing_about_a_console_that_never_ran() {
        assert_eq!(render_outcome(&[]), "");
    }
}
