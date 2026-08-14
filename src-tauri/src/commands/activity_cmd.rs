use tauri::State;

use crate::db::{
    models::{ActivityLogEntry, ChatConversationSummary, JobHistoryEntry, WorkspaceActivityEntry},
    queries, Db,
};

#[tauri::command]
pub fn list_chat_conversations(
    db: State<'_, Db>,
    project_id: String,
    search: Option<String>,
) -> Result<Vec<ChatConversationSummary>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::list_chat_conversations(&conn, &project_id, search.as_deref()).map_err(|e| e.to_string())
}

/// Every turn of one conversation, oldest first.
///
/// `with_trace` defaults to **true**, which is the shape this command has always had and what an
/// argument-less call still gets. Passing `false` returns the same turns with `trace: null`, and
/// that is the version worth calling: a trace can reach ~600 KB per turn, so reopening a 30-turn
/// conversation the eager way moves ~18 MB in a single IPC response and freezes the click that
/// opened it.
///
/// The option is not free to take. A caller that passes `false` **must** fetch the trace of a turn
/// on demand through [`get_turn_trace`] when the user expands its "how it got there" disclosure,
/// or the trace of every past turn silently disappears from the UI. Which is why the eager default
/// stays instead of the column simply being dropped.
#[tauri::command]
pub fn get_chat_conversation(
    db: State<'_, Db>,
    project_id: String,
    session_id: String,
    with_trace: Option<bool>,
) -> Result<Vec<ActivityLogEntry>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    if with_trace.unwrap_or(true) {
        queries::get_conversation_messages(&conn, &project_id, &session_id).map_err(|e| e.to_string())
    } else {
        queries::get_conversation_messages_lite(&conn, &project_id, &session_id).map_err(|e| e.to_string())
    }
}

/// One turn's process trace, by `activity_log` row id. `null` when that turn has none — a turn
/// recorded before traces existed, or a run that printed nothing, which is the same `null` the
/// eager read hands back for those rows.
///
/// This is the other half of `get_chat_conversation`'s `with_trace: false`: it is what keeps every
/// turn's trace reachable once the conversation stops carrying them all up front.
#[tauri::command]
pub fn get_turn_trace(db: State<'_, Db>, id: String) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::get_turn_trace(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_chat_conversation(db: State<'_, Db>, project_id: String, session_id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::delete_chat_conversation(&conn, &project_id, &session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_chat_conversation(db: State<'_, Db>, project_id: String, session_id: String, title: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::rename_chat_conversation(&conn, &project_id, &session_id, &title).map_err(|e| e.to_string())
}

/// One page of a project's Activity, newest first.
///
/// `limit`/`offset` are optional so the shape that existed before paging — no limit, everything in
/// one response — is still exactly what an argument-less call gets. The frontend passes a page size
/// and appends, so nothing older becomes unreachable; see `jobsStore.loadMore`.
///
/// `with_result` defaults to true, so an argument-less call is likewise unchanged. The frontend
/// sends it false for every page after the first — see the query's doc comment and
/// [`get_job_result`], which is how a row selected later gets its text.
#[tauri::command]
pub fn list_job_history(
    db: State<'_, Db>,
    project_id: String,
    limit: Option<i64>,
    offset: Option<i64>,
    with_result: Option<bool>,
) -> Result<Vec<JobHistoryEntry>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::list_job_history(&conn, &project_id, limit, offset.unwrap_or(0), with_result.unwrap_or(true))
        .map_err(|e| e.to_string())
}

/// One run's output text, by Activity row id. `null` for a row that produced none.
///
/// The counterpart to `with_result: false` above, and the exact shape [`get_turn_trace`] already
/// has for conversation traces: the list travels light, and the one row the user opens pays for
/// its own body.
#[tauri::command]
pub fn get_job_result(db: State<'_, Db>, id: String) -> Result<Option<String>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::get_job_result(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_job_history_entry(db: State<'_, Db>, id: String, label: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::rename_job_history(&conn, &id, &label).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_job_history_entry(db: State<'_, Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::delete_job_history(&conn, &id).map_err(|e| e.to_string())
}

/// Everything reviewed from a link in this workspace. Repository-agnostic on purpose: these runs
/// have no project, so they follow the workspace instead — visible whichever repo is open, gone
/// once another workspace is.
///
/// Paged on the same terms as [`list_job_history`]: both feed the one Activity list, so bounding
/// only one of them would leave the panel stalling on the other.
#[tauri::command]
pub fn list_workspace_activity(
    db: State<'_, Db>,
    workspace_id: String,
    limit: Option<i64>,
    offset: Option<i64>,
    with_result: Option<bool>,
) -> Result<Vec<WorkspaceActivityEntry>, String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::list_workspace_activity(
        &conn,
        &workspace_id,
        limit,
        offset.unwrap_or(0),
        with_result.unwrap_or(true),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_workspace_activity_entry(db: State<'_, Db>, id: String, label: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::rename_workspace_activity(&conn, &id, &label).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_workspace_activity_entry(db: State<'_, Db>, id: String) -> Result<(), String> {
    let conn = db.0.lock().map_err(|e| e.to_string())?;
    queries::delete_workspace_activity(&conn, &id).map_err(|e| e.to_string())
}
