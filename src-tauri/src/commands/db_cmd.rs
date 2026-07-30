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
    DbExecuteResult, DbForeignKey, DbNode, DbNodeKind, DbNodeRef, DbRegistry, DbRowEdit,
    DbSchemaGroup, DbServerInfo, DbStatementResult, DbTableDataRequest, Session,
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
    kind: String,
    spec: String,
    color: String,
) -> Result<DbConnectionRow, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::create_connection(&conn, &workspace_id, &name, &kind, &spec, &color)
        .map_err(|e| e.to_string())
}

/// Saves a connection's settings, and closes any session it already had.
///
/// The close is the point: a host, port or SSL change that left the old session open would keep
/// answering from the *previous* server, which is the kind of bug that ends with a statement run
/// against the wrong database.
#[tauri::command]
pub fn db_update_connection(
    db: State<Db>,
    registry: State<DbRegistry>,
    connection: DbConnectionRow,
) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::update_connection(&conn, &connection).map_err(|e| e.to_string())?;
    registry.disconnect(&connection.id);
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
            let session = Session::open(&inline, database.as_deref()).await?;
            let info = session.info();
            drop(session);
            // A test leaves nothing running. The tunnel this may have raised belongs to the
            // attempt, not to a connection that hasn't been saved yet — and an unsaved form has no
            // id, so leaving it would park an SSH process under an empty key that nothing closes.
            if inline.ssh_enabled {
                crate::datasource::tunnel::close(&inline.id);
            }
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
    let session = registry.session(&config, node.database.as_deref()).await?;
    let children = session.children(&node).await?;
    // The root is the only level that lists databases, and the only one where the connection's own
    // database means "start here" rather than "here is everything".
    if node.kind == DbNodeKind::Root && !config.show_all_databases {
        return Ok(scope_to_current_database(
            children,
            &session.info().database,
        ));
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
    let session = registry.session(&config, None).await?;
    let root = DbNodeRef {
        kind: DbNodeKind::Root,
        database: None,
        schema: None,
        name: None,
    };
    let mut databases = session.children(&root).await?;
    if !config.show_all_databases {
        databases = scope_to_current_database(databases, &session.info().database);
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
        let children = match registry.session(&config, node.database.as_deref()).await {
            Ok(session) => session.children(&node).await,
            Err(e) => Err(e),
        };
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
    run_id: String,
) -> Result<i64, String> {
    let config = resolve_config(&db, &connection_id)?;
    let session = registry.session(&config, node.database.as_deref()).await?;
    let key = DbRegistry::session_key(&connection_id, node.database.as_deref());
    registry
        .run(&run_id, &session, &key, session.row_count(&node, &filter))
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
    let session = registry.session(&config, node.database.as_deref()).await?;
    session.foreign_keys(&node).await
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
    let session = registry.session(&config, node.database.as_deref()).await?;
    session.object_ddl(&node).await
}

/// Stops a running statement. Unknown run ids are fine — a cancel legitimately races a query that
/// finished a moment earlier.
#[tauri::command]
pub fn db_cancel(registry: State<DbRegistry>, run_id: String) -> Result<(), String> {
    registry.cancel(&run_id);
    Ok(())
}
