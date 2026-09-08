//! One throwaway SQLite database per DBML diagram — the scratch data behind the **Datos** surface.
//!
//! The point of the feature is that the *engine* answers, not us. You draw two tables, press build,
//! and type rows in: a duplicate email comes back as `UNIQUE constraint failed: usuarios.email`
//! because your model said it was unique, not because a validator we wrote agreed with your model.
//! That is only true if there is a real database behind the grid, so there is one, per diagram, in
//! a file named by `diagrams.id`.
//!
//! **This module runs SQL it is handed and does not read it.** The DDL is emitted on the frontend
//! (`lib/dbml/sqlite.ts`), where the parsed `DbmlSchema` lives; what arrives here is text. The
//! console is the same: whatever the user typed runs, including `DELETE FROM usuarios` with no
//! confirmation and no rewrite. `sqlGuards.unguardedDelete` exists because the *Base de datos*
//! workspace console points at production connections — here a `DELETE` is a thing you write every
//! day, and refusing it would be refusing the feature.
//!
//! Two things do bound it, and both are set before any statement runs:
//!
//! - `SQLITE_LIMIT_ATTACHED = 0`, which is the only thing that stops an `ATTACH` typed into that
//!   console from reaching `codeflow.db`. There is a test.
//! - A progress handler, so the Stop button can interrupt a statement that is already running.
//!
//! # Why a file and not a table in the app database
//!
//! A table could only ever be a *mirror* of the real thing, rewritten on every insert — and the
//! moment someone types `CREATE TABLE scratch AS SELECT …` into the console, the mirror either lies
//! or has to become a generic dump. The console is not an extra; it is the feature. A file *is* the
//! database, so persistence is exact and costs nothing.
//!
//! And not a third `// codeflow:` sidecar in the document: `doc_versions` snapshots the previous
//! document on every save, capped at fifty, so fixtures would be duplicated fifty times — and
//! restoring one of those versions would resurrect old rows against a new schema, which is a
//! data-loss bug wearing a recovery button. `mergeDbml` would drop it too (`merge.ts:117` already
//! drops the marks sidecar for the same structural reason), so applying an AI answer would silently
//! delete every row.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use rusqlite::limits::Limit;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};

use crate::datasource::{DbColumn, DbStatementResult};
use crate::paths;

/// The metadata table written into every sandbox. Underscore-prefixed and named for the app, so a
/// user typing `select * from` and pressing tab does not find it first, and so the schema
/// comparison below can skip it by exact name rather than by a prefix rule.
const META_TABLE: &str = "_cf_sandbox";

/// How many rows one statement may return before the console is told it was cut short. Matches the
/// Database workspace's own console cap, for the same reason: a `SELECT *` on a table someone
/// filled from the console should not serialise a million rows across IPC.
const ROW_CAP: usize = 5_000;

/// A soft ceiling per sandbox. Nobody typing rows by hand reaches this; a runaway
/// `INSERT … SELECT` in the console does, and then the write is refused with a message instead of
/// filling the user's disk.
const MAX_BYTES: u64 = 64 * 1024 * 1024;

/// How often SQLite asks whether it should still be running. ~1ms of work at a typical VM speed —
/// small enough that Stop feels immediate, large enough that the callback is not the cost.
const PROGRESS_OPS: std::os::raw::c_int = 10_000;

/// The error text the frontend matches to show "cancelled" rather than a red failure. Deliberately
/// the same string the Database workspace uses, so one branch in the console handles both.
pub const CANCELLED: &str = "Query cancelled";

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/// What one sandbox is, as the panel reads it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxStatus {
    /// Whether the file exists. Everything else is meaningless when this is false — a diagram
    /// nobody has tested has no sandbox, which is the first of the four don't-leave-rubbish rules.
    pub built: bool,
    /// The fingerprint of the schema that produced these rows, or `null`. Compared against the
    /// current document's to decide whether the drift bar shows.
    pub fingerprint: Option<String>,
    /// The whole schema that built it, as JSON — not just its fingerprint. This is what lets the
    /// drift bar say *what* changed rather than only *that* something did.
    pub schema: Option<String>,
    /// `constraint name → (table, column, rule)`, as JSON. Written at build time because the name
    /// cannot be taken apart afterwards: `_` is legal in identifiers, so `ck_perfil_usuario_nombre_len`
    /// has two valid readings, and `NOT NULL constraint failed: core.usuarios.email` breaks a split
    /// on `.` as well.
    pub constraints: Option<String>,
    pub bytes: u64,
    /// Per table, in the order the map iterates. The rail's counts and the canvas's `~N`.
    pub counts: HashMap<String, i64>,
    /// What building it complained about — an unsatisfiable foreign key, mostly. Warnings do not
    /// stop the build; they are the answers the DBML alone could never give.
    pub warnings: Vec<String>,
}

impl SandboxStatus {
    fn absent() -> Self {
        Self {
            built: false,
            fingerprint: None,
            schema: None,
            constraints: None,
            bytes: 0,
            counts: HashMap::new(),
            warnings: Vec::new(),
        }
    }
}

