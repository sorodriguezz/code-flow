//! Opening the database at startup without ever taking the app down with it — and noticing when the
//! frontend never comes up.
//!
//! The database used to be opened by `db::init().expect(…)` while the app was being built. Anything
//! that went wrong there — a migration step that met data it did not expect, a file that is no longer
//! a database, a full disk — was a panic before any window existed: on that launch and on every one
//! after it, with the reason only in the log. Nothing was copied before a new version migrated, so a
//! bad migration had nothing to go back to. And a *downgrade* went through in silence: an older build
//! ran its migrations over a database a newer one had already moved on, and some of them are not
//! harmless there — `move_openai_settings_to_cline` deletes the rows it moves.
//!
//! What a launch does now, in order ([`open_at`]):
//!
//! 1. **Read the stamp** — which build last migrated this file (`db::read_stamp`).
//! 2. **Leave a newer build's database alone.** Nothing is written until the user has been told and
//!    chose to go on ([`ask_about_the_newer_database`]).
//! 3. **Copy before a different build migrates it** — `codeflow.db.pre-<version>` beside it, taken
//!    with `VACUUM INTO`, which reads a live WAL database consistently where a file copy of three
//!    sidecars would not. The last [`KEEP_COPIES`] are kept.
//! 4. **Migrate in one transaction**, which writes the new stamp as well (`db::migrate`).
//! 5. **Anything that fails** leaves the launch on a scratch database with no window, while a native
//!    dialog offers the ways out: retry, restore the newest copy, the logs, quit ([`offer_recovery`]).
//!
//! The dialogs are the operating system's, not a screen of the app: at this point the database the
//! frontend reads everything from is the thing that is broken, and nothing about this launch vouches
//! for the webview either. Every answer that needs the rest of the app ends in a relaunch rather than
//! in finishing `setup` from another thread: the second launch takes the ordinary path, the one every
//! other launch takes.
//!
//! The storage rules of the v1.19 layout hold here too: all of this happens only when the layout
//! migration vouched for the state root (otherwise the launch is on `db::init_scratch`, as before),
//! the copies are named after the database's own path so they follow it, and a database is never
//! put in place beside a `-wal` or `-shm` that is not its own.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime};

use rusqlite::Connection;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::MessageDialogKind;

use crate::{applog, db, native_dialog, paths};

/// How many pre-migration copies stay beside the database. Each is the whole database, so this is a
/// trade between disk and history; three reaches back past a release that went wrong and the one
/// that tried to fix it.
const KEEP_COPIES: usize = 3;

/// How the database came up on this launch — decided in `setup` by [`open`], acted on by
/// [`take_over`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Opened, migrated and stamped: the ordinary launch.
    Ready,
    /// The layout migration could not vouch for the state root, so nothing on disk was opened. The
    /// frontend's `DataDirsNotice` handles that one, as it always has.
    Scratch,
    /// A newer build migrated this database. Nothing has been written to it.
    Newer { stamped: String, running: String },
    /// Opening failed; the reason, verbatim.
    Failed { error: String },
}

/// What [`open`] decided, under management for [`take_over`].
pub struct BootState(Verdict);

/// Opens the database and puts it under management, together with how that went.
///
/// The first thing `setup` does. See `lib.rs` for why it is there and not at `.manage()` time.
pub fn open(app: &AppHandle) {
    let version = app.package_info().version.to_string();
    let layout_ok = app.state::<crate::migrate::LayoutStatus>().ok;
    let (database, verdict) = if layout_ok {
        open_database(&version)
    } else {
        (scratch(), Verdict::Scratch)
    };
    app.manage(database);
    app.manage(BootState(verdict));
}

/// `true` when this launch is not going to open the app, because the database needs the user first.
///
/// Then nothing else in `setup` runs — no window, no tray, no background work. A native dialog runs
/// on a thread of its own (it has to: the dialog is shown by the main thread, which `setup` is still
/// holding), and every answer ends this process, in a quit or in a relaunch.
pub fn take_over(app: &AppHandle) -> bool {
    let verdict = app.state::<BootState>().0.clone();
    let handle = app.clone();
    let spawned = match verdict {
        Verdict::Ready | Verdict::Scratch => return false,
        Verdict::Newer { stamped, running } => std::thread::Builder::new()
            .name("boot-guard".into())
            .spawn(move || ask_about_the_newer_database(&handle, &stamped, &running)),
        Verdict::Failed { error } => std::thread::Builder::new()
            .name("boot-guard".into())
            .spawn(move || offer_recovery(&handle, &error)),
    };
    if let Err(e) = spawned {
        // Nothing can ask the user anything, and going on would put the scratch database on screen as
        // if it were theirs.
        applog::error(&format!("database: could not start the recovery dialog — {e}"));
        app.exit(1);
    }
    true
}

