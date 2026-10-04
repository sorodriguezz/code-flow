pub mod api_backup;
pub mod api_cookie_seal;
pub mod api_import;
pub mod api_queries;
pub mod api_secrets;
pub mod api_sync;
pub mod api_trust;
pub mod chat_queries;
pub mod datasource_queries;
pub mod diagram_queries;
pub mod flow_queries;
pub mod flow_run_queries;
pub mod hybrid_queries;
pub mod keyvault_queries;
pub mod migrations;
pub mod models;
pub mod note_queries;
pub mod version_queries;
pub mod queries;
pub mod remote_queries;
pub mod service_queries;

use rusqlite::Connection;
use std::sync::Mutex;

pub struct Db(pub Mutex<Connection>);

// Opening used to be one call, `init()`, that also migrated and recovered and was `.expect()`ed in
// `run()`: a migration step that met data it did not expect, a file that is no longer a database, a
// full disk — any of them panicked before a window existed, on that launch and on every one after it,
// and the reason reached only the log. The steps are separate now — `read_stamp` on the bare
// connection, `configure`, `migrate`, `finish` — so the boot guard can look at a database
// before anything changes it (which build last migrated it, whether it wants a copy first) and turn a
// failure into a question instead of a crash. See `boot_guard`.

/// Which build last migrated this database, as [`version_stamp`] encodes it: `0` when none has —
/// every database from before the stamp existed, and every brand-new one.
///
/// Kept in SQLite's own `user_version` header field rather than in a table. It needs no schema, so
/// it can be read before [`migrate`] has run; it is written inside the migration's transaction, so a
/// migration that rolls back leaves the previous stamp in place; `VACUUM INTO` carries it into every
/// pre-migration copy; and it is not a row, so it never travels in a backup — which build last
/// migrated *this file* is a fact about this machine.
pub fn read_stamp(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
}

/// `major.minor.patch` as one integer that sorts the way the versions do, for `user_version`:
/// `2.0.5` is `2_000_005`.
///
/// Pre-release and build suffixes are dropped. Every release this app ships is a plain version, and
/// a stamp that cannot tell `2.1.0-beta.1` from `2.1.0` costs no more than a missed downgrade warning
/// between the two. `None` for anything else — a component too wide for its three digits, and
/// `0.0.0`, which would read as "never stamped".
pub fn version_stamp(version: &str) -> Option<i64> {
    let core = version.trim().split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|part| part.parse::<u32>().ok());
    let (major, minor, patch) = (parts.next()??, parts.next()??, parts.next()??);
    if parts.next().is_some() || minor > 999 || patch > 999 {
        return None;
    }
    let stamp = i64::from(major) * 1_000_000 + i64::from(minor) * 1_000 + i64::from(patch);
    (stamp > 0 && stamp <= i64::from(i32::MAX)).then_some(stamp)
}

/// [`version_stamp`] read back, for messages and the log.
pub fn stamp_version(stamp: i64) -> String {
    format!("{}.{}.{}", stamp / 1_000_000, stamp / 1_000 % 1_000, stamp % 1_000)
}

/// Brings the schema up to date — every step of [`migrations::run`] in one transaction — and writes
/// `stamp` (see [`read_stamp`]) in that same transaction.
///
/// **Why one transaction.** The steps are idempotent, so a list that dies half-way is simply run
/// from the top next time; the trouble was everything in between. A step that fails fails again on
/// the next launch, and meanwhile the database sits half-migrated: neither the shape the previous
/// build understands nor the one this build needs. Rolled back, a failed migration leaves exactly
/// what the previous version left — which the recovery dialog can then say truthfully, and which
/// that version can still open.
///
/// **Why foreign keys are off for it.** `PRAGMA foreign_keys` is a no-op inside a transaction, and
/// the steps switch it. The `api_*` move renames tables under `legacy_alter_table` with foreign keys
/// *off*, precisely so SQLite leaves the children's `REFERENCES` pointing at the original name;
/// pinned on by an enclosing transaction, that rename would drag `api_folders` and `api_requests`
/// along to the renamed table, which is then dropped. So they go off before `BEGIN` — SQLite's own
/// recipe for schema changes — and come back on afterwards for everything else this connection
/// does. What running every step with them off changes is only what foreign keys enforce: no step
/// relies on a cascade to do its work (a step that ever needs one has to delete the children
/// itself), and a row that would have failed the check gets in instead of failing the launch.
///
/// **A step that opens its own transaction** cannot run inside this one: `BEGIN` inside `BEGIN` is an
/// error in SQLite. Rather than turn that into a launch that fails forever, the attempt is rolled
/// back and the list runs once more the way it always used to, statement by statement, with a
/// warning in the log naming the problem — such a step should use a `SAVEPOINT`, which nests.
///
/// `VACUUM` and `PRAGMA journal_mode` cannot run in a transaction either. Neither is a migration
/// step: the journal mode is [`configure`]'s, and the pre-migration copy (`VACUUM INTO`) is taken by the
/// boot guard before this is called.
pub fn migrate(conn: &Connection, stamp: Option<i64>) -> rusqlite::Result<()> {
    migrate_with(conn, stamp, migrations::run)
}