/// One page of one table, plus what the grid needs to page and to write.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SandboxPage {
    pub columns: Vec<DbColumn>,
    pub rows: Vec<Vec<Option<String>>>,
    /// The `rowid` of each row, in the same order — the grid's row identity.
    ///
    /// Measured: `rowid` exists and numbers normally on a table whose primary key is text
    /// (`select rowid, cod from t` → `1|AB-01`), so an UPDATE or DELETE keyed on it is correct for
    /// text keys, composite keys and tables with no key at all. The one exception would be
    /// `WITHOUT ROWID`, which the emitter never produces.
    pub rowids: Vec<i64>,
    pub total: i64,
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/// The open connections, one per diagram, plus the switches that stop their statements.
///
/// Connections are kept rather than reopened per call because the console and the grid interleave —
/// paging a table between two inserts would otherwise pay for opening the file each time — and
/// because a connection is where the attach limit and the progress handler are installed. Reopening
/// per statement would mean re-establishing both, and the first time that was forgotten the limit
/// would be silently gone.
#[derive(Default)]
pub struct SandboxRegistry {
    conns: Mutex<HashMap<String, Arc<Mutex<Connection>>>>,
    /// Diagram id → "stop whatever is running". Read by the progress handler, which is the only
    /// thing that can interrupt SQLite mid-statement.
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl SandboxRegistry {
    /// The connection for this diagram, opening the file if it isn't open yet.
    ///
    /// Errors when the file does not exist rather than creating it: building is an explicit gesture
    /// with a button, and a `sandbox_page` that quietly created an empty database would make the
    /// panel show a built-looking sandbox nobody built.
    fn conn(&self, diagram_id: &str) -> Result<Arc<Mutex<Connection>>, String> {
        if let Some(existing) = self.conns.lock().unwrap().get(diagram_id) {
            return Ok(existing.clone());
        }
        let path = paths::sandbox_path(diagram_id);
        if !path.exists() {
            return Err("no sandbox for this diagram".to_string());
        }
        let conn = open_at(&path, false)?;
        install_progress(&conn, self.cancel_flag(diagram_id));
        let handle = Arc::new(Mutex::new(conn));
        self.conns
            .lock()
            .unwrap()
            .insert(diagram_id.to_string(), handle.clone());
        Ok(handle)
    }

    fn cancel_flag(&self, diagram_id: &str) -> Arc<AtomicBool> {
        self.cancels
            .lock()
            .unwrap()
            .entry(diagram_id.to_string())
            .or_default()
            .clone()
    }

    /// Drops the connection so the file can be replaced or deleted.
    ///
    /// Windows cannot remove a file that is still open, which is why every path that touches the
    /// file on disk — build, wipe, sweep, deleting the diagram — goes through here first.
    fn forget(&self, diagram_id: &str) {
        self.conns.lock().unwrap().remove(diagram_id);
        self.cancels.lock().unwrap().remove(diagram_id);
    }

    pub fn cancel(&self, diagram_id: &str) {
        if let Some(flag) = self.cancels.lock().unwrap().get(diagram_id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

/// Opens a sandbox file with the two settings that bound it, in the order they have to happen.
///
/// `SQLITE_LIMIT_ATTACHED` is set **before any statement runs**, and that ordering is the whole
/// point: the limit is checked when `ATTACH` is prepared, so a connection that ran one statement
/// first is a connection that was briefly able to reach `codeflow.db`.
fn open_at(path: &Path, create: bool) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    if create {
        flags |= OpenFlags::SQLITE_OPEN_CREATE;
    }
    let conn = Connection::open_with_flags(path, flags).map_err(|error| error.to_string())?;
    conn.set_limit(Limit::SQLITE_LIMIT_ATTACHED, 0);
    // Not optional either: without it a foreign key is a comment, and "does this reference actually
    // hold?" is one of the two questions the whole surface exists to answer.
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|error| error.to_string())?;
    Ok(conn)
}

/// Wires the Stop button to SQLite's progress callback and arms the flag fresh.
///
/// Returning `true` from the handler aborts the running statement with `SQLITE_INTERRUPT`, which
/// surfaces as an ordinary statement error — so a cancelled run reports per statement, like every
/// other failure, instead of taking the whole batch down.
fn install_progress(conn: &Connection, flag: Arc<AtomicBool>) {
    conn.progress_handler(
        PROGRESS_OPS,
        Some(move || flag.load(Ordering::SeqCst)),
    );
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/// Creates the file from scratch and runs the DDL in one transaction.
///
/// Destructive by construction: building replaces whatever was there. The panel never calls this
/// without either an empty sandbox or an explicit "Rebuild (deletes N rows)" that names the number.
pub fn build(
    registry: &SandboxRegistry,
    diagram_id: &str,
    ddl: &str,
    fingerprint: &str,
    schema_json: &str,
    constraints_json: &str,
) -> Result<SandboxStatus, String> {
    registry.forget(diagram_id);
    let path = paths::sandbox_path(diagram_id);
    // Removed rather than dropped and recreated in place: a failed `CREATE TABLE` half way through
    // the batch would otherwise leave the previous schema's tables standing beside the new ones.
    if path.exists() {
        std::fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    let conn = open_at(&path, true)?;

    let outcome = (|| -> Result<Vec<String>, String> {
        conn.execute_batch("BEGIN").map_err(sql_error)?;
        conn.execute_batch(ddl).map_err(sql_error)?;
        write_meta(&conn, fingerprint, schema_json, constraints_json)?;
        conn.execute_batch("COMMIT").map_err(sql_error)?;
        Ok(foreign_key_warnings(&conn))
    })();

    match outcome {
        Ok(warnings) => {
            drop(conn);
            let mut status = status_of(diagram_id)?;
            status.warnings = warnings;
            Ok(status)
        }
        Err(error) => {
            // The transaction is abandoned and the file goes with it. Leaving a half-built database
            // on disk would make `built: true` mean "there is a file", which is not the same as
            // "your model made a database" — and the panel keys everything off that flag.
            let _ = conn.execute_batch("ROLLBACK");
            drop(conn);
            let _ = std::fs::remove_file(&path);
            Err(error)
        }
    }
}

/// Applies a new schema to a sandbox that already holds rows, keeping what still fits.
///
/// **One generic rebuild rather than a catalogue of `ALTER` cases.** SQLite can add and drop a
/// column in place, but not change a type, a nullability or a constraint — and the in-place
/// `ADD COLUMN … NOT NULL` without a default is refused the moment a table has rows anyway
/// (measured: `Cannot add a NOT NULL column with default value NULL`). Since the interesting half
/// of the catalogue falls through to the twelve-step rebuild regardless, everything takes that
/// path: it is one code path to get right instead of six, and it behaves the same for all of them.
///
/// The twelve steps, in the order they have to happen:
///
/// 1. `foreign_keys = OFF` — **outside** the transaction, because SQLite silently ignores the
///    pragma inside one, and a rebuild that renames a parent table trips every reference into it.
/// 2. Drop the old indexes, or a `CREATE INDEX` in the new DDL collides with a name that a
///    `RENAME TABLE` carried across.
/// 3. Rename each old table aside, run the new DDL, copy the columns the two schemas share, drop
///    the old tables, write the metadata, and check the references.
///
/// A failure rolls the whole thing back and reports SQLite's own message — which is exactly what
/// the drift bar needs: `NOT NULL constraint failed: pedidos.slug` is the sentence that says the
/// change is harmless on an empty schema and impossible on the one you actually have.
pub fn migrate(
    registry: &SandboxRegistry,
    diagram_id: &str,
    ddl: &str,
    fingerprint: &str,
    schema_json: &str,
    constraints_json: &str,
) -> Result<SandboxStatus, String> {
    let handle = registry.conn(diagram_id)?;
    {
        let conn = handle.lock().unwrap();
        conn.execute_batch("PRAGMA foreign_keys = OFF;")
            .map_err(sql_error)?;

        let outcome = rebuild(&conn, ddl, fingerprint, schema_json, constraints_json);
        // The pragma is restored whichever way it went. Leaving it off would turn every later
        // insert into one that cannot fail a reference — the surface would keep working and stop
        // answering the question it exists for.
        let _ = conn.execute_batch("PRAGMA foreign_keys = ON;");
        outcome?;
    }
    // Re-read from the file so the size and counts are the ones on disk, not the ones we predicted.
    let mut status = status_of(diagram_id)?;
    let conn = handle.lock().unwrap();
    status.warnings = foreign_key_warnings(&conn);
    Ok(status)
}

fn rebuild(
    conn: &Connection,
    ddl: &str,
    fingerprint: &str,
    schema_json: &str,
    constraints_json: &str,
) -> Result<(), String> {
    let old_tables = user_tables(conn);
    let old_columns: HashMap<String, Vec<String>> = old_tables
        .iter()
        .map(|name| (name.clone(), columns_of(conn, name)))
        .collect();

    let attempt = (|| -> Result<(), String> {
        conn.execute_batch("BEGIN").map_err(sql_error)?;
        for index in user_indexes(conn) {
            conn.execute_batch(&format!("DROP INDEX IF EXISTS {}", ident(&index)))
                .map_err(sql_error)?;
        }
        for name in &old_tables {
            conn.execute_batch(&format!(
                "ALTER TABLE {} RENAME TO {}",
                ident(name),
                ident(&format!("_cf_old_{name}"))
            ))
            .map_err(sql_error)?;
        }
        conn.execute_batch(ddl).map_err(sql_error)?;

        for name in user_tables(conn) {
            let Some(before) = old_columns.get(&name) else { continue };
            let after = columns_of(conn, &name);
            // The intersection, in the *new* table's order. A column that only exists on one side
            // is simply not copied — which is what makes a rename read as a drop plus an add, and
            // why the bar says so rather than guessing.
            let shared: Vec<String> = after
                .into_iter()
                .filter(|column| before.contains(column))
                .collect();
            if shared.is_empty() {
                continue;
            }
            let list = shared.iter().map(|c| ident(c)).collect::<Vec<_>>().join(", ");
            conn.execute_batch(&format!(
                "INSERT INTO {} ({list}) SELECT {list} FROM {}",
                ident(&name),
                ident(&format!("_cf_old_{name}"))
            ))
            .map_err(sql_error)?;
        }

        for name in &old_tables {
            conn.execute_batch(&format!(
                "DROP TABLE IF EXISTS {}",
                ident(&format!("_cf_old_{name}"))
            ))
            .map_err(sql_error)?;
        }
        write_meta(conn, fingerprint, schema_json, constraints_json)?;
        conn.execute_batch("COMMIT").map_err(sql_error)?;
        Ok(())
    })();

    if attempt.is_err() {
        let _ = conn.execute_batch("ROLLBACK");
    }
    attempt
}

/// The tables a user would recognise: no `sqlite_*`, no metadata, and none of the rebuild's own
/// scaffolding — which matters because a rolled-back rebuild can leave `_cf_old_*` behind.
fn user_tables(conn: &Connection) -> Vec<String> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' \
         ORDER BY name",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) else {
        return Vec::new();
    };
    rows.flatten()
        .filter(|name| name != META_TABLE && !name.starts_with("_cf_old_"))
        .collect()
}

fn user_indexes(conn: &Connection) -> Vec<String> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) else {
        return Vec::new();
    };
    rows.flatten().collect()
}