/// The on-disk database, or the verdict that stands in for it.
fn open_database(version: &str) -> (db::Db, Verdict) {
    if let Err(e) = paths::ensure_dirs() {
        let error = format!("CodeFlow's folders could not be created: {e}");
        applog::error(&format!("database: {error}"));
        return (scratch(), Verdict::Failed { error });
    }
    let path = paths::db_path();
    let consent = take_consent(&path);
    match open_at(&path, version, consent.as_deref()) {
        Ok(database) => (database, Verdict::Ready),
        Err(verdict) => {
            match &verdict {
                Verdict::Newer { stamped, .. } => applog::warn(&format!(
                    "database: CodeFlow {stamped} migrated this database and this is {version} — \
                     asking before touching it"
                )),
                Verdict::Failed { error } => {
                    applog::error(&format!("database: could not be opened — {error}; asking what to do"))
                }
                Verdict::Ready | Verdict::Scratch => {}
            }
            (scratch(), verdict)
        }
    }
}

/// The on-disk sequence against any path — the one the tests drive. See the module note.
///
/// `consent` is what [`take_consent`] found: the user's answer to the downgrade question, carried
/// across the relaunch it asked for.
fn open_at(path: &Path, version: &str, consent: Option<&str>) -> Result<db::Db, Verdict> {
    let failed = |what: &str, e: &dyn std::fmt::Display| Verdict::Failed { error: format!("{what}: {e}") };
    let running = db::version_stamp(version);
    let opening = |e: &dyn std::fmt::Display| failed(&format!("opening {}", path.display()), e);
    // Read on the bare connection, before `configure`: switching a rollback-journal database to WAL
    // rewrites its header, and a database a newer build migrated gets nothing written to it at all.
    let conn = Connection::open(path).map_err(|e| opening(&e))?;
    let stamp = db::read_stamp(&conn).map_err(|e| failed("reading which version last updated it", &e))?;

    if let Some(running) = running {
        if stamp > running {
            let stamped = db::stamp_version(stamp);
            if consent != Some(consent_token(version, &stamped).as_str()) {
                return Err(Verdict::Newer { stamped, running: version.to_string() });
            }
            applog::warn(&format!(
                "database: opening what CodeFlow {stamped} migrated with {version}, as the user chose"
            ));
        }
    }
    let conn = db::configure(conn).map_err(|e| opening(&e))?;

    if let Some(running) = running {
        if stamp != running && has_schema(&conn) {
            match take_copy(&conn, path, version) {
                Ok(copy) => applog::info(&format!(
                    "database: last updated by {}, copied to {} before {version} migrates it",
                    describe(stamp),
                    copy.display()
                )),
                // Not a reason to stop: the migration is still one transaction, and refusing to start
                // over a copy — typically a full disk, which the migration would then hit too — would
                // only move the failure somewhere with fewer ways out.
                Err(e) => applog::warn(&format!("database: no copy before migrating — {e}")),
            }
        }
    }

    db::migrate(&conn, running).map_err(|e| failed("updating the database", &e))?;
    if running.is_some_and(|running| running != stamp) {
        applog::info(&format!("database: migrated from {} to {version}", describe(stamp)));
    }
    // Flow runs the last session left going, and the files of runs nobody can reach any more. Here
    // and not in `db::finish`, which the scratch database runs through too: against an empty
    // in-memory schema, "a folder with no row" is every folder there is.
    crate::flows::runs::recover(&conn);
    db::finish(conn).map_err(|e| failed("marking interrupted work", &e))
}

/// The database a launch runs on when it must not use, or cannot open, the real one.
fn scratch() -> db::Db {
    db::init_scratch().unwrap_or_else(|e| {
        // The schema itself would not build, which is a bug in the migrations rather than anything in
        // anybody's data. A bare connection keeps every command answering with an error instead of
        // the app panicking at its first `state::<Db>()`.
        applog::error(&format!("database: even the scratch database failed — {e}"));
        db::Db(std::sync::Mutex::new(
            Connection::open_in_memory().expect("an in-memory SQLite connection"),
        ))
    })
}

fn has_schema(conn: &Connection) -> bool {
    conn.query_row("SELECT EXISTS (SELECT 1 FROM sqlite_master)", [], |row| row.get(0))
        .unwrap_or(false)
}

fn describe(stamp: i64) -> String {
    if stamp == 0 {
        "a version from before the stamp".to_string()
    } else {
        db::stamp_version(stamp)
    }
}

// ---------- the copies ----------

/// `codeflow.db` + `suffix`, beside it — the copies, the staging file and the markers are named from
/// the database's own path, so they go wherever `paths::db_path` says the database is.
fn sibling(db: &Path, suffix: &str) -> PathBuf {
    let mut name = db.file_name().map(|name| name.to_os_string()).unwrap_or_else(|| "codeflow.db".into());
    name.push(suffix);
    db.with_file_name(name)
}

fn copy_path(db: &Path, version: &str) -> PathBuf {
    let safe: String = version
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+') { c } else { '_' })
        .collect();
    sibling(db, &format!(".pre-{safe}"))
}