/// [`migrate`] over any list of steps, so a test can hand it one that fails.
fn migrate_with(
    conn: &Connection,
    stamp: Option<i64>,
    steps: impl Fn(&Connection) -> rusqlite::Result<()>,
) -> rusqlite::Result<()> {
    conn.execute_batch("PRAGMA foreign_keys = OFF;")?;
    let attempt = in_one_transaction(conn, stamp, &steps);
    // Back on however that went: every other statement on this connection relies on the cascades.
    let restored = conn.execute_batch("PRAGMA foreign_keys = ON;");
    match attempt {
        Ok(()) => restored,
        Err(e) if opens_its_own_transaction(&e) => {
            crate::applog::warn(&format!(
                "database: a migration step opens its own transaction ({e}), so the list ran \
                 without one — that step should use a SAVEPOINT"
            ));
            steps(conn)?;
            if let Some(stamp) = stamp {
                write_stamp(conn, stamp)?;
            }
            conn.execute_batch("PRAGMA foreign_keys = ON;")
        }
        Err(e) => Err(e),
    }
}

fn in_one_transaction(
    conn: &Connection,
    stamp: Option<i64>,
    steps: &impl Fn(&Connection) -> rusqlite::Result<()>,
) -> rusqlite::Result<()> {
    conn.execute_batch("BEGIN IMMEDIATE;")?;
    let result = steps(conn).and_then(|()| match stamp {
        Some(stamp) => write_stamp(conn, stamp),
        None => Ok(()),
    });
    if conn.is_autocommit() {
        // A step ended the transaction itself — a bare `COMMIT` or `ROLLBACK` in a batch. Whatever ran
        // after it ran statement by statement, as the whole list always used to; there is nothing
        // left here to commit or to undo.
        return result;
    }
    match result {
        Ok(()) => conn.execute_batch("COMMIT;").inspect_err(|_| {
            let _ = conn.execute_batch("ROLLBACK;");
        }),
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK;");
            Err(e)
        }
    }
}

/// SQLite's answer to a `BEGIN` inside a transaction — what `unchecked_transaction` inside a step
/// runs into. The message has been the same for as long as SQLite has had transactions; there is no
/// dedicated error code to match instead.
fn opens_its_own_transaction(e: &rusqlite::Error) -> bool {
    matches!(e, rusqlite::Error::SqliteFailure(_, Some(message))
        if message.contains("cannot start a transaction within a transaction"))
}

fn write_stamp(conn: &Connection, stamp: i64) -> rusqlite::Result<()> {
    conn.pragma_update(None, "user_version", stamp)
}