fn columns_of(conn: &Connection, table: &str) -> Vec<String> {
    let sql = format!("SELECT name FROM pragma_table_info({})", literal(table));
    let Ok(mut stmt) = conn.prepare(&sql) else { return Vec::new() };
    let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) else {
        return Vec::new();
    };
    rows.flatten().collect()
}

fn write_meta(
    conn: &Connection,
    fingerprint: &str,
    schema_json: &str,
    constraints_json: &str,
) -> Result<(), String> {
    conn.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS \"{META_TABLE}\" (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    ))
    .map_err(sql_error)?;
    for (key, value) in [
        ("fingerprint", fingerprint),
        ("schema", schema_json),
        ("constraints", constraints_json),
    ] {
        conn.execute(
            &format!("INSERT OR REPLACE INTO \"{META_TABLE}\" (key, value) VALUES (?1, ?2)"),
            rusqlite::params![key, value],
        )
        .map_err(sql_error)?;
    }
    Ok(())
}

/// A quoted identifier. Every name here comes from `sqlite_master`, never from the console.
fn ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// A quoted string literal, for the one place a name is passed as a *value* (`pragma_table_info`).
fn literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

/// What `PRAGMA foreign_key_check` says about a schema with no rows in it yet.
///
/// This is the part that earns the build button on its own. A `Ref: pedidos.correo > usuarios.email`
/// where `email` is not unique is a `foreign key mismatch` — reported here, against empty tables,
/// before a single row exists. DBML alone will never tell you that.
fn foreign_key_warnings(conn: &Connection) -> Vec<String> {
    let mut warnings = Vec::new();
    let mut stmt = match conn.prepare("PRAGMA foreign_key_check") {
        Ok(stmt) => stmt,
        // Measured, and the reason this is not an `if let … else { return }`: an unsatisfiable
        // reference does not come back as a *row* from this pragma. It fails the pragma itself,
        // at prepare time, with `foreign key mismatch - "pedidos" referencing "usuarios"`. Written
        // the obvious way, the single most valuable thing a build can tell you would be swallowed
        // as "the pragma didn't work" and the panel would report a clean build.
        Err(error) => {
            warnings.push(sql_error(error));
            return warnings;
        }
    };
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0).unwrap_or_default(),
            row.get::<_, String>(2).unwrap_or_default(),
        ))
    });
    match rows {
        Ok(rows) => {
            for entry in rows.flatten() {
                warnings.push(format!("{} → {}", entry.0, entry.1));
            }
        }
        Err(error) => warnings.push(sql_error(error)),
    }
    warnings
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