/// Copies the database as it stands, before this build migrates it, and prunes the old copies.
///
/// `VACUUM INTO` rather than a file copy: it reads through SQLite, so the committed transactions
/// still in the `-wal` are in the copy and a half-written one is not — a copy of the three files
/// taken while the database is open promises neither. It writes a `.partial` name first and renames,
/// so a copy cut short by a crash never passes for a finished one.
fn take_copy(conn: &Connection, db: &Path, version: &str) -> Result<PathBuf, String> {
    let copy = copy_path(db, version);
    let partial = sibling(&copy, ".partial");
    let _ = std::fs::remove_file(&partial);
    let target = partial.to_str().ok_or("the copy's path is not valid UTF-8")?;
    let started = Instant::now();
    if let Err(e) = conn.execute("VACUUM INTO ?1", [target]) {
        let _ = std::fs::remove_file(&partial);
        return Err(format!("VACUUM INTO {}: {e}", partial.display()));
    }
    if let Err(e) = std::fs::rename(&partial, &copy) {
        let _ = std::fs::remove_file(&partial);
        return Err(format!("{}: {e}", copy.display()));
    }
    applog::info(&format!("database: copy written in {} ms", started.elapsed().as_millis()));
    prune_copies(db, KEEP_COPIES);
    Ok(copy)
}

/// Every finished copy beside `db`, newest first.
fn copies(db: &Path) -> Vec<PathBuf> {
    let Some(dir) = db.parent() else { return Vec::new() };
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let prefix = format!("{}.pre-", db.file_name().unwrap_or_default().to_string_lossy());
    let mut found: Vec<(SystemTime, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let finished = [".partial", "-wal", "-shm", "-journal"].iter().all(|tail| !name.ends_with(tail));
            if !name.starts_with(&prefix) || !finished {
                return None;
            }
            let meta = entry.metadata().ok()?;
            meta.is_file().then(|| (meta.modified().unwrap_or(SystemTime::UNIX_EPOCH), entry.path()))
        })
        .collect();
    found.sort_by(|a, b| b.cmp(a));
    found.into_iter().map(|(_, path)| path).collect()
}

fn prune_copies(db: &Path, keep: usize) {
    for old in copies(db).into_iter().skip(keep) {
        match std::fs::remove_file(&old) {
            Ok(()) => applog::info(&format!("database: removed the old copy {}", old.display())),
            Err(e) => applog::info(&format!("database: could not remove {} — {e}", old.display())),
        }
    }
}

/// What a restore did: the copy now in place, and where the database it replaced was put.
#[derive(Debug)]
struct Restored {
    copy: PathBuf,
    aside: Option<PathBuf>,
}

/// Puts the newest copy back in place of the database.
///
/// Destroys nothing. The database it replaces is moved aside, all three files together, as
/// `codeflow.db.failed-<time>`; the copy stays where it was, for another attempt. The order is the
/// point:
///
/// - The copy is checked first, on a staging file, before anything else moves — a copy that does
///   not open is found out while the database is still where it was.
/// - The `-wal` and `-shm` go with the database. A WAL carries no link to the database it belongs
///   to: left beside the restored file it would be replayed into it, and `integrity_check` would
///   then pass on data that is neither the copy's nor anybody's (the trap
///   `migrate::clear_destination_database` exists for). A sidecar that can be neither moved nor
///   deleted stops the restore.
/// - Only then does the staging file take the database's name.
fn restore_newest_copy(db: &Path) -> Result<Restored, String> {
    let copy = copies(db).into_iter().next().ok_or("there is no copy to restore")?;
    let staging = sibling(db, ".restoring");
    remove_database_files(&staging);
    std::fs::copy(&copy, &staging).map_err(|e| format!("copying {}: {e}", copy.display()))?;
    if let Err(e) = verify(&staging) {
        remove_database_files(&staging);
        return Err(format!("{} does not verify: {e}", copy.display()));
    }
    let aside = match set_aside(db) {
        Ok(aside) => aside,
        Err(e) => {
            remove_database_files(&staging);
            return Err(e);
        }
    };
    if let Err(e) = std::fs::rename(&staging, db) {
        // Back where it was, rather than leave no database at all.
        if let Some(aside) = &aside {
            let _ = move_database_files(aside, db);
        }
        remove_database_files(&staging);
        return Err(format!("putting the copy in place: {e}"));
    }
    Ok(Restored { copy, aside })
}

fn verify(path: &Path) -> Result<(), String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    let verdict: String = conn
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    drop(conn);
    // Nothing was written, so any sidecar the check left is empty — and none may ride the rename.
    for suffix in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(sibling(path, suffix));
    }
    if verdict == "ok" {
        Ok(())
    } else {
        Err(verdict)
    }
}

