//! The DBML scratch-database commands.
//!
//! Every one of them is `async`, and that is not decoration: a synchronous `#[tauri::command]` in
//! Tauri v2 runs on the **main thread**, so a `SELECT` over a table somebody filled from the
//! console would freeze the window while it ran. Async commands run on the runtime's worker pool
//! instead, which is where the blocking SQLite call belongs — and a statement that overruns is
//! interruptible from the Stop button rather than by force-quitting the app.
//!
//! The two commands that hold no `State` go further and use `spawn_blocking`, because they touch
//! the filesystem (a `read_dir` over the sandbox directory, a `stat` per file) rather than a
//! connection. The rest take `State<'_, SandboxRegistry>`, which cannot cross an await, so they do
//! their work inline on the worker they were dispatched to.

use std::collections::{HashMap, HashSet};

use tauri::State;

use crate::datasource::DbStatementResult;
use crate::db::Db;
use crate::sandbox::{self, SandboxPage, SandboxRegistry, SandboxStatus};

/// Runs `work` off the main thread and flattens the join error into the command's own `String`.
///
/// A panic inside the closure arrives here as a `JoinError`; reporting it as a plain failure means
/// the panel shows a message instead of a promise that never settles.
async fn blocking<T, F>(work: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
}

/// Builds (or rebuilds) the scratch database from DDL the frontend emitted.
///
/// The DDL arrives as text because the parsed `DbmlSchema` lives on the frontend — see
/// `lib/dbml/sqlite.ts`, which is also where the type and id normalisation happens. This end runs
/// it and reports what SQLite said.
#[tauri::command]
pub async fn sandbox_open(
    registry: State<'_, SandboxRegistry>,
    diagram_id: String,
    ddl: String,
    fingerprint: String,
    schema_json: String,
    constraints_json: String,
) -> Result<SandboxStatus, String> {
    sandbox::build(
        registry.inner(),
        &diagram_id,
        &ddl,
        &fingerprint,
        &schema_json,
        &constraints_json,
    )
}

#[tauri::command]
pub async fn sandbox_status(diagram_id: String) -> Result<SandboxStatus, String> {
    blocking(move || sandbox::status_of(&diagram_id)).await
}

#[tauri::command]
pub async fn sandbox_counts(
    registry: State<'_, SandboxRegistry>,
    diagram_id: String,
) -> Result<HashMap<String, i64>, String> {
    sandbox::counts(registry.inner(), &diagram_id)
}

#[tauri::command]
pub async fn sandbox_page(
    registry: State<'_, SandboxRegistry>,
    diagram_id: String,
    table: String,
    offset: i64,
    limit: i64,
) -> Result<SandboxPage, String> {
    sandbox::page(registry.inner(), &diagram_id, &table, offset, limit)
}

/// Runs whatever the user typed. No guards — see the module doc on `sandbox.rs`.
#[tauri::command]
pub async fn sandbox_execute(
    registry: State<'_, SandboxRegistry>,
    diagram_id: String,
    sql: String,
) -> Result<Vec<DbStatementResult>, String> {
    sandbox::execute(registry.inner(), &diagram_id, &sql)
}

/// Applies a changed model to a sandbox that already has rows in it, keeping what still fits.
///
/// The failure path is the point, not the exception: a column added `not null` with no default is
/// impossible over existing rows, and SQLite says so by name. The drift bar turns that into "N rows
/// of pedidos cannot satisfy slug not null", which is the answer generated data could never give —
/// generated rows satisfy a new constraint by construction.
#[tauri::command]
pub async fn sandbox_migrate(
    registry: State<'_, SandboxRegistry>,
    diagram_id: String,
    ddl: String,
    fingerprint: String,
    schema_json: String,
    constraints_json: String,
) -> Result<SandboxStatus, String> {
    sandbox::migrate(
        registry.inner(),
        &diagram_id,
        &ddl,
        &fingerprint,
        &schema_json,
        &constraints_json,
    )
}

/// The scratch database as a `.sql` script — schema and one INSERT per row.
#[tauri::command]
pub async fn sandbox_export_sql(
    registry: State<'_, SandboxRegistry>,
    diagram_id: String,
) -> Result<String, String> {
    sandbox::export_sql(registry.inner(), &diagram_id)
}

/// The database file itself, base64 for the bridge. See `apiSaveBinaryFile`.
#[tauri::command]
pub async fn sandbox_export_file(
    registry: State<'_, SandboxRegistry>,
    diagram_id: String,
) -> Result<String, String> {
    sandbox::export_file(registry.inner(), &diagram_id)
}

#[tauri::command]
pub async fn sandbox_cancel(
    registry: State<'_, SandboxRegistry>,
    diagram_id: String,
) -> Result<(), String> {
    registry.cancel(&diagram_id);
    Ok(())
}

#[tauri::command]
pub async fn sandbox_wipe(
    registry: State<'_, SandboxRegistry>,
    diagram_id: String,
) -> Result<(), String> {
    sandbox::wipe(registry.inner(), &diagram_id)
}

#[tauri::command]
pub async fn sandbox_close(
    registry: State<'_, SandboxRegistry>,
    diagram_id: String,
) -> Result<(), String> {
    sandbox::close(registry.inner(), &diagram_id);
    Ok(())
}

/// Deletes every sandbox file whose diagram is gone. Called once at launch.
#[tauri::command]
pub async fn sandbox_sweep(db: State<'_, Db>) -> Result<usize, String> {
    let known: HashSet<String> = {
        let conn = db.0.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id FROM diagrams")
            .map_err(|error| error.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        rows.flatten().collect()
    };
    blocking(move || Ok(sandbox::sweep(&known))).await
}