pub fn status_of(diagram_id: &str) -> Result<SandboxStatus, String> {
    let path = paths::sandbox_path(diagram_id);
    if !path.exists() {
        return Ok(SandboxStatus::absent());
    }
    let bytes = std::fs::metadata(&path)
        .map(|meta| meta.len())
        .unwrap_or(0);
    let conn = open_at(&path, false)?;
    let meta = |key: &str| -> Option<String> {
        conn.query_row(
            &format!("SELECT value FROM \"{META_TABLE}\" WHERE key = ?1"),
            rusqlite::params![key],
            |row| row.get::<_, String>(0),
        )
        .ok()
    };
    Ok(SandboxStatus {
        built: true,
        fingerprint: meta("fingerprint"),
        schema: meta("schema"),
        constraints: meta("constraints"),
        bytes,
        counts: counts_in(&conn),
        warnings: Vec::new(),
    })
}

/// Row counts per table. The rail's numbers and the canvas's `~N` come from the same call, so the
/// two can never disagree.
fn counts_in(conn: &Connection) -> HashMap<String, i64> {
    let mut counts = HashMap::new();
    let Ok(mut stmt) = conn.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ) else {
        return counts;
    };
    let Ok(names) = stmt.query_map([], |row| row.get::<_, String>(0)) else {
        return counts;
    };
    for name in names.flatten() {
        if name == META_TABLE {
            continue;
        }
        // The identifier is quoted, not interpolated raw: a DBML table may legally be called
        // `order` or carry a quote in its name, and this string is built from `sqlite_master`
        // rather than from anything the user typed into the console.
        let sql = format!("SELECT COUNT(*) FROM \"{}\"", name.replace('"', "\"\""));
        if let Ok(count) = conn.query_row(&sql, [], |row| row.get::<_, i64>(0)) {
            counts.insert(name, count);
        }
    }
    counts
}

pub fn counts(registry: &SandboxRegistry, diagram_id: &str) -> Result<HashMap<String, i64>, String> {
    let handle = registry.conn(diagram_id)?;
    let conn = handle.lock().unwrap();
    Ok(counts_in(&conn))
}

/// One page of one table, ordered by `rowid` so the order is the order rows were written.
pub fn page(
    registry: &SandboxRegistry,
    diagram_id: &str,
    table: &str,
    offset: i64,
    limit: i64,
) -> Result<SandboxPage, String> {
    let handle = registry.conn(diagram_id)?;
    let conn = handle.lock().unwrap();
    let quoted = format!("\"{}\"", table.replace('"', "\"\""));
    let total: i64 = conn
        .query_row(&format!("SELECT COUNT(*) FROM {quoted}"), [], |row| row.get(0))
        .map_err(sql_error)?;

    // `rowid` first and then `*`, so the identity column is at a known index and never collides
    // with a user column that happens to be called `rowid` — it would simply appear twice, and the
    // grid reads position 0.
    let sql = format!("SELECT rowid, * FROM {quoted} ORDER BY rowid LIMIT ?1 OFFSET ?2");
    let mut stmt = conn.prepare(&sql).map_err(sql_error)?;
    let columns: Vec<DbColumn> = stmt
        .columns()
        .iter()
        .skip(1)
        .map(|column| {
            DbColumn::new(
                column.name(),
                column.decl_type().unwrap_or_default().to_string(),
            )
        })
        .collect();
    let width = columns.len();

    let mut rows = Vec::new();
    let mut rowids = Vec::new();
    let mut cursor = stmt.query(rusqlite::params![limit, offset]).map_err(sql_error)?;
    while let Some(row) = cursor.next().map_err(sql_error)? {
        rowids.push(row.get::<_, i64>(0).map_err(sql_error)?);
        let mut values = Vec::with_capacity(width);
        for index in 0..width {
            values.push(cell(row, index + 1));
        }
        rows.push(values);
    }
    Ok(SandboxPage {
        columns,
        rows,
        rowids,
        total,
    })
}

/// One value as the wire carries it: `None` is SQL NULL, `Some("")` is an empty string.
///
/// The distinction survives end to end on purpose — a grid that collapsed the two would make it
/// impossible to tell a column you left blank from one you set to `''`, which is exactly the kind
/// of thing you build a scratch database to find out.
fn cell(row: &rusqlite::Row<'_>, index: usize) -> Option<String> {
    match row.get_ref(index) {
        Ok(rusqlite::types::ValueRef::Null) | Err(_) => None,
        Ok(rusqlite::types::ValueRef::Integer(value)) => Some(value.to_string()),
        Ok(rusqlite::types::ValueRef::Real(value)) => Some(value.to_string()),
        Ok(rusqlite::types::ValueRef::Text(value)) => {
            Some(String::from_utf8_lossy(value).into_owned())
        }
        Ok(rusqlite::types::ValueRef::Blob(value)) => Some(format!("<{} bytes>", value.len())),
    }
}

// ---------------------------------------------------------------------------
// Executing
// ---------------------------------------------------------------------------