/// Moves the database and its sidecars aside; `None` when there was no database to move.
fn set_aside(db: &Path) -> Result<Option<PathBuf>, String> {
    let aside = if db.exists() {
        let aside = sibling(db, &format!(".failed-{}", chrono::Local::now().format("%Y%m%d-%H%M%S")));
        std::fs::rename(db, &aside).map_err(|e| format!("moving {} aside: {e}", db.display()))?;
        Some(aside)
    } else {
        None
    };
    for suffix in ["-wal", "-shm"] {
        let sidecar = sibling(db, suffix);
        if !sidecar.exists() {
            continue;
        }
        let moved = match &aside {
            Some(aside) => std::fs::rename(&sidecar, sibling(aside, suffix)).is_ok(),
            None => false,
        };
        if !moved && std::fs::remove_file(&sidecar).is_err() {
            if let Some(aside) = &aside {
                let _ = move_database_files(aside, db);
            }
            return Err(format!("{} is in use", sidecar.display()));
        }
    }
    Ok(aside)
}

fn move_database_files(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::rename(from, to)?;
    for suffix in ["-wal", "-shm"] {
        let sidecar = sibling(from, suffix);
        if sidecar.exists() {
            std::fs::rename(&sidecar, sibling(to, suffix))?;
        }
    }
    Ok(())
}

fn remove_database_files(path: &Path) {
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(sibling(path, suffix));
    }
}

// ---------- the downgrade answer ----------

/// Where the answer "continue at my own risk" waits for the relaunch it asked for.
fn consent_path(db: &Path) -> PathBuf {
    sibling(db, ".downgrade-ok")
}

/// Names both versions, so an answer about one pair never waves another through.
fn consent_token(running: &str, stamped: &str) -> String {
    format!("{running} over {stamped}")
}

/// Reads and deletes the answer: it covers exactly one launch.
fn take_consent(db: &Path) -> Option<String> {
    let path = consent_path(db);
    let token = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    Some(token.trim().to_string())
}

// ---------- the questions ----------

fn ask_about_the_newer_database(app: &AppHandle, stamped: &str, running: &str) {
    let spanish = crate::tray::spanish(app);
    let w = words(spanish);
    let body = newer_body(spanish, stamped, running);
    if native_dialog::ask(app, MessageDialogKind::Warning, w.newer_title, &body, &[w.go_on, w.quit]) == Some(0) {
        match std::fs::write(consent_path(&paths::db_path()), consent_token(running, stamped)) {
            Ok(()) => {
                applog::warn(&format!(
                    "database: the user chose to open CodeFlow {stamped}'s database with {running}; relaunching"
                ));
                app.request_restart();
                return;
            }
            Err(e) => applog::error(&format!("database: could not record the answer — {e}")),
        }
    }
    app.exit(0);
}

fn offer_recovery(app: &AppHandle, error: &str) {
    let spanish = crate::tray::spanish(app);
    let w = words(spanish);
    let db = paths::db_path();
    let body = failed_body(spanish, &app.package_info().version.to_string(), error);
    loop {
        match native_dialog::ask(app, MessageDialogKind::Error, w.failed_title, &body, &[w.retry, w.more, w.quit]) {
            Some(0) => {
                applog::info("database: retrying, with a relaunch");
                app.request_restart();
                return;
            }
            Some(1) => {
                if more_options(app, spanish, &db) {
                    app.request_restart();
                    return;
                }
            }
            _ => {
                app.exit(0);
                return;
            }
        }
    }
}

/// The second page of the recovery dialog: the copy, and the logs. `true` when a copy was put in
/// place and the app should relaunch onto it.
fn more_options(app: &AppHandle, spanish: bool, db: &Path) -> bool {
    let w = words(spanish);
    let logs = paths::logs_dir();
    let newest = copies(db).into_iter().next();
    let restore_chosen = match &newest {
        Some(copy) => {
            let body = restore_body(spanish, copy, &logs);
            match native_dialog::ask(app, MessageDialogKind::Info, w.more_title, &body, &[w.restore, w.show_logs, w.back]) {
                Some(0) => true,
                Some(1) => return show_logs(&logs),
                _ => return false,
            }
        }
        None => {
            let body = no_copy_body(spanish, &logs);
            match native_dialog::ask(app, MessageDialogKind::Info, w.more_title, &body, &[w.show_logs, w.back]) {
                Some(0) => return show_logs(&logs),
                _ => return false,
            }
        }
    };
    if !restore_chosen {
        return false;
    }
    match restore_newest_copy(db) {
        Ok(restored) => {
            applog::warn(&format!(
                "database: restored {}{}; relaunching",
                restored.copy.display(),
                restored
                    .aside
                    .map(|aside| format!(", the one it replaced kept as {}", aside.display()))
                    .unwrap_or_default()
            ));
            true
        }
        Err(e) => {
            applog::error(&format!("database: the restore failed — {e}"));
            native_dialog::ask(app, MessageDialogKind::Error, w.restore_failed_title, &e, &[w.ok]);
            false
        }
    }
}

/// Opens the logs folder; `false`, so the caller goes back to the question it came from.
fn show_logs(logs: &Path) -> bool {
    if let Err(e) = open::that(logs) {
        applog::info(&format!("database: could not open {} — {e}", logs.display()));
    }
    false
}

// ---------- the watchdog ----------

/// Whether the main window's frontend has said it rendered. See [`arm_watchdog`].
static READY: AtomicBool = AtomicBool::new(false);

