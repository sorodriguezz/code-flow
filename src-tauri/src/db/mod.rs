pub mod api_backup;
pub mod api_queries;
pub mod api_sync;
pub mod datasource_queries;
pub mod diagram_queries;
pub mod keyvault_queries;
pub mod migrations;
pub mod models;
pub mod note_queries;
pub mod queries;
pub mod remote_queries;

use rusqlite::Connection;
use std::sync::Mutex;

use crate::paths;

pub struct Db(pub Mutex<Connection>);

pub fn init() -> rusqlite::Result<Db> {
    paths::ensure_dirs().expect("failed to create CodeFlow config directory");
    open(Connection::open(paths::db_path())?)
}

/// A throwaway database in memory, for a launch where the state root must not be written to.
///
/// Used when [`crate::migrate`] reports a layout it cannot vouch for — a copy that failed, an
/// unrecognised occupant, a shared Windows root. The frontend blocks the whole window in that case
/// (`DataDirsNotice`), so nothing *should* reach this connection; this is the second lock, and it
/// is the one that holds if the first is ever wrong. The alternative is what this used to do:
/// `Connection::open` on the state root, which on a failed migration means either creating a fresh
/// empty database beside the user's real one — a plausible, working, empty app — or opening the
/// truncated remains of a half-finished copy, which returns `SQLITE_CORRUPT` from the schema parse
/// and takes the `.expect()` in `run()` down with it. That panic happens before any window exists,
/// on every subsequent launch, so the recovery screen with the Retry button could never be reached.
///
/// The whole schema is created here, exactly as on disk, because every command in the app assumes
/// its tables exist and a blocked window still mounts its React tree.
pub fn init_scratch() -> rusqlite::Result<Db> {
    open(Connection::open_in_memory()?)
}

fn open(conn: Connection) -> rusqlite::Result<Db> {
    // Must come before `migrations::run` — the journal mode is a property of the database file,
    // and switching it is cheapest when nothing is mid-transaction.
    //
    // Why WAL: the default rollback journal costs *two* fsyncs per write transaction, and this
    // connection is written from the UI thread by things that fire constantly — the terminal
    // transcript flusher (every 4s), `ai_usage::record` on every agent run, every settings toggle.
    // On Windows an fsync is far more expensive than on APFS, and that was showing up as the
    // window going unresponsive mid-typing. WAL writes append to a sidecar and readers never block
    // the writer.
    //
    // Why `synchronous = NORMAL` is safe here: in WAL mode NORMAL only gives up durability for the
    // last few transactions on an OS/power crash — the database itself cannot corrupt, which is the
    // guarantee that actually matters for a local settings/history store. (In rollback-journal mode
    // NORMAL *would* risk corruption; it is specifically WAL that makes this trade sound.)
    //
    // Why a single writer is guaranteed: `tauri-plugin-single-instance` means there is never a
    // second CodeFlow process on this file, and inside the process every access goes through the
    // `Mutex<Connection>` below.
    //
    // That claim was false on Windows until v1.19, and worth recording as the reason the data
    // directory moved. The old `C:\CodeFlow` had no per-user component, so every local account
    // shared one database file — and the plugin's mutex is per Terminal Services session, so two
    // signed-in accounts under fast user switching defeated it outright. Two processes, one file,
    // each running `recover_after_restart` and demoting the other's live rows to `interrupted`.
    // The state root is per user now (`paths::state_dir`), which is what makes the sentence above
    // true rather than aspirational.
    //
    // `busy_timeout` is the precondition for ever moving read commands off the UI thread: the
    // moment a second connection can exist, a reader that lands during a checkpoint must wait
    // rather than fail with SQLITE_BUSY.
    //
    // `execute_batch` and not `execute`: `PRAGMA journal_mode` *returns a row* (the resulting
    // mode), and `execute` errors on any statement that yields rows. `execute_batch` steps past it
    // (rusqlite only rejects rows here under its `extra_check` feature, which we do not enable).
    //
    // If WAL cannot be had — a home directory on a network share has no shared memory to put the
    // `-shm` file in — SQLite answers with the *old* mode instead of failing, so this degrades to
    // the previous behaviour rather than refusing to start.
    conn.execute_batch(
        "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;",
    )?;
    migrations::run(&conn)?;
    // Before any window exists: a previous session killed mid-run leaves rows claiming to be
    // running with no process behind them, and the frontend's own correction only happens if the
    // user opens the view that owns them. See `queries::recover_after_restart`.
    queries::recover_after_restart(&conn)?;
    Ok(Db(Mutex::new(conn)))
}