/// Runs a console buffer, one `DbStatementResult` per statement.
///
/// No guards, no implicit limit on what may run, no rewriting of the text. The only thing that
/// stops early is the size ceiling, and only for statements that write.
pub fn execute(
    registry: &SandboxRegistry,
    diagram_id: &str,
    sql: &str,
) -> Result<Vec<DbStatementResult>, String> {
    let handle = registry.conn(diagram_id)?;
    let flag = registry.cancel_flag(diagram_id);
    flag.store(false, Ordering::SeqCst);
    let conn = handle.lock().unwrap();

    let statements = crate::datasource::split_statements(sql, None);
    let mut results = Vec::new();
    for statement in statements {
        let trimmed = statement.trim();
        if trimmed.is_empty() {
            continue;
        }
        if writes(trimmed) {
            if let Err(error) = check_size(diagram_id) {
                results.push(DbStatementResult::failed(trimmed, error));
                break;
            }
        }
        let started = std::time::Instant::now();
        let mut result = run_one(&conn, trimmed);
        result.duration_ms = started.elapsed().as_millis() as u64;
        let failed = result.error.is_some();
        results.push(result);
        // A batch stops at the first failure, which is what a console user means by "run this
        // script": the statements after a failed `CREATE TABLE` are written against a table that
        // does not exist, and running them produces a wall of consequential errors that hides the
        // one that matters.
        if failed {
            break;
        }
    }
    if flag.swap(false, Ordering::SeqCst) {
        for result in results.iter_mut() {
            if result.error.is_some() {
                result.error = Some(CANCELLED.to_string());
            }
        }
    }
    Ok(results)
}

fn run_one(conn: &Connection, statement: &str) -> DbStatementResult {
    let mut out = DbStatementResult::empty(statement);
    let mut stmt = match conn.prepare(statement) {
        Ok(stmt) => stmt,
        Err(error) => return DbStatementResult::failed(statement, sql_error(error)),
    };
    let width = stmt.column_count();
    // A statement with no result columns is a write — `INSERT`, `UPDATE`, `DELETE`, DDL — and
    // reporting its affected-row count is the only thing it has to say. `INSERT … RETURNING` has
    // columns, so it correctly takes the other branch and comes back as rows.
    if width == 0 {
        return match stmt.execute([]) {
            Ok(changed) => {
                out.rows_affected = Some(changed as i64);
                out
            }
            Err(error) => DbStatementResult::failed(statement, sql_error(error)),
        };
    }

    out.columns = stmt
        .columns()
        .iter()
        .map(|column| {
            DbColumn::new(
                column.name(),
                column.decl_type().unwrap_or_default().to_string(),
            )
        })
        .collect();
    let mut cursor = match stmt.query([]) {
        Ok(cursor) => cursor,
        Err(error) => return DbStatementResult::failed(statement, sql_error(error)),
    };
    loop {
        match cursor.next() {
            Ok(Some(row)) => {
                if out.rows.len() >= ROW_CAP {
                    out.truncated = true;
                    break;
                }
                out.rows
                    .push((0..width).map(|index| cell(row, index)).collect());
            }
            Ok(None) => break,
            Err(error) => {
                out.error = Some(sql_error(error));
                break;
            }
        }
    }
    out
}

/// Whether a statement could grow the file. Only used to decide when to check the ceiling, so a
/// false positive costs one `stat` and a false negative costs nothing — the next write catches it.
fn writes(statement: &str) -> bool {
    let head = statement
        .trim_start()
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        head.as_str(),
        "insert" | "update" | "replace" | "create" | "alter" | "with"
    )
}

fn check_size(diagram_id: &str) -> Result<(), String> {
    let path = paths::sandbox_path(diagram_id);
    let bytes = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    if bytes >= MAX_BYTES {
        return Err(format!(
            "This scratch database has reached its {} MB ceiling. Delete some rows, or wipe it and \
             build again.",
            MAX_BYTES / (1024 * 1024)
        ));
    }
    Ok(())
}

/// SQLite's own message, with the interrupt mapped to the string the console shows as "cancelled".
fn sql_error(error: rusqlite::Error) -> String {
    let text = match &error {
        rusqlite::Error::SqliteFailure(_, Some(message)) => message.clone(),
        other => other.to_string(),
    };
    if text.contains("interrupted") {
        return CANCELLED.to_string();
    }
    text
}

// ---------------------------------------------------------------------------
// Taking it with you
// ---------------------------------------------------------------------------

/// The whole sandbox as a `.sql` script: schema, then one `INSERT` per row.
///
/// Text rather than the file itself, because that is what the app's save dialog takes for text —
/// and because a script is the form you can paste into a real database, which is the only reason
/// to export a scratch one at all. The metadata table is left out: it is ours, and a script that
/// recreated it would carry our bookkeeping into somebody's Postgres.
pub fn export_sql(registry: &SandboxRegistry, diagram_id: &str) -> Result<String, String> {
    let handle = registry.conn(diagram_id)?;
    let conn = handle.lock().unwrap();
    let mut out = String::new();

    let mut stmt = conn
        .prepare(
            "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' \
             AND name <> ?1 ORDER BY type DESC, name",
        )
        .map_err(sql_error)?;
    let rows = stmt
        .query_map(rusqlite::params![META_TABLE], |row| row.get::<_, String>(0))
        .map_err(sql_error)?;
    for statement in rows.flatten() {
        out.push_str(&statement);
        out.push_str(";\n\n");
    }

    for table in user_tables(&conn) {
        let columns = columns_of(&conn, &table);
        if columns.is_empty() {
            continue;
        }
        let list = columns.iter().map(|c| ident(c)).collect::<Vec<_>>().join(", ");
        let select = format!("SELECT {list} FROM {} ORDER BY rowid", ident(&table));
        let Ok(mut rows_stmt) = conn.prepare(&select) else { continue };
        let Ok(mut cursor) = rows_stmt.query([]) else { continue };
        let mut wrote = false;
        while let Ok(Some(row)) = cursor.next() {
            let values: Vec<String> = (0..columns.len())
                .map(|index| match cell(row, index) {
                    None => "NULL".to_string(),
                    Some(value) => literal(&value),
                })
                .collect();
            out.push_str(&format!(
                "INSERT INTO {} ({list}) VALUES ({});\n",
                ident(&table),
                values.join(", ")
            ));
            wrote = true;
        }
        if wrote {
            out.push('\n');
        }
    }
    Ok(out)
}