/// The watchdog's thread, for [`boot_ready`] to wake.
static WATCHDOG: OnceLock<std::thread::Thread> = OnceLock::new();

/// How long the frontend gets to render before the watchdog speaks up. Minutes would be kinder to a
/// very slow machine; seconds would catch a broken release sooner. The frontend's first render
/// normally lands in about one.
const WATCHDOG_WAIT: Duration = Duration::from_secs(30);

/// The main window's frontend saying it rendered — the boot watchdog's all-clear. Idempotent.
#[tauri::command]
pub fn boot_ready() {
    if !READY.swap(true, Ordering::SeqCst) {
        applog::info("boot: the main window rendered");
    }
    if let Some(watchdog) = WATCHDOG.get() {
        watchdog.unpark();
    }
}

/// Waits for [`boot_ready`], and when it does not come, offers the ways out a broken release still has.
///
/// The app's update check lives in its frontend, so a release whose frontend does not come up — a
/// chunk that fails to load, a throw in the shell's first render — could never update itself out of
/// trouble: the window stayed blank, and the only way back was a manual download. Rust notices
/// instead, and offers the update check it can run on its own (`updates`), the logs folder and the
/// releases page.
///
/// Not in a debug build: there the frontend is served by Vite, whose first compile can take a
/// while, and there is no installed bundle for an update to replace.
pub fn arm_watchdog(app: &AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("boot-watchdog".into()).spawn(move || {
        if wait_until_ready(&READY, WATCHDOG_WAIT) {
            return;
        }
        applog::warn("boot: the main window has not rendered after 30 s — offering a way out");
        offer_a_way_out(&app);
    });
    match spawned {
        Ok(handle) => {
            let _ = WATCHDOG.set(handle.thread().clone());
        }
        Err(e) => applog::info(&format!("boot: no watchdog this launch — {e}")),
    }
}

/// `true` as soon as `flag` is set, `false` once `timeout` has passed without it. Woken early by an
/// `unpark`; the flag, not the wake-up, is what it believes.
fn wait_until_ready(flag: &AtomicBool, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if flag.load(Ordering::SeqCst) {
            return true;
        }
        let now = Instant::now();
        if now >= deadline {
            return false;
        }
        std::thread::park_timeout(deadline - now);
    }
}

fn offer_a_way_out(app: &AppHandle) {
    let spanish = crate::tray::spanish(app);
    let w = words(spanish);
    let logs = paths::logs_dir();
    loop {
        // It may have come up while a question was on screen.
        if READY.load(Ordering::SeqCst) {
            return;
        }
        let body = stalled_body(spanish);
        match native_dialog::ask(app, MessageDialogKind::Warning, w.stalled_title, &body, &[w.check_updates, w.more, w.keep_waiting]) {
            Some(0) => {
                crate::updates::check_and_offer(app);
                return;
            }
            Some(1) => {
                let body = logs_body(&logs);
                match native_dialog::ask(app, MessageDialogKind::Info, w.more_title, &body, &[w.show_logs, w.releases, w.back]) {
                    Some(0) => {
                        show_logs(&logs);
                        return;
                    }
                    Some(1) => {
                        crate::updates::open_releases_page();
                        return;
                    }
                    _ => continue,
                }
            }
            _ => return,
        }
    }
}

// ---------- the words ----------

/// The dialogs' labels, in the app's language — decided here for the reason `tray::TrayLabels` gives.
/// `native_dialog::ask` tells buttons apart by label, so the ones that share a dialog must differ.
struct Words {
    newer_title: &'static str,
    go_on: &'static str,
    quit: &'static str,
    failed_title: &'static str,
    retry: &'static str,
    more: &'static str,
    more_title: &'static str,
    restore: &'static str,
    show_logs: &'static str,
    back: &'static str,
    restore_failed_title: &'static str,
    ok: &'static str,
    stalled_title: &'static str,
    check_updates: &'static str,
    keep_waiting: &'static str,
    releases: &'static str,
}

fn words(spanish: bool) -> Words {
    if spanish {
        Words {
            newer_title: "Estos datos son de una versión más nueva",
            go_on: "Continuar bajo mi riesgo",
            quit: "Salir",
            failed_title: "CodeFlow no pudo abrir tus datos",
            retry: "Reintentar",
            more: "Más opciones…",
            more_title: "Más opciones",
            restore: "Restaurar copia previa",
            show_logs: "Mostrar carpeta de logs",
            back: "Volver",
            restore_failed_title: "No se pudo restaurar la copia",
            ok: "Aceptar",
            stalled_title: "CodeFlow no terminó de abrir",
            check_updates: "Buscar actualizaciones",
            keep_waiting: "Seguir esperando",
            releases: "Abrir página de versiones",
        }
    } else {
        Words {
            newer_title: "This data is from a newer version",
            go_on: "Continue at my own risk",
            quit: "Quit",
            failed_title: "CodeFlow couldn't open its data",
            retry: "Retry",
            more: "More options…",
            more_title: "More options",
            restore: "Restore previous copy",
            show_logs: "Show logs folder",
            back: "Back",
            restore_failed_title: "Couldn't restore the copy",
            ok: "OK",
            stalled_title: "CodeFlow didn't finish opening",
            check_updates: "Check for updates",
            keep_waiting: "Keep waiting",
            releases: "Open releases page",
        }
    }
}

