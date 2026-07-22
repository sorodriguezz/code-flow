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
    Ok(Db(Mutex::new(conn)))
}