/// The database file itself, base64-encoded for the bridge.
///
/// `VACUUM INTO` rather than copying the file: it writes a single consistent image even with the
/// connection open and a WAL beside it, which a `std::fs::copy` of a live database does not.
pub fn export_file(registry: &SandboxRegistry, diagram_id: &str) -> Result<String, String> {
    let handle = registry.conn(diagram_id)?;
    let conn = handle.lock().unwrap();
    let target = std::env::temp_dir().join(format!("cf-sandbox-export-{diagram_id}.sqlite"));
    // `VACUUM INTO` refuses to overwrite, so a leftover from an interrupted export would make every
    // later one fail.
    let _ = std::fs::remove_file(&target);
    conn.execute_batch(&format!("VACUUM INTO {}", literal(&target.to_string_lossy())))
        .map_err(sql_error)?;
    let bytes = std::fs::read(&target).map_err(|error| error.to_string())?;
    let _ = std::fs::remove_file(&target);
    Ok(base64_encode(&bytes))
}

/// Base64, written out rather than pulled in: the crate is a dependency of things this module does
/// not otherwise touch, and this is the only place in it that needs one.
fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { ALPHABET[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[n as usize & 63] as char } else { '=' });
    }
    out
}

// ---------------------------------------------------------------------------
// Cleaning up
// ---------------------------------------------------------------------------

/// Deletes the file. The "no dejar basura" gesture, and the one behind the bin icon in the status
/// line. Never touches the document.
pub fn wipe(registry: &SandboxRegistry, diagram_id: &str) -> Result<(), String> {
    registry.forget(diagram_id);
    let path = paths::sandbox_path(diagram_id);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    // WAL and shared-memory sidecars, if the connection did not get to clean them up.
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = path.clone().into_os_string();
        sidecar.push(suffix);
        let _ = std::fs::remove_file(std::path::PathBuf::from(sidecar));
    }
    Ok(())
}

pub fn close(registry: &SandboxRegistry, diagram_id: &str) {
    registry.forget(diagram_id);
}

