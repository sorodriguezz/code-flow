pub mod api_backup;
pub mod api_queries;
pub mod api_sync;
pub mod datasource_queries;
pub mod migrations;
pub mod models;
pub mod queries;

use rusqlite::Connection;
use std::sync::Mutex;

use crate::paths;

pub struct Db(pub Mutex<Connection>);

pub fn init() -> rusqlite::Result<Db> {
    paths::ensure_dirs().expect("failed to create CodeFlow config directory");
    let conn = Connection::open(paths::db_path())?;
    migrations::run(&conn)?;
    // Before any window exists: a previous session killed mid-run leaves rows claiming to be
    // running with no process behind them, and the frontend's own correction only happens if the
    // user opens the view that owns them. See `queries::recover_after_restart`.
    queries::recover_after_restart(&conn)?;
    Ok(Db(Mutex::new(conn)))
}