fn newer_body(spanish: bool, stamped: &str, running: &str) -> String {
    if spanish {
        format!(
            "CodeFlow {stamped} ya actualizó esta base de datos, y esta es la {running}. Una versión \
             anterior puede perder o dañar datos que no conoce.\n\nSi continúas, antes se guarda una copia."
        )
    } else {
        format!(
            "CodeFlow {stamped} already updated this database, and this is {running}. An older version \
             can lose or damage data it doesn't know about.\n\nIf you continue, a copy is saved first."
        )
    }
}

fn failed_body(spanish: bool, running: &str, error: &str) -> String {
    if spanish {
        format!("No se pudo preparar la base de datos para CodeFlow {running}.\n\n{error}")
    } else {
        format!("The database couldn't be prepared for CodeFlow {running}.\n\n{error}")
    }
}

fn restore_body(spanish: bool, copy: &Path, logs: &Path) -> String {
    let name = copy.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let when = std::fs::metadata(copy)
        .and_then(|meta| meta.modified())
        .map(|time| chrono::DateTime::<chrono::Local>::from(time).format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_default();
    if spanish {
        format!(
            "Copia previa: {name} ({when}).\n\nRestaurarla reemplaza la base de datos actual, que se guarda \
             aparte, y reinicia CodeFlow. Si el error se repite, instala la versión anterior.\n\nLogs: {}",
            logs.display()
        )
    } else {
        format!(
            "Previous copy: {name} ({when}).\n\nRestoring it replaces the current database, which is kept \
             aside, and restarts CodeFlow. If the error comes back, install the previous version.\n\nLogs: {}",
            logs.display()
        )
    }
}

fn no_copy_body(spanish: bool, logs: &Path) -> String {
    if spanish {
        format!("No hay copias previas de la base de datos.\n\nLogs: {}", logs.display())
    } else {
        format!("There are no previous copies of the database.\n\nLogs: {}", logs.display())
    }
}

fn stalled_body(spanish: bool) -> String {
    if spanish {
        "La ventana lleva 30 segundos sin cargar. Si esta versión tiene un problema, una actualización \
         suele resolverlo."
            .to_string()
    } else {
        "The window has been loading for 30 seconds. If this version has a problem, an update usually \
         fixes it."
            .to_string()
    }
}

/// The same in both languages: "logs" is the word the Spanish copy uses too.
fn logs_body(logs: &Path) -> String {
    format!("Logs: {}", logs.display())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A directory of its own under the system temp dir, removed when dropped.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("cf-boot-guard-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn db(&self) -> PathBuf {
            self.0.join("codeflow.db")
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A database as an earlier build left it: the real schema, one row of the user's, and the stamp.
    fn database_from(path: &Path, version: &str) {
        let conn = db::configure(Connection::open(path).unwrap()).unwrap();
        db::migrate(&conn, db::version_stamp(version)).unwrap();
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES ('marker', ?1)",
            [format!("written by {version}")],
        )
        .unwrap();
    }

    fn marker(path: &Path) -> String {
        let conn = Connection::open(path).unwrap();
        conn.query_row("SELECT value FROM app_settings WHERE key = 'marker'", [], |row| row.get(0))
            .unwrap()
    }

    fn stamp_of(path: &Path) -> i64 {
        db::read_stamp(&Connection::open(path).unwrap()).unwrap()
    }

    fn names(paths: &[PathBuf]) -> Vec<String> {
        paths.iter().map(|path| path.file_name().unwrap().to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn a_new_version_copies_the_database_before_migrating_it() {
        let dir = TempDir::new();
        let path = dir.db();
        database_from(&path, "2.0.4");

        let opened = open_at(&path, "2.0.5", None).expect("opens");
        drop(opened);

        let copy = dir.0.join("codeflow.db.pre-2.0.5");
        assert!(copy.exists(), "no copy in {:?}", std::fs::read_dir(&dir.0).unwrap().flatten().map(|e| e.file_name()).collect::<Vec<_>>());
        // The copy is the database as 2.0.4 left it — its row, and 2.0.4's stamp.
        assert_eq!(marker(&copy), "written by 2.0.4");
        assert_eq!(stamp_of(&copy), 2_000_004);
        assert!(verify(&copy).is_ok());
        // And the database itself now says 2.0.5 migrated it.
        assert_eq!(stamp_of(&path), 2_000_005);
        assert!(!dir.0.join("codeflow.db.pre-2.0.5.partial").exists());
    }

    #[test]
    fn the_same_version_and_a_brand_new_database_are_not_copied() {
        let dir = TempDir::new();
        let path = dir.db();

        drop(open_at(&path, "2.0.5", None).expect("a fresh database opens"));
        assert!(copies(&path).is_empty(), "a new, empty database has nothing to keep");
        assert_eq!(stamp_of(&path), 2_000_005);

        drop(open_at(&path, "2.0.5", None).expect("opens again"));
        assert!(copies(&path).is_empty(), "the version that stamped it does not copy it again");
    }

    #[test]
    fn a_database_from_before_the_stamp_is_copied_too() {
        let dir = TempDir::new();
        let path = dir.db();
        // What every existing install looks like the first time a build with the stamp opens it.
        let conn = db::configure(Connection::open(&path).unwrap()).unwrap();
        db::migrate(&conn, None).unwrap();
        drop(conn);
        assert_eq!(stamp_of(&path), 0);

        drop(open_at(&path, "2.0.5", None).expect("opens"));
        assert_eq!(names(&copies(&path)), ["codeflow.db.pre-2.0.5"]);
    }

    #[test]
    fn only_the_last_three_copies_are_kept() {
        let dir = TempDir::new();
        let path = dir.db();
        std::fs::write(&path, b"").unwrap();
        let base = SystemTime::now() - Duration::from_secs(3600);
        for (i, version) in ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0"].iter().enumerate() {
            let copy = copy_path(&path, version);
            std::fs::write(&copy, version.as_bytes()).unwrap();
            let file = std::fs::File::options().write(true).open(&copy).unwrap();
            file.set_modified(base + Duration::from_secs(60 * i as u64)).unwrap();
        }
        // Neither a half-written copy nor a sidecar is a copy.
        std::fs::write(sibling(&copy_path(&path, "1.5.0"), ".partial"), b"").unwrap();
        std::fs::write(sibling(&copy_path(&path, "1.4.0"), "-wal"), b"").unwrap();

        prune_copies(&path, KEEP_COPIES);

        assert_eq!(
            names(&copies(&path)),
            ["codeflow.db.pre-1.4.0", "codeflow.db.pre-1.3.0", "codeflow.db.pre-1.2.0"]
        );
        assert!(!copy_path(&path, "1.0.0").exists());
        assert!(!copy_path(&path, "1.1.0").exists());
    }

    /// A migration that fails is a verdict, not a panic — and, being one transaction, it leaves the
    /// database exactly as the previous version left it.
    #[test]
    fn a_database_that_cannot_be_migrated_is_a_recovery_not_a_panic() {
        let dir = TempDir::new();
        let path = dir.db();
        // A `notes` table in a shape no build ever wrote: the schema batch's index on `book_id` fails.
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT);
             INSERT INTO notes (id, body) VALUES ('n1', 'mine');
             PRAGMA user_version = 2000004;",
        )
        .unwrap();
        drop(conn);

        let verdict = match open_at(&path, "2.0.5", None) {
            Ok(_) => panic!("a database that cannot be migrated opened"),
            Err(verdict) => verdict,
        };
        assert!(matches!(&verdict, Verdict::Failed { error } if error.starts_with("updating the database")), "{verdict:?}");

        let conn = Connection::open(&path).unwrap();
        assert_eq!(db::read_stamp(&conn).unwrap(), 2_000_004);
        let tables: i64 = conn
            .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(tables, 1, "the half-run migration left tables behind");
        drop(conn);
        // The copy was taken first, so the recovery dialog has something to offer.
        assert_eq!(names(&copies(&path)), ["codeflow.db.pre-2.0.5"]);
        // And the scratch database that launch then runs on is a working one.
        let scratch = scratch();
        let conn = scratch.0.lock().unwrap();
        let settings: i64 = conn.query_row("SELECT COUNT(*) FROM app_settings", [], |row| row.get(0)).unwrap();
        assert_eq!(settings, 0);
    }

    #[test]
    fn a_file_that_is_not_a_database_is_a_recovery_not_a_panic() {
        let dir = TempDir::new();
        let path = dir.db();
        std::fs::write(&path, vec![0x42_u8; 8192]).unwrap();
        let verdict = match open_at(&path, "2.0.5", None) {
            Ok(_) => panic!("garbage opened as a database"),
            Err(verdict) => verdict,
        };
        assert!(matches!(verdict, Verdict::Failed { .. }), "{verdict:?}");
    }

    #[test]
    fn restoring_puts_the_newest_copy_back_and_keeps_what_it_replaced() {
        let dir = TempDir::new();
        let path = dir.db();
        database_from(&path, "2.0.4");
        drop(open_at(&path, "2.0.5", None).expect("opens"));
        // What happened after the copy: 2.0.5 wrote something, and a stale WAL sits beside it.
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute("UPDATE app_settings SET value = 'written by 2.0.5' WHERE key = 'marker'", [])
                .unwrap();
        }
        std::fs::write(sibling(&path, "-wal"), b"not this database's").unwrap();

        let restored = restore_newest_copy(&path).expect("restores");

        // Looked at before anything opens these files: closing a WAL database removes its sidecars.
        // The stale WAL went aside with the database it sat beside, not under the restored one.
        let aside = restored.aside.clone().expect("the replaced database was kept");
        assert!(!sibling(&path, "-wal").exists());
        assert!(sibling(&aside, "-wal").exists());
        assert!(!dir.0.join("codeflow.db.restoring").exists());

        assert_eq!(restored.copy, dir.0.join("codeflow.db.pre-2.0.5"));
        assert_eq!(marker(&path), "written by 2.0.4");
        assert_eq!(stamp_of(&path), 2_000_004);
        // Nothing destroyed: the replaced database is aside, and the copy is still there.
        assert_eq!(marker(&aside), "written by 2.0.5");
        assert!(restored.copy.exists());
    }

    #[test]
    fn a_copy_that_does_not_verify_is_not_restored() {
        let dir = TempDir::new();
        let path = dir.db();
        database_from(&path, "2.0.5");
        std::fs::write(copy_path(&path, "2.0.5"), vec![0x42_u8; 8192]).unwrap();

        assert!(restore_newest_copy(&path).is_err());
        // The database is untouched and nothing was moved aside.
        assert_eq!(marker(&path), "written by 2.0.5");
        let leftovers: Vec<String> = std::fs::read_dir(&dir.0)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".failed-") || name.contains(".restoring"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn no_copy_means_no_restore() {
        let dir = TempDir::new();
        let path = dir.db();
        database_from(&path, "2.0.5");
        assert!(restore_newest_copy(&path).is_err());
        assert_eq!(marker(&path), "written by 2.0.5");
    }

    /// A database a newer build migrated is not written to — not migrated, not stamped, not copied —
    /// until the user has answered, and the answer covers exactly that pair of versions.
    #[test]
    fn a_newer_database_is_left_alone_until_the_user_answers() {
        let dir = TempDir::new();
        let path = dir.db();
        database_from(&path, "2.1.0");
        // In rollback-journal mode, where even switching it to WAL would be a write to its header.
        Connection::open(&path).unwrap().execute_batch("PRAGMA journal_mode = DELETE;").unwrap();
        let before = std::fs::read(&path).unwrap();

        let verdict = match open_at(&path, "2.0.5", None) {
            Ok(_) => panic!("opened a newer database without asking"),
            Err(verdict) => verdict,
        };
        assert_eq!(verdict, Verdict::Newer { stamped: "2.1.0".into(), running: "2.0.5".into() });
        assert_eq!(std::fs::read(&path).unwrap(), before, "the database changed");
        assert!(copies(&path).is_empty());

        // An answer about another pair does not count.
        assert!(open_at(&path, "2.0.5", Some(&consent_token("2.0.5", "2.2.0"))).is_err());

        // The answer given: opened, copied first, and stamped by the version that is running now.
        drop(open_at(&path, "2.0.5", Some(&consent_token("2.0.5", "2.1.0"))).expect("opens once answered"));
        assert_eq!(stamp_of(&path), 2_000_005);
        let copy = copy_path(&path, "2.0.5");
        assert_eq!(stamp_of(&copy), 2_001_000);
        assert_eq!(marker(&copy), "written by 2.1.0");
    }

    #[test]
    fn the_answer_to_the_downgrade_question_covers_one_launch() {
        let dir = TempDir::new();
        let path = dir.db();
        std::fs::write(consent_path(&path), consent_token("2.0.5", "2.1.0")).unwrap();
        assert_eq!(take_consent(&path).as_deref(), Some("2.0.5 over 2.1.0"));
        assert_eq!(take_consent(&path), None);
    }

    #[test]
    fn the_watchdog_waits_for_the_frontend_and_no_longer() {
        // Already there.
        assert!(wait_until_ready(&AtomicBool::new(true), Duration::from_secs(5)));
        // Never comes.
        let started = Instant::now();
        assert!(!wait_until_ready(&AtomicBool::new(false), Duration::from_millis(40)));
        assert!(started.elapsed() >= Duration::from_millis(40));
        // Comes, and wakes it early.
        let flag = std::sync::Arc::new(AtomicBool::new(false));
        let waiter = std::thread::current();
        let signal = flag.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            signal.store(true, Ordering::SeqCst);
            waiter.unpark();
        });
        let started = Instant::now();
        assert!(wait_until_ready(&flag, Duration::from_secs(10)));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn both_languages_name_every_button_and_no_two_in_a_dialog_match() {
        for spanish in [false, true] {
            let w = words(spanish);
            let dialogs: [&[&str]; 6] = [
                &[w.go_on, w.quit],
                &[w.retry, w.more, w.quit],
                &[w.restore, w.show_logs, w.back],
                &[w.show_logs, w.back],
                &[w.check_updates, w.more, w.keep_waiting],
                &[w.show_logs, w.releases, w.back],
            ];
            for buttons in dialogs {
                for (i, label) in buttons.iter().enumerate() {
                    assert!(!label.trim().is_empty());
                    assert!(!buttons[i + 1..].contains(label), "{label} twice in one dialog");
                }
            }
            for title in [w.newer_title, w.failed_title, w.more_title, w.restore_failed_title, w.stalled_title, w.ok] {
                assert!(!title.trim().is_empty());
            }
        }
    }
}