/// Deletes every sandbox whose diagram no longer exists.
///
/// Covers the three ways a file can outlive its owner: a workspace deleted while the app was shut,
/// a backup restored over the database, and a crash between removing the file and removing the row.
/// Cheap enough to run at launch — one `read_dir` over a directory with as many entries as the user
/// has tested diagrams.
pub fn sweep(known: &HashSet<String>) -> usize {
    let dir = paths::sandbox_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("sqlite") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        if known.contains(stem) {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.set_limit(Limit::SQLITE_LIMIT_ATTACHED, 0);
        conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        conn
    }

    /// The one that has to hold: a console is a place to type arbitrary SQL, and without this limit
    /// `ATTACH 'codeflow.db' AS app` from inside it reaches every row the application owns.
    #[test]
    fn attach_is_refused() {
        let conn = scratch();
        let error = conn
            .execute_batch("ATTACH DATABASE ':memory:' AS other")
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("too many attached") || error.to_lowercase().contains("attach"),
            "expected the attach limit to refuse it, got: {error}"
        );
    }

    /// `rowid` is the grid's row identity for *every* table, which is only true if it survives a
    /// primary key that is not an integer. Measured rather than assumed.
    #[test]
    fn rowid_numbers_a_text_key_table() {
        let conn = scratch();
        conn.execute_batch(
            "CREATE TABLE t (cod TEXT PRIMARY KEY, n TEXT); INSERT INTO t VALUES ('AB-01','x');",
        )
        .unwrap();
        let (id, cod): (i64, String) = conn
            .query_row("SELECT rowid, cod FROM t", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!((id, cod.as_str()), (1, "AB-01"));
    }

    /// A write statement is recognised so the size ceiling is checked before it runs. `select` must
    /// not be, or every read would pay for a `stat`.
    #[test]
    fn writes_recognises_the_write_verbs() {
        assert!(writes("INSERT INTO t VALUES (1)"));
        assert!(writes("  update t set a = 1"));
        assert!(writes("CREATE TABLE x (a int)"));
        assert!(!writes("select * from t"));
        assert!(!writes("DELETE FROM t"), "delete shrinks the file, never grows it");
    }

    /// The build's most valuable warning arrives as a *failure of the pragma*, not as a row from
    /// it. Written the obvious way this case reports a clean build, which is the opposite of true.
    #[test]
    fn an_unsatisfiable_reference_fails_the_pragma_itself() {
        let conn = scratch();
        conn.execute_batch(
            "CREATE TABLE usuarios (id INTEGER PRIMARY KEY, email TEXT);
             CREATE TABLE pedidos (correo TEXT REFERENCES usuarios(email));",
        )
        .unwrap();
        let warnings = foreign_key_warnings(&conn);
        assert_eq!(warnings.len(), 1, "got: {warnings:?}");
        assert!(
            warnings[0].contains("foreign key mismatch"),
            "got: {}",
            warnings[0]
        );
    }

    /// And a schema whose references *do* hold says nothing at all, or every build would open with
    /// a warning nobody can act on.
    #[test]
    fn a_sound_schema_warns_about_nothing() {
        let conn = scratch();
        conn.execute_batch(
            "CREATE TABLE usuarios (id INTEGER PRIMARY KEY, email TEXT UNIQUE);
             CREATE TABLE pedidos (usuario_id INTEGER REFERENCES usuarios(id));",
        )
        .unwrap();
        assert!(foreign_key_warnings(&conn).is_empty());
    }

    /// The metadata table is skipped by the counts, or every table list in the UI would carry an
    /// internal row nobody created.
    #[test]
    fn counts_skip_the_metadata_table() {
        let conn = scratch();
        conn.execute_batch(&format!(
            "CREATE TABLE \"{META_TABLE}\" (key TEXT PRIMARY KEY, value TEXT);
             INSERT INTO \"{META_TABLE}\" VALUES ('fingerprint','abc');
             CREATE TABLE usuarios (id INTEGER PRIMARY KEY);
             INSERT INTO usuarios VALUES (1), (2);"
        ))
        .unwrap();
        let counts = counts_in(&conn);
        assert_eq!(counts.get("usuarios"), Some(&2));
        assert!(!counts.contains_key(META_TABLE));
    }

    /// A registry holding one already-open connection, so `page` and `execute` can be exercised
    /// without going through `paths::state_dir()` — which is a process-wide `OnceLock` and the
    /// user's real application-support directory.
    fn registry_with(conn: Connection) -> SandboxRegistry {
        let registry = SandboxRegistry::default();
        registry
            .conns
            .lock()
            .unwrap()
            .insert("d1".to_string(), Arc::new(Mutex::new(conn)));
        registry
    }

    /// `page` selects `rowid, *`, so every column index it reports is shifted by one. Getting that
    /// skip wrong is invisible in a two-column table and silently shows the wrong data in a wide
    /// one — the values would all be one column to the left of their headers.
    #[test]
    fn a_page_carries_rowids_beside_the_row_and_not_inside_it() {
        let conn = scratch();
        conn.execute_batch(
            "CREATE TABLE productos (sku TEXT PRIMARY KEY, nombre TEXT, precio REAL);
             INSERT INTO productos VALUES ('TEC-01','Teclado',49.9), ('0012','Cable',9.9);",
        )
        .unwrap();
        let registry = registry_with(conn);
        let page = page(&registry, "d1", "productos", 0, 10).unwrap();

        assert_eq!(
            page.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            ["sku", "nombre", "precio"],
            "the rowid must not appear as a column"
        );
        assert_eq!(page.rowids, vec![1, 2]);
        assert_eq!(page.total, 2);
        assert_eq!(
            page.rows[0],
            vec![
                Some("TEC-01".to_string()),
                Some("Teclado".to_string()),
                Some("49.9".to_string())
            ]
        );
        // The text key that looks like a number stayed text all the way across the wire.
        assert_eq!(page.rows[1][0], Some("0012".to_string()));
    }

    /// NULL and the empty string must not collapse into each other anywhere on the path. A grid
    /// that showed them the same would make "I left this blank" and "I set this to ''" the same
    /// row, which is exactly the sort of thing a scratch database exists to tell you apart.
    #[test]
    fn null_and_the_empty_string_survive_the_trip() {
        let conn = scratch();
        conn.execute_batch(
            "CREATE TABLE t (a TEXT, b TEXT); INSERT INTO t VALUES (NULL, '');",
        )
        .unwrap();
        let page = page(&registry_with(conn), "d1", "t", 0, 10).unwrap();
        assert_eq!(page.rows[0], vec![None, Some(String::new())]);
    }

    /// A console batch stops at its first failure. Running on would produce a wall of consequential
    /// errors from statements written against a table the failed one was supposed to create.
    #[test]
    fn a_batch_stops_at_the_first_failure() {
        let conn = scratch();
        conn.execute_batch("CREATE TABLE t (a INTEGER PRIMARY KEY);").unwrap();
        let registry = registry_with(conn);
        let results = execute(
            &registry,
            "d1",
            "INSERT INTO t VALUES (1); INSERT INTO nope VALUES (2); INSERT INTO t VALUES (3);",
        )
        .unwrap();
        assert_eq!(results.len(), 2, "the third statement must not have run");
        assert_eq!(results[0].rows_affected, Some(1));
        assert!(results[1].error.as_deref().unwrap().contains("no such table"));
        // And the first statement's write stands — a batch is not a transaction.
        let page = page(&registry, "d1", "t", 0, 10).unwrap();
        assert_eq!(page.total, 1);
    }

    /// `INSERT … RETURNING` has result columns, so it must come back as *rows* rather than as an
    /// affected-row count. That is what lets the grid learn the id the engine assigned and the
    /// defaults it applied in the same round trip.
    #[test]
    fn returning_comes_back_as_rows() {
        let conn = scratch();
        conn.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, n TEXT DEFAULT 'x');")
            .unwrap();
        let results = execute(
            &registry_with(conn),
            "d1",
            "INSERT INTO t DEFAULT VALUES RETURNING rowid, *;",
        )
        .unwrap();
        assert_eq!(results[0].error, None);
        assert_eq!(results[0].rows.len(), 1);
        assert_eq!(
            results[0].rows[0],
            vec![
                Some("1".to_string()),
                Some("1".to_string()),
                Some("x".to_string())
            ]
        );
    }

    /// The counts the rail and the canvas both read come from one call, so they cannot disagree.
    #[test]
    fn counts_follow_the_writes() {
        let conn = scratch();
        conn.execute_batch("CREATE TABLE a (x INTEGER); CREATE TABLE b (y INTEGER);")
            .unwrap();
        let registry = registry_with(conn);
        execute(&registry, "d1", "INSERT INTO a VALUES (1), (2);").unwrap();
        let counts = counts(&registry, "d1").unwrap();
        assert_eq!(counts.get("a"), Some(&2));
        assert_eq!(counts.get("b"), Some(&0));
    }

    /// The rebuild keeps the columns two schemas share and drops the rest — which is also what
    /// makes a rename read as a drop plus an add, said out loud by the bar rather than guessed.
    #[test]
    fn a_migration_keeps_what_still_fits() {
        let conn = scratch();
        conn.execute_batch(
            "CREATE TABLE usuarios (id INTEGER PRIMARY KEY, email TEXT, edad INTEGER);
             INSERT INTO usuarios (email, edad) VALUES ('ana@x.test', 34), ('luis@x.test', 28);",
        )
        .unwrap();
        let registry = registry_with(conn);
        let handle = registry.conn("d1").unwrap();
        let conn = handle.lock().unwrap();

        // `edad` goes, `nota` arrives with a default, `email` stays.
        rebuild(
            &conn,
            "CREATE TABLE usuarios (id INTEGER PRIMARY KEY, email TEXT, nota TEXT DEFAULT 'x');",
            "fp2",
            "{}",
            "{}",
        )
        .unwrap();

        let (id, email, nota): (i64, String, String) = conn
            .query_row(
                "SELECT id, email, nota FROM usuarios ORDER BY rowid LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!((id, email.as_str(), nota.as_str()), (1, "ana@x.test", "x"));
        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM usuarios", [], |row| row.get(0))
            .unwrap();
        assert_eq!(total, 2, "both rows survived");
        // And no scaffolding is left behind.
        assert_eq!(user_tables(&conn), vec!["usuarios".to_string()]);
        let leftovers: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name LIKE '_cf_old_%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(leftovers, 0);
    }

    /// The failure path, which is the one the whole surface exists to produce: a column added
    /// `not null` with no default is harmless on an empty schema and impossible on the one you
    /// have. Nothing may be applied, and the message must name the column.
    #[test]
    fn a_migration_that_cannot_hold_the_rows_changes_nothing() {
        let conn = scratch();
        conn.execute_batch(
            "CREATE TABLE pedidos (id INTEGER PRIMARY KEY, total REAL);
             INSERT INTO pedidos (total) VALUES (1.0), (2.0), (3.0);",
        )
        .unwrap();
        let registry = registry_with(conn);
        let handle = registry.conn("d1").unwrap();
        let conn = handle.lock().unwrap();

        let error = rebuild(
            &conn,
            "CREATE TABLE pedidos (id INTEGER PRIMARY KEY, total REAL, slug TEXT NOT NULL);",
            "fp2",
            "{}",
            "{}",
        )
        .unwrap_err();
        assert!(error.contains("NOT NULL"), "got: {error}");
        assert!(error.contains("slug"), "the message must name the column: {error}");

        // Untouched: the old shape, the old rows, and no half-built replacement.
        assert_eq!(columns_of(&conn, "pedidos"), vec!["id", "total"]);
        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM pedidos", [], |row| row.get(0))
            .unwrap();
        assert_eq!(total, 3);
        assert_eq!(user_tables(&conn), vec!["pedidos".to_string()]);
    }

    /// The same change over an *empty* table is fine, which is the contrast that makes the message
    /// above worth printing.
    #[test]
    fn the_same_change_is_harmless_with_no_rows() {
        let conn = scratch();
        conn.execute_batch("CREATE TABLE pedidos (id INTEGER PRIMARY KEY, total REAL);")
            .unwrap();
        let registry = registry_with(conn);
        let handle = registry.conn("d1").unwrap();
        let conn = handle.lock().unwrap();
        rebuild(
            &conn,
            "CREATE TABLE pedidos (id INTEGER PRIMARY KEY, total REAL, slug TEXT NOT NULL);",
            "fp2",
            "{}",
            "{}",
        )
        .unwrap();
        assert_eq!(columns_of(&conn, "pedidos"), vec!["id", "total", "slug"]);
    }

    /// An index carried across by `RENAME TABLE` keeps its name, and the new DDL's `CREATE INDEX`
    /// would collide with it. Dropping them first is not optional.
    #[test]
    fn a_migration_survives_an_index_of_the_same_name() {
        let conn = scratch();
        conn.execute_batch(
            "CREATE TABLE t (a INTEGER, b INTEGER);
             CREATE INDEX idx_t_a ON t (a);
             INSERT INTO t VALUES (1, 2);",
        )
        .unwrap();
        let registry = registry_with(conn);
        let handle = registry.conn("d1").unwrap();
        let conn = handle.lock().unwrap();
        rebuild(
            &conn,
            "CREATE TABLE t (a INTEGER, b INTEGER, c TEXT);\nCREATE INDEX idx_t_a ON t (a);",
            "fp2",
            "{}",
            "{}",
        )
        .unwrap();
        assert_eq!(columns_of(&conn, "t"), vec!["a", "b", "c"]);
    }

    /// A `.sql` export is a script somebody can paste into a real database, so our bookkeeping
    /// table must not travel with it.
    #[test]
    fn the_sql_export_leaves_our_metadata_behind() {
        let conn = scratch();
        conn.execute_batch(&format!(
            "CREATE TABLE \"{META_TABLE}\" (key TEXT PRIMARY KEY, value TEXT);
             INSERT INTO \"{META_TABLE}\" VALUES ('fingerprint','abc');
             CREATE TABLE usuarios (id INTEGER PRIMARY KEY, email TEXT);
             INSERT INTO usuarios (email) VALUES ('ana@x.test'), (NULL);"
        ))
        .unwrap();
        let script = export_sql(&registry_with(conn), "d1").unwrap();
        assert!(script.contains("CREATE TABLE usuarios"));
        assert!(script.contains("INSERT INTO \"usuarios\""));
        assert!(script.contains("'ana@x.test'"));
        assert!(script.contains("NULL"), "a null must export as NULL, not as ''");
        assert!(!script.contains(META_TABLE), "our metadata must not travel");
    }

    /// The sweep is keyed on the file stem, so a diagram that still exists keeps its data and one
    /// that does not loses it. Run against a real directory because the bug it guards against is a
    /// path-handling bug.
    #[test]
    fn sweep_keeps_only_known_diagrams() {
        let dir = std::env::temp_dir().join(format!("cf-sandbox-sweep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["alive.sqlite", "gone.sqlite", "notes.txt"] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        // `sweep` reads `paths::sandbox_dir()`, so this exercises the same predicate directly
        // rather than reaching into the real state root from a test.
        let known: HashSet<String> = ["alive".to_string()].into_iter().collect();
        let mut removed = 0;
        for entry in std::fs::read_dir(&dir).unwrap().flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("sqlite") {
                continue;
            }
            let stem = path.file_stem().unwrap().to_str().unwrap().to_string();
            if !known.contains(&stem) && std::fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
        assert_eq!(removed, 1);
        assert!(dir.join("alive.sqlite").exists());
        assert!(!dir.join("gone.sqlite").exists());
        assert!(dir.join("notes.txt").exists(), "the sweep only claims .sqlite files");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