/// The last step of opening, after [`migrate`]: work a previous session was killed in the middle
/// of is marked as such, and the connection is wrapped for the app to manage.
///
/// Before any window exists: a session killed mid-run leaves rows claiming to be running with no
/// process behind them, and the frontend's own correction only happens if the user opens the view
/// that owns them. See `queries::recover_after_restart`.
pub fn finish(conn: Connection) -> rusqlite::Result<Db> {
    queries::recover_after_restart(&conn)?;
    Ok(Db(Mutex::new(conn)))
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
///
/// Also what a launch runs on while the boot guard is asking the user something — a database it
/// could not open, or one a newer build migrated — so that nothing which reaches for `Db` in the
/// meantime (the exit handler, above all) finds it missing. See `boot_guard`.
pub fn init_scratch() -> rusqlite::Result<Db> {
    let conn = configure(Connection::open_in_memory()?)?;
    migrate(&conn, None)?;
    finish(conn)
}

/// Puts a freshly opened connection under the pragmas every connection here runs with. No schema
/// work — but not quite no writes either: switching a rollback-journal database to WAL rewrites its
/// header, which is why the boot guard reads the stamp on the bare connection first.
pub fn configure(conn: Connection) -> rusqlite::Result<Connection> {
    // Must come before `migrate` — the journal mode is a property of the database file, and
    // switching it is cheapest when nothing is mid-transaction (and impossible inside one).
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
    // `Mutex<Connection>` in [`Db`]. The database is opened in `setup` for that reason: the plugin
    // turns a second launch away while the app is being built, and `setup` runs after it — where
    // `.manage(db::init())` used to run before it, so a second launch opened, migrated and
    // "recovered" the live database before it was told to leave.
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
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scalar(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    fn table_exists(conn: &Connection, name: &str) -> bool {
        scalar(conn, &format!("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = '{name}'")) == 1
    }

    #[test]
    fn a_version_stamp_sorts_the_way_versions_do() {
        assert_eq!(version_stamp("2.0.5"), Some(2_000_005));
        assert_eq!(version_stamp(" 1.19.0 "), Some(1_019_000));
        assert_eq!(version_stamp("2.1.0-beta.1"), Some(2_001_000));
        assert!(version_stamp("2.0.10") > version_stamp("2.0.9"));
        assert!(version_stamp("10.0.0") > version_stamp("9.999.999"));
        for nonsense in ["", "2", "2.0", "2.0.x", "2.0.0.1", "1.1000.0", "0.0.0", "-1.0.0"] {
            assert_eq!(version_stamp(nonsense), None, "{nonsense}");
        }
        assert_eq!(stamp_version(2_000_005), "2.0.5");
        assert_eq!(stamp_version(1_019_000), "1.19.0");
    }

    /// The whole point of the transaction: a list that fails part-way leaves the database exactly as
    /// the previous version left it — schema, rows and stamp.
    #[test]
    fn a_migration_that_fails_changes_nothing() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE kept (id INTEGER PRIMARY KEY, name TEXT);
             INSERT INTO kept (name) VALUES ('before');
             PRAGMA user_version = 2000004;",
        )
        .unwrap();

        let failed = migrate_with(&conn, Some(2_000_005), |conn| {
            conn.execute_batch(
                "CREATE TABLE added (x TEXT);
                 ALTER TABLE kept ADD COLUMN extra TEXT;
                 UPDATE kept SET name = 'after';",
            )?;
            Err(rusqlite::Error::InvalidQuery)
        });

        assert!(failed.is_err());
        assert!(!table_exists(&conn, "added"));
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM pragma_table_info('kept') WHERE name = 'extra'"), 0);
        let name: String = conn.query_row("SELECT name FROM kept", [], |row| row.get(0)).unwrap();
        assert_eq!(name, "before");
        assert_eq!(read_stamp(&conn).unwrap(), 2_000_004);
        // And the connection is left the way the rest of the app expects it.
        assert!(conn.is_autocommit());
        assert_eq!(scalar(&conn, "PRAGMA foreign_keys"), 1);
    }

    #[test]
    fn the_real_list_migrates_a_fresh_database_and_stamps_it() {
        let conn = configure(Connection::open_in_memory().unwrap()).unwrap();
        assert_eq!(read_stamp(&conn).unwrap(), 0);
        migrate(&conn, Some(2_000_005)).unwrap();
        assert_eq!(read_stamp(&conn).unwrap(), 2_000_005);
        assert!(table_exists(&conn, "workspaces"));
        assert!(table_exists(&conn, "app_settings"));
        assert_eq!(scalar(&conn, "PRAGMA foreign_keys"), 1);
        assert!(conn.is_autocommit());
        // Idempotent under the wrapper as it is without it: the next launch runs the same list.
        migrate(&conn, Some(2_000_006)).unwrap();
        assert_eq!(read_stamp(&conn).unwrap(), 2_000_006);
    }

    /// A rename with foreign keys off — what the `api_*` move does — must not drag the children's
    /// `REFERENCES` along to the new name. Inside a transaction the step's own `foreign_keys = OFF` is
    /// ignored, so this only holds because the wrapper turns them off *before* `BEGIN`.
    #[test]
    fn a_rename_inside_it_leaves_the_children_pointing_where_they_did() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE parent (id TEXT PRIMARY KEY);
             CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id) ON DELETE CASCADE);",
        )
        .unwrap();

        migrate_with(&conn, None, |conn| {
            conn.execute_batch(
                "PRAGMA foreign_keys = OFF;
                 PRAGMA legacy_alter_table = ON;
                 ALTER TABLE parent RENAME TO parent_legacy;
                 PRAGMA legacy_alter_table = OFF;
                 CREATE TABLE parent (id TEXT PRIMARY KEY);
                 DROP TABLE parent_legacy;",
            )
        })
        .unwrap();

        let child: String = conn
            .query_row("SELECT sql FROM sqlite_master WHERE name = 'child'", [], |row| row.get(0))
            .unwrap();
        assert!(child.contains("REFERENCES parent(id)"), "{child}");
        assert!(!child.contains("legacy"), "{child}");
        assert_eq!(scalar(&conn, "PRAGMA foreign_keys"), 1);
    }

    /// A step that opens a transaction of its own cannot nest inside the wrapper's; the list still has
    /// to migrate, the way it did before there was a wrapper.
    #[test]
    fn a_step_with_its_own_transaction_still_migrates() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_with(&conn, Some(2_000_005), |conn| {
            conn.execute_batch("CREATE TABLE IF NOT EXISTS seeded (x TEXT);")?;
            let tx = conn.unchecked_transaction()?;
            tx.execute("INSERT INTO seeded (x) VALUES ('once')", [])?;
            tx.commit()
        })
        .unwrap();
        assert_eq!(scalar(&conn, "SELECT COUNT(*) FROM seeded"), 1);
        assert_eq!(read_stamp(&conn).unwrap(), 2_000_005);
        assert_eq!(scalar(&conn, "PRAGMA foreign_keys"), 1);
        assert!(conn.is_autocommit());
    }

    #[test]
    fn a_scratch_database_has_the_whole_schema() {
        let db = init_scratch().unwrap();
        let conn = db.0.lock().unwrap();
        assert!(table_exists(&conn, "workspaces"));
        assert_eq!(read_stamp(&conn).unwrap(), 0);
    }
}
